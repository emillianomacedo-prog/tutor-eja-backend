// routes/murais.js
const express = require('express');
const router = express.Router();
const { supabase, requireAluno, requirePapel } = require('../middleware/auth');
const { mediarMural, avaliarMural } = require('../services/avaliacaoIA');

const MAX_TENTATIVAS = 5; // mural é mais livre que atividade

// =====================================================================
// GET /api/murais?area=linguagens
// Lista murais + status do aluno
// =====================================================================
router.get('/', requireAluno, async (req, res) => {
  try {
    const { area } = req.query;
    let q = supabase
      .from('murais')
      .select('id, titulo, texto_base, area, competencia')
      .eq('ativo', true);
    if (area) q = q.eq('area', area);

    const { data: murais, error } = await q.order('created_at');
    if (error) throw error;
    if (!murais || murais.length === 0) {
      return res.json({ murais: [] });
    }

    const ids = murais.map((m) => m.id);
    const { data: postagens } = await supabase
      .from('postagens_murais')
      .select('mural_id, status, nota_ia, tentativas, feedback_ia')
      .eq('aluno_id', req.user.aluno_id)
      .in('mural_id', ids);

    const mapa = Object.fromEntries((postagens || []).map((p) => [p.mural_id, p]));

    return res.json({
      murais: murais.map((m) => ({
        ...m,
        status: mapa[m.id]?.status || 'INICIAR',
        nota_ia: mapa[m.id]?.nota_ia ?? null,
        tentativas: mapa[m.id]?.tentativas || 0,
        feedback_ia: mapa[m.id]?.feedback_ia || null,
      })),
    });
  } catch (err) {
    console.error('[murais GET]', err);
    return res.status(500).json({ error: 'Erro ao listar murais' });
  }
});

// =====================================================================
// POST /api/murais/:id/iniciar
// =====================================================================
router.post('/:id/iniciar', requireAluno, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('postagens_murais')
      .upsert(
        {
          mural_id: req.params.id,
          aluno_id: req.user.aluno_id,
          status: 'EM_ANDAMENTO',
        },
        { onConflict: 'mural_id,aluno_id', ignoreDuplicates: false }
      )
      .select()
      .single();
    if (error) throw error;
    return res.json({ postagem: data });
  } catch (err) {
    console.error('[murais iniciar]', err);
    return res.status(500).json({ error: 'Erro ao iniciar mural' });
  }
});

// =====================================================================
// PATCH /api/murais/:id/rascunho
// =====================================================================
router.patch('/:id/rascunho', requireAluno, async (req, res) => {
  try {
    const { rascunho } = req.body;
    const { data, error } = await supabase
      .from('postagens_murais')
      .update({ rascunho })
      .eq('mural_id', req.params.id)
      .eq('aluno_id', req.user.aluno_id)
      .select()
      .single();
    if (error) throw error;
    return res.json({ postagem: data });
  } catch (err) {
    console.error('[murais rascunho]', err);
    return res.status(500).json({ error: 'Erro ao salvar rascunho' });
  }
});

// =====================================================================
// POST /api/murais/:id/mediar  (IA instiga, NÃO dá nota)
// =====================================================================
router.post('/:id/mediar', requireAluno, async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto || !texto.trim()) {
      return res.status(400).json({ error: 'Texto vazio' });
    }

    const { data: mural } = await supabase
      .from('murais')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (!mural) return res.status(404).json({ error: 'Mural não encontrado' });

    const resultado = await mediarMural({
      mural,
      textoAluno: texto.trim(),
      competencia: mural.competencia,
      segmento: req.user.segmento,
    });

    await supabase
      .from('postagens_murais')
      .upsert(
        {
          mural_id: mural.id,
          aluno_id: req.user.aluno_id,
          texto: texto.trim(),
          status: 'EM_ANDAMENTO',
        },
        { onConflict: 'mural_id,aluno_id', ignoreDuplicates: false }
      );

    return res.json({ mediacao: resultado });
  } catch (err) {
    console.error('[murais mediar]', err);
    return res.status(500).json({ error: 'Erro na mediação' });
  }
});

// =====================================================================
// POST /api/murais/:id/avaliar  (IA dá nota 0-100)
// =====================================================================
router.post('/:id/avaliar', requireAluno, async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto || !texto.trim()) {
      return res.status(400).json({ error: 'Texto vazio' });
    }

    const { data: mural } = await supabase
      .from('murais')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (!mural) return res.status(404).json({ error: 'Mural não encontrado' });

    const { data: atual } = await supabase
      .from('postagens_murais')
      .select('tentativas, status')
      .eq('mural_id', mural.id)
      .eq('aluno_id', req.user.aluno_id)
      .maybeSingle();

    if (atual?.status === 'FINALIZADA') {
      return res.status(400).json({ error: 'Mural já finalizado.' });
    }

    const tentativas = (atual?.tentativas || 0) + 1;
    if (tentativas > MAX_TENTATIVAS) {
      await supabase.from('alertas_coordenacao').insert({
        matricula_id: req.user.matricula_id,
        tipo: 'mural_refazer_limite',
        mensagem_original: `Aluno ${req.user.nome_completo} excedeu ${MAX_TENTATIVAS} tentativas no mural ${mural.id}.`,
        status: 'pendente',
      });
      return res.status(429).json({ error: 'Limite de tentativas excedido.' });
    }

    const resultado = await avaliarMural({
      mural,
      textoAluno: texto.trim(),
      competencia: mural.competencia,
      segmento: req.user.segmento,
    });

    const { data, error } = await supabase
      .from('postagens_murais')
      .upsert(
        {
          mural_id: mural.id,
          aluno_id: req.user.aluno_id,
          texto: texto.trim(),
          rascunho: null,
          nota_ia: resultado.nota,
          feedback_ia: resultado.feedback,
          status: resultado.status_sugerido,
          tentativas,
          avaliado_em: new Date().toISOString(),
          submetido_em: new Date().toISOString(),
        },
        { onConflict: 'mural_id,aluno_id', ignoreDuplicates: false }
      )
      .select()
      .single();

    if (error) throw error;

    if (data.status === 'FINALIZADA') {
      try {
        const { verificarConclusao } = require('../jobs/verificarConclusao');
        await verificarConclusao(req.user.aluno_id);
      } catch (jobErr) {
        console.warn('[murais avaliar] verificarConclusao falhou:', jobErr.message);
      }
    }

    return res.json({
      postagem: data,
      resultado_ia: {
        pontos_fortes: resultado.pontos_fortes || [],
        pontos_a_melhorar: resultado.pontos_a_melhorar || [],
      },
    });
  } catch (err) {
    console.error('[murais avaliar]', err);
    return res.status(500).json({ error: 'Erro na avaliação' });
  }
});

// =====================================================================
// POST /api/murais (coordenador/professor cria mural)
// =====================================================================
router.post('/', requirePapel('coordenador', 'professor'), async (req, res) => {
  try {
    const { titulo, texto_base, area, competencia, rubrica_ia } = req.body;
    if (!titulo || !texto_base || !area) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }
    const { data, error } = await supabase
      .from('murais')
      .insert({
        titulo,
        texto_base,
        area,
        competencia: competencia || null,
        rubrica_ia: rubrica_ia || null,
      })
      .select()
      .single();
    if (error) throw error;
    return res.status(201).json({ mural: data });
  } catch (err) {
    console.error('[murais POST]', err);
    return res.status(500).json({ error: 'Erro ao criar mural' });
  }
});

module.exports = router;