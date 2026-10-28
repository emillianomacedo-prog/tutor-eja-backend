// =====================================================================
// TUTOR IA - NOVA EJA (SESI) - Backend
// Node.js + Express + Supabase + Gemini (failover Groq)
// =====================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { authMiddleware } = require('./middleware/auth');

// --- Rotas NOVAS (regra 40/40/20, mural, atividades, oficinas, boletim) ---
const atividadesRouter = require('./routes/atividades');
const muraisRouter     = require('./routes/murais');
const oficinasRouter   = require('./routes/oficinas');
const boletimRouter    = require('./routes/boletim');

// --- Rotas EXISTENTES (mantenha os arquivos que você já tem) ---
// Descomente à medida que confirmar os caminhos reais:
// const authRouter      = require('./routes/auth');       // login aluno/coordenador
// const chatRouter      = require('./routes/chat');       // chat com RAG
// const relatorioRouter = require('./routes/relatorio');  // relatório final
// const coordenadorRouter = require('./routes/coordenador'); // painel admin

const app = express();

// =====================================================================
// 1. MIDDLEWARES GLOBAIS
// =====================================================================

app.use(helmet());

// CORS: libera o frontend do Vercel + localhost para dev
const ORIGENS_PERMITIDAS = [
  'https://tutor-nova-eja.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5500',
];

app.use(cors({
  origin: (origin, callback) => {
    // Permite requisições sem Origin (curl, Postman, healthcheck do Render)
    if (!origin) return callback(null, true);
    if (ORIGENS_PERMITIDAS.includes(origin)) return callback(null, true);
    // Em dev, aceita qualquer subdomínio do Vercel de preview
    if (/\.vercel\.app$/.test(origin)) return callback(null, true);
    return callback(new Error(`Origem não permitida: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));

// Rate limit básico (protege contra abuso)
app.use(rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 120,            // 120 req/min por IP
  standardHeaders: true,
  legacyHeaders: false,
}));

// Log simples de requisição
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// =====================================================================
// 2. HEALTHCHECK (Render usa para saber se está vivo)
// =====================================================================
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    servico: 'Tutor IA - Nova EJA (SESI)',
    versao: '2.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

// =====================================================================
// 3. ROTAS PÚBLICAS (não exigem JWT)
// =====================================================================
// Descomente quando confirmar o arquivo:
// app.use('/api/auth', authRouter);

// =====================================================================
// 4. ROTAS AUTENTICADAS (exigem JWT do Supabase)
// =====================================================================

// --- Rotas NOVAS (turno 2) ---
app.use('/api/atividades', authMiddleware, atividadesRouter);
app.use('/api/murais',     authMiddleware, muraisRouter);
app.use('/api/oficinas',   authMiddleware, oficinasRouter);
app.use('/api/boletim',    authMiddleware, boletimRouter);

// --- Rotas EXISTENTES (reaproveitadas) ---
// app.use('/api/chat',       authMiddleware, chatRouter);
// app.use('/api/relatorio',  authMiddleware, relatorioRouter);
// app.use('/api/coordenador', authMiddleware, coordenadorRouter);

// =====================================================================
// 5. 404 (rota não encontrada)
// =====================================================================
app.use((req, res) => {
  res.status(404).json({
    error: 'Rota não encontrada',
    path: req.path,
    method: req.method,
  });
});

// =====================================================================
// 6. TRATAMENTO GLOBAL DE ERROS
// =====================================================================
app.use((err, req, res, _next) => {
  console.error('[ERRO GLOBAL]', {
    path: req.path,
    method: req.method,
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });

  // Erro de CORS
  if (err.message && err.message.startsWith('Origem não permitida')) {
    return res.status(403).json({ error: err.message });
  }

  // Erro de JSON malformado
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido no corpo da requisição' });
  }

  return res.status(err.status || 500).json({
    error: err.message || 'Erro interno do servidor',
  });
});

// =====================================================================
// 7. START DO SERVIDOR
// =====================================================================
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 Tutor IA - Nova EJA (SESI) rodando na porta ${PORT}`);
  console.log(`   Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Rotas novas: /api/atividades, /api/murais, /api/oficinas, /api/boletim`);
});

// Graceful shutdown (Render envia SIGTERM ao reiniciar)
process.on('SIGTERM', () => {
  console.log('SIGTERM recebido, encerrando...');
  process.exit(0);
});

module.exports = app;