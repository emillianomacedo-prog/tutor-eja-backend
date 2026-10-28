// routes/oficinas.js
const express = require('express');
const router = express.Router();
const { supabase, requirePapel } = require('../middleware/auth');

// =====================================================================
// POST /api/oficinas  (coordenador lança nota de oficina por área)
// Body: { aluno_id, area, nota, data_oficina?, observacao? }
// Faz UPSERT pela UNIQUE (aluno_id, area)
// =====================================================================
router.post('/', requirePapel('coordenador'), async (req, res) => {
  try {
    const { aluno_id, area, nota, data_oficina, observacao } = req.body;
    if (!aluno_id || !area || nota == null) {
      return res.status(400).json({ error: 'aluno_id, area e nota são obrigatórios' });
    }
    if (nota < 0 || nota > 100) {
      return res.status(400).json({ error: 'Nota deve estar entre 0 e 100' });
    }

    const { data, error } = await supabase
      .from('oficinas_presenciais')
      .upsert(
        {
          aluno_id,
          area,
          nota,
          data_oficina: data_oficina || null,
          observacao: observacao || null,
          coordenador_id: req.user.coord_id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'aluno_id,area', ignoreDuplicates: false }
      )
      .select()
      .single();

    if (error) throw error;

    // Se ao menos uma oficina está completa, checa conclusão
    const { verificarConclusao } = require('../jobs/verificarConclusao');
    await verificarConclusao(aluno_id);

    return res.json({ oficina: data });
  } catch (err) {
    console.error('[oficinas POST]', err);
    return res.status(500).json({ error: 'Erro ao lançar oficina' });
  }
});

// =====================================================================
// GET /api/oficinas/:aluno_id  (coordenador vê as oficinas do aluno)
// =====================================================================
router.get('/:aluno_id', requirePapel('coordenador', 'professor'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('oficinas_presenciais')
      .select('*')
      .eq('aluno_id', req.params.aluno_id)
      .order('area');
    if (error) throw error;
    return res.json({ oficinas: data || [] });
  } catch (err) {
    console.error('[oficinas GET]', err);
    return res.status(500).json({ error: 'Erro ao buscar oficinas' });
  }
});

module.exports = router;