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
// CONEXÃO SUPABASE
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.error('❌ Variáveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórias.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ============================================================
// CONFIGURAÇÃO NODEMAILER (E-MAIL)
// ============================================================
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // true para 465, false para 587
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    connectionTimeout: 10000
});

// ============================================================
// CONFIGURAÇÃO MULTER
// ============================================================
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const permitidos = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (permitidos.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Formato de imagem não permitido. Use JPG, PNG, WEBP ou GIF.'));
        }
    }
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
// UPLOAD DE IMAGEM
// ============================================================
app.post('/api/upload-imagem', upload.single('imagem'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        const filePath = gerarNomeArquivo(req.file.originalname);

        const { error: uploadError } = await supabase.storage
            .from(BUCKET_IMAGENS)
            .upload(filePath, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: false
            });

        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase.storage
            .from(BUCKET_IMAGENS)
            .getPublicUrl(filePath);

        return res.json({ success: true, url: publicUrlData.publicUrl, path: filePath });
    } catch (err) {
        console.error('Erro rota /api/upload-imagem:', err);
        return res.status(500).json({ error: 'Erro interno ao processar upload.' });
    }
});

// ============================================================
// AUTENTICAÇÃO DO COORDENADOR
// ============================================================
app.post('/api/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        if (!email || !senha) return res.status(400).json({ error: 'Email e senha são obrigatórios.' });

        const { data: usuario, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('email', email)
            .maybeSingle();

        if (error) throw error;
        if (!usuario) return res.status(401).json({ error: 'Credenciais inválidas.' });

        const senhaValida = await bcrypt.compare(senha, usuario.senha_hash || usuario.senha);
        if (!senhaValida) return res.status(401).json({ error: 'Credenciais inválidas.' });

        return res.json({
            success: true,
            usuario: { id: usuario.id, nome: usuario.nome || usuario.nome_completo, email: usuario.email, tipo: usuario.tipo }
        });
    } catch (err) {
        console.error('Erro /api/login:', err);
        return res.status(500).json({ error: 'Erro interno no login.' });
    }
});

// ============================================================
// AUTENTICAÇÃO DOS PROFESSORES
// ============================================================
app.post('/api/login-professor', async (req, res) => {
    try {
        const { email, senha } = req.body;
        if (!email || !senha) return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });

        const { data: professor, error } = await supabase
            .from('professores')
            .select('*')
            .eq('email', email)
            .maybeSingle();

        if (error) throw error;
        if (!professor) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });

        const senhaValida = await bcrypt.compare(senha, professor.senha_hash);
        if (!senhaValida) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });

        return res.json({
            success: true,
            professor: { 
                id: professor.id, 
                nome: professor.nome, 
                email: professor.email, 
                area: professor.area 
            }
        });
    } catch (err) {
        console.error('Erro /api/login-professor:', err);
        return res.status(500).json({ error: 'Erro interno no servidor.' });
    }
});

// ============================================================
// CHAT COM IA
// ============================================================
app.post('/api/chat', async (req, res) => {
    try {
        const { mensagem } = req.body;
        if (!mensagem) return res.status(400).json({ error: 'Mensagem é obrigatória.' });
        const respostaIA = `Resposta simulada para: "${mensagem}"`;
        return res.json({ resposta: respostaIA });
    } catch (err) {
        console.error('Erro /api/chat:', err);
        return res.status(500).json({ error: 'Erro ao processar chat.' });
    }
});

// ============================================================
// ALUNOS - CRUD
// ============================================================
app.get('/api/alunos', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('alunos')
            .select('*')
            .order('nome_completo', { ascending: true });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Erro GET /api/alunos:', err);
        res.status(500).json({ error: 'Erro ao listar alunos.' });
    }
});

app.post('/api/alunos', async (req, res) => {
    try {
        const { nome, email, senha, matricula, turma, cpf, telefone_whatsapp } = req.body;
        if (!nome || !email) return res.status(400).json({ error: 'Nome e email são obrigatórios.' });

        const senha_hash = senha ? await bcrypt.hash(senha, 10) : null;

        const { data, error } = await supabase
            .from('alunos')
            .insert([{ 
                nome_completo: nome,
                email, 
                senha: senha_hash,
                cpf,
                telefone_whatsapp,
                matricula, 
                turma 
            }])
            .select()
            .single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (err) {
        console.error('Erro POST /api/alunos:', err);
        res.status(500).json({ error: 'Erro ao criar aluno.' });
    }
});

app.put('/api/alunos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, email, matricula, turma, cpf, telefone_whatsapp } = req.body;

        const { data, error } = await supabase
            .from('alunos')
            .update({ 
                nome_completo: nome,
                email, 
                matricula, 
                turma, 
                cpf, 
                telefone_whatsapp 
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Erro PUT /api/alunos:', err);
        res.status(500).json({ error: 'Erro ao atualizar aluno.' });
    }
});

app.delete('/api/alunos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('alunos').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error('Erro DELETE /api/alunos:', err);
        res.status(500).json({ error: 'Erro ao deletar aluno.' });
    }
});

// ============================================================
// MURAIS - CRUD
// ============================================================
app.get('/api/murais', async (req, res) => {
    try {
        const { data, error } = await supabase.from('murais').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Erro GET /api/murais:', err);
        res.status(500).json({ error: 'Erro ao listar murais.' });
    }
});

app.post('/api/murais', async (req, res) => {
    try {
        const { titulo, conteudo, autor } = req.body;
        if (!titulo || !conteudo) return res.status(400).json({ error: 'Título e conteúdo são obrigatórios.' });
        const { data, error } = await supabase.from('murais').insert([{ titulo, conteudo, autor }]).select().single();
        if (error) throw error;
        res.status(201).json(data);
    } catch (err) {
        console.error('Erro POST /api/murais:', err);
        res.status(500).json({ error: 'Erro ao criar mural.' });
    }
});

app.delete('/api/murais/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('murais').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error('Erro DELETE /api/murais:', err);
        res.status(500).json({ error: 'Erro ao deletar mural.' });
    }
});

// ============================================================
// ATIVIDADES - CRUD
// ============================================================
app.get('/api/atividades', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('atividades')
            .select(`*, respostas_atividades (count)`)
            .eq('ativa', true)
            .order('id', { ascending: false });

        if (error) throw error;

        const atividadesFormatadas = data.map(atv => ({
            ...atv,
            total_respostas: atv.respostas_atividades[0]?.count || 0
        }));

        res.json(atividadesFormatadas);
    } catch (err) {
        console.error('Erro GET /api/atividades:', err);
        res.status(500).json({ error: 'Erro ao listar atividades.' });
    }
});

app.get('/api/atividades/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase.from('atividades').select('*').eq('id', id).single();
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Erro GET /api/atividades/:id:', err);
        res.status(500).json({ error: 'Erro ao buscar atividade.' });
    }
});

app.post('/api/atividades', async (req, res) => {
    try {
        const { etapa, competencia, habilidade_codigo, area, tipo, enunciado, alternativas, gabarito, imagem_url } = req.body;
        if (!enunciado) return res.status(400).json({ error: 'Enunciado é obrigatório.' });

        const { data, error } = await supabase
            .from('atividades')
            .insert([{ etapa, competencia, habilidade_codigo, area, tipo, enunciado, alternativas, gabarito, imagem_url: imagem_url || null, ativa: true }])
            .select()
            .single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (err) {
        console.error('Erro POST /api/atividades:', err);
        res.status(500).json({ error: 'Erro ao criar atividade.' });
    }
});

app.put('/api/atividades/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { etapa, competencia, habilidade_codigo, area, tipo, enunciado, alternativas, gabarito, imagem_url, ativa } = req.body;

        const { data, error } = await supabase
            .from('atividades')
            .update({ etapa, competencia, habilidade_codigo, area, tipo, enunciado, alternativas, gabarito, imagem_url, ativa })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Erro PUT /api/atividades:', err);
        res.status(500).json({ error: 'Erro ao atualizar atividade.' });
    }
});

app.delete('/api/atividades/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('atividades').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error('Erro DELETE /api/atividades:', err);
        res.status(500).json({ error: 'Erro ao deletar atividade.' });
    }
});

// ============================================================
// RESPOSTAS DE ATIVIDADES
// ============================================================
app.post('/api/respostas', async (req, res) => {
    try {
        const { atividade_id, aluno_id, resposta } = req.body;
        if (!atividade_id || !aluno_id) return res.status(400).json({ error: 'atividade_id e aluno_id são obrigatórios.' });

        const { data: atividade, error: errorAtv } = await supabase
            .from('atividades')
            .select('tipo, gabarito')
            .eq('id', atividade_id)
            .single();
            
        if (errorAtv) throw errorAtv;

        let correta = null;
        let status = 'pendente';
        let nota = null;

        if (atividade.tipo === 'objetiva') {
            correta = (resposta === atividade.gabarito);
            nota = correta ? 100 : 0;
            status = correta ? 'corrigida' : 'refazer';
        }

        const { data, error } = await supabase
            .from('respostas_atividades')
            .insert([{ atividade_id, aluno_id, resposta, correta, nota, status }])
            .select()
            .single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (err) {
        console.error('Erro POST /api/respostas:', err);
        res.status(500).json({ error: 'Erro ao registrar resposta.' });
    }
});

app.put('/api/respostas/:id/corrigir', async (req, res) => {
    try {
        const { id } = req.params;
        const { nota } = req.body;
        if (nota === undefined) return res.status(400).json({ error: 'A nota é obrigatória.' });

        const status = nota >= 60 ? 'corrigida' : 'refazer';

        const { data, error } = await supabase
            .from('respostas_atividades')
            .update({ nota: nota, status: status, correta: nota >= 60 })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, status: status, data });
    } catch (err) {
        console.error('Erro ao corrigir resposta:', err);
        res.status(500).json({ error: 'Erro ao salvar correção.' });
    }
});

app.get('/api/respostas/:aluno_id', async (req, res) => {
    try {
        const { aluno_id } = req.params;
        const { data, error } = await supabase
            .from('respostas_atividades')
            .select('*, atividades(*)')
            .eq('aluno_id', aluno_id)
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Erro GET /api/respostas:', err);
        res.status(500).json({ error: 'Erro ao listar respostas.' });
    }
});

// ============================================================
// CONSULTAR BOLETIM DO ALUNO (CORRIGIDO)
// ============================================================
app.get('/api/boletim/:aluno_id', async (req, res) => {
    try {
        const { aluno_id } = req.params;

        // 1. Busca as respostas do aluno
        const { data: respostas, error: errorRespostas } = await supabase
            .from('respostas_atividades')
            .select('*')
            .eq('aluno_id', aluno_id)
            .order('created_at', { ascending: false });

        if (errorRespostas) throw errorRespostas;

        // 2. Para cada resposta, busca os dados da atividade correspondente
        const respostasCompletas = await Promise.all(respostas.map(async (resp) => {
            const { data: atividade, error: errorAtv } = await supabase
                .from('atividades')
                .select('area, etapa, competencia, habilidade_codigo, enunciado')
                .eq('id', resp.atividade_id)
                .single();
            
            return {
                ...resp,
                atividades: atividade || {} // Se não achar a atividade, retorna vazio
            };
        }));

        // 3. Calcula a média geral (apenas das atividades corrigidas)
        const atividadesCorrigidas = respostasCompletas.filter(r => r.nota !== null && r.nota !== undefined);
        const mediaGeral = atividadesCorrigidas.length > 0 
            ? (atividadesCorrigidas.reduce((acc, r) => acc + Number(r.nota), 0) / atividadesCorrigidas.length).toFixed(1)
            : 0;

        res.json({ respostas: respostasCompletas, mediaGeral });
    } catch (err) {
        console.error('Erro ao buscar boletim:', err);
        res.status(500).json({ error: 'Erro ao buscar dados do boletim.' });
    }
});

// ============================================================
// CATÁLOGO DE HABILIDADES
// ============================================================
app.get('/api/habilidades', async (req, res) => {
    try {
        const { data, error } = await supabase.from('catalogo_habilidades').select('*').order('codigo', { ascending: true });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Erro GET /api/habilidades:', err);
        res.status(500).json({ error: 'Erro ao listar habilidades.' });
    }
});

// ============================================================
// ROTINA DE NOTIFICAÇÕES (BUSCA ATIVA)
// ============================================================
async function verificarAlunosInativos() {
    try {
        const cincoDiasAtras = new Date();
        cincoDiasAtras.setDate(cincoDiasAtras.getDate() - 5);
        const dataLimite = cincoDiasAtras.toISOString();

        const { data: alunosInativos, error } = await supabase
            .from('alunos')
            .select('id, nome_completo, email, telefone_whatsapp, ultimo_acesso')
            .lt('ultimo_acesso', dataLimite);

        if (error) throw error;

        if (alunosInativos.length === 0) {
            return { success: true, enviados: 0 };
        }

        const mensagensEnviadas = alunosInativos.map(aluno => {
            const dataAcesso = new Date(aluno.ultimo_acesso);
            const hoje = new Date();
            const diasInativo = Math.floor((hoje - dataAcesso) / (1000 * 60 * 60 * 24));

            let numeroLimpo = (aluno.telefone_whatsapp || '').replace(/\D/g, ''); 
            if (numeroLimpo.length === 10 || numeroLimpo.length === 11) numeroLimpo = '55' + numeroLimpo;

            const textoWpp = 
                `Olá *${aluno.nome_completo}*, notamos que *você não acessa a plataforma há ${diasInativo} dias*. Vamos retomar seus estudos?\n\n` +
                `🎓 *Acesse:* https://tutor-nova-eja.vercel.app\n` +
                `👤 *Login:* ${aluno.email}\n` +
                `🔑 *Senha:* Sesi@1234\n\n` +
                `💡 *Tutorial:* Acesse a tela inicial para ver o passo a passo.`;

            const linkWhatsApp = `https://wa.me/${numeroLimpo}?text=${encodeURIComponent(textoWpp)}`;

            return {
                aluno_id: aluno.id,
                aluno: aluno.nome_completo,
                email: aluno.email,
                telefone: aluno.telefone_whatsapp,
                link_whatsapp: linkWhatsApp,
                mensagem_texto: textoWpp,
                dias_inativo: diasInativo
            };
        });

        return { success: true, enviados: alunosInativos.length, detalhes: mensagensEnviadas };
    } catch (err) {
        console.error('Erro na rotina de inativos:', err);
        throw err;
    }
}

app.get('/api/admin/testar-notificacoes', async (req, res) => {
    try {
        const resultado = await verificarAlunosInativos();
        res.json(resultado);
    } catch (err) {
        res.status(500).json({ error: 'Erro ao testar notificações.' });
    }
});

// ============================================================
// HISTÓRICO DE BUSCA ATIVA E ENVIO DE E-MAIL
// ============================================================
app.post('/api/busca-ativa/registrar', async (req, res) => {
    try {
        const { aluno_id, mensagem_enviada, canal, aluno_email, aluno_nome, dias_inativo } = req.body;
        if (!aluno_id) return res.status(400).json({ error: 'O ID do aluno é obrigatório.' });

        // 1. Se o canal for e-mail, dispara o e-mail real
        if (canal === 'Email') {
            if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
                console.warn('⚠️ Credenciais de e-mail não configuradas no Render.');
            } else {
                const mailOptions = {
                    from: `"Tutor IA Nova EJA" <${process.env.EMAIL_USER}>`,
                    to: aluno_email,
                    subject: `Sentimos sua falta, ${aluno_nome}! Vamos estudar?`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
                            <h2 style="color: #1e3a8a;">Olá, ${aluno_nome}!</h2>
                            <p>Notamos que <strong>você não acessa a plataforma há ${dias_inativo} dias</strong>. Estamos com saudades e queremos te ajudar a retomar seus estudos!</p>
                            <p>Clique no botão abaixo para acessar o sistema:</p>
                            <a href="https://tutor-nova-eja.vercel.app" style="display: inline-block; background-color: #1e3a8a; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 16px 0;">Acessar Plataforma</a>
                            <p><strong>Login:</strong> ${aluno_email}</p>
                            <p><strong>Senha:</strong> Sesi@1234</p>
                            <p>Qualquer dúvida, estamos à disposição.</p>
                            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
                            <p style="font-size: 12px; color: #888;">SESI - Serviço Social da Indústria - Nova EJA</p>
                        </div>
                    `
                };
                
                await transporter.sendMail(mailOptions);
                console.log(`✅ E-mail enviado com sucesso para ${aluno_email}`);
            }
        }

        // 2. Registra no banco de dados (tanto para WhatsApp quanto para E-mail)
        const { data, error } = await supabase
            .from('historico_busca_ativa')
            .insert([{ aluno_id, mensagem_enviada, canal: canal || 'WhatsApp' }])
            .select()
            .single();

        if (error) throw error;
        res.status(201).json(data);
    } catch (err) {
        console.error('Erro ao registrar/enviar busca ativa:', err);
        res.status(500).json({ error: 'Erro ao processar o contato.' });
    }
});

app.get('/api/busca-ativa/relatorio/:aluno_id', async (req, res) => {
    try {
        const { aluno_id } = req.params;

        const { data: aluno, error: errorAluno } = await supabase
            .from('alunos')
            .select('*')
            .eq('id', aluno_id)
            .single();

        if (errorAluno) throw errorAluno;

        const { data: historico, error: errorHistorico } = await supabase
            .from('historico_busca_ativa')
            .select('*')
            .eq('aluno_id', aluno_id)
            .order('data_envio', { ascending: false });

        if (errorHistorico) throw errorHistorico;

        res.json({ aluno, historico });
    } catch (err) {
        console.error('Erro ao gerar relatório:', err);
        res.status(500).json({ error: 'Erro ao buscar dados do relatório.' });
    }
});

// ============================================================
// TRATAMENTO GLOBAL DE ERROS
// ============================================================
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Imagem muito grande. Máximo 5MB.' });
        return res.status(400).json({ error: `Erro no upload: ${err.message}` });
    }
    if (err && err.message && err.message.includes('Formato de imagem')) {
        return res.status(400).json({ error: err.message });
    }
    console.error('Erro não tratado:', err);
    res.status(500).json({ error: 'Erro interno no servidor.' });
});

// ============================================================
// INICIALIZAÇÃO
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 Tutor IA - Nova EJA rodando na porta ${PORT}`);
});

module.exports = app;