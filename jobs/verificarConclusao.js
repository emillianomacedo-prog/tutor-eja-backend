// jobs/verificarConclusao.js
const { supabase } = require('../middleware/auth');
const nodemailer = require('nodemailer');

// Anti-spam: 1 notificação por dia por aluno
const ENVIADOS = new Map();
const INTERVALO_MIN_MS = 24 * 60 * 60 * 1000;

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return null;
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return transporter;
}

/**
 * Verifica se o aluno ficou apto à certificação.
 * Se sim, cria alerta in-app + envia e-mail ao coordenador (1x por dia).
 */
async function verificarConclusao(aluno_id) {
  try {
    // 1. Chama a função SQL
    const { data, error } = await supabase.rpc('verificar_aproveitamento', {
      p_aluno_id: aluno_id,
    });
    if (error) throw error;
    if (!data || data.length === 0) return { apto: false };

    const apto = data.every((c) => c.apto_certificacao);
    if (!apto) return { apto: false };

    // 2. Anti-spam
    const ultimo = ENVIADOS.get(aluno_id);
    if (ultimo && Date.now() - ultimo < INTERVALO_MIN_MS) {
      return { apto: true, notificado: false };
    }

    // 3. Busca matrícula ativa do aluno (necessária para o alerta)
    const { data: matricula } = await supabase
      .from('matriculas_estudos')
      .select('id')
      .eq('aluno_id', aluno_id)
      .eq('status', 'ativa')
      .maybeSingle();

    if (!matricula) {
      console.warn('[verificarConclusao] Aluno sem matrícula ativa:', aluno_id);
      return { apto: true, notificado: false, erro: 'sem matrícula ativa' };
    }

    // 4. Alerta in-app
    await supabase.from('alertas_coordenacao').insert({
      matricula_id: matricula.id,
      tipo: 'apto_certificacao',
      mensagem_original:
        'Aluno atingiu a nota mínima em todas as competências. Apto à certificação.',
      status: 'pendente',
    });

    // 5. E-mail ao coordenador
    const { data: coords } = await supabase
      .from('coordenadores')
      .select('email, nome')
      .eq('papel', 'coordenador')
      .limit(5);

    const { data: aluno } = await supabase
      .from('alunos')
      .select('nome_completo')
      .eq('id', aluno_id)
      .single();

    const mailer = getTransporter();
    if (mailer && coords && coords.length > 0) {
      const emails = coords.map((c) => c.email).filter(Boolean);
      if (emails.length > 0) {
        try {
          await mailer.sendMail({
            from: `"Tutor IA Nova EJA" <${process.env.GMAIL_USER}>`,
            to: emails.join(','),
            subject: `✅ Aluno apto à certificação: ${aluno?.nome_completo || aluno_id}`,
            html: `
              <p>Olá, coordenação!</p>
              <p>O aluno <strong>${aluno?.nome_completo || aluno_id}</strong>
                 atingiu a nota mínima em todas as competências e está
                 <strong>apto à certificação</strong>.</p>
              <p>Verifique o boletim completo no painel do coordenador.</p>
              <p>— Tutor IA Nova EJA (SESI)</p>
            `,
          });
        } catch (mailErr) {
          console.error('[verificarConclusao] e-mail falhou:', mailErr.message);
        }
      }
    }

    ENVIADOS.set(aluno_id, Date.now());
    return { apto: true, notificado: true };
  } catch (err) {
    console.error('[verificarConclusao]', err);
    return { apto: false, erro: err.message };
  }
}

module.exports = { verificarConclusao };