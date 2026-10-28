// routes/boletim.js
const express = require('express');
const router = express.Router();
const { supabase, requireAluno, requirePapel } = require('../middleware/auth');

// =====================================================================
// GET /api/boletim  (aluno vê o próprio boletim)
// =====================================================================
router.get('/', requireAluno, async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('verificar_aproveitamento', {
      p_aluno_id: req.user.aluno_id,
    });
    if (error) throw error;

    const apto = (data || []).length > 0 && data.every((c) => c.apto_certificacao);

    // Agrupa por área para facilitar o frontend
    const porArea = {};
    for (const c of data || []) {
      if (!porArea[c.area]) porArea[c.area] = [];
      porArea[c.area].push(c);
    }

    return res.json({
      aluno: {
        id: req.user.aluno_id,
        nome_completo: req.user.nome_completo,
        segmento: req.user.segmento,
        turma: req.user.turma,
      },
      competencias: data || [],
      por_area: porArea,
      apto_certificacao: apto,
      total_competencias: (data || []).length,
      total_aprovadas: (data || []).filter((c) => c.aprovado_competencia).length,
    });
  } catch (err) {
    console.error('[boletim GET]', err);
    return res.status(500).json({ error: 'Erro ao gerar boletim' });
  }
});

// =====================================================================
// GET /api/boletim/:aluno_id  (coordenador vê o boletim de um aluno)
// =====================================================================
router.get('/:aluno_id', requirePapel('coordenador', 'professor'), async (req, res) => {
  try {
    const { aluno_id } = req.params;

    const { data: aluno } = await supabase
      .from('alunos')
      .select('id, nome_completo')
      .eq('id', aluno_id)
      .single();
    if (!aluno) return res.status(404).json({ error: 'Aluno não encontrado' });

    const { data: matricula } = await supabase
      .from('matriculas_estudos')
      .select('segmento, turma')
      .eq('aluno_id', aluno_id)
      .eq('status', 'ativa')
      .maybeSingle();

    const { data, error } = await supabase.rpc('verificar_aproveitamento', {
      p_aluno_id: aluno_id,
    });
    if (error) throw error;

    const apto = (data || []).length > 0 && data.every((c) => c.apto_certificacao);

    return res.json({
      aluno: { ...aluno, segmento: matricula?.segmento, turma: matricula?.turma },
      competencias: data || [],
      apto_certificacao: apto,
      total_competencias: (data || []).length,
      total_aprovadas: (data || []).filter((c) => c.aprovado_competencia).length,
    });
  } catch (err) {
    console.error('[boletim GET/:id]', err);
    return res.status(500).json({ error: 'Erro ao gerar boletim' });
  }
});

module.exports = router;