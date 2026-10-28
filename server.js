require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const geminiKeys = process.env.GEMINI_KEYS.split(',').map(k => k.trim());

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// =====================================================================
// CONSTANTES DE NEGÓCIO
// =====================================================================
const NOTA_MINIMA = 60;
const MAX_TENTATIVAS_ATIVIDADE = 3;
const MAX_TENTATIVAS_MURAL = 5;
const CONCLUSAO_ENVIADA = new Map();
const INTERVALO_CONCLUSAO_MS = 24 * 60 * 60 * 1000;

app.get('/', (req, res) => res.send('Backend do Tutor Nova EJA está rodando!'));

// =====================================================================
// FUNÇÕES AUXILIARES (MANTIDAS)
// =====================================================================
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

// =====================================================================
// FUNÇÕES AUXILIARES NOVAS
// =====================================================================

/**
 * Resolve o aluno_id recebido. Se for um matricula_id, converte para aluno_id.
 * Se já for um aluno_id válido, retorna ele mesmo.
 */
async function resolverAlunoId(idRecebido) {
  if (!idRecebido) return null;
  
  // 1. Tenta como aluno_id
  const { data: aluno } = await supabase.from('alunos').select('id').eq('id', idRecebido).maybeSingle();
  if (aluno) return aluno.id;

  // 2. Se não for aluno_id, tenta como matricula_id
  const { data: matricula } = await supabase.from('matriculas_estudos').select('aluno_id').eq('id', idRecebido).maybeSingle();
  if (matricula) return matricula.aluno_id;

  return null;
}

async function gerarEmbeddingRAG(texto) {
  for (let i = 0; i < geminiKeys.length; i++) {
    try {
      const genAI = new GoogleGenerativeAI(geminiKeys[i]);
      const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
      const result = await model.embedContent(texto);
      return result.embedding.values;
    } catch (error) { console.log(`⚠️ Embedding chave ${i+1} falhou.`); }
  }
  throw new Error('Nenhuma chave Gemini funcionou para embedding');
}

async function buscarChunksRelevantes({ competencia, segmento, textoConsulta, limite = 5 }) {
  if (!competencia || !segmento) return [];
  const { data: habilidades, error: errHab } = await supabase
    .from('catalogo_habilidades')
    .select('habilidade_codigo')
    .eq('competencia', competencia)
    .eq('segmento', segmento);

  if (errHab || !habilidades || habilidades.length === 0) return [];

  let embeddingConsulta;
  try { embeddingConsulta = await gerarEmbeddingRAG(textoConsulta); }
  catch (err) { return []; }

  const todos = [];
  for (const h of habilidades) {
    try {
      const { data: chunks, error } = await supabase.rpc('match_chunks', {
        query_embedding: embeddingConsulta,
        filter_habilidade: h.habilidade_codigo,
        filter_segmento: segmento,
        match_count: limite,
      });
      if (!error && chunks) todos.push(...chunks);
    } catch (e) { /* ignora falha individual */ }
  }

  const vistos = new Set();
  const unicos = [];
  for (const c of todos) {
    const chave = c.id != null ? String(c.id) : JSON.stringify(c).slice(0, 80);
    if (!vistos.has(chave)) { vistos.add(chave); unicos.push(c); }
  }
  unicos.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));

  return unicos.slice(0, limite).map(c => ({
    id: c.id, habilidade_codigo: c.habilidade_codigo, area: c.area, conteudo: c.conteudo, score: c.similarity,
  }));
}

function formatarChunksParaPrompt(chunks) {
  if (!chunks || chunks.length === 0) return '(Nenhum conteúdo do livro encontrado para esta consulta.)';
  return chunks.map((c, i) => `--- Trecho ${i + 1} (habilidade ${c.habilidade_codigo}, área ${c.area}) ---\n${c.conteudo}`).join('\n\n');
}

async function chamarIAComJSON(prompt) {
  for (let i = 0; i < geminiKeys.length; i++) {
    try {
      const genAI = new GoogleGenerativeAI(geminiKeys[i]);
      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
      });
      const result = await model.generateContent([{ text: prompt }]);
      return result.response.text();
    } catch (error) { console.log(`⚠️ IA JSON chave ${i+1} falhou.`); }
  }
  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "openai/gpt-oss-20b",
      response_format: { type: "json_object" },
      temperature: 0.4,
    });
    return completion.choices[0]?.message?.content;
  } catch (error) { throw new Error('Nenhum provedor de IA disponível'); }
}

function parseJSONSeguro(raw) {
  try { return JSON.parse(raw); }
  catch {
    const match = String(raw || '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('IA não retornou JSON válido');
    return JSON.parse(match[0]);
  }
}

async function avaliarAtividadeIA({ atividade, resposta, competencia, segmento }) {
  if (atividade.tipo === 'objetiva') {
    const acertou = String(resposta).trim().toLowerCase() === String(atividade.gabarito || '').trim().toLowerCase();
    const nota = acertou ? 100 : 0;
    return {
      nota, status_sugerido: nota >= NOTA_MINIMA ? 'FINALIZADA' : 'REFAZER',
      feedback: acertou ? 'Resposta correta! Muito bem.' : 'Resposta incorreta. Revise o conteúdo do livro e tente novamente.',
      pontos_fortes: acertou ? ['Alternativa correta'] : [],
      pontos_a_melhorar: acertou ? [] : ['Reveja o conteúdo da habilidade trabalhada'],
      corrigido_por: 'gabarito',
    };
  }

  const chunks = await buscarChunksRelevantes({ competencia, segmento, textoConsulta: `${atividade.enunciado}\n\n${resposta}`, limite: 5 });
  const contexto = formatarChunksParaPrompt(chunks);

  const prompt = `
Você é o Tutor IA da Nova EJA (SESI). Avalie a resposta do aluno com base
na Matriz SESI e no conteúdo dos livros (contexto RAG abaixo).
REGRAS:
- Nota de 0 a 100.
- Nota mínima para aprovação: ${NOTA_MINIMA}.
- Abaixo → status_sugerido = "REFAZER".
- Acima → status_sugerido = "FINALIZADA".
SEGMENTO: ${segmento}
COMPETÊNCIA: ${competencia}
ENUNCIADO: ${atividade.enunciado}
RUBRICA: ${atividade.rubrica_ia || 'Avalie clareza, fundamentação e uso do conteúdo.'}
CONTEXTO RAG: ${contexto}
RESPOSTA DO ALUNO: """${resposta}"""
Responda APENAS com JSON válido: {"nota": <0-100>, "feedback": "<texto>", "pontos_fortes": [], "pontos_a_melhorar": []}`;

  const raw = await chamarIAComJSON(prompt);
  const parsed = parseJSONSeguro(raw);
  return { ...parsed, status_sugerido: parsed.nota >= NOTA_MINIMA ? 'FINALIZADA' : 'REFAZER', corrigido_por: 'ia' };
}

async function mediarMuralIA({ mural, textoAluno, competencia, segmento }) {
  const chunks = await buscarChunksRelevantes({ competencia, segmento, textoConsulta: `${mural.texto_base}\n\n${textoAluno}`, limite: 5 });
  const contexto = formatarChunksParaPrompt(chunks);
  const prompt = `
Você é o Tutor IA. O aluno está CONSTRUINDO um posicionamento para o mural "${mural.titulo}". NÃO dê nota.
Seu papel é MEDIAR: instigar, provocar, sugerir caminhos.
COMPETÊNCIA: ${competencia}
TEXTO-BASE: ${mural.texto_base}
CONTEXTO RAG: ${contexto}
TEXTO ATUAL: """${textoAluno}"""
Responda APENAS com JSON: {"feedback": "<comentário>", "perguntas": ["p1", "p2"], "pronto_para_avaliar": <bool>}`;
  const raw = await chamarIAComJSON(prompt);
  return parseJSONSeguro(raw);
}

async function avaliarMuralIA({ mural, textoAluno, competencia, segmento }) {
  const chunks = await buscarChunksRelevantes({ competencia, segmento, textoConsulta: `${mural.texto_base}\n\n${textoAluno}`, limite: 5 });
  const contexto = formatarChunksParaPrompt(chunks);
  const prompt = `
Você é o Tutor IA. Avalie o posicionamento do aluno no mural "${mural.titulo}". Não há resposta "certa".
REGRAS:
- Nota de 0 a 100.
- Nota mínima: ${NOTA_MINIMA}.
COMPETÊNCIA: ${competencia}
TEXTO-BASE: ${mural.texto_base}
CONTEXTO RAG: ${contexto}
POSICIONAMENTO: """${textoAluno}"""
Responda APENAS com JSON: {"nota": <0-100>, "feedback": "<texto>", "pontos_fortes": [], "pontos_a_melhorar": []}`;
  const raw = await chamarIAComJSON(prompt);
  const parsed = parseJSONSeguro(raw);
  return { ...parsed, status_sugerido: parsed.nota >= NOTA_MINIMA ? 'FINALIZADA' : 'REFAZER', corrigido_por: 'ia' };
}

async function verificarConclusao(aluno_id) {
  try {
    const { data, error } = await supabase.rpc('verificar_aproveitamento', { p_aluno_id: aluno_id });
    if (error || !data || data.length === 0) return { apto: false };
    const apto = data.every(c => c.apto_certificacao);
    if (!apto) return { apto: false };

    const ultimo = CONCLUSAO_ENVIADA.get(aluno_id);
    if (ultimo && Date.now() - ultimo < INTERVALO_CONCLUSAO_MS) return { apto: true, notificado: false };

    const { data: matricula } = await supabase.from('matriculas_estudos').select('id').eq('aluno_id', aluno_id).eq('status', 'ativa').maybeSingle();
    if (!matricula) return { apto: true, notificado: false, erro: 'sem matrícula ativa' };

    await supabase.from('alertas_coordenacao').insert({
      matricula_id: matricula.id,
      tipo: 'apto_certificacao',
      mensagem_original: 'Aluno atingiu a nota mínima em todas as competências. Apto à certificação.',
      status: 'pendente',
    });

    const { data: coords } = await supabase.from('coordenadores').select('email').eq('papel', 'coordenador').limit(5);
    const { data: aluno } = await supabase.from('alunos').select('nome_completo').eq('id', aluno_id).single();

    if (coords && coords.length > 0 && process.env.GMAIL_USER) {
      const emails = coords.map(c => c.email).filter(Boolean);
      if (emails.length > 0) {
        try {
          await transporter.sendMail({
            from: `"Tutor IA Nova EJA" <${process.env.GMAIL_USER}>`,
            to: emails.join(','),
            subject: `✅ Aluno apto à certificação: ${aluno?.nome_completo || aluno_id}`,
            html: `<p>O aluno <strong>${aluno?.nome_completo}</strong> está <strong>apto à certificação</strong>.</p>`,
          });
        } catch (mailErr) { console.error('[conclusao] e-mail falhou:', mailErr.message); }
      }
    }

    CONCLUSAO_ENVIADA.set(aluno_id, Date.now());
    return { apto: true, notificado: true };
  } catch (err) { return { apto: false, erro: err.message }; }
}

// =====================================================================
// ROTAS EXISTENTES (COM AJUSTES)
// =====================================================================

// LOGIN ALUNO — AGORA RETORNA aluno_id
app.post('/api/login', async (req, res) => {
  const { cpf } = req.body;
  try {
    const { data: aluno } = await supabase.from('alunos').select('id, nome_completo').eq('cpf', cpf).single();
    if (!aluno) return res.status(404).json({ erro: "CPF não encontrado." });
    const { data: matricula } = await supabase.from('matriculas_estudos').select('id, segmento, turma').eq('aluno_id', aluno.id).eq('status', 'ativa').single();
    if (!matricula) return res.status(404).json({ erro: "Nenhuma matrícula ativa." });
    
    // Retorno com aluno_id incluído
    return res.json({ aluno: { 
      aluno_id: aluno.id,
      nome: aluno.nome_completo, 
      matricula_id: matricula.id, 
      segmento: matricula.segmento, 
      turma: matricula.turma 
    } });
  } catch (e) { return res.status(500).json({ erro: "Erro interno." }); }
});

// LOGIN COORDENADOR
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) return res.status(401).json({ erro: "E-mail ou senha inválidos." });
    return res.json({ mensagem: "Login realizado com sucesso", token: authData.session.access_token, nome: "Coordenador" });
  } catch (error) { return res.status(500).json({ erro: "Erro interno no login." }); }
});

function verificarToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: "Acesso negado. Faça login." });
  next();
}

// CHAT
app.post('/api/chat', async (req, res) => {
  const { mensagemAluno, matricula_id, historico = [] } = req.body;
  try {
    await supabase.from('matriculas_estudos').update({ ultimo_acesso: new Date() }).eq('id', matricula_id);
    const { data: matricula } = await supabase.from('matriculas_estudos').select('segmento').eq('id', matricula_id).single();
    const segmentoAluno = matricula ? matricula.segmento : 'fundamental';

    const { data: habsDesenvolver } = await supabase.from('habilidades_a_desenvolver').select('*').eq('matricula_id', matricula_id).neq('status', 'concluida');
    const { data: habsDispensadas } = await supabase.from('habilidades_dispensadas').select('habilidade_codigo').eq('matricula_id', matricula_id);
    const { data: obrigatorias } = await supabase.from('questoes_obrigatorias').select('enunciado').eq('ativo', true).eq('segmento', segmentoAluno);
    const listaObrigatorias = obrigatorias?.map(q => q.enunciado).join('\n') || "Nenhuma";

    let habilidadeFoco = null;
    const matchHab = mensagemAluno.match(/(C\d+H\d+)/i);
    if (matchHab) habilidadeFoco = matchHab[0].toUpperCase();

    if (habilidadeFoco) {
      const isDispensada = habsDispensadas && habsDispensadas.some(h => h.habilidade_codigo === habilidadeFoco);
      if (isDispensada) {
        const pendentesSugestao = habsDesenvolver && habsDesenvolver.length > 0 ? habsDesenvolver.slice(0, 2).map(h => h.habilidade_codigo).join(' e ') : 'as pendentes';
        const respostaBloqueio = `Que ótima notícia! Você já tem a habilidade ${habilidadeFoco} reconhecida. Vamos focar no que falta? Suas próximas pendências são: ${pendentesSugestao}.`;
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
    let chunksUsados = [];
    if (textoBusca) {
      const modelEmbed = new GoogleGenerativeAI(geminiKeys[0]).getGenerativeModel({ model: "gemini-embedding-001" });
      const resultEmb = await modelEmbed.embedContent(textoBusca);
      const { data: chunks } = await supabase.rpc('match_chunks', { query_embedding: resultEmb.embedding.values, filter_habilidade: habilidadeFoco, filter_segmento: segmentoAluno, match_count: 1 });
      if (chunks && chunks.length > 0) {
        contextoLivro = chunks.map(c => c.conteudo).join("\n---\n");
        chunksUsados = chunks.map(c => c.id);
      }
    }

    let avisoConclusao = "";
    const palavrasDeAcerto = /(sim|entendi|acertei|já sei|compreendi|isso mesmo|correto|ok)/i;
    if (palavrasDeAcerto.test(mensagemAluno) && habilidadeFoco) {
      await supabase.from('habilidades_a_desenvolver').update({ status: 'concluida' }).eq('matricula_id', matricula_id).eq('habilidade_codigo', habilidadeFoco);
      avisoConclusao = `SISTEMA: O aluno concluiu a habilidade ${habilidadeFoco}. Parabenize-o.`;
    }

    const systemPrompt = `Você é o TUTOR NOVA EJA. Habilidade em foco: ${habilidadeFoco || 'Geral'}. ${avisoConclusao} DIRETRIZES: Microlearning (3 parágrafos). Termine com UMA pergunta. BLOQUEIO: ${listaObrigatorias}. APOIO: "${contextoLivro}"`;

    const respostaBruta = await gerarRespostaIA(systemPrompt, historico, mensagemAluno);
    const { textoLimpo, registros } = extrairTagsQualitativas(respostaBruta, matricula_id);

    if (registros.length > 0) await supabase.from('registros_qualitativos').insert(registros);
    await supabase.from('mensagens_chat').insert([
      { texto: mensagemAluno, remetente: 'aluno', matricula_id },
      { texto: textoLimpo, remetente: 'ia', matricula_id, chunks_referenciados: chunksUsados },
    ]);

    return res.json({ resposta: textoLimpo });
  } catch (error) { return res.status(500).json({ erro: "Erro no chat." }); }
});

// PROGRESSO
app.get('/api/aluno/:matricula_id/progresso', async (req, res) => {
  const { matricula_id } = req.params;
  try {
    const { data: habilidades, error } = await supabase.from('habilidades_a_desenvolver').select('habilidade_codigo, area, status, descricao, competencia').eq('matricula_id', matricula_id);
    if (error) throw error;
    const areas = ['matematica', 'linguagens', 'ciencias_natureza', 'ciencias_humanas'];
    const progresso = areas.map(area => {
      const habsArea = habilidades.filter(h => h.area === area);
      const total = habsArea.length;
      const concluidas = habsArea.filter(h => h.status === 'concluida').length;
      return { area, total, concluidas, percentual: total > 0 ? Math.round((concluidas / total) * 100) : 0, habilidades: habsArea };
    });
    return res.json(progresso);
  } catch (error) { return res.status(500).json({ erro: "Erro." }); }
});

// CATÁLOGO
app.get('/api/admin/catalogo/:segmento', verificarToken, async (req, res) => {
  const { segmento } = req.params;
  try {
    const { data: catalogo, error } = await supabase.from('catalogo_habilidades').select('habilidade_codigo, area, descricao').eq('segmento', segmento).order('area', { ascending: true }).order('habilidade_codigo', { ascending: true });
    if (error) throw error;
    return res.json(catalogo);
  } catch (error) { return res.status(500).json({ erro: "Erro ao buscar catálogo." }); }
});

// CADASTRAR ALUNO
app.post('/api/admin/cadastrar-aluno', verificarToken, async (req, res) => {
  const { nome_completo, cpf, email, telefone_whatsapp, segmento, turma, habilidades_dispensadas } = req.body;
  if (!nome_completo || !cpf || !segmento || !turma) return res.status(400).json({ erro: "Campos obrigatórios faltando." });
  try {
    const { data: aluno, error: errAluno } = await supabase.from('alunos').insert({ nome_completo, cpf, email, telefone_whatsapp }).select().single();
    if (errAluno) {
      if (errAluno.code === '23505') return res.status(400).json({ erro: "CPF já cadastrado." });
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
    return res.json({ mensagem: "Aluno cadastrado!", aluno_id: aluno.id, matricula_id: matricula.id });
  } catch (error) { return res.status(500).json({ erro: "Erro ao cadastrar aluno." }); }
});

// BUSCAR ALUNO
app.get('/api/admin/aluno/:matricula_id', verificarToken, async (req, res) => {
  const { matricula_id } = req.params;
  try {
    const { data: matricula } = await supabase.from('matriculas_estudos').select(`id, segmento, turma, alunos ( nome_completo, cpf, email, telefone_whatsapp )`).eq('id', matricula_id).single();
    const { data: dispensadas } = await supabase.from('habilidades_dispensadas').select('habilidade_codigo, area').eq('matricula_id', matricula_id);
    return res.json({ matricula, dispensadas });
  } catch (error) { return res.status(500).json({ erro: "Erro ao buscar aluno." }); }
});

// EDITAR ALUNO
app.put('/api/admin/editar-aluno/:matricula_id', verificarToken, async (req, res) => {
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
    return res.json({ mensagem: "Aluno atualizado!" });
  } catch (error) { return res.status(500).json({ erro: "Erro ao atualizar aluno." }); }
});

// FINALIZAR E GERAR RELATÓRIO
app.post('/api/finalizar-curso/:matricula_id', async (req, res) => {
  const { matricula_id } = req.params;
  try {
    const aluno_id = await resolverAlunoId(matricula_id);
    if (!aluno_id) return res.status(404).json({ erro: "Aluno não encontrado." });

    const { data: competencias, error: errCalc } = await supabase.rpc('verificar_aproveitamento', { p_aluno_id: aluno_id });
    if (errCalc) throw new Error(errCalc.message);
    
    const todasAprovadas = competencias.every(c => c.aprovado_competencia === true || c.status === 'Aprovado');
    if (!todasAprovadas) return res.status(400).json({ mensagem: "Ainda faltam competências.", detalhes: competencias });

    const { data: registros } = await supabase.from('registros_qualitativos').select('*').eq('matricula_id', matricula_id);
    const promptRelatorio = `Gere a síntese qualitativa do portfólio. Status: Aprovado. Registros: ${JSON.stringify(registros || [])}. Use Andragogia e Bloom.`;
    const sintese = await gerarRespostaIA(promptRelatorio, [], "Gerar Relatório");

    await supabase.from('relatorios_oficiais').insert({ matricula_id, status_geral: 'Aprovado', detalhes_competencias: competencias, sintese_qualitativa: sintese });
    await supabase.from('matriculas_estudos').update({ status: 'concluida' }).eq('id', matricula_id);
    return res.json({ mensagem: "Curso concluído!", relatorio: sintese });
  } catch (error) { return res.status(500).json({ erro: "Erro ao finalizar curso.", detalhes: error.message }); }
});

// LISTAR ALUNOS
app.get('/api/admin/alunos', verificarToken, async (req, res) => {
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

// ALERTAS
app.get('/api/admin/alertas', verificarToken, async (req, res) => {
  try {
    const { data: alertas, error } = await supabase.from('alertas_coordenacao').select(`id, tipo, mensagem_original, status, criado_em, matriculas_estudos (id, alunos (nome_completo, telefone_whatsapp, email))`).eq('status', 'pendente');
    if (error) throw error;
    return res.json(alertas);
  } catch (error) { return res.status(500).json({ erro: "Erro." }); }
});

app.post('/api/admin/alertas/:id/enviar', verificarToken, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: alerta, error: errAlerta } = await supabase.from('alertas_coordenacao').select(`id, mensagem_original, matriculas_estudos (alunos (nome_completo, email))`).eq('id', id).single();
    if (errAlerta || !alerta) throw new Error("Alerta não encontrado.");
    const aluno = alerta.matriculas_estudos.alunos;
    const mensagem = alerta.mensagem_original;
    if (aluno.email && process.env.GMAIL_USER) {
      try {
        await transporter.sendMail({ from: `"Tutor Nova EJA" <${process.env.GMAIL_USER}>`, to: aluno.email, subject: 'Senti sua falta!', html: `<p>${mensagem}</p>` });
      } catch (e) { console.error(e); }
    }
    await supabase.from('alertas_coordenacao').update({ status: 'resolvido' }).eq('id', id);
    return res.json({ mensagem: "Processado." });
  } catch (error) { return res.status(500).json({ erro: "Erro." }); }
});

// =====================================================================
// ROTAS NOVAS — ATIVIDADES (com resolverAlunoId)
// =====================================================================

app.get('/api/atividades', async (req, res) => {
  const { competencia, aluno_id } = req.query;
  if (!competencia || !aluno_id) return res.status(400).json({ erro: 'competencia e aluno_id são obrigatórios' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    if (!alunoIdReal) return res.status(404).json({ erro: 'Aluno não encontrado' });

    const { data: atividades, error } = await supabase.from('atividades').select('id, competencia, area, tipo, enunciado, alternativas, pontuacao_max').eq('competencia', competencia).eq('ativa', true).order('created_at');
    if (error) throw error;
    if (!atividades || atividades.length === 0) return res.json({ atividades: [] });

    const ids = atividades.map(a => a.id);
    const { data: respostas } = await supabase.from('respostas_atividades').select('atividade_id, status, nota, tentativas, feedback').eq('aluno_id', alunoIdReal).in('atividade_id', ids);

    const mapa = Object.fromEntries((respostas || []).map(r => [r.atividade_id, r]));
    return res.json({
      atividades: atividades.map(a => ({
        ...a,
        status: mapa[a.id]?.status || 'INICIAR',
        nota: mapa[a.id]?.nota ?? null,
        tentativas: mapa[a.id]?.tentativas || 0,
        feedback: mapa[a.id]?.feedback || null,
      })),
    });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao listar atividades', detalhe: err.message }); }
});

app.post('/api/atividades/:id/iniciar', async (req, res) => {
  const { aluno_id } = req.body;
  if (!aluno_id) return res.status(400).json({ erro: 'aluno_id é obrigatório' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    if (!alunoIdReal) return res.status(404).json({ erro: 'Aluno não encontrado' });

    const { data, error } = await supabase.from('respostas_atividades').upsert(
      { atividade_id: req.params.id, aluno_id: alunoIdReal, status: 'EM_ANDAMENTO' },
      { onConflict: 'atividade_id,aluno_id', ignoreDuplicates: false }
    ).select().single();
    if (error) throw error;
    return res.json({ resposta: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao iniciar atividade' }); }
});

app.patch('/api/atividades/:id/rascunho', async (req, res) => {
  const { aluno_id, rascunho } = req.body;
  if (!aluno_id) return res.status(400).json({ erro: 'aluno_id é obrigatório' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data, error } = await supabase.from('respostas_atividades').update({ rascunho }).eq('atividade_id', req.params.id).eq('aluno_id', alunoIdReal).select().single();
    if (error) throw error;
    return res.json({ resposta: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao salvar rascunho' }); }
});

app.post('/api/atividades/:id/responder', async (req, res) => {
  const { aluno_id, resposta, segmento, matricula_id } = req.body;
  if (!aluno_id || !resposta || !resposta.trim()) return res.status(400).json({ erro: 'aluno_id e resposta são obrigatórios' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    if (!alunoIdReal) return res.status(404).json({ erro: 'Aluno não encontrado' });

    const { data: atividade, error: errAtiv } = await supabase.from('atividades').select('*').eq('id', req.params.id).single();
    if (errAtiv || !atividade) return res.status(404).json({ erro: 'Atividade não encontrada' });

    const { data: atual } = await supabase.from('respostas_atividades').select('tentativas, status').eq('atividade_id', req.params.id).eq('aluno_id', alunoIdReal).maybeSingle();
    if (atual?.status === 'FINALIZADA') return res.status(400).json({ erro: 'Atividade já finalizada.' });

    const tentativas = (atual?.tentativas || 0) + 1;
    if (tentativas > MAX_TENTATIVAS_ATIVIDADE) {
      if (matricula_id) {
        await supabase.from('alertas_coordenacao').insert({
          matricula_id, tipo: 'atividade_refazer_limite',
          mensagem_original: `Aluno excedeu ${MAX_TENTATIVAS_ATIVIDADE} tentativas na atividade ${req.params.id}.`,
          status: 'pendente',
        });
      }
      return res.status(429).json({ erro: 'Limite de tentativas excedido. Coordenação foi notificada.' });
    }

    const resultado = await avaliarAtividadeIA({ atividade, resposta: resposta.trim(), competencia: atividade.competencia, segmento: segmento || 'medio' });

    const { data, error } = await supabase.from('respostas_atividades').upsert({
      atividade_id: req.params.id, aluno_id: alunoIdReal, resposta: resposta.trim(), rascunho: null,
      nota: resultado.nota, feedback: resultado.feedback, status: resultado.status_sugerido, tentativas,
      corrigido_por: resultado.corrigido_por, corrigido_em: new Date().toISOString(), submetido_em: new Date().toISOString(),
    }, { onConflict: 'atividade_id,aluno_id', ignoreDuplicates: false }).select().single();
    if (error) throw error;

    if (data.status === 'FINALIZADA') {
      try { await verificarConclusao(alunoIdReal); } catch (e) { console.warn(e.message); }
    }

    return res.json({ resposta: data, resultado_ia: { pontos_fortes: resultado.pontos_fortes || [], pontos_a_melhorar: resultado.pontos_a_melhorar || [] } });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao avaliar resposta' }); }
});

app.post('/api/atividades', verificarToken, async (req, res) => {
  const { competencia, area, tipo, enunciado, alternativas, gabarito, rubrica_ia } = req.body;
  if (!competencia || !area || !tipo || !enunciado) return res.status(400).json({ erro: 'Campos obrigatórios faltando' });
  if (tipo === 'objetiva' && (!alternativas || !gabarito)) return res.status(400).json({ erro: 'Objetiva exige alternativas e gabarito' });
  try {
    const { data, error } = await supabase.from('atividades').insert({
      competencia, area, tipo, enunciado, alternativas: alternativas || null, gabarito: gabarito || null, rubrica_ia: rubrica_ia || null,
    }).select().single();
    if (error) throw error;
    return res.status(201).json({ atividade: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao criar atividade' }); }
});

// =====================================================================
// ROTAS NOVAS — MURAIS (com resolverAlunoId)
// =====================================================================

app.get('/api/murais', async (req, res) => {
  const { area, aluno_id } = req.query;
  if (!aluno_id) return res.status(400).json({ erro: 'aluno_id é obrigatório' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    if (!alunoIdReal) return res.status(404).json({ erro: 'Aluno não encontrado' });

    let q = supabase.from('murais').select('id, titulo, texto_base, area, competencia').eq('ativo', true);
    if (area) q = q.eq('area', area);
    const { data: murais, error } = await q.order('created_at');
    if (error) throw error;
    if (!murais || murais.length === 0) return res.json({ murais: [] });

    const ids = murais.map(m => m.id);
    const { data: postagens } = await supabase.from('postagens_murais').select('mural_id, status, nota_ia, tentativas, feedback_ia').eq('aluno_id', alunoIdReal).in('mural_id', ids);

    const mapa = Object.fromEntries((postagens || []).map(p => [p.mural_id, p]));
    return res.json({
      murais: murais.map(m => ({
        ...m,
        status: mapa[m.id]?.status || 'INICIAR',
        nota_ia: mapa[m.id]?.nota_ia ?? null,
        tentativas: mapa[m.id]?.tentativas || 0,
        feedback_ia: mapa[m.id]?.feedback_ia || null,
      })),
    });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao listar murais' }); }
});

app.post('/api/murais/:id/iniciar', async (req, res) => {
  const { aluno_id } = req.body;
  if (!aluno_id) return res.status(400).json({ erro: 'aluno_id é obrigatório' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data, error } = await supabase.from('postagens_murais').upsert(
      { mural_id: req.params.id, aluno_id: alunoIdReal, status: 'EM_ANDAMENTO' },
      { onConflict: 'mural_id,aluno_id', ignoreDuplicates: false }
    ).select().single();
    if (error) throw error;
    return res.json({ postagem: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao iniciar mural' }); }
});

app.patch('/api/murais/:id/rascunho', async (req, res) => {
  const { aluno_id, rascunho } = req.body;
  if (!aluno_id) return res.status(400).json({ erro: 'aluno_id é obrigatório' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data, error } = await supabase.from('postagens_murais').update({ rascunho }).eq('mural_id', req.params.id).eq('aluno_id', alunoIdReal).select().single();
    if (error) throw error;
    return res.json({ postagem: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao salvar rascunho' }); }
});

app.post('/api/murais/:id/mediar', async (req, res) => {
  const { aluno_id, texto, segmento } = req.body;
  if (!aluno_id || !texto || !texto.trim()) return res.status(400).json({ erro: 'aluno_id e texto são obrigatórios' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data: mural } = await supabase.from('murais').select('*').eq('id', req.params.id).single();
    if (!mural) return res.status(404).json({ erro: 'Mural não encontrado' });

    const resultado = await mediarMuralIA({ mural, textoAluno: texto.trim(), competencia: mural.competencia, segmento: segmento || 'medio' });

    await supabase.from('postagens_murais').upsert(
      { mural_id: mural.id, aluno_id: alunoIdReal, texto: texto.trim(), status: 'EM_ANDAMENTO' },
      { onConflict: 'mural_id,aluno_id', ignoreDuplicates: false }
    );

    return res.json({ mediacao: resultado });
  } catch (err) { return res.status(500).json({ erro: 'Erro na mediação' }); }
});

app.post('/api/murais/:id/avaliar', async (req, res) => {
  const { aluno_id, texto, segmento, matricula_id } = req.body;
  if (!aluno_id || !texto || !texto.trim()) return res.status(400).json({ erro: 'aluno_id e texto são obrigatórios' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data: mural } = await supabase.from('murais').select('*').eq('id', req.params.id).single();
    if (!mural) return res.status(404).json({ erro: 'Mural não encontrado' });

    const { data: atual } = await supabase.from('postagens_murais').select('tentativas, status').eq('mural_id', mural.id).eq('aluno_id', alunoIdReal).maybeSingle();
    if (atual?.status === 'FINALIZADA') return res.status(400).json({ erro: 'Mural já finalizado.' });

    const tentativas = (atual?.tentativas || 0) + 1;
    if (tentativas > MAX_TENTATIVAS_MURAL) {
      if (matricula_id) {
        await supabase.from('alertas_coordenacao').insert({
          matricula_id, tipo: 'mural_refazer_limite',
          mensagem_original: `Aluno excedeu ${MAX_TENTATIVAS_MURAL} tentativas no mural ${mural.id}.`,
          status: 'pendente',
        });
      }
      return res.status(429).json({ erro: 'Limite de tentativas excedido.' });
    }

    const resultado = await avaliarMuralIA({ mural, textoAluno: texto.trim(), competencia: mural.competencia, segmento: segmento || 'medio' });

    const { data, error } = await supabase.from('postagens_murais').upsert({
      mural_id: mural.id, aluno_id: alunoIdReal, texto: texto.trim(), rascunho: null,
      nota_ia: resultado.nota, feedback_ia: resultado.feedback, status: resultado.status_sugerido,
      tentativas, avaliado_em: new Date().toISOString(), submetido_em: new Date().toISOString(),
    }, { onConflict: 'mural_id,aluno_id', ignoreDuplicates: false }).select().single();
    if (error) throw error;

    if (data.status === 'FINALIZADA') {
      try { await verificarConclusao(alunoIdReal); } catch (e) { console.warn(e.message); }
    }

    return res.json({ postagem: data, resultado_ia: { pontos_fortes: resultado.pontos_fortes || [], pontos_a_melhorar: resultado.pontos_a_melhorar || [] } });
  } catch (err) { return res.status(500).json({ erro: 'Erro na avaliação' }); }
});

app.post('/api/murais', verificarToken, async (req, res) => {
  const { titulo, texto_base, area, competencia, rubrica_ia } = req.body;
  if (!titulo || !texto_base || !area) return res.status(400).json({ erro: 'Campos obrigatórios faltando' });
  try {
    const { data, error } = await supabase.from('murais').insert({ titulo, texto_base, area, competencia: competencia || null, rubrica_ia: rubrica_ia || null }).select().single();
    if (error) throw error;
    return res.status(201).json({ mural: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao criar mural' }); }
});

// =====================================================================
// ROTAS NOVAS — OFICINAS
// =====================================================================

app.post('/api/oficinas', verificarToken, async (req, res) => {
  const { aluno_id, area, nota, data_oficina, observacao } = req.body;
  if (!aluno_id || !area || nota == null) return res.status(400).json({ erro: 'aluno_id, area e nota são obrigatórios' });
  if (nota < 0 || nota > 100) return res.status(400).json({ erro: 'Nota deve estar entre 0 e 100' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data, error } = await supabase.from('oficinas_presenciais').upsert({
      aluno_id: alunoIdReal, area, nota, data_oficina: data_oficina || null, observacao: observacao || null, updated_at: new Date().toISOString(),
    }, { onConflict: 'aluno_id,area', ignoreDuplicates: false }).select().single();
    if (error) throw error;
    
    try { await verificarConclusao(alunoIdReal); } catch (e) { console.warn(e.message); }
    return res.json({ oficina: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao lançar oficina' }); }
});

app.get('/api/oficinas/:aluno_id', verificarToken, async (req, res) => {
  try {
    const alunoIdReal = await resolverAlunoId(req.params.aluno_id);
    const { data, error } = await supabase.from('oficinas_presenciais').select('*').eq('aluno_id', alunoIdReal).order('area');
    if (error) throw error;
    return res.json({ oficinas: data || [] });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao buscar oficinas' }); }
});

// =====================================================================
// ROTAS NOVAS — BOLETIM (com resolverAlunoId)
// =====================================================================

app.get('/api/boletim', async (req, res) => {
  const { aluno_id } = req.query;
  if (!aluno_id) return res.status(400).json({ erro: 'aluno_id é obrigatório' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    if (!alunoIdReal) return res.status(404).json({ erro: 'Aluno não encontrado' });

    const { data, error } = await supabase.rpc('verificar_aproveitamento', { p_aluno_id: alunoIdReal });
    if (error) {
      return res.status(500).json({ erro: 'Erro ao executar verificar_aproveitamento', detalhe: error.message, codigo: error.code });
    }

    const apto = (data || []).length > 0 && data.every(c => c.apto_certificacao);
    const porArea = {};
    for (const c of data || []) {
      if (!porArea[c.area]) porArea[c.area] = [];
      porArea[c.area].push(c);
    }
    return res.json({
      competencias: data || [], por_area: porArea, apto_certificacao: apto,
      total_competencias: (data || []).length,
      total_aprovadas: (data || []).filter(c => c.aprovado_competencia).length,
    });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao gerar boletim', detalhe: err.message }); }
});

app.get('/api/boletim/:aluno_id', verificarToken, async (req, res) => {
  const { aluno_id } = req.params;
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    if (!alunoIdReal) return res.status(404).json({ erro: 'Aluno não encontrado' });

    const { data: aluno } = await supabase.from('alunos').select('id, nome_completo').eq('id', alunoIdReal).single();
    const { data: matricula } = await supabase.from('matriculas_estudos').select('segmento, turma').eq('aluno_id', alunoIdReal).eq('status', 'ativa').maybeSingle();
    const { data, error } = await supabase.rpc('verificar_aproveitamento', { p_aluno_id: alunoIdReal });

    if (error) {
      return res.status(500).json({ erro: 'Erro ao executar verificar_aproveitamento', detalhe: error.message, codigo: error.code });
    }

    const apto = (data || []).length > 0 && data.every(c => c.apto_certificacao);
    return res.json({
      aluno: { ...aluno, segmento: matricula?.segmento, turma: matricula?.turma },
      competencias: data || [], apto_certificacao: apto,
      total_competencias: (data || []).length,
      total_aprovadas: (data || []).filter(c => c.aprovado_competencia).length,
    });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao gerar boletim', detalhe: err.message }); }
});

// =====================================================================
// HEALTHCHECK
// =====================================================================
app.get('/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));

// =====================================================================
// START
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend Rodando na porta ${PORT}`));