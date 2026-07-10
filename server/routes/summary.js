const express = require('express');
const router  = express.Router();

// Trabajos completados (incluye alias legacy 'done')
const DONE    = "('finished','done')";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// El resumen semanal cambia lento, así que lo cacheamos: evita pagar una llamada
// a Claude por cada request (p. ej. una página que refresca o recarga).
const CACHE_TTL_MS      = 60 * 60 * 1000; // 1 hora
const CLAUDE_TIMEOUT_MS = 30 * 1000;      // corta el fetch si Anthropic no responde

// Un solo slot: el endpoint no toma parámetros, así que hay un único resumen vigente.
let cache = null; // { at: number, payload: { stats, summary } }

module.exports = (db) => {
  // GET /api/summary/weekly — agrega los últimos 7 días y le pide a Claude un resumen en lenguaje natural.
  router.get('/weekly', async (req, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Falta ANTHROPIC_API_KEY en el entorno del servidor.' });
    }

    // Sirve desde caché salvo que se pida ?refresh=1 (o refresh=true).
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    if (!force && cache && (Date.now() - cache.at) < CACHE_TTL_MS) {
      return res.json({ ...cache.payload, cached: true, generated_at: cache.at });
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
      // AbortController corta el fetch si Anthropic no responde a tiempo, así el
      // request no queda colgado indefinidamente (fetch no trae timeout propio).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

      let r;
      try {
        r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type':     'application/json',
            'x-api-key':        apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model:      'claude-sonnet-5',
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
      } catch (err) {
        if (err.name === 'AbortError') {
          return res.status(504).json({ error: `La API de Claude no respondió en ${CLAUDE_TIMEOUT_MS / 1000}s.` });
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }

      if (!r.ok) {
        const detail = await r.text();
        return res.status(502).json({ error: 'La API de Claude devolvió un error.', detail });
      }

      const data    = await r.json();
      const summary = data.content?.[0]?.text ?? '(sin texto)';
      const payload = { stats, summary };

      cache = { at: Date.now(), payload };
      res.json({ ...payload, cached: false, generated_at: cache.at });

    } catch (err) {
      console.error('summary/weekly error:', err);
      res.status(500).json({ error: 'No se pudo generar el resumen.', detail: String(err.message || err) });
    }
  });

  return router;
};