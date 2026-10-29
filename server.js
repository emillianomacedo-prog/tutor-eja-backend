// ============================================================
// TUTOR IA - NOVA EJA (SESI) - server.js
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const BUCKET_IMAGENS = 'atividades-imagens';

function gerarNomeArquivo(originalName) {
    const ext = (originalName.split('.').pop() || 'png').toLowerCase();
    return `questoes/${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${ext}`;
}

// ============================================================
// AUTENTICAÇÃO E LOGIN
// ============================================================
app.post('/api/login', async (req, res) => {
    try {
        const { cpf, senha } = req.body;
        const { data: aluno, error } = await supabase.from('alunos').select('*').eq('cpf', cpf).maybeSingle();
        
        if (error || !aluno || !await bcrypt.compare(senha, aluno.senha)) {
            return res.status(401).json({ erro: 'CPF ou senha inválidos.' });
        }

        await supabase.from('alunos').update({ ultimo_acesso: new Date().toISOString() }).eq('id', aluno.id);

        return res.json({
            aluno: {
                aluno_id: aluno.id,
                nome: aluno.nome_completo,
                turma: aluno.turma || 'Não informada',
                segmento: aluno.etapa === 'Ensino Médio' ? 'medio' : 'fundamental',
                matricula_id: aluno.id
            }
        });
    } catch (err) { res.status(500).json({ erro: 'Erro no login.' }); }
});

app.post('/api/login-professor', async (req, res) => {
    try {
        const { email, senha } = req.body;
        const { data: prof } = await supabase.from('professores').select('*').eq('email', email).maybeSingle();
        if (!prof || !await bcrypt.compare(senha, prof.senha_hash)) return res.status(401).json({ error: 'Inválido.' });
        res.json({ professor: { id: prof.id, nome: prof.nome, area: prof.area } });
    } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

// ============================================================
// ALUNOS - CRUD (COM DISPENSAS)
// ============================================================
app.get('/api/alunos', async (req, res) => {
    try {
        const { data, error } = await supabase.from('alunos').select('*').order('nome_completo');
        if (error) throw error;
        res.json(data);
    } catch (err) { res.status(500).json({ error: 'Erro ao listar alunos.' }); }
});

app.post('/api/alunos', async (req, res) => {
    try {
        const { nome, email, cpf, telefone_whatsapp, matricula, turma, etapa, senha, dispensas } = req.body;
        
        const { data: existente } = await supabase.from('alunos').select('id').eq('cpf', cpf).eq('etapa', etapa).maybeSingle();
        if (existente) return res.status(400).json({ error: 'Já existe um aluno cadastrado com este CPF nesta etapa.' });

        const senha_hash = await bcrypt.hash(senha || 'Sesi@1234', 10);

        const { data, error } = await supabase
            .from('alunos')
            .insert([{ 
                nome_completo: nome, email, cpf, telefone_whatsapp, matricula, turma, etapa, senha: senha_hash,
                dispensas: dispensas || [] 
            }])
            .select().single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (err) { res.status(500).json({ error: 'Erro ao criar aluno.' }); }
});

app.put('/api/alunos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, email, telefone_whatsapp, matricula, turma, etapa, dispensas } = req.body;

        const { data, error } = await supabase
            .from('alunos')
            .update({ 
                nome_completo: nome, email, telefone_whatsapp, matricula, turma, etapa,
                dispensas: dispensas || []
            })
            .eq('id', id).select().single();

        if (error) throw error;
        res.json(data);
    } catch (err) { res.status(500).json({ error: 'Erro ao atualizar aluno.' }); }
});

// ============================================================
// HABILIDADES PARA O CADASTRO (POR ETAPA)
// ============================================================
app.get('/api/habilidades-por-etapa', async (req, res) => {
    try {
        const { etapa } = req.query;
        const termo = etapa === 'Ensino Médio' ? 'Médio' : 'Fundamental';
        const { data: habilidades, error } = await supabase.from('catalogo_habilidades').select('*').ilike('segmento', `%${termo}%`);
        if (error) throw error;

        const agrupado = {};
        habilidades.forEach(h => {
            if (!agrupado[h.area]) agrupado[h.area] = {};
            if (!agrupado[h.area][h.competencia]) agrupado[h.area][h.competencia] = [];
            
            // Remove a sigla da competência do código da habilidade para ficar apenas H1, H2...
            let codigoLimpo = h.habilidade_codigo;
            if (codigoLimpo.startsWith(h.competencia)) {
                codigoLimpo = codigoLimpo.replace(h.competencia, ''); 
            }
            agrupado[h.area][h.competencia].push({ original: h.habilidade_codigo, exibicao: codigoLimpo });
        });
        res.json(agrupado);
    } catch (err) { res.status(500).json({ error: 'Erro ao buscar habilidades.' }); }
});

// ============================================================
// ROTAS DO ALUNO (FILTRANDO DISPENSAS)
// ============================================================
app.get('/api/atividades-aluno/:aluno_id', async (req, res) => {
    try {
        const { aluno_id } = req.params;
        const { data: aluno } = await supabase.from('alunos').select('dispensas, etapa').eq('id', aluno_id).single();
        const dispensas = aluno.dispensas || [];

        const { data: atividades } = await supabase.from('atividades').select('*').eq('ativa', true).eq('etapa', aluno.etapa);
        const { data: respostas } = await supabase.from('respostas_atividades').select('*').eq('aluno_id', aluno_id);

        const atividadesDisponiveis = atividades.filter(atv => {
            if (dispensas.includes(atv.area)) return false;
            if (dispensas.includes(`${atv.area}|${atv.competencia}`)) return false;
            if (dispensas.includes(`${atv.area}|${atv.competencia}|${atv.habilidade_codigo}`)) return false;
            return true;
        });

        res.json(atividadesDisponiveis.map(atv => ({
            ...atv, resposta_aluno: respostas.find(r => r.atividade_id === atv.id) || null
        })));
    } catch (err) { res.status(500).json({ error: 'Erro ao buscar atividades.' }); }
});

app.get('/api/aluno/:matricula_id/habilidades', async (req, res) => {
    try {
        const { matricula_id } = req.params;
        const { segmento } = req.query;
        const { data: aluno } = await supabase.from('alunos').select('dispensas').eq('id', matricula_id).single();
        const dispensas = aluno?.dispensas || [];

        const termo = segmento === 'medio' ? 'Médio' : 'Fundamental';
        const { data: habilidades } = await supabase.from('catalogo_habilidades').select('*').ilike('segmento', `%${termo}%`);

        const habilidadesFiltradas = habilidades.filter(h => {
            if (dispensas.includes(h.area)) return false;
            if (dispensas.includes(`${h.area}|${h.competencia}`)) return false;
            if (dispensas.includes(`${h.area}|${h.competencia}|${h.habilidade_codigo}`)) return false;
            return true;
        });

        const extrairNumero = (str) => { const m = str?.match(/\d+/); return m ? parseInt(m[0]) : 0; };
        habilidadesFiltradas.sort((a, b) => {
            if (a.area !== b.area) return a.area.localeCompare(b.area);
            const compA = extrairNumero(a.competencia), compB = extrairNumero(b.competencia);
            if (compA !== compB) return compA - compB;
            return extrairNumero(a.habilidade_codigo) - extrairNumero(b.habilidade_codigo);
        });

        res.json(habilidadesFiltradas.map(h => ({
            area: h.area, competencia: h.competencia, habilidade_codigo: h.habilidade_codigo, descricao: h.descricao
        })));
    } catch (err) { res.status(500).json({ error: 'Erro ao listar habilidades.' }); }
});

app.get('/api/murais-aluno/:aluno_id', async (req, res) => {
    try {
        const { aluno_id } = req.params;
        const { data: aluno } = await supabase.from('alunos').select('dispensas').eq('id', aluno_id).single();
        const dispensas = aluno?.dispensas || [];
        const { data: murais } = await supabase.from('murais').select('*').eq('ativo', true);
        res.json(murais.filter(m => !dispensas.includes(m.area)));
    } catch (err) { res.status(500).json({ error: 'Erro ao buscar murais.' }); }
});

// ============================================================
// ROTAS DO PROFESSOR E ATIVIDADES
// ============================================================
app.get('/api/atividades', async (req, res) => {
    try {
        const { data, error } = await supabase.from('atividades').select(`*, respostas_atividades(count)`).eq('ativa', true).order('id', { ascending: false });
        if (error) throw error;
        res.json({ atividades: data.map(a => ({ ...a, total_respostas: a.respostas_atividades[0]?.count || 0 })) });
    } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

app.post('/api/atividades', async (req, res) => {
    try {
        const { data, error } = await supabase.from('atividades').insert([{ ...req.body, ativa: true }]).select().single();
        if (error) throw error; res.status(201).json(data);
    } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

app.get('/api/atividades/:id', async (req, res) => {
    try {
        const { data, error } = await supabase.from('atividades').select('*').eq('id', req.params.id).single();
        if (error) throw error; res.json(data);
    } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

app.post('/api/atividades/:id/responder', async (req, res) => {
    try {
        const { aluno_id, resposta } = req.body;
        const { data: atv } = await supabase.from('atividades').select('tipo, gabarito').eq('id', req.params.id).single();
        let nota = atv.tipo === 'objetiva' ? (resposta === atv.gabarito ? 100 : 0) : null;
        let status = atv.tipo === 'objetiva' ? (nota >= 60 ? 'corrigida' : 'refazer') : 'pendente';

        const { data: respExistente } = await supabase.from('respostas_atividades').select('id').eq('atividade_id', req.params.id).eq('aluno_id', aluno_id).maybeSingle();
        let result;
        if (respExistente) {
            result = await supabase.from('respostas_atividades').update({ resposta, nota, status }).eq('id', respExistente.id).select().single();
        } else {
            result = await supabase.from('respostas_atividades').insert([{ atividade_id: req.params.id, aluno_id, resposta, nota, status }]).select().single();
        }
        res.json({ resposta: result.data });
    } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

// ============================================================
// RELATÓRIOS, BOLETIM E ADMIN
// ============================================================
app.get('/api/boletim', async (req, res) => {
    try {
        const { aluno_id } = req.query;
        const { data: respostas } = await supabase.from('respostas_atividades').select('*').eq('aluno_id', aluno_id);
        const areas = { linguagens: { comps: {} }, matematica: { comps: {} }, ciencias_natureza: { comps: {} }, ciencias_humanas: { comps: {} } };
        for (const r of respostas || []) {
            const { data: atv } = await supabase.from('atividades').select('area, competencia').eq('id', r.atividade_id).single();
            if (!atv || !areas[atv.area.toLowerCase().replace(/ /g, '_')]) continue;
            const key = atv.area.toLowerCase().replace(/ /g, '_');
            if (!areas[key].comps[atv.competencia]) areas[key].comps[atv.competencia] = { notas: [] };
            areas[key].comps[atv.competencia].notas.push(r.nota || 0);
        }
        const por_area = {}; let total = 0; let aprovadas = 0;
        for (const [key, d] of Object.entries(areas)) {
            por_area[key] = Object.entries(d.comps).map(([c, obj]) => {
                const media = obj.notas.reduce((a, b) => a + b, 0) / obj.notas.length;
                const aprov = media >= 60; total++; if (aprov) aprovadas++;
                return { competencia: c, nota_oficina: 0, nota_atividades: media, nota_engajamento: 0, nota_final: media, aprovado_competencia: aprov };
            });
        }
        res.json({ apto_certificacao: aprovadas === total && total > 0, total_competencias: total, total_aprovadas: aprovadas, por_area });
    } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

app.get('/api/consultar-atividades/:aluno_id', async (req, res) => {
    try {
        const { data } = await supabase.from('respostas_atividades').select(`id, nota, status, created_at, atividades (enunciado, area)`).eq('aluno_id', req.params.aluno_id).order('created_at', { ascending: false });
        res.json(data || []);
    } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

app.get('/api/admin/testar-notificacoes', async (req, res) => {
    try {
        const dataLimite = new Date(); dataLimite.setDate(dataLimite.getDate() - 5);
        const { data: inativos } = await supabase.from('alunos').select('id, nome_completo, email, telefone_whatsapp, ultimo_acesso').lt('ultimo_acesso', dataLimite.toISOString());
        const detalhes = inativos.map(a => {
            const dias = Math.floor((new Date() - new Date(a.ultimo_acesso)) / (1000 * 60 * 60 * 24));
            let num = (a.telefone_whatsapp || '').replace(/\D/g, ''); if (num.length >= 10) num = '55' + num;
            const msg = `Olá *${a.nome_completo}*, notamos que *você não acessa a plataforma há ${dias} dias*. Vamos retomar seus estudos?\n\n🎓 *Acesse:* https://tutor-nova-eja.vercel.app\n👤 *Login:* ${a.email}\n🔑 *Senha:* Sesi@1234`;
            return { aluno_id: a.id, aluno: a.nome_completo, email: a.email, dias_inativo: dias, mensagem_texto: msg, link_whatsapp: `https://wa.me/${num}?text=${encodeURIComponent(msg)}` };
        });
        res.json({ success: true, enviados: inativos.length, detalhes });
    } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

app.post('/api/busca-ativa/registrar', async (req, res) => {
    try {
        const { aluno_id, mensagem_enviada, canal, aluno_email, aluno_nome, dias_inativo } = req.body;
        let textoSalvar = mensagem_enviada;
        if (canal === 'Email') {
            textoSalvar = `Assunto: Sentimos sua falta, ${aluno_nome}! Vamos estudar?\n\nOlá, ${aluno_nome}!\nNotamos que você não acessa a plataforma há ${dias_inativo} dias. Estamos com saudades e queremos te ajudar a retomar seus estudos!\nClique no botão abaixo para acessar o sistema.\nLogin: ${aluno_email}\nSenha: Sesi@1234`;
            if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
                await transporter.sendMail({ from: `"Tutor IA Nova EJA" <${process.env.EMAIL_USER}>`, to: aluno_email, subject: `Sentimos sua falta, ${aluno_nome}!`, html: `<p>Olá, ${aluno_nome}!</p><p>Notamos que você não acessa a plataforma há ${dias_inativo} dias...</p><p><a href="https://tutor-nova-eja.vercel.app">Acessar</a></p>` });
            }
        }
        const { data } = await supabase.from('historico_busca_ativa').insert([{ aluno_id, mensagem_enviada: textoSalvar, canal }]).select().single();
        res.status(201).json(data);
    } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

app.get('/api/busca-ativa/relatorio/:id', async (req, res) => {
    const { data: aluno } = await supabase.from('alunos').select('*').eq('id', req.params.id).single();
    const { data: historico } = await supabase.from('historico_busca_ativa').select('*').eq('aluno_id', req.params.id).order('data_envio', { ascending: false });
    res.json({ aluno, historico });
});

app.post('/api/upload-imagem', upload.single('imagem'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo.' });
        const filePath = gerarNomeArquivo(req.file.originalname);
        await supabase.storage.from(BUCKET_IMAGENS).upload(filePath, req.file.buffer, { contentType: req.file.mimetype });
        const { data } = supabase.storage.from(BUCKET_IMAGENS).getPublicUrl(filePath);
        return res.json({ success: true, url: data.publicUrl });
    } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

app.post('/api/murais/:id/mediar', async (req, res) => { res.json({ mediacao: { feedback: "Excelente ponto de vista!", perguntas: ["Qual seria a solução?"], pronto_para_avaliar: true } }); });
app.post('/api/murais/:id/avaliar', async (req, res) => { res.json({ postagem: { status: 'FINALIZADA', nota_ia: 85 } }); });

app.get('/api/murais', async (req, res) => {
    try {
        const { area } = req.query;
        let query = supabase.from('murais').select('*').eq('ativo', true);
        if (area) query = query.ilike('area', `%${area}%`);
        const { data } = await query;
        res.json({ murais: data.map(m => ({ ...m, texto_base: m.texto_base || m.conteudo, status: 'INICIAR' })) });
    } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));