const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

let db;
let app;

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'draft',
      priority INTEGER DEFAULT 0,
      required_material TEXT,
      required_color TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      target_qty INTEGER NOT NULL,
      completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER REFERENCES parts(id),  -- nullable: null = in the Library, no Part
      printer_model TEXT NOT NULL,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL,
      est_print_secs INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ip TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER NOT NULL REFERENCES printers(id),
      gcode_id INTEGER REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL
    );
  `);

  const now = Date.now();
  db.prepare('INSERT INTO printers (name, ip, api_key, model, created_at) VALUES (?,?,?,?,?)')
    .run('P1', '192.168.1.1', 'k', 'mk4s', now);

  app = express();
  app.use(express.json());
  app.use('/api/projects', require('../routes/projects')(db));
});

afterAll(() => db.close());

function insertProject(status = 'draft', name = 'Proj') {
  const now = Date.now();
  return db.prepare(
    'INSERT INTO projects (name, status, created_at, updated_at) VALUES (?,?,?,?)'
  ).run(name, status, now, now).lastInsertRowid;
}

function insertPart(projectId) {
  const now = Date.now();
  return db.prepare(
    'INSERT INTO parts (project_id, name, target_qty, created_at, updated_at) VALUES (?,?,10,?,?)'
  ).run(projectId, 'Part', now, now).lastInsertRowid;
}

function insertGcode(partId, filename) {
  const now = Date.now();
  return db.prepare(
    'INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (?,?,?,?,1,?)'
  ).run(partId, 'mk4s', filename, filename, now).lastInsertRowid;
}

describe('DELETE /api/projects/:id', () => {
  test('returns 404 for an unknown id', async () => {
    const res = await request(app).delete('/api/projects/99999');
    expect(res.status).toBe(404);
  });

  test('refuses to delete a non-draft project', async () => {
    const id = insertProject('active');
    const res = await request(app).delete(`/api/projects/${id}`);
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(id)).toBeDefined();
  });

  test('deletes the project, its parts and gcodes, and the files on disk', async () => {
    const projId   = insertProject();
    const partId   = insertPart(projId);
    const filename = `proj_del_${Date.now()}.bgcode`;
    const filePath = path.join(GCODE_DIR, filename);
    fs.writeFileSync(filePath, 'fake gcode');
    insertGcode(partId, filename);

    const res = await request(app).delete(`/api/projects/${projId}`);

    expect(res.status).toBe(200);
    expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(projId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM parts WHERE id = ?').get(partId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM gcodes WHERE part_id = ?').get(partId)).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  // Regression: a reused G-code is one physical file shared by rows across Parts
  // (and Projects). Deleting one project must not unlink a file another Part needs.
  test('keeps the physical file when a part in ANOTHER project reuses it', async () => {
    const doomedProj = insertProject();
    const keeperProj = insertProject();
    const doomedPart = insertPart(doomedProj);
    const keeperPart = insertPart(keeperProj);

    const filename = `proj_shared_${Date.now()}.bgcode`;
    const filePath = path.join(GCODE_DIR, filename);
    fs.writeFileSync(filePath, 'fake gcode');
    insertGcode(doomedPart, filename);
    const keptId = insertGcode(keeperPart, filename); // same physical file, reused

    const res = await request(app).delete(`/api/projects/${doomedProj}`);

    expect(res.status).toBe(200);
    // The other project still references the file - it must survive
    expect(fs.existsSync(filePath)).toBe(true);
    expect(db.prepare('SELECT id FROM gcodes WHERE id = ?').get(keptId)).toBeDefined();

    fs.unlinkSync(filePath);
  });

  test('still deletes the file when the reuse was inside the deleted project', async () => {
    const projId = insertProject();
    const partA  = insertPart(projId);
    const partB  = insertPart(projId);

    const filename = `proj_internal_${Date.now()}.bgcode`;
    const filePath = path.join(GCODE_DIR, filename);
    fs.writeFileSync(filePath, 'fake gcode');
    insertGcode(partA, filename);
    insertGcode(partB, filename); // both parts belong to the project being deleted

    const res = await request(app).delete(`/api/projects/${projId}`);

    expect(res.status).toBe(200);
    // Nothing references it any more - the file goes with the project
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
