const express = require('express');
const router  = express.Router();

// Trabajos completados (incluye alias legacy 'done')
const DONE    = "('finished','done')";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

module.exports = (db) => {
  // GET /api/summary/weekly — agrega los últimos 7 días y le pide a Claude un resumen en lenguaje natural.
  router.get('/weekly', async (req, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Falta ANTHROPIC_API_KEY en el entorno del servidor.' });
    }

    const since = Date.now() - WEEK_MS;

    try {
      // ── Totales de la semana ────────────────────────────────────────────
      const totals = db.prepare(`
        SELECT
          COUNT(*)                                        AS jobs_done,
          COALESCE(SUM(parts_per_plate), 0)               AS parts,
          COALESCE(SUM(finished_at - started_at), 0) / 3600000.0 AS machine_hours
        FROM jobs
        WHERE status IN ${DONE} AND finished_at >= ?
      `).get(since);

      const material = db.prepare(`
        SELECT COALESCE(SUM(g.material_grams * 1.0 / g.parts_per_plate * j.parts_per_plate), 0) AS grams
        FROM jobs j
        JOIN gcodes g ON g.id = j.gcode_id
        WHERE j.status IN ${DONE} AND j.finished_at >= ? AND g.material_grams IS NOT NULL
      `).get(since);

      const failures = db.prepare(`
        SELECT COUNT(*) AS n FROM printer_events
        WHERE event_type IN ('job_failed', 'job_cancelled') AND created_at >= ?
      `).get(since).n;

      // ── Desglose por impresora (incluye las que no imprimieron nada) ─────
      const perPrinter = db.prepare(`
        SELECT p.name, p.model,
          COUNT(j.id)                                     AS jobs,
          COALESCE(SUM(j.parts_per_plate), 0)             AS parts,
          COALESCE(SUM(j.finished_at - j.started_at), 0) / 3600000.0 AS hours
        FROM printers p
        LEFT JOIN jobs j
          ON j.printer_id = p.id AND j.status IN ${DONE} AND j.finished_at >= ?
        WHERE p.is_active = 1
        GROUP BY p.id
        ORDER BY parts DESC
      `).all(since);

      const stats = {
        rango:                'últimos 7 días',
        trabajos_completados: totals.jobs_done,
        piezas:               totals.parts,
        horas_maquina:        Math.round(totals.machine_hours * 10) / 10,
        material_gramos:      Math.round(material.grams),
        fallas:               failures,
        por_impresora: perPrinter.map(r => ({
          nombre:   r.name,
          modelo:   r.model,
          trabajos: r.jobs,
          piezas:   r.parts,
          horas:    Math.round(r.hours * 10) / 10,
        })),
      };

      // ── Llamada a la API de Claude (fetch nativo, sin SDK) ───────────────
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type':     'application/json',
          'x-api-key':        apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-5',
          max_tokens: 400,
          system:
            'Eres el asistente de una granja de impresión 3D (Fábrica 3D). ' +
            'Escribe en español chileno, tono directo y práctico, sin relleno. ' +
            'Resume la semana en 3-4 frases: destaca lo relevante (qué robot rindió más, ' +
            'fallas si las hubo, material usado) y una sugerencia si algo llama la atención. ' +
            'No inventes datos fuera del JSON entregado.',
          messages: [
            { role: 'user', content: `Datos de la semana:\n${JSON.stringify(stats, null, 2)}` },
          ],
        }),
      });

      if (!r.ok) {
        const detail = await r.text();
        return res.status(502).json({ error: 'La API de Claude devolvió un error.', detail });
      }

      const data    = await r.json();
      const summary = data.content?.[0]?.text ?? '(sin texto)';
      res.json({ stats, summary });

    } catch (err) {
      console.error('summary/weekly error:', err);
      res.status(500).json({ error: 'No se pudo generar el resumen.', detail: String(err.message || err) });
    }
  });

  return router;
};