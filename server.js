// ============================================================
// TUTOR IA - NOVA EJA (SESI) - server.js
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MIDDLEWARES GLOBAIS
// ============================================================
app.use(cors({
    origin: 'https://tutor-nova-eja.vercel.app', // ou '*' para testar
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
// CONFIGURAÇÃO MULTER (memória, para upload direto no Supabase)
// ============================================================
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        const permitidos = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (permitidos.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Formato de imagem não permitido. Use JPG, PNG, WEBP ou GIF.'));
        }
    }
});

// Nome do bucket no Supabase Storage
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

// Middleware simples de autenticação por header (ajuste conforme seu esquema)
// Se você usa JWT em cookie ou header Authorization, adapte aqui.
function autenticarAdmin(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token || token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Não autorizado.' });
    }
    next();
}

// ============================================================
// ROTA RAIZ (health check)
// ============================================================
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Tutor IA - Nova EJA', timestamp: new Date().toISOString() });
});

// ============================================================
// UPLOAD DE IMAGEM
// ============================================================
app.post('/api/upload-imagem', upload.single('imagem'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
        }

        const filePath = gerarNomeArquivo(req.file.originalname);

        const { error: uploadError } = await supabase.storage
            .from(BUCKET_IMAGENS)
            .upload(filePath, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: false
            });

        if (uploadError) {
            console.error('Erro upload Supabase:', uploadError);
            return res.status(500).json({ error: 'Falha ao enviar imagem para o Storage.' });
        }

        const { data: publicUrlData } = supabase.storage
            .from(BUCKET_IMAGENS)
            .getPublicUrl(filePath);

        return res.json({
            success: true,
            url: publicUrlData.publicUrl,
            path: filePath
        });
    } catch (err) {
        console.error('Erro rota /api/upload-imagem:', err);
        return res.status(500).json({ error: 'Erro interno ao processar upload.' });
    }
});

// ============================================================
// AUTENTICAÇÃO
// ============================================================
app.post('/api/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        if (!email || !senha) {
            return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
        }

        // Exemplo: assumindo tabela "usuarios" ou "coordenadores"
        const { data: usuario, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('email', email)
            .maybeSingle();

        if (error) throw error;
        if (!usuario) return res.status(401).json({ error: 'Credenciais inválidas.' });

        const senhaValida = await bcrypt.compare(senha, usuario.senha_hash);
        if (!senhaValida) return res.status(401).json({ error: 'Credenciais inválidas.' });

        // Ajuste para gerar JWT se você usa
        return res.json({
            success: true,
            usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, tipo: usuario.tipo }
        });
    } catch (err) {
        console.error('Erro /api/login:', err);
        return res.status(500).json({ error: 'Erro interno no login.' });
    }
});

// ============================================================
// CHAT COM IA
// ============================================================
app.post('/api/chat', async (req, res) => {
    try {
        const { mensagem, historico = [], aluno_id, atividade_id } = req.body;

        if (!mensagem) {
            return res.status(400).json({ error: 'Mensagem é obrigatória.' });
        }

        // >>> AQUI entra a chamada real da sua IA (OpenAI, Gemini, etc.) <<<
        // Exemplo placeholder:
        const respostaIA = `Resposta simulada para: "${mensagem}"`;

        // (Opcional) Salvar interação no banco
        // await supabase.from('interacoes_chat').insert([...]);

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
            .order('nome', { ascending: true });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Erro GET /api/alunos:', err);
        res.status(500).json({ error: 'Erro ao listar alunos.' });
    }
});

app.post('/api/alunos', async (req, res) => {
    try {
        const { nome, email, senha, matricula, turma } = req.body;
        if (!nome || !email) {
            return res.status(400).json({ error: 'Nome e email são obrigatórios.' });
        }

        const senha_hash = senha ? await bcrypt.hash(senha, 10) : null;

        const { data, error } = await supabase
            .from('alunos')
            .insert([{ nome, email, senha_hash, matricula, turma }])
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
        const { nome, email, matricula, turma } = req.body;

        const { data, error } = await supabase
            .from('alunos')
            .update({ nome, email, matricula, turma })
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
        const { data, error } = await supabase
            .from('murais')
            .select('*')
            .order('created_at', { ascending: false });
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
        if (!titulo || !conteudo) {
            return res.status(400).json({ error: 'Título e conteúdo são obrigatórios.' });
        }
        const { data, error } = await supabase
            .from('murais')
            .insert([{ titulo, conteudo, autor }])
            .select()
            .single();
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
            .select('*')
            .eq('ativa', true)
            .order('id', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Erro GET /api/atividades:', err);
        res.status(500).json({ error: 'Erro ao listar atividades.' });
    }
});

app.get('/api/atividades/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('atividades')
            .select('*')
            .eq('id', id)
            .single();
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Erro GET /api/atividades/:id:', err);
        res.status(500).json({ error: 'Erro ao buscar atividade.' });
    }
});

// CRIAR ATIVIDADE (agora com imagem_url opcional)
app.post('/api/atividades', async (req, res) => {
    try {
        const {
            competencia,
            habilidade_codigo,
            area,
            tipo,
            enunciado,
            alternativas,
            gabarito,
            rubrica_ia,
            imagem_url // <-- NOVO CAMPO
        } = req.body;

        if (!enunciado) {
            return res.status(400).json({ error: 'Enunciado é obrigatório.' });
        }

        const { data, error } = await supabase
            .from('atividades')
            .insert([{
                competencia,
                habilidade_codigo,
                area,
                tipo,
                enunciado,
                alternativas,
                gabarito,
                rubrica_ia,
                imagem_url: imagem_url || null, // <-- salva a URL (ou null)
                ativa: true
            }])
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
        const {
            competencia,
            habilidade_codigo,
            area,
            tipo,
            enunciado,
            alternativas,
            gabarito,
            rubrica_ia,
            imagem_url,
            ativa
        } = req.body;

        const { data, error } = await supabase
            .from('atividades')
            .update({
                competencia,
                habilidade_codigo,
                area,
                tipo,
                enunciado,
                alternativas,
                gabarito,
                rubrica_ia,
                imagem_url,
                ativa
            })
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
        const { atividade_id, aluno_id, resposta, correta } = req.body;
        if (!atividade_id || !aluno_id) {
            return res.status(400).json({ error: 'atividade_id e aluno_id são obrigatórios.' });
        }
        const { data, error } = await supabase
            .from('respostas_atividades')
            .insert([{ atividade_id, aluno_id, resposta, correta }])
            .select()
            .single();
        if (error) throw error;
        res.status(201).json(data);
    } catch (err) {
        console.error('Erro POST /api/respostas:', err);
        res.status(500).json({ error: 'Erro ao registrar resposta.' });
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
// CATÁLOGO DE HABILIDADES
// ============================================================
app.get('/api/habilidades', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('catalogo_habilidades')
            .select('*')
            .order('codigo', { ascending: true });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Erro GET /api/habilidades:', err);
        res.status(500).json({ error: 'Erro ao listar habilidades.' });
    }
});

// ============================================================
// MATRÍCULAS EM ESTUDOS
// ============================================================
app.get('/api/matriculas/:aluno_id', async (req, res) => {
    try {
        const { aluno_id } = req.params;
        const { data, error } = await supabase
            .from('matriculas_estudos')
            .select('*')
            .eq('aluno_id', aluno_id);
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('Erro GET /api/matriculas:', err);
        res.status(500).json({ error: 'Erro ao listar matrículas.' });
    }
});

// ============================================================
// TRATAMENTO GLOBAL DE ERROS
// ============================================================
app.use((err, req, res, next) => {
    // Erros específicos do Multer
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'Imagem muito grande. Máximo 5MB.' });
        }
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
    console.log(`📦 Bucket de imagens: ${BUCKET_IMAGENS}`);
});

module.exports = app;