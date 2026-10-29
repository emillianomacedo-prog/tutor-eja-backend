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

// ============================================================
// MIDDLEWARES GLOBAIS
// ============================================================
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================
// CONEXÃO SUPABASE E NODEMAILER
// ============================================================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    connectionTimeout: 10000
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const BUCKET_IMAGENS = 'atividades-imagens';

// ============================================================
// HELPERS
// ============================================================
function gerarNomeArquivo(originalName) {
    const ext = (originalName.split('.').pop() || 'png').toLowerCase();
    return `questoes/${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${ext}`;
}

// ============================================================
// LOGIN E AUTENTICAÇÃO
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
                segmento: aluno.segmento || 'medio',
                matricula_id: aluno.id
            }
        });
    } catch (err) { res.status(500).json({ erro: 'Erro no login.' }); }
});

app.post('/api/login-professor', async (req, res) => {
    try {
        const { email, senha } = req.body;
        const { data: professor } = await supabase.from('professores').select('*').eq('email', email).maybeSingle();
        if (!professor || !await bcrypt.compare(senha, professor.senha_hash)) return res.status(401).json({ error: 'Inválido.' });
        res.json({ professor: { id: professor.id, nome: professor.nome, area: professor.area } });
    } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

app.post('/api/login-admin', async (req, res) => {
    try {
        const { email, senha } = req.body;
        const { data: usuario } = await supabase.from('usuarios').select('*').eq('email', email).maybeSingle();
        if (!usuario || !await bcrypt.compare(senha, usuario.senha_hash || usuario.senha)) return res.status(401).json({ error: 'Inválido.' });
        res.json({ usuario: { id: usuario.id, nome: usuario.nome || usuario.nome_completo, email: usuario.email } });
    } catch (err) { res.status(500).json({ error: 'Erro.' }); }
});

// ============================================================
// ROTAS DO ALUNO
// ============================================================
app.get('/api/atividades', async (req, res) => {
    try {
        const { competencia, aluno_id } = req.query;
        let query = supabase.from('atividades').select('*').eq('ativa', true);
        if (competencia) query = query.eq('competencia', competencia);
        
        const { data: atividades, error } = await query;
        if (error) throw error;

        let respostas = [];
        if (aluno_id) {
            const { data: r } = await supabase.from('respostas_atividades').select('*').eq('aluno_id', aluno_id);
            respostas = r || [];
        }

        const atividadesFormatadas = atividades.map(atv => {
            const resp = respostas.find(r => r.atividade_id === atv.id);
            let alternativas = null;
            if (atv.tipo === 'objetiva' && atv.alternativas) {
                const letras = ['A', 'B', 'C', 'D', 'E'];
                alternativas = (typeof atv.alternativas[0] === 'string') 
                    ? atv.alternativas.map((t, i) => ({ letra: letras[i], texto: t })) 
                    : atv.alternativas;
            }

            return {
                ...atv,
                alternativas,
                status: resp ? (resp.status === 'corrigida' ? 'FINALIZADA' : 'REFAZER') : 'INICIAR',
                rascunho: resp ? resp.resposta : '',
                nota: resp ? resp.nota : null,
                tentativas: resp ? 1 : 0
            };
        });
        res.json({ atividades: atividadesFormatadas });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/atividades/:id/iniciar', async (req, res) => { res.json({ ok: true }); });
app.patch('/api/atividades/:id/rascunho', async (req, res) => { res.json({ ok: true }); });

app.post('/api/atividades/:id/responder', async (req, res) => {
    try {
        const { aluno_id, resposta } = req.body;
        const { data: atv } = await supabase.from('atividades').select('tipo, gabarito').eq('id', req.params.id).single();
        
        let nota = null;
        let status = 'pendente';
        if (atv.tipo === 'objetiva') {
            nota = (resposta === atv.gabarito) ? 100 : 0;
            status = nota >= 60 ? 'corrigida' : 'refazer';
        }

        const { data: respExistente } = await supabase.from('respostas_atividades').select('id').eq('atividade_id', req.params.id).eq('aluno_id', aluno_id).maybeSingle();
        
        let result;
        if (respExistente) {
            result = await supabase.from('respostas_atividades').update({ resposta, nota, status }).eq('id', respExistente.id).select().single();
        } else {
            result = await supabase.from('respostas_atividades').insert([{ atividade_id: req.params.id, aluno_id, resposta, nota, status }]).select().single();
        }
        res.json({ resposta: result.data });
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
// MURAIS (Ajustado para a estrutura real do banco)
// ============================================================
app.get('/api/murais', async (req, res) => {
    try {
        const { area } = req.query;
        let query = supabase.from('murais').select('*').eq('ativo', true); // Garante que só pega os ativos
        
        // Filtro por área (o frontend envia 'ciencias_humanas', o banco pode ter 'Ciências Humanas')
        if (area) {
            let dbArea = area;
            if (area === 'ciencias_humanas') dbArea = 'Ciências Humanas';
            if (area === 'ciencias_natureza') dbArea = 'Ciências da Natureza';
            if (area === 'linguagens') dbArea = 'Linguagens';
            if (area === 'matematica') dbArea = 'Matemática';
            
            query = query.ilike('area', `%${dbArea}%`);
        }
        
        const { data: murais, error } = await query;
        if (error) throw error;

        // Formata para o frontend (murais.js espera texto_base e status)
        const formatados = murais.map(m => ({
            id: m.id, 
            titulo: m.titulo, 
            area: m.area, 
            competencia: m.competencia || 'Geral',
            texto_base: m.texto_base, // <-- Usando a coluna correta do seu banco
            status: 'INICIAR', 
            nota_ia: null, 
            feedback_ia: null
        }));
        
        res.json({ murais: formatados });
    } catch (err) { 
        console.error('Erro GET /api/murais:', err);
        res.status(500).json({ erro: err.message }); 
    }
});

// ============================================================
// HABILIDADES DO ALUNO (Filtrado por Segmento e Ordenado)
// ============================================================
app.get('/api/aluno/:matricula_id/habilidades', async (req, res) => {
    try {
        // Pega o segmento que o frontend enviou (fundamental ou medio)
        const { segmento } = req.query; 
        
        let query = supabase.from('catalogo_habilidades').select('*');
        
        // Se o segmento foi enviado, filtra no banco. 
        // (Ajuste o nome da coluna 'etapa' se no seu banco ela se chamar 'segmento')
        if (segmento) {
            // Mapeia 'medio' para 'Médio' ou 'Ensino Médio', dependendo de como está no seu banco
            const dbEtapa = segmento === 'medio' ? 'Médio' : 'Fundamental';
            query = query.ilike('etapa', `%${dbEtapa}%`); 
        }

        const { data: habilidades, error } = await query;
        if (error) throw error;

        // Como o banco não ordena "H1, H2, H10" corretamente apenas com string, fazemos no JS:
        const formatadas = habilidades.map(h => ({
            area: h.area, 
            competencia: h.competencia || 'Geral', 
            habilidade_codigo: h.codigo || h.habilidade_codigo, 
            descricao: h.descricao || 'Descrição não cadastrada.'
        }));

        // Função para extrair o número e ordenar C1, C2... H1, H2...
        const extrairNumero = (str) => {
            if (!str) return 0;
            const match = str.match(/\d+/);
            return match ? parseInt(match[0]) : 0;
        };

        formatadas.sort((a, b) => {
            // 1º Ordena por Área (A-Z)
            if (a.area !== b.area) return a.area.localeCompare(b.area);
            // 2º Ordena por Competência (C1, C2...)
            const compA = extrairNumero(a.competencia);
            const compB = extrairNumero(b.competencia);
            if (compA !== compB) return compA - compB;
            // 3º Ordena por Habilidade (H1, H2, H10...)
            const habA = extrairNumero(a.habilidade_codigo);
            const habB = extrairNumero(b.habilidade_codigo);
            return habA - habB;
        });

        res.json(formatadas);
    } catch (err) { 
        console.error('Erro GET habilidades:', err);
        res.status(500).json({ erro: err.message }); 
    }
});

app.get('/api/boletim', async (req, res) => {
    try {
        const { aluno_id } = req.query;
        const { data: respostas } = await supabase.from('respostas_atividades').select('*').eq('aluno_id', aluno_id);
        
        const areas = { linguagens: { comps: {} }, matematica: { comps: {} }, ciencias_natureza: { comps: {} }, ciencias_humanas: { comps: {} } };

        for (const r of respostas || []) {
            const { data: atv } = await supabase.from('atividades').select('area, competencia').eq('id', r.atividade_id).single();
            if (!atv || !areas[atv.area]) continue;
            const key = atv.area.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace(/ /g, '_');
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
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/aluno/:matricula_id/habilidades', async (req, res) => {
    try {
        const { data: habilidades } = await supabase.from('catalogo_habilidades').select('*').order('area');
        const formatadas = habilidades.map(h => ({
            area: h.area, competencia: h.competencia || 'Geral', habilidade_codigo: h.codigo, descricao: h.descricao || 'Descrição não cadastrada.'
        }));
        res.json(formatadas);
    } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
// ROTAS DE ADMIN, PROFESSOR E BUSCA ATIVA (Mantidas)
// ============================================================
app.post('/api/upload-imagem', upload.single('imagem'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo.' });
        const filePath = gerarNomeArquivo(req.file.originalname);
        await supabase.storage.from(BUCKET_IMAGENS).upload(filePath, req.file.buffer, { contentType: req.file.mimetype });
        const { data } = supabase.storage.from(BUCKET_IMAGENS).getPublicUrl(filePath);
        return res.json({ success: true, url: data.publicUrl });
    } catch (err) { res.status(500).json({ error: 'Erro no upload.' }); }
});

app.post('/api/atividades-admin', async (req, res) => {
    try {
        const { data, error } = await supabase.from('atividades').insert([req.body]).select().single();
        if (error) throw error; res.status(201).json(data);
    } catch (err) { res.status(500).json({ error: 'Erro ao criar.' }); }
});

app.get('/api/alunos', async (req, res) => {
    const { data } = await supabase.from('alunos').select('*').order('nome_completo');
    res.json(data);
});

app.get('/api/admin/testar-notificacoes', async (req, res) => {
    try {
        const dataLimite = new Date(); dataLimite.setDate(dataLimite.getDate() - 5);
        const { data: inativos } = await supabase.from('alunos').select('id, nome_completo, email, telefone_whatsapp, ultimo_acesso').lt('ultimo_acesso', dataLimite.toISOString());
        
        const detalhes = inativos.map(aluno => {
            const dias = Math.floor((new Date() - new Date(aluno.ultimo_acesso)) / (1000 * 60 * 60 * 24));
            let num = (aluno.telefone_whatsapp || '').replace(/\D/g, ''); if (num.length >= 10) num = '55' + num;
            const msg = `Olá *${aluno.nome_completo}*, notamos que *você não acessa a plataforma há ${dias} dias*. Vamos retomar seus estudos?\n\n🎓 *Acesse:* https://tutor-nova-eja.vercel.app\n👤 *Login:* ${aluno.email}\n🔑 *Senha:* Sesi@1234`;
            return { aluno_id: aluno.id, aluno: aluno.nome_completo, email: aluno.email, dias_inativo: dias, mensagem_texto: msg, link_whatsapp: `https://wa.me/${num}?text=${encodeURIComponent(msg)}` };
        });
        res.json({ success: true, enviados: inativos.length, detalhes });
    } catch (err) { res.status(500).json({ error: 'Erro na busca ativa.' }); }
});

app.post('/api/busca-ativa/registrar', async (req, res) => {
    try {
        const { aluno_id, mensagem_enviada, canal, aluno_email, aluno_nome, dias_inativo } = req.body;
        if (canal === 'Email' && process.env.EMAIL_USER) {
            await transporter.sendMail({ from: `"Tutor IA" <${process.env.EMAIL_USER}>`, to: aluno_email, subject: `Sentimos sua falta, ${aluno_nome}!`, html: `<p>Olá, ${aluno_nome}!</p><p>Notamos que você não acessa há ${dias_inativo} dias. Volte a estudar!</p>` });
        }
        const { data } = await supabase.from('historico_busca_ativa').insert([{ aluno_id, mensagem_enviada, canal }]).select().single();
        res.status(201).json(data);
    } catch (err) { res.status(500).json({ error: 'Erro ao registrar.' }); }
});

app.get('/api/busca-ativa/relatorio/:id', async (req, res) => {
    const { data: aluno } = await supabase.from('alunos').select('*').eq('id', req.params.id).single();
    const { data: historico } = await supabase.from('historico_busca_ativa').select('*').eq('aluno_id', req.params.id).order('data_envio', { ascending: false });
    res.json({ aluno, historico });
});

app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));