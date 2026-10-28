// routes/atividades.js
const express = require('express');
const router = express.Router();
const { supabase, requireAluno, requirePapel } = require('../middleware/auth');
const { avaliarAtividade } = require('../services/avaliacaoIA');

const MAX_TENTATIVAS = 3;

// =====================================================================
// GET /api/atividades?competencia=C1
// Aluno lista atividades da competência + status dele em cada uma
// =====================================================================
router.get('/', requireAluno, async (req, res) => {
  try {
    const { competencia } = req.query;
    if (!competencia) {
      return res.status(400).json({ error: 'competencia é obrigatória' });
    }

    const { data: atividades, error: errAtiv } = await supabase
      .from('atividades')
      .select('id, competencia, area, tipo, enunciado, alternativas, pontuacao_max')
      .eq('competencia', competencia)
      .eq('ativa', true)
      .order('created_at');

    if (errAtiv) throw errAtiv;
    if (!atividades || atividades.length === 0) {
      return res.json({ atividades: [] });
    }

    const ids = atividades.map((a) => a.id);
    const { data: respostas, error: errResp } = await supabase
      .from('respostas_atividades')
      .select('atividade_id, status, nota, tentativas, feedback')
      .eq('aluno_id', req.user.aluno_id)
      .in('atividade_id', ids);

    if (errResp) throw errResp;

    const mapa = Object.fromEntries((respostas || []).map((r) => [r.atividade_id, r]));

    const resultado = atividades.map((a) => ({
      ...a,
      status: mapa[a.id]?.status || 'INICIAR',
      nota: mapa[a.id]?.nota ?? null,
      tentativas: mapa[a.id]?.tentativas || 0,
      feedback: mapa[a.id]?.feedback || null,
    }));

    return res.json({ atividades: resultado });
  } catch (err) {
    console.error('[atividades GET]', err);
    return res.status(500).json({ error: 'Erro ao listar atividades' });
  }
});

// =====================================================================
// POST /api/atividades/:id/iniciar
// INICIAR -> EM_ANDAMENTO
// =====================================================================
router.post('/:id/iniciar', requireAluno, async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('respostas_atividades')
      .upsert(
        {
          atividade_id: id,
          aluno_id: req.user.aluno_id,
          status: 'EM_ANDAMENTO',
        },
        { onConflict: 'atividade_id,aluno_id', ignoreDuplicates: false }
      )
      .select()
      .single();

    if (error) throw error;
    return res.json({ resposta: data });
  } catch (err) {
    console.error('[atividades iniciar]', err);
    return res.status(500).json({ error: 'Erro ao iniciar atividade' });
  }
});

// =====================================================================
// PATCH /api/atividades/:id/rascunho
// Autosave do rascunho (não submete)
// =====================================================================
router.patch('/:id/rascunho', requireAluno, async (req, res) => {
  try {
    const { id } = req.params;
    const { rascunho } = req.body;

    const { data, error } = await supabase
      .from('respostas_atividades')
      .update({ rascunho })
      .eq('atividade_id', id)
      .eq('aluno_id', req.user.aluno_id)
      .select()
      .single();

    if (error) throw error;
    return res.json({ resposta: data });
  } catch (err) {
    console.error('[atividades rascunho]', err);
    return res.status(500).json({ error: 'Erro ao salvar rascunho' });
  }
});

// =====================================================================
// POST /api/atividades/:id/responder
// Submete, corrige (gabarito ou IA) e retorna o status final
// =====================================================================
router.post('/:id/responder', requireAluno, async (req, res) => {
  try {
    const { id } = req.params;
    const { resposta } = req.body;

    if (!resposta || !resposta.trim()) {
      return res.status(400).json({ error: 'Resposta vazia' });
    }

    // 1. Busca atividade
    const { data: atividade, error: errAtiv } = await supabase
      .from('atividades')
      .select('*')
      .eq('id', id)
      .single();
    if (errAtiv || !atividade) {
      return res.status(404).json({ error: 'Atividade não encontrada' });
    }

    // 2. Estado atual do aluno
    const { data: atual } = await supabase
      .from('respostas_atividades')
      .select('tentativas, status')
      .eq('atividade_id', id)
      .eq('aluno_id', req.user.aluno_id)
      .maybeSingle();

    if (atual?.status === 'FINALIZADA') {
      return res.status(400).json({
        error: 'Atividade já finalizada. Não é possível refazer.',
      });
    }

    const tentativas = (atual?.tentativas || 0) + 1;

    // 3. Regra de 3 tentativas -> bloqueia e alerta coordenador
    if (tentativas > MAX_TENTATIVAS) {
      await supabase.from('alertas_coordenacao').insert({
        matricula_id: req.user.matricula_id,
        tipo: 'atividade_refazer_limite',
        mensagem_original: `Aluno ${req.user.nome_completo} excedeu ${MAX_TENTATIVAS} tentativas na atividade ${id}.`,
        status: 'pendente',
      });
      return res.status(429).json({
        error: 'Limite de tentativas excedido. Coordenação foi notificada.',
      });
    }

    // 4. Avalia (gabarito ou IA)
    const resultado = await avaliarAtividade({
      atividade,
      resposta: resposta.trim(),
      competencia: atividade.competencia,
      segmento: req.user.segmento,
    });

    // 5. Persiste (trigger do banco consolida FINALIZADA/REFAZER)
    const { data, error } = await supabase
      .from('respostas_atividades')
      .upsert(
        {
          atividade_id: id,
          aluno_id: req.user.aluno_id,
          resposta: resposta.trim(),
          rascunho: null,
          nota: resultado.nota,
          feedback: resultado.feedback,
          status: resultado.status_sugerido,
          tentativas,
          corrigido_por: resultado.corrigido_por,
          corrigido_em: new Date().toISOString(),
          submetido_em: new Date().toISOString(),
        },
        { onConflict: 'atividade_id,aluno_id', ignoreDuplicates: false }
      )
      .select()
      .single();

    if (error) throw error;

    // 6. Se FINALIZADA, checa se o aluno ficou apto à certificação
    if (data.status === 'FINALIZADA') {
      try {
        const { verificarConclusao } = require('../jobs/verificarConclusao');
        await verificarConclusao(req.user.aluno_id);
      } catch (jobErr) {
        console.warn('[atividades responder] verificarConclusao falhou:', jobErr.message);
      }
    }

    return res.json({
      resposta: data,
      resultado_ia: {
        pontos_fortes: resultado.pontos_fortes || [],
        pontos_a_melhorar: resultado.pontos_a_melhorar || [],
      },
    });
  } catch (err) {
    console.error('[atividades responder]', err);
    return res.status(500).json({ error: 'Erro ao avaliar resposta' });
  }
});

// =====================================================================
// POST /api/atividades (coordenador/professor cria atividade)
// =====================================================================
router.post('/', requirePapel('coordenador', 'professor'), async (req, res) => {
  try {
    const {
      competencia, area, tipo, enunciado, alternativas, gabarito, rubrica_ia,
    } = req.body;

    if (!competencia || !area || !tipo || !enunciado) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }
    if (tipo === 'objetiva' && (!alternativas || !gabarito)) {
      return res.status(400).json({ error: 'Objetiva exige alternativas e gabarito' });
    }

    const { data, error } = await supabase
      .from('atividades')
      .insert({
        competencia,
        area,
        tipo,
        enunciado,
        alternativas: alternativas || null,
        gabarito: gabarito || null,
        rubrica_ia: rubrica_ia || null,
        professor_id: req.user.coord_id,
      })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json({ atividade: data });
  } catch (err) {
    console.error('[atividades POST]', err);
    return res.status(500).json({ error: 'Erro ao criar atividade' });
  }
});

module.exports = router;