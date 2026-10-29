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
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================
// CONEXÃO SUPABASE E NODEMAILER
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.error('❌ Variáveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórias.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    connectionTimeout: 10000
});

// ============================================================
// CONFIGURAÇÃO DE UPLOAD (MULTER)
// ============================================================
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
});
const BUCKET_IMAGENS = 'atividades-imagens';

// ============================================================
// HELPERS
// ============================================================
function gerarNomeArquivo(originalName) {
    const ext = (originalName.split('.').pop() || 'png').toLowerCase();
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `questoes/${timestamp}-${random}.${ext}`;
}

// ============================================================
// ROTA RAIZ
// ============================================================
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Tutor IA - Nova EJA', timestamp: new Date().toISOString() });
});

// ============================================================
// LOGIN DO ALUNO (Compatível com index.html)
// ============================================================
app.post('/api/login', async (req, res) => {
    try {
        const { cpf, senha } = req.body;
        if (!cpf || !senha) return res.status(400).json({ erro: 'CPF e senha são obrigatórios.' });

        const { data: aluno, error } = await supabase.from('alunos').select('*').eq('cpf', cpf).maybeSingle();
        
        if (error) throw error;
        if (!aluno) return res.status(401).json({ erro: 'CPF ou senha inválidos.' });

        const senhaValida = await bcrypt.compare(senha, aluno.senha);
        if (!senhaValida) return res.status(401).json({ erro: 'CPF ou senha inválidos.' });

        // Atualiza o último acesso
        await supabase.from('alunos').update({ ultimo_acesso: new Date().toISOString() }).eq('id', aluno.id);

        return res.json({
            aluno: {
                aluno_id: aluno.id,
                nome: aluno.nome_completo,
                turma: aluno.turma || 'Não informada',
                segmento: aluno.segmento || 'medio',
                matricula_id: aluno.id // Usando o ID como matrícula para compatibilidade
            }
        });
    } catch (err) {
        console.error('Erro /api/login:', err);
        res.status(500).json({ erro: 'Erro interno no login.' });
    }
});

// ============================================================
// LOGIN DO PROFESSOR E COORDENADOR
// ============================================================
app.post('/api/login-professor', async (req, res) => {
    try {
        const { email, senha } = req.body;
        const { data: professor, error } = await supabase.from('professores').select('*').eq('email', email).maybeSingle();
        
        if (error) throw error;
        if (!professor || !await bcrypt.compare(senha, professor.senha_hash)) {
            return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
        }
        
        res.json({ professor: { id: professor.id, nome: professor.nome, email: professor.email, area: professor.area } });
    } catch (err) {
        res.status(500).json({ error: 'Erro no login do professor.' });
    }
});

app.post('/api/login-admin', async (req, res) => {
    try {
        const { email, senha } = req.body;
        const { data: usuario, error } = await supabase.from('usuarios').select('*').eq('email', email).maybeSingle();
        
        if (error) throw error;
        if (!usuario || !await bcrypt.compare(senha, usuario.senha_hash || usuario.senha)) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }
        
        res.json({ usuario: { id: usuario.id, nome: usuario.nome || usuario.nome_completo, email: usuario.email } });
    } catch (err) {
        res.status(500).json({ error: 'Erro no login do coordenador.' });
    }
});

// ============================================================
// ATIVIDADES (Compatível com atividades.js)
// ============================================================
app.get('/api/atividades', async (req, res) => {
    try {
        const { competencia, aluno_id } = req.query;
        
        // 1. Busca atividades (filtra por competência se enviada)
        let query = supabase.from('atividades').select('*').eq('ativa', true);
        if (competencia) query = query.eq('competencia', competencia);
        
        const { data: atividades, error } = await query;
        if (error) throw error;

        // 2. Busca respostas do aluno (se informado)
        let respostas = [];
        if (aluno_id) {
            const { data: r } = await supabase.from('respostas_atividades').select('*').eq('aluno_id', aluno_id);
            respostas = r || [];
        }

        // 3. Formata para o frontend
        const atividadesFormatadas = atividades.map(atv => {
            const resp = respostas.find(r => r.atividade_id === atv.id);
            
            let alternativas = null;
            if (atv.tipo === 'objetiva' && atv.alternativas) {
                const letras = ['A', 'B', 'C', 'D', 'E'];
                alternativas = atv.alternativas.map((texto, i) => ({ letra: letras[i], texto }));
            }

            return {
                ...atv,
                alternativas,
                status: resp ? (resp.status === 'corrigida' ? 'FINALIZADA' : 'REFAZER') : 'INICIAR',
                rascunho: resp ? resp.resposta : '',
                nota: resp ? resp.nota : null,
                feedback: resp ? 'Correção processada.' : null, // Pode ser ajustado para pegar da tabela
                tentativas: resp ? 1 : 0
            };
        });

        res.json({ atividades: atividadesFormatadas });
    } catch (err) {
        console.error('Erro GET /api/atividades:', err);
        res.status(500).json({ erro: 'Erro ao listar atividades.' });
    }
});

app.post('/api/atividades/:id/iniciar', async (req, res) => {
    res.json({ ok: true });
});

app.patch('/api/atividades/:id/rascunho', async (req, res) => {
    res.json({ ok: true }); // Autosave desativado por enquanto
});

app.post('/api/atividades/:id/responder', async (req, res) => {
    try {
        const { id } = req.params;
        const { aluno_id, resposta } = req.body;

        const { data: atv } = await supabase.from('atividades').select('tipo, gabarito').eq('id', id).single();
        if (!atv) throw new Error('Atividade não encontrada.');

        let nota = null;
        let status = 'pendente';

        if (atv.tipo === 'objetiva') {
            nota = (resposta === atv.gabarito) ? 100 : 0;
            status = nota >= 60 ? 'corrigida' : 'refazer';
        }

        const { data: respExistente } = await supabase.from('respostas_atividades').select('id').eq('atividade_id', id).eq('aluno_id', aluno_id).maybeSingle();

        let result;
        if (respExistente) {
            result = await supabase.from('respostas_atividades').update({ resposta, nota, status }).eq('id', respExistente.id).select().single();
        } else {
            result = await supabase.from('respostas_atividades').insert([{ atividade_id: id, aluno_id, resposta, nota, status }]).select().single();
        }

        res.json({ resposta: result.data });
    } catch (err) {
        console.error('Erro POST /api/atividades/responder:', err);
        res.status(500).json({ erro: 'Erro ao responder atividade.' });
    }
});

// ============================================================
// MURAIS (Compatível com murais.js)
// ============================================================
app.get('/api/murais', async (req, res) => {
    try {
        const { area, aluno_id } = req.query;
        let query = supabase.from('murais').select('*');
        if (area) query = query.eq('area', area);
        
        const { data: murais, error } = await query;
        if (error) throw error;

        const muraisFormatados = murais.map(m => ({
            ...m,
            status: 'INICIAR',
            nota_ia: null,
            texto_base: m.conteudo // Mapeia conteudo -> texto_base para o frontend
        }));

        res.json({ murais: muraisFormatados });
    } catch (err) {
        console.error('Erro GET /api/murais:', err);
        res.status(500).json({ erro: 'Erro ao listar murais.' });
    }
});

app.post('/api/murais/:id/mediar', async (req, res) => {
    // Simulação da IA para a mediação do mural
    res.json({ 
        mediacao: { 
            feedback: "Excelente ponto de vista! Para aprofundar, pense em como isso afeta a sociedade.", 
            perguntas: ["Qual seria a solução para esse problema?", "Você consegue dar um exemplo prático?"], 
            pronto_para_avaliar: true 
        } 
    });
});

app.post('/api/murais/:id/avaliar', async (req, res) => {
    // Simulação da nota da IA para o mural
    res.json({ postagem: { status: 'FINALIZADA', nota_ia: 85 } });
});

// ============================================================
// BOLETIM (Compatível com boletim.js)
// ============================================================
app.get('/api/boletim', async (req, res) => {
    try {
        const { aluno_id } = req.query;
        if (!aluno_id) return res.status(400).json({ erro: 'ID do aluno é obrigatório.' });

        // Busca todas as respostas do aluno
        const { data: respostas, error } = await supabase.from('respostas_atividades').select('*').eq('aluno_id', aluno_id);
        if (error) throw error;

        const areas = {
            linguagens: { comps: {}, total: 0, aprovadas: 0 },
            matematica: { comps: {}, total: 0, aprovadas: 0 },
            ciencias_natureza: { comps: {}, total: 0, aprovadas: 0 },
            ciencias_humanas: { comps: {}, total: 0, aprovadas: 0 }
        };

        for (const r of respostas) {
            const { data: atv } = await supabase.from('atividades').select('area, competencia').eq('id', r.atividade_id).single();
            
            if (!atv || !areas[atv.area]) continue;

            const areaKey = atv.area.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace(/ /g, '_');
            const areaObj = areas[areaKey] || areas['linguagens']; 
            
            if (!areaObj.comps[atv.competencia]) {
                areaObj.comps[atv.competencia] = { notas: [] };
            }
            areaObj.comps[atv.competencia].notas.push(r.nota || 0);
        }

        const por_area = {};
        let total_competencias = 0;
        let total_aprovadas = 0;

        for (const [areaKey, data] of Object.entries(areas)) {
            por_area[areaKey] = Object.entries(data.comps).map(([comp, obj]) => {
                const media = obj.notas.reduce((a, b) => a + b, 0) / obj.notas.length;
                const aprovado = media >= 60;
                
                total_competencias++;
                if (aprovado) total_aprovadas++;

                return {
                    competencia: comp,
                    nota_oficina: 0,
                    nota_atividades: media,
                    nota_engajamento: 0,
                    nota_final: media,
                    aprovado_competencia: aprovado
                };
            });
        }

        res.json({
            apto_certificacao: total_aprovadas === total_competencias && total_competencias > 0,
            total_competencias,
            total_aprovadas,
            por_area
        });

    } catch (err) {
        console.error('Erro GET /api/boletim:', err);
        res.status(500).json({ erro: 'Erro ao gerar boletim.' });
    }
});

// ============================================================
// ROTAS DO ADMIN/PROFESSOR E BUSCA ATIVA
// ============================================================

// 1. Upload de Imagem
app.post('/api/upload-imagem', upload.single('imagem'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        const filePath = gerarNomeArquivo(req.file.originalname);

        const { error: uploadError } = await supabase.storage.from(BUCKET_IMAGENS).upload(filePath, req.file.buffer, { contentType: req.file.mimetype });
        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase.storage.from(BUCKET_IMAGENS).getPublicUrl(filePath);
        return res.json({ success: true, url: publicUrlData.publicUrl });
    } catch (err) {
        res.status(500).json({ error: 'Erro no upload.' });
    }
});

// 2. CRUD de Atividades (Para o painel do professor)
app.post('/api/atividades-admin', async (req, res) => {
    try {
        const { etapa, competencia, habilidade_codigo, area, tipo, enunciado, alternativas, gabarito, imagem_url } = req.body;
        const { data, error } = await supabase.from('atividades').insert([{ 
            etapa, competencia, habilidade_codigo, area, tipo, enunciado, alternativas, gabarito, imagem_url, ativa: true 
        }]).select().single();
        
        if (error) throw error;
        res.status(201).json(data);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao criar atividade.' });
    }
});

// 3. Listar Alunos
app.get('/api/alunos', async (req, res) => {
    try {
        const { data, error } = await supabase.from('alunos').select('*').order('nome_completo');
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao listar alunos.' });
    }
});

// 4. Relatório de Busca Ativa
app.get('/api/admin/testar-notificacoes', async (req, res) => {
    try {
        const cincoDiasAtras = new Date();
        cincoDiasAtras.setDate(cincoDiasAtras.getDate() - 5);
        
        const { data: alunosInativos, error } = await supabase.from('alunos')
            .select('id, nome_completo, email, telefone_whatsapp, ultimo_acesso')
            .lt('ultimo_acesso', cincoDiasAtras.toISOString());

        if (error) throw error;

        const detalhes = alunosInativos.map(aluno => {
            const diasInativo = Math.floor((new Date() - new Date(aluno.ultimo_acesso)) / (1000 * 60 * 60 * 24));
            
            let numeroLimpo = (aluno.telefone_whatsapp || '').replace(/\D/g, '');
            if (numeroLimpo.length >= 10) numeroLimpo = '55' + numeroLimpo;

            const msg = `Olá *${aluno.nome_completo}*, notamos que *você não acessa a plataforma há ${diasInativo} dias*. Vamos retomar seus estudos?\n\n🎓 *Acesse:* https://tutor-nova-eja.vercel.app\n👤 *Login:* ${aluno.email}\n🔑 *Senha:* Sesi@1234`;
            
            return {
                aluno_id: aluno.id,
                aluno: aluno.nome_completo,
                email: aluno.email,
                dias_inativo: diasInativo,
                mensagem_texto: msg,
                link_whatsapp: `https://wa.me/${numeroLimpo}?text=${encodeURIComponent(msg)}`
            };
        });

        res.json({ success: true, enviados: alunosInativos.length, detalhes });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao buscar inativos.' });
    }
});

// 5. Histórico de Busca Ativa (Registrar)
app.post('/api/busca-ativa/registrar', async (req, res) => {
    try {
        const { aluno_id, mensagem_enviada, canal, aluno_email, aluno_nome, dias_inativo } = req.body;

        if (canal === 'Email' && process.env.EMAIL_USER) {
            await transporter.sendMail({
                from: `"Tutor IA Nova EJA" <${process.env.EMAIL_USER}>`,
                to: aluno_email,
                subject: `Sentimos sua falta, ${aluno_nome}! Vamos estudar?`,
                html: `<p>Olá, ${aluno_nome}!</p><p>Notamos que você não acessa a plataforma há ${dias_inativo} dias. Clique <a href="https://tutor-nova-eja.vercel.app">aqui</a> para voltar a estudar.</p>`
            });
        }

        const { data, error } = await supabase.from('historico_busca_ativa')
            .insert([{ aluno_id, mensagem_enviada, canal: canal || 'WhatsApp' }])
            .select().single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao registrar busca.' });
    }
});

// 6. Gerar Relatório de Busca Ativa
app.get('/api/busca-ativa/relatorio/:aluno_id', async (req, res) => {
    try {
        const { data: aluno } = await supabase.from('alunos').select('*').eq('id', req.params.aluno_id).single();
        const { data: historico } = await supabase.from('historico_busca_ativa').select('*').eq('aluno_id', req.params.aluno_id).order('data_envio', { ascending: false });
        
        res.json({ aluno, historico });
    } catch (err) {
        res.status(500).json({ error: 'Erro ao gerar relatório.' });
    }
});

// ============================================================
// INICIALIZAÇÃO
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 Tutor IA - Nova EJA rodando na porta ${PORT}`);
});

module.exports = app;