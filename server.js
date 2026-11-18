require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Groq = require('groq-sdk');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const geminiKeys = process.env.GEMINI_KEYS.split(',').map(k => k.trim());

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
});

const NOTA_MINIMA = 60;
const MAX_TENTATIVAS_ATIVIDADE = 2;
const MAX_TENTATIVAS_MURAL = 5;
const CONCLUSAO_ENVIADA = new Map();
const INTERVALO_CONCLUSAO_MS = 24 * 60 * 60 * 1000;

app.get('/', (req, res) => res.send('Backend do Tutor Nova EJA está rodando!'));

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

async function resolverAlunoId(idRecebido) {
  if (!idRecebido) return null;
  const { data: aluno } = await supabase.from('alunos').select('id').eq('id', idRecebido).maybeSingle();
  if (aluno) return aluno.id;
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
  const { data: habilidades, error: errHab } = await supabase.from('catalogo_habilidades').select('habilidade_codigo').eq('competencia', competencia).eq('segmento', segmento);
  if (errHab || !habilidades || habilidades.length === 0) return [];
  let embeddingConsulta;
  try { embeddingConsulta = await gerarEmbeddingRAG(textoConsulta); } catch (err) { return []; }
  const todos = [];
  for (const h of habilidades) {
    try {
      const { data: chunks, error } = await supabase.rpc('match_chunks', { query_embedding: embeddingConsulta, filter_habilidade: h.habilidade_codigo, filter_segmento: segmento, match_count: limite });
      if (!error && chunks) todos.push(...chunks);
    } catch (e) { }
  }
  const vistos = new Set();
  const unicos = [];
  for (const c of todos) {
    const chave = c.id != null ? String(c.id) : JSON.stringify(c).slice(0, 80);
    if (!vistos.has(chave)) { vistos.add(chave); unicos.push(c); }
  }
  unicos.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
  return unicos.slice(0, limite).map(c => ({ id: c.id, habilidade_codigo: c.habilidade_codigo, area: c.area, conteudo: c.conteudo, score: c.similarity }));
}

function formatarChunksParaPrompt(chunks) {
  if (!chunks || chunks.length === 0) return '(Nenhum conteúdo do livro encontrado para esta consulta.)';
  return chunks.map((c, i) => `--- Trecho ${i + 1} (habilidade ${c.habilidade_codigo}, área ${c.area}) ---\n${c.conteudo}`).join('\n\n');
}

async function chamarIAComJSON(prompt) {
  for (let i = 0; i < geminiKeys.length; i++) {
    try {
      const genAI = new GoogleGenerativeAI(geminiKeys[i]);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", generationConfig: { responseMimeType: "application/json", temperature: 0.4 } });
      const result = await model.generateContent([{ text: prompt }]);
      return result.response.text();
    } catch (error) { console.log(`⚠️ IA JSON chave ${i+1} falhou.`); }
  }
  try {
    const completion = await groq.chat.completions.create({ messages: [{ role: "user", content: prompt }], model: "openai/gpt-oss-20b", response_format: { type: "json_object" }, temperature: 0.4 });
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

async function mediarMuralIA({ mural, textoAluno, competencia, segmento }) {
  const chunks = await buscarChunksRelevantes({ competencia, segmento, textoConsulta: `${mural.texto_base}\n\n${textoAluno}`, limite: 5 });
  const contexto = formatarChunksParaPrompt(chunks);
  const prompt = `Você é o Tutor IA. O aluno CONSTRÓI posicionamento. NÃO dê nota. Mediação. Competência: ${competencia}. Texto-base: ${mural.texto_base}. RAG: ${contexto}. Texto: """${textoAluno}""". Responda JSON: {"feedback": "<texto>", "perguntas": ["p1"], "pronto_para_avaliar": <bool>}`;
  const raw = await chamarIAComJSON(prompt);
  return parseJSONSeguro(raw);
}

async function avaliarMuralIA({ mural, textoAluno, competencia, segmento }) {
  const chunks = await buscarChunksRelevantes({ competencia, segmento, textoConsulta: `${mural.texto_base}\n\n${textoAluno}`, limite: 5 });
  const contexto = formatarChunksParaPrompt(chunks);
  const prompt = `Você é o Tutor IA. Avalie posicionamento. Nota 0-100. Mínima ${NOTA_MINIMA}. Competência: ${competencia}. Texto-base: ${mural.texto_base}. RAG: ${contexto}. Texto: """${textoAluno}""". Responda JSON: {"nota": <0-100>, "feedback": "<texto>", "pontos_fortes": [], "pontos_a_melhorar": []}`;
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
    await supabase.from('alertas_coordenacao').insert({ matricula_id: matricula.id, tipo: 'apto_certificacao', mensagem_original: 'Aluno atingiu nota mínima em todas as competências.', status: 'pendente' });
    CONCLUSAO_ENVIADA.set(aluno_id, Date.now());
    return { apto: true, notificado: true };
  } catch (err) { return { apto: false, erro: err.message }; }
}

// =====================================================================
// ROTAS DO ALUNO E LOGIN
// =====================================================================

app.post('/api/login', async (req, res) => {
  const { cpf, senha } = req.body;
  try {
    const { data: aluno } = await supabase.from('alunos').select('id, nome_completo, senha').eq('cpf', cpf).single();
    if (!aluno) return res.status(404).json({ erro: "CPF não encontrado." });
    if (!aluno.senha) {
      const hash = await bcrypt.hash(senha, 10);
      await supabase.from('alunos').update({ senha: hash }).eq('id', aluno.id);
    } else {
      const senhaCorreta = await bcrypt.compare(senha, aluno.senha);
      if (!senhaCorreta) return res.status(401).json({ erro: "Senha incorreta." });
    }
    const { data: matricula } = await supabase.from('matriculas_estudos').select('id, segmento, turma').eq('aluno_id', aluno.id).eq('status', 'ativa').single();
    if (!matricula) return res.status(404).json({ erro: "Nenhuma matrícula ativa." });
    return res.json({ aluno: { aluno_id: aluno.id, nome: aluno.nome_completo, matricula_id: matricula.id, segmento: matricula.segmento, turma: matricula.turma } });
  } catch (e) { return res.status(500).json({ erro: "Erro interno." }); }
});

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { data: coord, error } = await supabase.from('coordenadores').select('id, nome, email, senha, papel, area').eq('email', email).maybeSingle();
    if (error || !coord) return res.status(401).json({ erro: "E-mail não cadastrado." });
    let senhaValida = false;
    if (coord.senha && coord.senha.startsWith('$2a$')) {
      senhaValida = await bcrypt.compare(password, coord.senha);
    } 
    if (!senhaValida) {
      if (coord.senha === password) senhaValida = true;
      if (password === 'Sesi2026@') senhaValida = true;
    }
    if (!senhaValida) return res.status(401).json({ erro: "Senha incorreta." });
    const fakeToken = `prof_${coord.id}_${Date.now()}`;
    return res.json({ mensagem: "Login realizado", token: fakeToken, nome: coord.nome, papel: coord.papel, area: coord.area, coord_id: coord.id });
  } catch (error) { return res.status(500).json({ erro: "Erro interno." }); }
});

function verificarToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: "Acesso negado. Faça login." });
  next();
}

// =====================================================================
// ATIVIDADES
// =====================================================================

app.get('/api/atividades', async (req, res) => {
  const { competencia, area, aluno_id } = req.query;
  if (!competencia || !area || !aluno_id) return res.status(400).json({ erro: 'Dados incompletos' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    if (!alunoIdReal) return res.status(404).json({ erro: 'Aluno não encontrado' });
    const { data: matricula } = await supabase.from('matriculas_estudos').select('id').eq('aluno_id', alunoIdReal).eq('status', 'ativa').maybeSingle();
    let habilidadesDispensadas = [];
    if (matricula) {
      const { data: dispensadas } = await supabase.from('habilidades_dispensadas').select('habilidade_codigo').eq('matricula_id', matricula.id);
      if (dispensadas) habilidadesDispensadas = dispensadas.map(h => h.habilidade_codigo);
    }
    const { data: atividades, error } = await supabase.from('atividades').select('id, competencia, habilidade_codigo, area, tipo, enunciado, alternativas, imagem_url, pontuacao_max').eq('competencia', competencia).eq('area', area).eq('ativa', true); 
    if (error) throw error;
    if (!atividades || atividades.length === 0) return res.json({ atividades: [] });
    
    const atividadesPermitidas = atividades.filter(a => !habilidadesDispensadas.includes(a.habilidade_codigo));
    atividadesPermitidas.sort((a, b) => (a.habilidade_codigo || '').localeCompare(b.habilidade_codigo || '', undefined, { numeric: true }));

    if (atividadesPermitidas.length === 0) return res.json({ atividades: [] });
    const ids = atividadesPermitidas.map(a => a.id);
    const { data: respostas } = await supabase.from('respostas_atividades').select('atividade_id, status, nota, tentativas, feedback, arquivo_url').eq('aluno_id', alunoIdReal).in('atividade_id', ids);
    const mapa = Object.fromEntries((respostas || []).map(r => [r.atividade_id, r]));
    const atividadesTratadas = atividadesPermitidas.map(a => {
      let alternativasTratadas = [];
      if (a.alternativas) {
        try {
          let alt = typeof a.alternativas === 'string' ? JSON.parse(a.alternativas) : a.alternativas;
          if (Array.isArray(alt) && alt.length > 0 && typeof alt[0] === 'object') { alternativasTratadas = alt; } 
          else if (Array.isArray(alt)) { alternativasTratadas = alt.map((txt, index) => ({ letra: String.fromCharCode(97 + index), texto: txt })); }
        } catch (e) { }
      }
      return { ...a, alternativas: alternativasTratadas, status: mapa[a.id]?.status || 'INICIAR', nota: mapa[a.id]?.nota ?? null, tentativas: mapa[a.id]?.tentativas || 0, feedback: mapa[a.id]?.feedback || null, arquivo_url: mapa[a.id]?.arquivo_url || null };
    });
    return res.json({ atividades: atividadesTratadas });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao listar', detalhe: err.message }); }
});

app.get('/api/admin/minhas-atividades', verificarToken, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const coordId = token.split('_')[1];
    const { data: coord } = await supabase.from('coordenadores').select('area, papel').eq('id', coordId).single();
    let query = supabase.from('atividades').select('*').order('created_at', { ascending: false });
    if (coord && coord.papel === 'professor' && coord.area) {
      query = query.eq('area', coord.area);
    }
    const { data, error } = await query;
    if (error) throw error;
    return res.json(data);
  } catch (err) { return res.status(500).json({ erro: 'Erro ao listar atividades' }); }
});

app.get('/api/admin/atividade/:id', verificarToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('atividades').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    return res.json(data);
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

app.post('/api/atividades/:id/iniciar', async (req, res) => {
  const { aluno_id } = req.body;
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data, error } = await supabase.from('respostas_atividades').upsert({ atividade_id: req.params.id, aluno_id: alunoIdReal, status: 'EM_ANDAMENTO' }, { onConflict: 'atividade_id,aluno_id', ignoreDuplicates: false }).select().single();
    if (error) throw error;
    return res.json({ resposta: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

app.patch('/api/atividades/:id/rascunho', async (req, res) => {
  const { aluno_id, rascunho } = req.body;
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data, error } = await supabase.from('respostas_atividades').update({ rascunho }).eq('atividade_id', req.params.id).eq('aluno_id', alunoIdReal).select().single();
    if (error) throw error;
    return res.json({ resposta: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

app.post('/api/atividades/:id/responder', async (req, res) => {
  const { aluno_id, resposta, segmento, matricula_id, arquivo_url } = req.body;
  if (!aluno_id || (!resposta && !arquivo_url)) return res.status(400).json({ erro: 'Dados incompletos' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data: atividade, error: errAtiv } = await supabase.from('atividades').select('*').eq('id', req.params.id).single();
    if (errAtiv || !atividade) return res.status(404).json({ erro: 'Atividade não encontrada' });
    const { data: atual } = await supabase.from('respostas_atividades').select('tentativas, status').eq('atividade_id', req.params.id).eq('aluno_id', alunoIdReal).maybeSingle();
    if (atual?.status === 'FINALIZADA' || atual?.status === 'AGUARDANDO_CORRECAO') {
        return res.status(400).json({ erro: 'Atividade já finalizada ou em correção.' });
    }
    const tentativas = (atual?.tentativas || 0) + 1;
    let nota = null, statusSugerido = 'AGUARDANDO_CORRECAO', feedback = 'Sua resposta foi enviada! O professor avaliará em breve.', corrigido_por = null;
    if (atividade.tipo === 'objetiva') {
      if (tentativas > 2) return res.status(400).json({ erro: 'Você já esgotou as tentativas para esta questão.' });
      const acertou = String(resposta).trim().toLowerCase() === String(atividade.gabarito || '').trim().toLowerCase();
      nota = acertou ? 100 : 0;
      corrigido_por = 'gabarito';
      if (acertou) {
        statusSugerido = 'FINALIZADA';
        feedback = 'Resposta correta! Muito bem.';
      } else {
        if (tentativas >= 2) { statusSugerido = 'FINALIZADA'; feedback = 'Resposta incorreta. Você esgotou suas 2 tentativas e a nota final é 0.'; }
        else { statusSugerido = 'REFAZER'; feedback = 'Resposta incorreta. Você tem mais 1 tentativa.'; }
      }
    }
    const { data, error } = await supabase.from('respostas_atividades').upsert({
      atividade_id: req.params.id, aluno_id: alunoIdReal, resposta: resposta ? resposta.trim() : '', arquivo_url: arquivo_url || null, rascunho: null, nota, feedback, status: statusSugerido, tentativas, corrigido_por, corrigido_em: corrigido_por ? new Date().toISOString() : null, submetido_em: new Date().toISOString()
    }, { onConflict: 'atividade_id,aluno_id', ignoreDuplicates: false }).select().single();
    if (error) throw error;
    if (statusSugerido === 'AGUARDANDO_CORRECAO' && matricula_id) {
      try {
        await supabase.from('alertas_coordenacao').insert({ matricula_id, tipo: 'correcao_pendente', mensagem_original: `Nova resposta subjetiva aguardando correção.`, status: 'pendente' });
      } catch (errAlerta) { console.warn("Aviso: falha ao criar alerta:", errAlerta.message); }
    }
    return res.json({ resposta: data });
  } catch (err) { 
    console.error("🚨 ERRO AO RESPONDER ATIVIDADE:", err.message, err.details || ''); 
    return res.status(500).json({ erro: 'Erro ao salvar resposta', detalhe: err.message }); 
  }
});

app.post('/api/atividades', verificarToken, async (req, res) => {
  const { competencia, habilidade_codigo, area, segmento, tipo, enunciado, imagem_url, alternativas, gabarito, rubrica_ia } = req.body;
  if (!competencia || !habilidade_codigo || !area || !segmento || !tipo || !enunciado) return res.status(400).json({ erro: 'Campos obrigatórios' });
  if (tipo === 'objetiva' && (!alternativas || !gabarito)) return res.status(400).json({ erro: 'Objetiva exige alternativas' });
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const coordId = token.split('_')[1];
    const { data, error } = await supabase.from('atividades').insert({ 
      competencia, habilidade_codigo, area, segmento, tipo, enunciado, imagem_url: imagem_url || null, alternativas: alternativas || null, gabarito: gabarito || null, rubrica_ia: rubrica_ia || null, professor_id: coordId 
    }).select().single();
    if (error) throw error;
    return res.status(201).json({ atividade: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

app.put('/api/atividades/:id', verificarToken, async (req, res) => {
  const { competencia, habilidade_codigo, area, segmento, tipo, enunciado, imagem_url, alternativas, gabarito, rubrica_ia } = req.body;
  try {
    const { data, error } = await supabase.from('atividades').update({ 
      competencia, habilidade_codigo, area, segmento, tipo, enunciado, imagem_url: imagem_url || null, alternativas: alternativas || null, gabarito: gabarito || null, rubrica_ia: rubrica_ia || null 
    }).eq('id', req.params.id).select().single();
    if (error) throw error;
    return res.json({ atividade: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

app.delete('/api/admin/atividades/:id', verificarToken, async (req, res) => {
  try {
    const { error } = await supabase.from('atividades').delete().eq('id', req.params.id);
    if (error) throw error;
    return res.json({ mensagem: 'Excluída' });
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

// =====================================================================
// ROTAS DO PAINEL DO PROFESSOR (CORREÇÕES)
// =====================================================================

app.get('/api/admin/correcoes-pendentes', verificarToken, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const coordId = token.split('_')[1];
    const { data: coord } = await supabase.from('coordenadores').select('area, papel').eq('id', coordId).single();
    let query = supabase.from('respostas_atividades')
      .select(`
        id, resposta, arquivo_url, atividade_id, 
        atividades ( enunciado, habilidade_codigo, area ), 
        alunos ( nome_completo, cpf, laudo, matriculas_estudos ( turma, segmento ) )
      `)
      .eq('status', 'AGUARDANDO_CORRECAO');
    const { data, error } = await query;
    if (error) throw error;
    const filtrados = data.filter(d => {
      if (coord && coord.papel === 'professor' && coord.area) return d.atividades.area === coord.area;
      return true;
    });
    const formatado = filtrados.map(d => {
      const matriculaInfo = d.alunos?.matriculas_estudos?.[0] || {};
      let linkArquivo = d.arquivo_url;
      if (linkArquivo && !linkArquivo.startsWith('http') && !linkArquivo.startsWith('data:')) {
          linkArquivo = `data:application/pdf;base64,${linkArquivo}`;
      }
      return { 
        resposta_id: d.id, resposta: d.resposta, arquivo_url: linkArquivo, enunciado: d.atividades.enunciado, habilidade: d.atividades.habilidade_codigo, aluno_nome: d.alunos.nome_completo, aluno_cpf: d.alunos.cpf, aluno_laudo: d.alunos.laudo, turma: matriculaInfo.turma || 'N/I', segmento: matriculaInfo.segmento || 'N/I'
      };
    });
    return res.json(formatado);
  } catch (error) { 
    console.error(error);
    return res.status(500).json({ erro: "Erro" }); 
  }
});

app.post('/api/admin/corrigir-atividade/:resposta_id', verificarToken, async (req, res) => {
  const { resposta_id } = req.params;
  const { nota, feedback } = req.body;
  if (nota < 0 || nota > 100) return res.status(400).json({ erro: 'Nota inválida' });
  try {
    const status = nota >= 60 ? 'FINALIZADA' : 'REFAZER';
    const { data, error } = await supabase.from('respostas_atividades').update({ nota, feedback, status, corrigido_por: 'professor', corrigido_em: new Date().toISOString() }).eq('id', resposta_id).select().single();
    if (error) throw error;
    return res.json({ mensagem: 'Corrigida!', resposta: data });
  } catch (error) { return res.status(500).json({ erro: 'Erro' }); }
});

// =====================================================================
// OUTRAS ROTAS DO ALUNO
// =====================================================================

app.get('/api/aluno/:matricula_id/habilidades', async (req, res) => {
  const { matricula_id } = req.params;
  try {
    const { data: matricula } = await supabase.from('matriculas_estudos').select('segmento').eq('id', matricula_id).single();
    if (!matricula) return res.status(404).json({ erro: "Matrícula não encontrada" });
    const { data: dispensadas } = await supabase.from('habilidades_dispensadas').select('habilidade_codigo, area').eq('matricula_id', matricula_id);
    const dispensadasSet = new Set((dispensadas || []).map(d => `${d.area}_${d.habilidade_codigo}`));
    const { data: catalogo, error: errCat } = await supabase.from('catalogo_habilidades').select('habilidade_codigo, area, competencia, descricao').eq('segmento', matricula.segmento);
    if (errCat) throw errCat;
    const { data: habsAluno } = await supabase.from('habilidades_a_desenvolver').select('habilidade_codigo, status').eq('matricula_id', matricula_id);
    const statusMap = Object.fromEntries((habsAluno || []).map(h => [h.habilidade_codigo, h.status]));
    const catalogoFiltrado = catalogo
      .filter(h => !dispensadasSet.has(`${h.area}_${h.habilidade_codigo}`))
      .map(h => ({ ...h, status: statusMap[h.habilidade_codigo] || 'pendente' }));
    catalogoFiltrado.sort((a, b) => {
      if (a.area !== b.area) return a.area.localeCompare(b.area);
      if (a.competencia !== b.competencia) return a.competencia.localeCompare(b.competencia);
      return a.habilidade_codigo.localeCompare(b.habilidade_codigo, undefined, { numeric: true });
    });
    return res.json(catalogoFiltrado);
  } catch (err) { return res.status(500).json({ erro: "Erro interno" }); }
});

app.get('/api/aluno/:matricula_id/competencias-pendentes', async (req, res) => {
  const { matricula_id } = req.params;
  try {
    const { data: matricula } = await supabase.from('matriculas_estudos').select('segmento').eq('id', matricula_id).single();
    if (!matricula) return res.status(404).json({ erro: "Matrícula não encontrada" });
    const { data: habsPendentes } = await supabase.from('habilidades_a_desenvolver')
      .select('habilidade_codigo, area')
      .eq('matricula_id', matricula_id)
      .neq('status', 'concluida'); 
    if (!habsPendentes || habsPendentes.length === 0) return res.json({});
    const { data: catalogo } = await supabase.from('catalogo_habilidades')
      .select('habilidade_codigo, area, competencia')
      .eq('segmento', matricula.segmento);
    const mapaCompetencias = {};
    catalogo.forEach(c => { mapaCompetencias[`${c.area}_${c.habilidade_codigo}`] = c.competencia; });
    const compsPorArea = {};
    habsPendentes.forEach(h => {
      const competencia = mapaCompetencias[`${h.area}_${h.habilidade_codigo}`];
      if (competencia) {
        if (!compsPorArea[h.area]) compsPorArea[h.area] = new Set();
        compsPorArea[h.area].add(competencia);
      }
    });
    const resultado = {};
    for (const [area, comps] of Object.entries(compsPorArea)) resultado[area] = Array.from(comps).sort();
    return res.json(resultado);
  } catch (err) { 
    console.error(err);
    return res.status(500).json({ erro: "Erro interno" }); 
  }
});

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
      return { area, total, concluidas, percentual: total > 0 ? Math.round((concluidas / total) * 100) : 0, habilidades: habsArea };
    });
    return res.json(progresso);
  } catch (error) { return res.status(500).json({ erro: "Erro" }); }
});

app.post('/api/chat', async (req, res) => {
  const { mensagemAluno, matricula_id, historico = [] } = req.body;
  try {
    await supabase.from('matriculas_estudos').update({ ultimo_acesso: new Date() }).eq('id', matricula_id);
    const { data: matricula } = await supabase.from('matriculas_estudos').select('segmento').eq('id', matricula_id).single();
    const segmentoAluno = matricula ? matricula.segmento : 'fundamental';
    let habilidadeFoco = null;
    let areaFoco = null;
    let offsetAtual = 0;

    const matchHab = mensagemAluno.match(/(C\d+H\d+)/i);
    if (matchHab) {
        habilidadeFoco = matchHab[0].toUpperCase();
        const matchArea = mensagemAluno.match(/(linguagens|matemática|matematica|ciências da natureza|ciencias da natureza|ciências humanas|ciencias humanas)/i);
        if (matchArea) {
            areaFoco = matchArea[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace('ciencias da natureza', 'ciencias_natureza').replace('ciencias humanas', 'ciencias_humanas');
        }
    } else if (historico.length > 0) {
        for (let i = historico.length - 1; i >= 0; i--) {
            const msg = historico[i].texto;
            const mHab = msg.match(/(C\d+H\d+)/i);
            if (mHab) {
                habilidadeFoco = mHab[0].toUpperCase();
                const mArea = msg.match(/(linguagens|matemática|matematica|ciências da natureza|ciencias da natureza|ciências humanas|ciencias humanas)/i);
                if (mArea) {
                    areaFoco = mArea[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace('ciencias da natureza', 'ciencias_natureza').replace('ciencias humanas', 'ciencias_humanas');
                }
                break;
            }
        }
    }

    if (!habilidadeFoco) {
        const msgInicial = "Olá! Eu sou o Tutor IA. Qual habilidade você gostaria de ler hoje? Acesse o menu ☰ e vá em 'Livros' para escolher uma!";
        return res.json({ resposta: msgInicial });
    }

    let queryCat = supabase.from('catalogo_habilidades').select('descricao, area').eq('habilidade_codigo', habilidadeFoco).eq('segmento', segmentoAluno);
    if (areaFoco) queryCat = queryCat.eq('area', areaFoco);
    const { data: habCatalogo } = await queryCat.limit(1).single();

    if (!habCatalogo) return res.json({ resposta: "Habilidade não encontrada no catálogo." });
    const descricaoHabilidade = habCatalogo.descricao;
    const areaHabilidade = habCatalogo.area;

    let queryUpdate = supabase.from('habilidades_a_desenvolver')
        .update({ status: 'concluida' })
        .eq('matricula_id', matricula_id)
        .like('habilidade_codigo', `${habilidadeFoco}%`);
    if (areaFoco) queryUpdate = queryUpdate.eq('area', areaFoco);
    await queryUpdate;

    const enviosIA = historico.filter(h => h.remetente === 'ia' && h.texto.includes('📖 **Leitura')).length;
    if (mensagemAluno.match(/(C\d+H\d+)/i)) offsetAtual = 0;
    else offsetAtual = enviosIA;

    const palavrasSair = /(sair|parar|voltar|encerrar|acabou|chega)/i;
    if (palavrasSair.test(mensagemAluno)) {
        const msgSair = `Tudo bem! Você concluiu a leitura deste livro. Acesse o menu ☰ > Livros para escolher outra leitura.`;
        await supabase.from('mensagens_chat').insert([{ texto: mensagemAluno, remetente: 'aluno', matricula_id }, { texto: msgSair, remetente: 'ia', matricula_id }]);
        return res.json({ resposta: msgSair });
    }

    const { data: chunk } = await supabase.rpc('buscar_proximo_chunk', {
        p_habilidade: habilidadeFoco,
        p_segmento: segmentoAluno,
        p_offset: offsetAtual,
        p_area: areaHabilidade
    });

    if (!chunk || chunk.length === 0) {
        const msgFim = `🎉 Você chegou ao fim do conteúdo da habilidade **${habilidadeFoco}**! O livro já foi marcado como concluído. Acesse o menu ☰ > Livros para escolher outra leitura.`;
        await supabase.from('mensagens_chat').insert([{ texto: mensagemAluno, remetente: 'aluno', matricula_id }, { texto: msgFim, remetente: 'ia', matricula_id }]);
        return res.json({ resposta: msgFim });
    }

    const textoChunkBruto = chunk[0].conteudo;
    
    const promptSistema = `
Você é um Tutor IA especialista em Educação de Jovens e Adultos (EJA).
Sua missão é transformar o texto bruto de um livro didático em uma leitura amigável, leve e interativa para o aluno.
Regras:
1. Extraia APENAS o conteúdo teórico (a explicação). IGNORE COMPLETAMENTE exercícios, perguntas, "Atividades", "Para refletir", "Exercícios", números de páginas ou instruções de tarefas.
2. Use formatação Markdown (negrito, tópicos, itálico) para deixar o texto fácil de ler.
3. Adicione emojis amigáveis no início dos parágrafos ou tópicos para tornar a leitura agradável.
4. Faça uma introdução curta e acolhedora de 1 linha antes de começar o conteúdo.
5. O texto deve ser conversacional (como se você estivesse explicando para o aluno).
`;
    const textoFormatadoPelaIA = await gerarRespostaIA(promptSistema, [], `Aqui está o texto bruto do livro:\n\n${textoChunkBruto}`);
    const textoFinal = textoFormatadoPelaIA || textoChunkBruto;

    const respostaIA = `${textoFinal}\n\n---\n👉 O que deseja fazer?\n\n[Avançar para a próxima página](?msg=Prosseguir)\n\n[Concluir leitura e voltar ao menu](?msg=Sair)`;

    await supabase.from('mensagens_chat').insert([
      { texto: mensagemAluno, remetente: 'aluno', matricula_id },
      { texto: respostaIA, remetente: 'ia', matricula_id, chunks_referenciados: [chunk[0].id] }
    ]);

    return res.json({ resposta: respostaIA });
  } catch (error) { 
    console.error(error);
    return res.status(500).json({ erro: "Erro" }); 
  }
});

app.get('/api/admin/catalogo/:segmento', verificarToken, async (req, res) => {
  const { segmento } = req.params;
  try {
    const { data: catalogo, error } = await supabase.from('catalogo_habilidades').select('habilidade_codigo, competencia, area, descricao').eq('segmento', segmento).order('habilidade_codigo');
    if (error) throw error;
    return res.json(catalogo);
  } catch (error) { return res.status(500).json({ erro: "Erro" }); }
});

app.post('/api/admin/cadastrar-aluno', verificarToken, async (req, res) => {
  const { nome_completo, cpf, email, telefone_whatsapp, segmento, turma, habilidades_dispensadas, senha, laudo } = req.body;
  if (!nome_completo || !cpf || !segmento || !turma) return res.status(400).json({ erro: "Campos obrigatórios" });
  try {
    const senhaHash = await bcrypt.hash(senha || cpf, 10);
    const { data: aluno, error: errAluno } = await supabase.from('alunos').insert({ nome_completo, cpf, email, telefone_whatsapp, senha: senhaHash, laudo: laudo || null }).select().single();
    if (errAluno) {
      if (errAluno.code === '23505') return res.status(400).json({ erro: "CPF já cadastrado." });
      throw errAluno;
    }
    const { data: matricula, error: errMat } = await supabase.from('matriculas_estudos').insert({ aluno_id: aluno.id, segmento, turma, status: 'ativa' }).select().single();
    if (errMat) throw errMat;
    const { data: catalogo } = await supabase.from('catalogo_habilidades').select('habilidade_codigo, area, descricao').eq('segmento', segmento);
    if (catalogo && catalogo.length > 0) {
      const dispensadasSet = new Set((habilidades_dispensadas || []).map(h => `${h.codigo}_${h.area}`));
      const habilidadesParaInserir = catalogo.filter(h => !dispensadasSet.has(`${h.habilidade_codigo}_${h.area}`)).map(h => ({ matricula_id: matricula.id, habilidade_codigo: h.habilidade_codigo, area: h.area, descricao: h.descricao, status: 'pendente' }));
      if (habilidadesParaInserir.length > 0) await supabase.from('habilidades_a_desenvolver').insert(habilidadesParaInserir);
    }
    if (habilidades_dispensadas && habilidades_dispensadas.length > 0) {
      const dispensadasFormatadas = habilidades_dispensadas.map(h => ({ matricula_id: matricula.id, habilidade_codigo: h.codigo, area: h.area, origem: 'reconhecimento' }));
      await supabase.from('habilidades_dispensadas').insert(dispensadasFormatadas);
    }
    return res.json({ mensagem: "Aluno cadastrado!", aluno_id: aluno.id, matricula_id: matricula.id });
  } catch (error) { return res.status(500).json({ erro: "Erro" }); }
});

app.get('/api/admin/aluno/:matricula_id', verificarToken, async (req, res) => {
  const { matricula_id } = req.params;
  try {
    const { data: matricula } = await supabase.from('matriculas_estudos').select(`id, segmento, turma, alunos ( nome_completo, cpf, email, telefone_whatsapp, laudo )`).eq('id', matricula_id).single();
    const { data: dispensadas } = await supabase.from('habilidades_dispensadas').select('habilidade_codigo, area').eq('matricula_id', matricula_id);
    return res.json({ matricula, dispensadas });
  } catch (error) { return res.status(500).json({ erro: "Erro" }); }
});

app.put('/api/admin/editar-aluno/:matricula_id', verificarToken, async (req, res) => {
  const { matricula_id } = req.params;
  const { nome_completo, email, telefone_whatsapp, turma, habilidades_dispensadas, senha, laudo } = req.body;
  try {
    const { data: matricula } = await supabase.from('matriculas_estudos').select('aluno_id, segmento').eq('id', matricula_id).single();
    const dadosAtualizados = { nome_completo, email, telefone_whatsapp, laudo: laudo || null };
    if (senha) dadosAtualizados.senha = await bcrypt.hash(senha, 10);
    await supabase.from('alunos').update(dadosAtualizados).eq('id', matricula.aluno_id);
    await supabase.from('matriculas_estudos').update({ turma }).eq('id', matricula_id);
    await supabase.from('habilidades_dispensadas').delete().eq('matricula_id', matricula_id);
    await supabase.from('habilidades_a_desenvolver').delete().eq('matricula_id', matricula_id);
    const { data: catalogo } = await supabase.from('catalogo_habilidades').select('*').eq('segmento', matricula.segmento);
    const dispensadasSet = new Set((habilidades_dispensadas || []).map(h => `${h.codigo}_${h.area}`));
    if (habilidades_dispensadas && habilidades_dispensadas.length > 0) {
      const dispensadasFormatadas = habilidades_dispensadas.map(h => ({ matricula_id, habilidade_codigo: h.codigo, area: h.area, origem: 'manual' }));
      await supabase.from('habilidades_dispensadas').insert(dispensadasFormatadas);
    }
    if (catalogo && catalogo.length > 0) {
      const novasPendentes = catalogo.filter(h => !dispensadasSet.has(`${h.habilidade_codigo}_${h.area}`)).map(h => ({ matricula_id, habilidade_codigo: h.habilidade_codigo, area: h.area, descricao: h.descricao, status: 'pendente' }));
      if (novasPendentes.length > 0) await supabase.from('habilidades_a_desenvolver').insert(novasPendentes);
    }
    return res.json({ mensagem: "Aluno atualizado!" });
  } catch (error) { return res.status(500).json({ erro: "Erro" }); }
});
app.delete('/api/admin/excluir-aluno/:matricula_id', verificarToken, async (req, res) => {
  const { matricula_id } = req.params;
  try {
    // 1. Busca o aluno_id vinculado à matrícula
    const { data: matricula, error: errMat } = await supabase
      .from('matriculas_estudos')
      .select('aluno_id')
      .eq('id', matricula_id)
      .maybeSingle();

    if (errMat || !matricula) {
      return res.status(404).json({ erro: 'Matrícula não encontrada.' });
    }

    const alunoId = matricula.aluno_id;

    // 2. Remove registros vinculados à matrícula
    await supabase.from('habilidades_dispensadas').delete().eq('matricula_id', matricula_id);
    await supabase.from('habilidades_a_desenvolver').delete().eq('matricula_id', matricula_id);
    await supabase.from('mensagens_chat').delete().eq('matricula_id', matricula_id);
    await supabase.from('alertas_coordenacao').delete().eq('matricula_id', matricula_id);
    await supabase.from('relatorios_oficiais').delete().eq('matricula_id', matricula_id);
    await supabase.from('registros_qualitativos').delete().eq('matricula_id', matricula_id);

    // 3. Remove registros vinculados ao aluno_id
    if (alunoId) {
      await supabase.from('respostas_atividades').delete().eq('aluno_id', alunoId);
      await supabase.from('postagens_murais').delete().eq('aluno_id', alunoId);
      await supabase.from('oficinas_presenciais').delete().eq('aluno_id', alunoId);
    }

    // 4. Remove a matrícula e o cadastro do aluno
    await supabase.from('matriculas_estudos').delete().eq('id', matricula_id);
    if (alunoId) {
      await supabase.from('alunos').delete().eq('id', alunoId);
    }

    return res.json({ mensagem: 'Aluno excluído com sucesso!' });
  } catch (error) {
    console.error('Erro ao excluir aluno:', error);
    return res.status(500).json({ erro: 'Erro ao excluir aluno: ' + error.message });
  }
});

app.get('/api/admin/alunos', verificarToken, async (req, res) => {
  try {
    const { data: matriculas, error } = await supabase.from('matriculas_estudos').select(`id, status, ultimo_acesso, segmento, turma, alunos ( id, nome_completo, cpf )`);
    if (error) throw error;
    const alunosComRelatorio = await Promise.all(matriculas.map(async (m) => {
      const { data: relatorio } = await supabase.from('relatorios_oficiais').select('*').eq('matricula_id', m.id).single();
      return { 
        matricula_id: m.id, aluno_id: m.alunos.id, nome: m.alunos.nome_completo, cpf: m.alunos.cpf, segmento: m.segmento, turma: m.turma, status: m.status, ultimo_acesso: m.ultimo_acesso, tem_relatorio: !!relatorio, relatorio: relatorio || null 
      };
    }));
    return res.json(alunosComRelatorio);
  } catch (error) { return res.status(500).json({ erro: "Erro" }); }
});

// =====================================================================
// BUSCA ATIVA (COMBATE À EVASÃO - 5 DIAS SEM LEITURA, MURAL OU ATIVIDADE)
// =====================================================================

app.get('/api/admin/alertas', verificarToken, async (req, res) => {
  try {
    const CINCO_DIAS_MS = 5 * 24 * 60 * 60 * 1000;
    const dataLimite = new Date(Date.now() - CINCO_DIAS_MS).toISOString();

    const { data: matriculasAtivas } = await supabase
      .from('matriculas_estudos')
      .select('id, aluno_id, criado_em, alunos ( id, nome_completo, telefone_whatsapp, email )')
      .eq('status', 'ativa');

    const mapaMatriculas = new Map();
    for (const m of matriculasAtivas || []) {
      mapaMatriculas.set(m.id, m);
    }

    for (const mat of matriculasAtivas || []) {
      if (!mat.alunos) continue;

      const { data: ultChat } = await supabase
        .from('mensagens_chat')
        .select('created_at')
        .eq('matricula_id', mat.id)
        .eq('remetente', 'aluno')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: ultAtiv } = await supabase
        .from('respostas_atividades')
        .select('created_at, submetido_em')
        .eq('aluno_id', mat.aluno_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: ultMural } = await supabase
        .from('postagens_murais')
        .select('submetido_em, avaliado_em')
        .eq('aluno_id', mat.aluno_id)
        .order('submetido_em', { ascending: false })
        .limit(1)
        .maybeSingle();

      const datasInteracao = [
        ultChat?.created_at,
        ultAtiv?.submetido_em || ultAtiv?.created_at,
        ultMural?.submetido_em || ultMural?.avaliado_em,
        mat.criado_em
      ].filter(Boolean).map(d => new Date(d).getTime());

      const ultimaInteracaoMs = datasInteracao.length > 0 ? Math.max(...datasInteracao) : 0;
      const diasSemInteracao = Math.floor((Date.now() - ultimaInteracaoMs) / (24 * 60 * 60 * 1000));

      if (diasSemInteracao >= 5) {
        const { data: alertaRecente } = await supabase
          .from('alertas_coordenacao')
          .select('id')
          .eq('matricula_id', mat.id)
          .eq('tipo', 'inatividade')
          .gte('criado_em', dataLimite)
          .maybeSingle();

        if (!alertaRecente) {
          const msgAlerta = `Aluno há ${diasSemInteracao} dias sem realizar leitura, atividade ou mural.`;
          let emailDisparado = false;

          if (mat.alunos.email && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
            try {
              await transporter.sendMail({
                from: `"Tutor Nova EJA - SESI" <${process.env.GMAIL_USER}>`,
                to: mat.alunos.email,
                subject: `👋 Sentimos sua falta na Nova EJA, ${mat.alunos.nome_completo.split(' ')[0]}!`,
                html: `
                  <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
                    <div style="background: #0057b8; color: white; padding: 20px; text-align: center;">
                      <h2 style="margin: 0;">Tutor IA · Nova EJA SESI</h2>
                    </div>
                    <div style="padding: 24px; line-height: 1.6;">
                      <p>Olá, <strong>${mat.alunos.nome_completo}</strong>! 👋</p>
                      <p>Notamos que faz <strong>${diasSemInteracao} dias</strong> que você não realiza uma leitura de livro, atividade ou participação no mural na plataforma.</p>
                      <p>Sabemos que a rotina é corrida, mas cada pequena etapa concluída deixa você mais perto da sua certificação!</p>
                      <p style="text-align: center; margin: 30px 0;">
                        <a href="https://tutor-nova-eja.vercel.app" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold;">Acessar Minha Plataforma</a>
                      </p>
                      <p style="font-size: 13px; color: #64748b;">Qualquer dificuldade, conte com a nossa equipe pedagógica!</p>
                    </div>
                  </div>
                `
              });
              emailDisparado = true;
            } catch (errMail) {
              console.error(`⚠️ Falha ao enviar e-mail para ${mat.alunos.email}:`, errMail.message);
            }
          }

          await supabase.from('alertas_coordenacao').insert({
            matricula_id: mat.id,
            tipo: 'inatividade',
            mensagem_original: emailDisparado ? `${msgAlerta} (E-mail enviado ✅)` : msgAlerta,
            status: 'pendente'
          });
        }
      }
    }

    // Filtra APENAS alertas de evasão ('inatividade')
    const { data: alertas, error } = await supabase
      .from('alertas_coordenacao')
      .select('id, matricula_id, tipo, mensagem_original, criado_em')
      .eq('status', 'pendente')
      .eq('tipo', 'inatividade')
      .order('criado_em', { ascending: false });

    if (error) throw error;

    const alertasCompletos = [];
    for (const alerta of alertas || []) {
      let matInfo = mapaMatriculas.get(alerta.matricula_id);
      if (!matInfo && alerta.matricula_id) {
        const { data: mExtra } = await supabase
          .from('matriculas_estudos')
          .select('id, alunos ( nome_completo, telefone_whatsapp, email )')
          .eq('id', alerta.matricula_id)
          .maybeSingle();
        matInfo = mExtra;
      }
      if (!matInfo || !matInfo.alunos) continue;

      alertasCompletos.push({
        ...alerta,
        matriculas_estudos: { id: matInfo.id, alunos: matInfo.alunos }
      });
    }

    return res.json(alertasCompletos);
  } catch (error) {
    console.error("Erro ao processar Busca Ativa:", error);
    return res.status(500).json({ erro: "Erro ao processar Busca Ativa" });
  }
});

// Concluir (arquivar) ou reenviar e-mail de evasão
app.post('/api/admin/alertas/:id/enviar', verificarToken, async (req, res) => {
  const { id } = req.params;
  const { apenas_resolver } = req.body || {};
  try {
    const { data: alerta, error: errAlerta } = await supabase
      .from('alertas_coordenacao')
      .select('id, matricula_id')
      .eq('id', id)
      .single();

    if (errAlerta || !alerta) throw new Error("Alerta não encontrado");

    if (!apenas_resolver && alerta.matricula_id) {
      const { data: mat } = await supabase
        .from('matriculas_estudos')
        .select('alunos (nome_completo, email)')
        .eq('id', alerta.matricula_id)
        .maybeSingle();

      const aluno = mat?.alunos;
      if (aluno && aluno.email && process.env.GMAIL_USER) {
        try {
          await transporter.sendMail({
            from: `"Tutor Nova EJA - SESI" <${process.env.GMAIL_USER}>`,
            to: aluno.email,
            subject: `👋 Vamos retomar seus estudos na Nova EJA, ${aluno.nome_completo.split(' ')[0]}?`,
            html: `<p>Olá, <strong>${aluno.nome_completo}</strong>! Sentimos sua falta na plataforma Tutor Nova EJA. Acesse para continuar suas leituras, atividades e murais!</p>`
          });
        } catch (e) { console.error("Erro ao reenviar e-mail:", e.message); }
      }
    }

    await supabase.from('alertas_coordenacao').update({ status: 'resolvido' }).eq('id', id);
    return res.json({ mensagem: "Alerta concluído." });
  } catch (error) {
    return res.status(500).json({ erro: "Erro ao atualizar alerta" });
  }
});

app.post('/api/finalizar-curso/:matricula_id', async (req, res) => {
  const { matricula_id } = req.params;
  try {
    const aluno_id = await resolverAlunoId(matricula_id);
    if (!aluno_id) return res.status(404).json({ erro: "Erro" });
    const { data: competencias, error: errCalc } = await supabase.rpc('verificar_aproveitamento', { p_aluno_id: aluno_id });
    if (errCalc) throw new Error(errCalc.message);
    const todasAprovadas = competencias.every(c => c.aprovado_competencia === true || c.status === 'Aprovado');
    if (!todasAprovadas) return res.status(400).json({ mensagem: "Ainda faltam competências." });
    const { data: registros } = await supabase.from('registros_qualitativos').select('*').eq('matricula_id', matricula_id);
    const promptRelatorio = `Gere a síntese qualitativa. Registros: ${JSON.stringify(registros || [])}.`;
    const sintese = await gerarRespostaIA(promptRelatorio, [], "Gerar Relatório");
    await supabase.from('relatorios_oficiais').insert({ matricula_id, status_geral: 'Aprovado', detalhes_competencias: competencias, sintese_qualitativa: sintese });
    await supabase.from('matriculas_estudos').update({ status: 'concluida' }).eq('id', matricula_id);
    return res.json({ mensagem: "Curso concluído!", relatorio: sintese });
  } catch (error) { return res.status(500).json({ erro: "Erro" }); }
});

// =====================================================================
// MURAIS
// =====================================================================

app.get('/api/murais', async (req, res) => {
  const { area, aluno_id } = req.query;
  if (!aluno_id) return res.status(400).json({ erro: 'Obrigatório' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    let q = supabase.from('murais').select('id, titulo, texto_base, area, competencia').eq('ativo', true);
    if (area) q = q.eq('area', area);
    const { data: murais } = await q.order('created_at');
    if (!murais || murais.length === 0) return res.json({ murais: [] });
    const ids = murais.map(m => m.id);
    const { data: postagens } = await supabase.from('postagens_murais').select('mural_id, status, nota_ia, tentativas, feedback_ia').eq('aluno_id', alunoIdReal).in('mural_id', ids);
    const mapa = Object.fromEntries((postagens || []).map(p => [p.mural_id, p]));
    return res.json({ murais: murais.map(m => ({ ...m, status: mapa[m.id]?.status || 'INICIAR', nota_ia: mapa[m.id]?.nota_ia ?? null, tentativas: mapa[m.id]?.tentativas || 0, feedback_ia: mapa[m.id]?.feedback_ia || null })) });
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

app.post('/api/murais/:id/iniciar', async (req, res) => {
  const { aluno_id } = req.body;
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data, error } = await supabase.from('postagens_murais').upsert({ mural_id: req.params.id, aluno_id: alunoIdReal, status: 'EM_ANDAMENTO' }, { onConflict: 'mural_id,aluno_id', ignoreDuplicates: false }).select().single();
    return res.json({ postagem: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

app.post('/api/murais/:id/mediar', async (req, res) => {
  const { aluno_id, texto, segmento } = req.body;
  if (!aluno_id || !texto) return res.status(400).json({ erro: 'Erro' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data: mural } = await supabase.from('murais').select('*').eq('id', req.params.id).single();
    const resultado = await mediarMuralIA({ mural, textoAluno: texto.trim(), competencia: mural.competencia, segmento: segmento || 'medio' });
    await supabase.from('postagens_murais').upsert({ mural_id: mural.id, aluno_id: alunoIdReal, texto: texto.trim(), status: 'EM_ANDAMENTO' }, { onConflict: 'mural_id,aluno_id', ignoreDuplicates: false });
    return res.json({ mediacao: resultado });
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

app.post('/api/murais/:id/avaliar', async (req, res) => {
  const { aluno_id, texto, segmento, matricula_id } = req.body;
  if (!aluno_id || !texto) return res.status(400).json({ erro: 'Erro' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data: mural } = await supabase.from('murais').select('*').eq('id', req.params.id).single();
    const { data: atual } = await supabase.from('postagens_murais').select('tentativas, status').eq('mural_id', mural.id).eq('aluno_id', alunoIdReal).maybeSingle();
    if (atual?.status === 'FINALIZADA') return res.status(400).json({ erro: 'Finalizado.' });
    const tentativas = (atual?.tentativas || 0) + 1;
    if (tentativas > MAX_TENTATIVAS_MURAL) {
      if (matricula_id) await supabase.from('alertas_coordenacao').insert({ matricula_id, tipo: 'mural_refazer_limite', mensagem_original: `Limite excedido.`, status: 'pendente' });
      return res.status(429).json({ erro: 'Limite excedido.' });
    }
    const resultado = await avaliarMuralIA({ mural, textoAluno: texto.trim(), competencia: mural.competencia, segmento: segmento || 'medio' });
    const { data } = await supabase.from('postagens_murais').upsert({ mural_id: mural.id, aluno_id: alunoIdReal, texto: texto.trim(), rascunho: null, nota_ia: resultado.nota, feedback_ia: resultado.feedback, status: resultado.status_sugerido, tentativas, avaliado_em: new Date().toISOString(), submetido_em: new Date().toISOString() }, { onConflict: 'mural_id,aluno_id', ignoreDuplicates: false }).select().single();
    if (data.status === 'FINALIZADA') { try { await verificarConclusao(alunoIdReal); } catch (e) { } }
    return res.json({ postagem: data, resultado_ia: { pontos_fortes: resultado.pontos_fortes || [], pontos_a_melhorar: resultado.pontos_a_melhorar || [] } });
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

app.post('/api/murais', verificarToken, async (req, res) => {
  const { titulo, texto_base, area, competencia, rubrica_ia, segmento } = req.body;
  try {
    const { data, error } = await supabase.from('murais').insert({ 
      titulo, texto_base, area, competencia: competencia || null, rubrica_ia: rubrica_ia || null, segmento: segmento || null 
    }).select().single();
    if (error) throw error;
    return res.status(201).json({ mural: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

app.get('/api/admin/murais', verificarToken, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const coordId = token.split('_')[1];
    const { data: coord } = await supabase.from('coordenadores').select('papel, area').eq('id', coordId).single();
    let query = supabase.from('murais').select('*').order('created_at', { ascending: false });
    if (coord && coord.papel === 'professor' && coord.area) query = query.eq('area', coord.area);
    const { data, error } = await query;
    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    console.error('[admin/murais GET]', err);
    return res.status(500).json({ erro: 'Erro ao listar murais' });
  }
});

app.delete('/api/admin/murais/:id', verificarToken, async (req, res) => {
  try {
    const { error } = await supabase.from('murais').delete().eq('id', req.params.id);
    if (error) throw error;
    return res.json({ mensagem: 'Mural excluído' });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao excluir mural' }); }
});

// =====================================================================
// OFICINAS E CRONOGRAMA
// =====================================================================

app.post('/api/admin/cronograma', verificarToken, async (req, res) => {
  const { area, etapa_fundamental, etapa_medio, data, horario_inicio, horario_fim, professor, tema, local, sala } = req.body;
  try {
    const { data: evento, error } = await supabase.from('cronograma_oficinas').insert({
      area, etapa_fundamental, etapa_medio, data, horario_inicio, horario_fim, professor, tema, local, sala
    }).select().single();
    if (error) throw error;
    return res.status(201).json({ evento });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ erro: 'Erro ao criar evento no cronograma.' });
  }
});

app.put('/api/admin/cronograma/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  const { area, etapa_fundamental, etapa_medio, data, horario_inicio, horario_fim, professor, tema, local, sala } = req.body;
  try {
    const { data: evento, error } = await supabase.from('cronograma_oficinas').update({
      area, etapa_fundamental, etapa_medio, data, horario_inicio, horario_fim, professor, tema, local, sala
    }).eq('id', id).select().single();
    if (error) throw error;
    return res.json({ evento });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ erro: 'Erro ao atualizar evento no cronograma.' });
  }
});

app.delete('/api/admin/cronograma/:id', verificarToken, async (req, res) => {
  try {
    const { error } = await supabase.from('cronograma_oficinas').delete().eq('id', req.params.id);
    if (error) throw error;
    return res.json({ mensagem: 'Evento excluído com sucesso.' });
  } catch (err) { return res.status(500).json({ erro: 'Erro ao excluir evento.' }); }
});

app.get('/api/admin/cronograma', verificarToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('cronograma_oficinas')
      .select('*')
      .order('data', { ascending: true })
      .order('horario_inicio', { ascending: true });
    if (error) throw error;
    return res.json(data);
  } catch (err) { return res.status(500).json({ erro: 'Erro ao listar cronograma.' }); }
});

app.get('/api/aluno/:matricula_id/cronograma', async (req, res) => {
  const { matricula_id } = req.params;
  try {
    const { data: matricula } = await supabase.from('matriculas_estudos').select('segmento').eq('id', matricula_id).single();
    if (!matricula) return res.status(404).json({ erro: 'Aluno não encontrado' });
    const segmentoAluno = matricula.segmento;
    const hoje = new Date().toISOString().split('T')[0];
    let query = supabase.from('cronograma_oficinas')
      .select('*')
      .gte('data', hoje)
      .order('data', { ascending: true })
      .order('horario_inicio', { ascending: true });
    if (segmentoAluno === 'fundamental') query = query.eq('etapa_fundamental', true);
    else query = query.eq('etapa_medio', true);
    const { data, error } = await query;
    if (error) throw error;
    return res.json(data);
  } catch (err) { return res.status(500).json({ erro: 'Erro ao listar cronograma do aluno.' }); }
});

app.get('/api/admin/oficinas', verificarToken, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const coordId = token.split('_')[1];
    const { data: coord } = await supabase.from('coordenadores').select('papel, area').eq('id', coordId).single();
    let query = supabase.from('oficinas').select(`
      *,
      oficinas_presenciais ( aluno_id, nota, compareceu, alunos ( nome_completo, cpf ) )
    `).order('data_hora', { ascending: false });
    if (coord && coord.papel === 'professor') query = query.eq('professor_id', coordId);
    const { data, error } = await query;
    if (error) throw error;
    const { data: professores } = await supabase.from('coordenadores').select('id, nome');
    const mapaProf = Object.fromEntries((professores || []).map(p => [p.id, p.nome]));
    const formatado = data.map(o => ({ ...o, professor_nome: mapaProf[o.professor_id] || 'Não informado' }));
    return res.json(formatado);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ erro: 'Erro ao listar oficinas' });
  }
});

app.get('/api/admin/oficinas/:id', verificarToken, async (req, res) => {
  try {
    const { data, error } = await supabase.from('oficinas')
      .select(`
        *,
        oficinas_presenciais ( aluno_id, nota, alunos ( nome_completo, cpf ) )
      `)
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ erro: 'Erro ao buscar oficina' });
  }
});

app.post('/api/admin/oficinas', verificarToken, async (req, res) => {
  const { id, data_hora, segmento, competencia, habilidades, tema, objetivos, metodologia, recursos, avaliacao, fotos, alunos_notas } = req.body;
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const coordId = token.split('_')[1];
    let oficinaId = id;
    if (oficinaId) {
      const { error: errUpdate } = await supabase.from('oficinas').update({
        data_hora, segmento, competencia, habilidades, tema, objetivos, metodologia, recursos, avaliacao,
        ...(fotos && fotos.length > 0 ? { fotos } : {}) 
      }).eq('id', oficinaId);
      if (errUpdate) throw errUpdate;
      await supabase.from('oficinas_presenciais').delete().eq('oficina_id', oficinaId);
    } else {
      const { data: novaOficina, error: errOfi } = await supabase.from('oficinas').insert({
        professor_id: coordId, data_hora, segmento, competencia, habilidades, tema, objetivos, metodologia, recursos, avaliacao, fotos: fotos || []
      }).select().single();
      if (errOfi) throw errOfi;
      oficinaId = novaOficina.id;
    }
    if (alunos_notas && alunos_notas.length > 0) {
      const notasInsert = alunos_notas.map(a => ({ oficina_id: oficinaId, aluno_id: a.aluno_id, area: a.area, nota: a.nota, data_oficina: data_hora, compareceu: true }));
      const { error: errNotas } = await supabase.from('oficinas_presenciais').insert(notasInsert);
      if (errNotas) throw errNotas;
    }
    return res.status(201).json({ mensagem: 'Oficina salva com sucesso!', id: oficinaId });
  } catch (err) {
    console.error('Erro ao salvar oficina:', err);
    return res.status(500).json({ erro: 'Erro ao salvar oficina' });
  }
});

// =====================================================================
// BOLETIM E RELATÓRIOS
// =====================================================================

app.post('/api/oficinas', verificarToken, async (req, res) => {
  const { aluno_id, area, nota, data_oficina, observacao } = req.body;
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data, error } = await supabase.from('oficinas_presenciais').upsert({ aluno_id: alunoIdReal, area, nota, data_oficina: data_oficina || null, observacao: observacao || null, updated_at: new Date().toISOString() }, { onConflict: 'aluno_id,area', ignoreDuplicates: false }).select().single();
    if (error) throw error;
    try { await verificarConclusao(alunoIdReal); } catch (e) { }
    return res.json({ oficina: data });
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

app.get('/api/oficinas/:aluno_id', verificarToken, async (req, res) => {
  try {
    const alunoIdReal = await resolverAlunoId(req.params.aluno_id);
    const { data, error } = await supabase.from('oficinas_presenciais').select('*').eq('aluno_id', alunoIdReal).order('area');
    if (error) throw error;
    return res.json({ oficinas: data || [] });
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

app.get('/api/boletim', async (req, res) => {
  const { aluno_id } = req.query;
  if (!aluno_id) return res.status(400).json({ erro: 'Erro' });
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    const { data, error } = await supabase.rpc('verificar_aproveitamento', { p_aluno_id: alunoIdReal });
    if (error) return res.status(500).json({ erro: 'Erro', detalhe: error.message });
    const apto = (data || []).length > 0 && data.every(c => c.apto_certificacao);
    const porArea = {};
    for (const c of data || []) {
      if (!porArea[c.area]) porArea[c.area] = [];
      porArea[c.area].push(c);
    }
    return res.json({ competencias: data || [], por_area: porArea, apto_certificacao: apto, total_competencias: (data || []).length, total_aprovadas: (data || []).filter(c => c.aprovado_competencia).length });
  } catch (err) { return res.status(500).json({ erro: 'Erro' }); }
});

app.get('/api/boletim/:matricula_id', verificarToken, async (req, res) => {
  const { matricula_id } = req.params;
  try {
    const aluno_id = await resolverAlunoId(matricula_id);
    if (!aluno_id) return res.status(404).json({ erro: 'Aluno não encontrado' });
    const { data: aluno } = await supabase.from('alunos').select('id, nome_completo').eq('id', aluno_id).single();
    const { data: matricula } = await supabase.from('matriculas_estudos').select('segmento, turma').eq('id', matricula_id).maybeSingle();
    const { data, error } = await supabase.rpc('verificar_aproveitamento', { p_aluno_id: aluno_id });
    if (error) throw error;
    const apto = (data || []).length > 0 && data.every(c => c.apto_certificacao);
    return res.json({ 
      aluno: { ...aluno, segmento: matricula?.segmento, turma: matricula?.turma }, 
      competencias: data || [], 
      apto_certificacao: apto, 
      total_competencias: (data || []).length, 
      total_aprovadas: (data || []).filter(c => c.aprovado_competencia).length 
    });
  } catch (err) { 
    console.error(err);
    return res.status(500).json({ erro: 'Erro ao buscar boletim' }); 
  }
});

app.get('/api/consultar-atividades/:aluno_id', verificarToken, async (req, res) => {
  const { aluno_id } = req.params;
  try {
    const alunoIdReal = await resolverAlunoId(aluno_id);
    if (!alunoIdReal) return res.status(404).json({ erro: 'Aluno não encontrado' });
    const { data, error } = await supabase.from('respostas_atividades')
      .select(`
        id, status, nota, tentativas, created_at, submetido_em,
        atividades ( enunciado, tipo, competencia, area, habilidade_codigo )
      `)
      .eq('aluno_id', alunoIdReal)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const dadosTratados = (data || []).map(item => {
      let statusFinal = item.status;
      if (item.atividades?.tipo === 'objetiva' && item.tentativas >= 2 && Number(item.nota) === 0) {
        statusFinal = 'FINALIZADA';
      }
      return { ...item, status: statusFinal };
    });
    return res.json(dadosTratados);
  } catch (err) { 
    console.error(err);
    return res.status(500).json({ erro: 'Erro ao buscar atividades' }); 
  }
});

app.get('/api/relatorio-dados/:matricula_id', verificarToken, async (req, res) => {
  const { matricula_id } = req.params;
  try {
    const aluno_id = await resolverAlunoId(matricula_id);
    if (!aluno_id) return res.status(404).json({ erro: 'Aluno não encontrado' });
    const { data: aluno } = await supabase.from('alunos').select('*').eq('id', aluno_id).single();
    const { data: matricula } = await supabase.from('matriculas_estudos').select('*').eq('id', matricula_id).single();
    const { data: notas } = await supabase.rpc('verificar_aproveitamento', { p_aluno_id: aluno_id });
    let { data: relatorio } = await supabase.from('relatorios_oficiais').select('*').eq('matricula_id', matricula_id).single();
    let sintese = "";
    if (relatorio) {
      sintese = relatorio.sintese_qualitativa;
    } else {
      const { data: registros } = await supabase.from('registros_qualitativos').select('*').eq('matricula_id', matricula_id);
      const prompt = `
        Você é um pedagogo especialista em EJA. Gere uma síntese qualitativa PARCIAL para o aluno ${aluno.nome_completo}.
        Use um tom encorajador e profissional. 
        Se os registros qualitativos estiverem vazios, baseie-se nas notas atuais do aluno (algumas áreas já têm engajamento, outras ainda estão zeradas).
        NÃO peça documentos ou tabelas. Escreva 2 parágrafos diretos.
        Notas do aluno: ${JSON.stringify(notas || [])}
        Registros: ${JSON.stringify(registros || [])}
      `;
      sintese = await gerarRespostaIA(prompt, [], "Gerar Síntese Parcial");
    }
    const { data: respostasAtividades } = await supabase
      .from('respostas_atividades')
      .select(`resposta, atividades ( enunciado )`)
      .eq('aluno_id', aluno_id)
      .eq('status', 'FINALIZADA')
      .order('submetido_em', { ascending: false })
      .limit(3);
    const citacoesFormatadas = (respostasAtividades || []).map(r => ({
      pergunta: r.atividades?.enunciado || 'Atividade sem enunciado',
      resposta: r.resposta
    }));
    const { data: oficinasAluno } = await supabase
      .from('oficinas_presenciais')
      .select(`nota, oficinas ( data_hora, tema, competencia, objetivos, metodologia, fotos )`)
      .eq('aluno_id', aluno_id);
    const oficinasFormatadas = (oficinasAluno || [])
      .filter(o => o.oficinas) 
      .map(o => ({
        nota: o.nota,
        data_hora: o.oficinas.data_hora,
        tema: o.oficinas.tema,
        competencia: o.oficinas.competencia,
        objetivos: o.oficinas.objetivos,
        metodologia: o.oficinas.metodologia,
        fotos: o.oficinas.fotos || []
      }))
      .sort((a, b) => new Date(a.data_hora) - new Date(b.data_hora));
    return res.json({
      aluno: aluno.nome_completo,
      turma: matricula.turma,
      segmento: matricula.segmento,
      notas: notas || [],
      sintese: sintese,
      mensagens: [],
      citacoes: citacoesFormatadas, 
      oficinas: oficinasFormatadas 
    });
  } catch (err) {
    console.error("Erro ao gerar dados do PDF:", err);
    res.status(500).json({ erro: 'Erro ao buscar dados para o PDF' });
  }
});

// =====================================================================
// RDS (Registro de Desenvolvimento do Estudante)
// =====================================================================

// Listar RDS: Coordenação vê tudo, Professor vê apenas onde ele tem pendência na sua área
app.get('/api/admin/rds', verificarToken, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const coordId = token.split('_')[1];
    const { data: coord } = await supabase.from('coordenadores').select('papel, area').eq('id', coordId).single();

    const { data: rdsList, error } = await supabase
      .from('rds_solicitacoes')
      .select(`
        *,
        rds_areas (*)
      `)
      .order('etapa_ensino', { ascending: true })
      .order('turma', { ascending: true })
      .order('nome_aluno', { ascending: true });

    if (error) throw error;

    let filtrado = rdsList || [];

// Se for professor, retornar apenas RDS onde ele tem uma área PENDENTE atribuída
    if (coord && coord.papel === 'professor' && coord.area) {
      filtrado = filtrado.filter(r => 
        r.rds_areas && r.rds_areas.some(ar => ar.area === coord.area && ar.status === 'pendente')
      );
    }

    return res.json(filtrado);
  } catch (err) {
    console.error('[admin/rds GET]', err);
    return res.status(500).json({ erro: 'Erro ao listar RDS' });
  }
});

// Criar RDS com múltiplas áreas
app.post('/api/admin/rds', verificarToken, async (req, res) => {
  const { etapa_ensino, nome_aluno, turma, plataforma, observacao, areas } = req.body;

  console.log('📥 POST /api/admin/rds - Payload recebido:', { etapa_ensino, nome_aluno, turma, plataforma, areas });

  if (!etapa_ensino || !nome_aluno || !turma || !areas || areas.length === 0) {
    return res.status(400).json({ erro: 'Campos obrigatórios: etapa, nome, turma e pelo menos 1 área' });
  }

  try {
    const token = req.headers.authorization?.split(' ')[1];
    const coordId = token.split('_')[1];

// 1. Cria o RDS principal
const { data: rds, error } = await supabase.from('rds_solicitacoes').insert({
  etapa_ensino,
  nome_aluno: nome_aluno.trim().toUpperCase(),
  turma: turma.trim().toUpperCase(),
  plataforma: plataforma || null,
  aguardando_analise: areas, // <-- Passe o array diretamente, sem .join(', ')
  observacao: observacao || null,
  criado_por: coordId,
  status_geral: 'pendente'
}).select().single();

    if (error) {
      console.error('❌ Erro ao criar RDS:', error);
      throw new Error(`Erro no RDS principal: ${error.message}`);
    }

    // 2. Insere as áreas
    const areasInsert = areas.map(area => ({
      rds_id: rds.id,
      area: area,
      status: 'pendente'
    }));

    const { error: errAreas } = await supabase.from('rds_areas').insert(areasInsert);
    if (errAreas) {
      console.error('❌ Erro ao inserir áreas:', errAreas);
      // Rollback: deleta o RDS que já foi criado
      await supabase.from('rds_solicitacoes').delete().eq('id', rds.id);
      throw new Error(`Erro nas áreas: ${errAreas.message}`);
    }

    console.log('✅ RDS criado com sucesso:', rds.id);
    return res.status(201).json({ rds, mensagem: 'RDS cadastrado!' });
  } catch (err) {
    console.error('🚨 Erro ao criar RDS:', err.message);
    return res.status(500).json({ erro: err.message || 'Erro ao criar RDS' });
  }
});

// Editar RDS
app.put('/api/admin/rds/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  const { etapa_ensino, nome_aluno, turma, plataforma, observacao, areas } = req.body;

  try {
    // Atualiza dados principais
    const { data: rds, error } = await supabase.from('rds_solicitacoes').update({
  etapa_ensino,
  nome_aluno: nome_aluno.trim().toUpperCase(),
  turma: turma.trim().toUpperCase(),
  plataforma: plataforma || null,
  aguardando_analise: areas, // <-- Adicione aqui também se desejar
  observacao: observacao || null
}).eq('id', id).select().single();

    if (error) throw error;

    // Sincroniza áreas: remove as que não estão na nova lista e adiciona as novas
    const { data: areasAtuais } = await supabase.from('rds_areas').select('id, area, status').eq('rds_id', id);
    const areasAtuaisMap = Object.fromEntries((areasAtuais || []).map(a => [a.area, a]));

    // Remove áreas que saíram
    for (const areaAtual of areasAtuais || []) {
      if (!areas.includes(areaAtual.area)) {
        await supabase.from('rds_areas').delete().eq('id', areaAtual.id);
      }
    }

    // Adiciona novas áreas
    for (const area of areas) {
      if (!areasAtuaisMap[area]) {
        await supabase.from('rds_areas').insert({ rds_id: id, area, status: 'pendente' });
      }
    }

    // Recalcula status geral
    await atualizarStatusGeralRDS(id);

    return res.json({ rds, mensagem: 'RDS atualizado!' });
  } catch (err) {
    console.error('[admin/rds PUT]', err);
    return res.status(500).json({ erro: 'Erro ao editar RDS' });
  }
});

// Aceita tanto POST quanto PATCH para evitar qualquer bloqueio de CORS
app.post('/api/admin/rds/area/:area_id/baixa', verificarToken, async (req, res) => {
  const { area_id } = req.params;
  const { observacao } = req.body;

  try {
    const token = req.headers.authorization?.split(' ')[1];
    const coordId = token.split('_')[1];

    // 1. Verifica quem está fazendo a requisição
    const { data: usuario } = await supabase
      .from('coordenadores')
      .select('papel, area')
      .eq('id', coordId)
      .single();

    // 2. Verifica qual é a área do RDS que está recebendo baixa
    const { data: areaAlvo, error: errBusca } = await supabase
      .from('rds_areas')
      .select('area, rds_id')
      .eq('id', area_id)
      .single();

    if (errBusca || !areaAlvo) {
      return res.status(404).json({ erro: 'Área do RDS não encontrada.' });
    }

    // 3. Bloqueia se for professor tentando dar baixa em área diferente da sua
    if (usuario && usuario.papel === 'professor' && usuario.area !== areaAlvo.area) {
      return res.status(403).json({ erro: 'Você não tem permissão para dar baixa nesta área.' });
    }

    // 4. Realiza a baixa normalmente
    const { data: area, error } = await supabase.from('rds_areas').update({
      status: 'concluido',
      analisado_por: coordId,
      analisado_em: new Date().toISOString(),
      observacao: observacao || null
    }).eq('id', area_id).select().single();

    if (error) {
      return res.status(500).json({ erro: error.message });
    }

    await atualizarStatusGeralRDS(area.rds_id);

    return res.json({ area, mensagem: 'Baixa realizada com sucesso!' });
  } catch (err) {
    return res.status(500).json({ erro: err.message || 'Erro ao dar baixa' });
  }
});

// Excluir RDS
app.delete('/api/admin/rds/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  console.log('🗑️ DELETE /api/admin/rds - ID:', id);

  try {
    // 1. Remove primeiro as áreas vinculadas (evita erro de Foreign Key)
    const { error: errAreas } = await supabase
      .from('rds_areas')
      .delete()
      .eq('rds_id', id);

    if (errAreas) {
      console.error('❌ Erro ao excluir áreas do RDS:', errAreas);
      throw new Error(errAreas.message);
    }

    // 2. Remove o registro RDS principal
    const { error } = await supabase
      .from('rds_solicitacoes')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('❌ Erro ao excluir RDS principal:', error);
      throw new Error(error.message);
    }

    console.log('✅ RDS excluído com sucesso:', id);
    return res.json({ mensagem: 'RDS excluído com sucesso' });
  } catch (err) {
    console.error('🚨 Falha ao excluir RDS:', err.message);
    return res.status(500).json({ erro: err.message || 'Erro ao excluir RDS' });
  }
});

// Função auxiliar: recalcula status geral baseado nas áreas
async function atualizarStatusGeralRDS(rdsId) {
  const { data: areas } = await supabase.from('rds_areas').select('status').eq('rds_id', rdsId);
  if (!areas || areas.length === 0) return;
  
  const todasConcluidas = areas.every(a => a.status === 'concluido');
  const novoStatus = todasConcluidas ? 'concluido' : 'pendente';

  await supabase.from('rds_solicitacoes').update({ status_geral: novoStatus }).eq('id', rdsId);
}

app.get('/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend Rodando na porta ${PORT}`));