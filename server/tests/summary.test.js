const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

// El endpoint llama a la API de Anthropic con fetch nativo. Mockeamos el transporte,
// nunca el modulo de la ruta: asi el test ejercita el parseo real de la respuesta.
let db;
let app;

const OLD_KEY = process.env.ANTHROPIC_API_KEY;

// Respuesta realista de un modelo con razonamiento (claude-sonnet-5): el primer
// bloque es 'thinking' y el texto viene despues. Esta es la forma que rompia el codigo.
function claudeReply(text = 'La semana estuvo buena.') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'razonando...', signature: 'sig' },
        { type: 'text', text },
      ],
    }),
  };
}

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      is_active INTEGER DEFAULT 1
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_grams REAL,
      parts_per_plate INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id INTEGER NOT NULL,
      gcode_id INTEGER,
      parts_per_plate INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE TABLE printer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  const now  = Date.now();
  const hour = 3600000;
  const day  = 24 * hour;

  db.prepare('INSERT INTO printers (name, model) VALUES (?, ?)').run('B.E.N.', 'c1');
  db.prepare('INSERT INTO gcodes (material_grams, parts_per_plate) VALUES (?, ?)').run(45, 4);
  // Un trabajo terminado hace 2 dias, de 3 horas, 4 piezas
  db.prepare(`
    INSERT INTO jobs (printer_id, gcode_id, parts_per_plate, status, started_at, finished_at)
    VALUES (1, 1, 4, 'finished', ?, ?)
  `).run(now - 2 * day - 3 * hour, now - 2 * day);
  db.prepare('INSERT INTO printer_events (printer_id, event_type, created_at) VALUES (1, ?, ?)')
    .run('job_failed', now - day);

  app = express();
  app.use(express.json());
  app.use('/api/summary', require('../routes/summary')(db));
});

afterAll(() => {
  db.close();
  if (OLD_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = OLD_KEY;
});

describe('GET /api/summary/weekly', () => {
  // Ojo: summary.js guarda la cache en una variable de modulo, asi que estos tests
  // corren en orden y comparten ese estado a proposito.

  test('returns 503 when the server has no API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    global.fetch = jest.fn();

    const res = await request(app).get('/api/summary/weekly');

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ANTHROPIC_API_KEY/i);
    expect(global.fetch).not.toHaveBeenCalled(); // no gastar una llamada sin key
  });

  // Regresion: claude-sonnet-5 antepone un bloque 'thinking'. Leer content[0].text
  // devolvia undefined y el resumen salia como '(sin texto)', pagando igual la llamada.
  test('extracts the text block even when a thinking block comes first', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue(claudeReply('B.E.N. rindió bien.'));

    const res = await request(app).get('/api/summary/weekly');

    expect(res.status).toBe(200);
    expect(res.body.summary).toBe('B.E.N. rindió bien.');
    expect(res.body.summary).not.toMatch(/sin texto/);
    expect(res.body.cached).toBe(false);
  });

  test('aggregates the week from the DB and sends it to Claude', async () => {
    // Reutiliza la respuesta cacheada del test anterior para los stats
    const res = await request(app).get('/api/summary/weekly');

    expect(res.status).toBe(200);
    expect(res.body.stats.trabajos_completados).toBe(1);
    expect(res.body.stats.piezas).toBe(4);
    expect(res.body.stats.horas_maquina).toBe(3);
    expect(res.body.stats.material_gramos).toBe(45); // 45g/plato * (4 piezas / 4 por plato)
    expect(res.body.stats.fallas).toBe(1);
    expect(res.body.stats.por_impresora).toHaveLength(1);
    expect(res.body.stats.por_impresora[0].nombre).toBe('B.E.N.');
  });

  test('serves from cache without calling Claude again', async () => {
    global.fetch = jest.fn(); // si se llama, el test falla

    const res = await request(app).get('/api/summary/weekly');

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.summary).toBe('B.E.N. rindió bien.');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('?refresh=1 bypasses the cache and calls Claude again', async () => {
    global.fetch = jest.fn().mockResolvedValue(claudeReply('Resumen nuevo.'));

    const res = await request(app).get('/api/summary/weekly?refresh=1');

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.summary).toBe('Resumen nuevo.');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('returns 504 when Claude does not answer in time', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    global.fetch = jest.fn().mockRejectedValue(abort);

    const res = await request(app).get('/api/summary/weekly?refresh=1');

    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/no respondió/i);
  });

  test('returns 502 when Claude answers with an error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid model',
    });

    const res = await request(app).get('/api/summary/weekly?refresh=1');

    expect(res.status).toBe(502);
    expect(res.body.detail).toMatch(/invalid model/);
  });
});
