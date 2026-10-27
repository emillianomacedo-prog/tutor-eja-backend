require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const geminiKeys = process.env.GEMINI_KEYS.split(',').map(k => k.trim());

app.get('/', (req, res) => res.send('Backend do Tutor Nova EJA está rodando!'));

// --- FUNÇÕES AUXILIARES ---

async function gerarRespostaIA(promptSistema, historico, mensagemAluno) {
  for (let i = 0; i < geminiKeys.length; i++) {
    try {
      const genAI = new GoogleGenerativeAI(geminiKeys[i]);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const result = await model.generateContent([
        { text: promptSistema },
        ...historico.map(h => ({ text: `${h.remetente}: ${h.texto}` })),
        { text: `Aluno: ${mensagemAluno}` }
      ]);
      return result.response.text();
    } catch (error) { console.log(`⚠️ Chave Gemini ${i+1} falhou.`); }
  }
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: promptSistema },
        ...historico.map(h => ({ role: h.remetente === 'aluno' ? 'user' : 'assistant', content: h.texto })),
        { role: "user", content: mensagemAluno || "Olá" }
      ],
      model: "openai/gpt-oss-20b",
    });
    return completion.choices[0]?.message?.content;
  } catch (error) { return "Puxa, nosso sistema está instável agora. Pode repetir sua pergunta?"; }
}

function extrairTagsQualitativas(textoIA, matricula_id) {
  const regex = /\[([A-Z_]+):\s*(.*?)\]/g;
  let match; const registros = [];
  while ((match = regex.exec(textoIA)) !== null) { registros.push({ matricula_id, tipo: match[1].toLowerCase(), descricao: match[2].trim(), gravidade: 'media' }); }
  return { textoLimpo: textoIA.replace(/\[.*?\]/g, '').trim(), registros };
}

// --- ROTAS ---

// LOGIN (Agora retorna Turma)
app.post('/api/login', async (req, res) => {
  const { cpf } = req.body;
  try {
    const { data: aluno } = await supabase.from('alunos').select('id, nome_completo').eq('cpf', cpf).single();
    if (!aluno) return res.status(404).json({ erro: "CPF não encontrado." });
    const { data: matricula } = await supabase.from('matriculas_estudos').select('id, segmento, turma').eq('aluno_id', aluno.id).eq('status', 'ativa').single();
    if (!matricula) return res.status(404).json({ erro: "Nenhuma matrícula ativa." });
    return res.json({ aluno: { nome: aluno.nome_completo, matricula_id: matricula.id, segmento: matricula.segmento, turma: matricula.turma } });
  } catch (e) { return res.status(500).json({ erro: "Erro interno." }); }
});

// CHAT
app.post('/api/chat', async (req, res) => {
  const { mensagemAluno, matricula_id, historico = [] } = req.body;
  try {
    await supabase.from('matriculas_estudos').update({ ultimo_acesso: new Date() }).eq('id', matricula_id);
    const { data: matricula } = await supabase.from('matriculas_estudos').select('segmento').eq('id', matricula_id).single();
    const segmentoAluno = matricula ? matricula.segmento : 'fundamental';

    const { data: habsDesenvolver } = await supabase.from('habilidades_a_desenvolver').select('*').eq('matricula_id', matricula_id).neq('status', 'concluida');
    const { data: habsDispensadas } = await supabase.from('habilidades_dispensadas').select('habilidade_codigo, area').eq('matricula_id', matricula_id);
    const { data: obrigatorias } = await supabase.from('questoes_obrigatorias').select('enunciado').eq('ativo', true).eq('segmento', segmentoAluno);
    const listaObrigatorias = obrigatorias?.map(q => q.enunciado).join('\n') || "Nenhuma";

    let habilidadeFoco = null;
    const matchHab = mensagemAluno.match(/(C\d+H\d+)/i);
    if (matchHab) habilidadeFoco = matchHab[0].toUpperCase();

    if (habilidadeFoco) {
      const isDispensada = habsDispensadas && habsDispensadas.some(h => h.habilidade_codigo === habilidadeFoco);
      if (isDispensada) {
        const pendentesSugestao = habsDesenvolver && habsDesenvolver.length > 0 ? habsDesenvolver.slice(0, 2).map(h => h.habilidade_codigo).join(' e ') : 'as pendentes';
        const respostaBloqueio = `Que ótima notícia! Você já tem a habilidade ${habilidadeFoco} reconhecida dos seus estudos ou trabalho anteriores. Não precisa estudá-la novamente. Vamos focar no que falta? Suas próximas pendências são: ${pendentesSugestao}. Qual delas você quer começar?`;
        await supabase.from('mensagens_chat').insert([{ texto: mensagemAluno, remetente: 'aluno', matricula_id }, { texto: respostaBloqueio, remetente: 'ia', matricula_id }]);
        return res.json({ resposta: respostaBloqueio });
      }
    }

    let descricaoHabilidade = "";
    if (habilidadeFoco && habsDesenvolver) {
      const habInfo = habsDesenvolver.find(h => h.habilidade_codigo === habilidadeFoco);
      if (habInfo && habInfo.descricao) descricaoHabilidade = habInfo.descricao;
    }

    let textoBusca = mensagemAluno;
    if (mensagemAluno.length < 10 && habilidadeFoco) textoBusca = `O que é ${habilidadeFoco} ${descricaoHabilidade}`; 

    let contextoLivro = "";
    if (textoBusca) {
      const modelEmbed = new GoogleGenerativeAI(geminiKeys[0]).getGenerativeModel({ model: "gemini-embedding-001" });
      const resultEmb = await modelEmbed.embedContent(textoBusca);
      const { data: chunks } = await supabase.rpc('match_chunks', { query_embedding: resultEmb.embedding.values, filter_habilidade: habilidadeFoco, filter_segmento: segmentoAluno, match_count: 1 });
      if (chunks && chunks.length > 0) contextoLivro = chunks.map(c => c.conteudo).join("\n---\n");
    }

    let avisoConclusao = "";
    const palavrasDeAcerto = /(sim|entendi|acertei|já sei|compreendi|isso mesmo|correto|ok)/i;
    if (palavrasDeAcerto.test(mensagemAluno) && habilidadeFoco) {
      await supabase.from('habilidades_a_desenvolver').update({ status: 'concluida' }).eq('matricula_id', matricula_id).eq('habilidade_codigo', habilidadeFoco);
      avisoConclusao = `SISTEMA: O aluno concluiu a habilidade ${habilidadeFoco}. Parabenize-o e sugira a próxima.`;
      if (habsDesenvolver) {
        const index = habsDesenvolver.findIndex(h => h.habilidade_codigo === habilidadeFoco);
        if (index > -1) habsDesenvolver.splice(index, 1);
      }
    }

    const systemPrompt = `
      Você é o TUTOR NOVA EJA. Um professor experiente, acolhedor e descontraído.
      
      CONTEXTO ATUAL DA AULA:
      - Habilidade em foco: ${habilidadeFoco || 'Geral'}
      - Descrição oficial da habilidade: ${descricaoHabilidade}
      ${avisoConclusao}
      
      DIRETRIZES DE COMUNICAÇÃO:
      1. Use uma linguagem amigável, como se estivesse conversando no WhatsApp.
      2. USE EMOJIS com moderação para tornar a conversa mais leve (ex: 🚀, 💡, 👏, 📚, ✅). Não exagere.
      3. Use Microlearning: Máximo 3 parágrafos curtos.
      4. SEMPRE termine com UMA pergunta para o aluno.
      5. Conecte o tema com o mundo do trabalho ou vida adulta.

      REGRAS DE OURO:
      1. BLOQUEIO DE QUESTÕES OBRIGATÓRIAS: Se o aluno pedir a resposta, diga: "Essa é uma avaliação obrigatória e eu não posso te dar a resposta. 😉".
         QUESTÕES PROIBIDAS: ${listaObrigatorias}
      2. Habilidades pendentes: ${JSON.stringify(habsDesenvolver)}.
      3. Não ensine o que já foi dispensado: ${JSON.stringify(habsDispensadas)}.

      MATERIAL DE APOIO DO LIVRO:
      "${contextoLivro}"
    `;

    const respostaBruta = await gerarRespostaIA(systemPrompt, historico, mensagemAluno);
    const { textoLimpo, registros } = extrairTagsQualitativas(respostaBruta, matricula_id);
    
    if (registros.length > 0) await supabase.from('registros_qualitativos').insert(registros);
    await supabase.from('mensagens_chat').insert([{ texto: mensagemAluno, remetente: 'aluno', matricula_id }, { texto: textoLimpo, remetente: 'ia', matricula_id }]);

    return res.json({ resposta: textoLimpo });
  } catch (error) { 
    console.error("Erro no chat:", error);
    return res.status(500).json({ erro: "Erro no chat." }); 
  }
});

// PROGRESSO
app.get('/api/aluno/:matricula_id/progresso', async (req, res) => {
  const { matricula_id } = req.params;
  try {
    const { data: habilidades, error } = await supabase.from('habilidades_a_desenvolver').select('habilidade_codigo, area, status').eq('matricula_id', matricula_id);
    if (error) throw error;

    const areas = ['matematica', 'linguagens', 'ciencias_natureza', 'ciencias_humanas'];
    const progresso = areas.map(area => {
      const habsArea = habilidades.filter(h => h.area === area);
      const total = habsArea.length;
      const concluidas = habsArea.filter(h => h.status === 'concluida').length;
      const percentual = total > 0 ? Math.round((concluidas / total) * 100) : 0;
      return { area, total, concluidas, percentual, habilidades: habsArea };
    });
    return res.json(progresso);
  } catch (error) { return res.status(500).json({ erro: "Erro." }); }
});

// CATÁLOGO
app.get('/api/admin/catalogo/:segmento', async (req, res) => {
  const { segmento } = req.params;
  try {
    const { data: catalogo, error } = await supabase.from('catalogo_habilidades').select('habilidade_codigo, area, descricao').eq('segmento', segmento).order('area', { ascending: true }).order('habilidade_codigo', { ascending: true });
    if (error) throw error;
    return res.json(catalogo);
  } catch (error) { return res.status(500).json({ erro: "Erro ao buscar catálogo." }); }
});

// CADASTRAR ALUNO (Com Turma)
app.post('/api/admin/cadastrar-aluno', async (req, res) => {
  const { nome_completo, cpf, email, telefone_whatsapp, segmento, turma, habilidades_dispensadas } = req.body;
  if (!nome_completo || !cpf || !segmento || !turma) return res.status(400).json({ erro: "Nome, CPF, Segmento e Turma são obrigatórios." });

  try {
    const { data: aluno, error: errAluno } = await supabase.from('alunos').insert({ nome_completo, cpf, email, telefone_whatsapp }).select().single();
    if (errAluno) {
      if (errAluno.code === '23505') return res.status(400).json({ erro: "Este CPF já está cadastrado." });
      throw errAluno;
    }

    const { data: matricula, error: errMat } = await supabase.from('matriculas_estudos').insert({ aluno_id: aluno.id, segmento, turma, status: 'ativa' }).select().single();
    if (errMat) throw errMat;

    const { data: catalogo } = await supabase.from('catalogo_habilidades').select('habilidade_codigo, area, descricao').eq('segmento', segmento);
    
    if (catalogo && catalogo.length > 0) {
      const dispensadasSet = new Set((habilidades_dispensadas || []).map(h => `${h.codigo}_${h.area}`));
      const habilidadesParaInserir = catalogo.filter(h => !dispensadasSet.has(`${h.habilidade_codigo}_${h.area}`)).map(h => ({
        matricula_id: matricula.id, habilidade_codigo: h.habilidade_codigo, area: h.area, descricao: h.descricao, status: 'pendente'
      }));
      if (habilidadesParaInserir.length > 0) await supabase.from('habilidades_a_desenvolver').insert(habilidadesParaInserir);
    }

    if (habilidades_dispensadas && habilidades_dispensadas.length > 0) {
      const dispensadasFormatadas = habilidades_dispensadas.map(h => ({ matricula_id: matricula.id, habilidade_codigo: h.codigo, area: h.area, origem: 'reconhecimento' }));
      await supabase.from('habilidades_dispensadas').insert(dispensadasFormatadas);
    }
    return res.json({ mensagem: "Aluno cadastrado com sucesso!", aluno_id: aluno.id, matricula_id: matricula.id });
  } catch (error) {
    return res.status(500).json({ erro: "Erro ao cadastrar aluno." });
  }
});

// BUSCAR ALUNO PARA EDIÇÃO
app.get('/api/admin/aluno/:matricula_id', async (req, res) => {
  const { matricula_id } = req.params;
  try {
    const { data: matricula } = await supabase.from('matriculas_estudos').select(`id, segmento, turma, alunos ( nome_completo, cpf, email, telefone_whatsapp )`).eq('id', matricula_id).single();
    const { data: dispensadas } = await supabase.from('habilidades_dispensadas').select('habilidade_codigo, area').eq('matricula_id', matricula_id);
    return res.json({ matricula, dispensadas });
  } catch (error) { return res.status(500).json({ erro: "Erro ao buscar aluno." }); }
});

// EDITAR ALUNO
app.put('/api/admin/editar-aluno/:matricula_id', async (req, res) => {
  const { matricula_id } = req.params;
  const { nome_completo, email, telefone_whatsapp, turma, habilidades_dispensadas } = req.body;

  try {
    const { data: matricula } = await supabase.from('matriculas_estudos').select('aluno_id, segmento').eq('id', matricula_id).single();
    
    await supabase.from('alunos').update({ nome_completo, email, telefone_whatsapp }).eq('id', matricula.aluno_id);
    await supabase.from('matriculas_estudos').update({ turma }).eq('id', matricula_id);

    await supabase.from('habilidades_dispensadas').delete().eq('matricula_id', matricula_id);
    await supabase.from('habilidades_a_desenvolver').delete().eq('matricula_id', matricula_id);
    
    const { data: catalogo } = await supabase.from('catalogo_habilidades').select('*').eq('segmento', matricula.segmento);

    const dispensadasSet = new Set((habilidades_dispensadas || []).map(h => `${h.codigo}_${h.area}`));
    if (habilidades_dispensadas && habilidades_dispensadas.length > 0) {
      const dispensadasFormatadas = habilidades_dispensadas.map(h => ({ matricula_id: matricula_id, habilidade_codigo: h.codigo, area: h.area, origem: 'manual' }));
      await supabase.from('habilidades_dispensadas').insert(dispensadasFormatadas);
    }

    if (catalogo && catalogo.length > 0) {
      const novasPendentes = catalogo.filter(h => !dispensadasSet.has(`${h.habilidade_codigo}_${h.area}`)).map(h => ({
        matricula_id: matricula_id, habilidade_codigo: h.habilidade_codigo, area: h.area, descricao: h.descricao, status: 'pendente'
      }));
      if (novasPendentes.length > 0) await supabase.from('habilidades_a_desenvolver').insert(novasPendentes);
    }

    return res.json({ mensagem: "Aluno atualizado e progresso sincronizado!" });
  } catch (error) {
    return res.status(500).json({ erro: "Erro ao atualizar aluno." });
  }
});

// FINALIZAR E GERAR RELATÓRIO
app.post('/api/finalizar-curso/:matricula_id', async (req, res) => {
  const { matricula_id } = req.params;
  try {
    const { data: competencias, error: errCalc } = await supabase.rpc('verificar_aproveitamento', { m_id: matricula_id });
    if (errCalc) throw new Error(errCalc.message);
    
    const todasAprovadas = competencias.every(c => c.status === 'Aprovado');
    if (!todasAprovadas) return res.status(400).json({ mensagem: "Ainda faltam competências.", detalhes: competencias });

    const { data: registros } = await supabase.from('registros_qualitativos').select('*').eq('matricula_id', matricula_id);
    const promptRelatorio = `Gere a síntese qualitativa do portfólio. Status: Aprovado. Registros: ${JSON.stringify(registros || [])}. Use Andragogia e Bloom.`;
    const sintese = await gerarRespostaIA(promptRelatorio, [], "Gerar Relatório");

    await supabase.from('relatorios_oficiais').insert({ matricula_id, status_geral: 'Aprovado', detalhes_competencias: competencias, sintese_qualitativa: sintese });
    await supabase.from('matriculas_estudos').update({ status: 'concluida' }).eq('id', matricula_id);
    
    return res.json({ mensagem: "Curso concluído!", relatorio: sintese });
  } catch (error) { return res.status(500).json({ erro: "Erro ao finalizar curso.", detalhes: error.message }); }
});

// LISTAR ALUNOS (Com Turma)
app.get('/api/admin/alunos', async (req, res) => {
  try {
    const { data: matriculas, error } = await supabase.from('matriculas_estudos').select(`id, status, ultimo_acesso, segmento, turma, alunos ( nome_completo, cpf )`);
    if (error) throw error;

    const alunosComRelatorio = await Promise.all(matriculas.map(async (m) => {
      const { data: relatorio } = await supabase.from('relatorios_oficiais').select('*').eq('matricula_id', m.id).single();
      return { matricula_id: m.id, nome: m.alunos.nome_completo, cpf: m.alunos.cpf, segmento: m.segmento, turma: m.turma, status: m.status, ultimo_acesso: m.ultimo_acesso, tem_relatorio: !!relatorio, relatorio: relatorio || null };
    }));
    return res.json(alunosComRelatorio);
  } catch (error) { return res.status(500).json({ erro: "Erro." }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend Rodando na porta ${PORT}`));