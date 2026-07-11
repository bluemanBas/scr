const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { extractThumbnail } = require('../gcode-thumbnail');
const router = express.Router();

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

const storage = multer.diskStorage({
  destination: GCODE_DIR,
  filename: (_req, file, cb) => cb(null, Date.now() + '_' + file.originalname),
});
const upload = multer({ storage });

function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Model token in filename → internal ID
const MODEL_TOKEN_MAP = {
  mk4s: 'mk4s',
  mk4:  'mk4',
  c1l:  'c1l',
  c1:   'c1',
  core1l: 'c1l',
  coreone: 'c1',
  core1:   'c1',
  xl:   'xl',
};

function parseFilename(filename) {
  // Allow an optional trailing token (e.g. _37grams, _45g) after the time field before the extension.
  const regex = /^(\d+)x\s+(.+?)_(\d+\.\d+n)_(\d+\.\d+mm)_([A-Za-z]+)_([A-Za-z0-9]+)_(\d+h\d+m)(?:_[^.]+)?\.(bgcode|gcode)$/i;
  const match = filename.match(regex);
  if (!match) return null;

  const parts_per_plate = parseInt(match[1], 10);
  const model_token = match[6].toLowerCase();
  const printer_model = MODEL_TOKEN_MAP[model_token] || null;

  // Parse "5h11m" → seconds
  const timeMatch = match[7].match(/(\d+)h(\d+)m/);
  const est_print_secs = timeMatch
    ? parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60
    : null;

  return { parts_per_plate, printer_model, est_print_secs, part_name_hint: match[2] };
}

// Extract material grams from any filename — flexible pattern matching.
// kg before g to avoid "1.2kg" matching "2" with /g/.
function extractMaterialGramsFromFilename(filename) {
  const kg = filename.match(/(?:^|[_\s\-\.])(\d+(?:\.\d+)?)\s*kg(?:[_\s\-\.\(]|$)/i);
  if (kg) return parseFloat(kg[1]) * 1000;
  const g = filename.match(/(?:^|[_\s\-\.])(\d+(?:\.\d+)?)\s*(?:grams?|g)(?:[_\s\-\.\(]|$)/i);
  if (g) return parseFloat(g[1]);
  return null;
}

// Accepts: bare integer (seconds), HH:MM:SS, H:MM, or component form (2h15m, 1h 30m, etc.)
function normalizePrintTime(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let m = s.match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  m = s.match(/^(\d{1,3}):(\d{2})$/);
  if (m) return +m[1] * 3600 + +m[2] * 60;
  let total = 0, found = false;
  m = s.match(/(\d+)\s*h/i); if (m) { total += +m[1] * 3600; found = true; }
  m = s.match(/(\d+)\s*m/i); if (m) { total += +m[1] * 60;   found = true; }
  m = s.match(/(\d+)\s*s/i); if (m) { total += +m[1];        found = true; }
  return found ? total : null;
}

// Accepts: bare number (grams), "45g", "45.5 grams", "1.2kg", "1.2 kilograms"
function normalizeMaterialGrams(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  let m = s.match(/^(\d+(?:\.\d+)?)\s*kg(?:ilograms?)?$/i);
  if (m) return parseFloat(m[1]) * 1000;
  m = s.match(/^(\d+(?:\.\d+)?)\s*g(?:rams?)?$/i);
  if (m) return parseFloat(m[1]);
  return null;
}

module.exports = (db) => {
  // GET /api/gcodes — list, optionally filtered by part_id
  router.get('/', (req, res) => {
    const { part_id } = req.query;
    const gcodes = part_id
      ? db.prepare('SELECT * FROM gcodes WHERE part_id = ?').all(part_id)
      : db.prepare('SELECT * FROM gcodes ORDER BY created_at DESC').all();
    res.json(gcodes);
  });

  // GET /api/gcodes/library - the G-code Library: one row per unique physical file.
  // A file reused across Parts shares a single filepath, so grouping by filepath
  // collapses those into one entry and reports how many Parts/Projects use it.
  router.get('/library', (req, res) => {
    const rows = db.prepare(`
      SELECT
        MIN(g.id)                        AS id,
        g.filepath                       AS filepath,
        MIN(g.filename)                  AS filename,
        MIN(g.printer_model)             AS printer_model,
        MIN(g.parts_per_plate)           AS parts_per_plate,
        MIN(g.est_print_secs)            AS est_print_secs,
        MIN(g.material_grams)            AS material_grams,
        MIN(g.created_at)                AS created_at,
        SUM(CASE WHEN g.part_id IS NOT NULL THEN 1 ELSE 0 END) AS use_count,
        GROUP_CONCAT(DISTINCT pr.name)   AS project_names
      FROM gcodes g
      LEFT JOIN parts    p  ON p.id  = g.part_id
      LEFT JOIN projects pr ON pr.id = p.project_id
      GROUP BY g.filepath
      ORDER BY created_at DESC
    `).all();
    for (const row of rows) {
      try {
        const fname = row.filepath.split(/[\\/]/).pop();
        row.size_bytes = fs.statSync(path.join(GCODE_DIR, fname)).size;
      } catch (_) {
        row.size_bytes = null; // file missing on disk
      }
    }
    res.json(rows);
  });

  // GET /api/gcodes/:id/download - download the original G-code file
  router.get('/:id/download', (req, res) => {
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!gcode) return res.status(404).json({ error: 'G-code not found' });

    const fname = gcode.filepath.split(/[\\/]/).pop();
    const fullPath = path.join(GCODE_DIR, fname);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing on disk' });

    // Send it under the original upload name, not the internal timestamped name.
    res.download(fullPath, gcode.filename);
  });

  // GET /api/gcodes/:id/thumbnail - the slicer-embedded preview image, if any.
  // 404 when the file has no embedded thumbnail (or the format isn't supported).
  router.get('/:id/thumbnail', (req, res) => {
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!gcode) return res.status(404).json({ error: 'G-code not found' });

    const fname = gcode.filepath.split(/[\\/]/).pop();
    const thumb = extractThumbnail(path.join(GCODE_DIR, fname));
    if (!thumb) return res.status(404).json({ error: 'No embedded thumbnail' });

    res.set('Content-Type', thumb.mime);
    res.set('Cache-Control', 'public, max-age=86400'); // the file never changes under a given id
    res.send(thumb.buffer);
  });

  // POST /api/gcodes/:id/reuse - attach an existing G-code to another Part.
  // Points the new row at the SAME physical file (no copy), so reusing a file
  // any number of times never duplicates it on disk. Body: { part_id }.
  router.post('/:id/reuse', (req, res) => {
    const source = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source G-code not found' });

    const { part_id } = req.body;
    if (!part_id) return res.status(400).json({ error: 'part_id is required' });

    if (!db.prepare('SELECT 1 FROM parts WHERE id = ?').get(part_id)) {
      return res.status(404).json({ error: 'Target Part not found' });
    }

    // Same (part_id, printer_model) uniqueness the upload enforces.
    const existing = db.prepare(
      'SELECT id FROM gcodes WHERE part_id = ? AND printer_model = ?'
    ).get(part_id, source.printer_model);
    if (existing) {
      return res.status(409).json({
        error: `This Part already has a G-code for ${source.printer_model}. Delete it before reusing another.`,
      });
    }

    // New DB row for the target Part, pointing at the same file + copied metadata.
    const result = db.prepare(`
      INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, material_grams, ams_slot, allowed_groups, required_material, required_color, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      part_id,
      source.printer_model,
      source.filename,
      source.filepath,
      source.parts_per_plate,
      source.est_print_secs,
      source.material_grams,
      source.ams_slot,
      source.allowed_groups,
      source.required_material,
      source.required_color,
      Date.now()
    );

    // If the file was sitting in the Library unused (an anchor row with no Part),
    // drop that anchor now that it has a real usage again.
    db.prepare('DELETE FROM gcodes WHERE filepath = ? AND part_id IS NULL').run(source.filepath);

    res.status(201).json(db.prepare('SELECT * FROM gcodes WHERE id = ?').get(result.lastInsertRowid));
  });

  // POST /api/gcodes/parse-filename — parse filename, return fields, don't save anything
  router.post('/parse-filename', (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    const parsed = parseFilename(filename);
    const material_grams = extractMaterialGramsFromFilename(filename);
    if (!parsed) {
      return res.json({ parse_failed: true, material_grams });
    }
    res.json({ parse_failed: false, ...parsed, material_grams });
  });

  // POST /api/gcodes/upload — upload G-code file and create DB record
  router.post('/upload', async (req, res) => {
    try {
      await runUpload(req, res);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { part_id, parts_per_plate, printer_model, est_print_secs, ams_slot, material_grams,
            allowed_groups, required_material, required_color } = req.body;

    if (!part_id || !parts_per_plate || !printer_model) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'part_id, parts_per_plate, and printer_model are required' });
    }

    if (!db.prepare('SELECT 1 FROM printer_models WHERE model_id = ?').get(printer_model)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Unknown model "${printer_model}". Add it in Settings → Printer Models first.` });
    }

    // Enforce uniqueness on (part_id, printer_model) at app layer
    const existing = db.prepare(
      'SELECT id FROM gcodes WHERE part_id = ? AND printer_model = ?'
    ).get(part_id, printer_model);
    if (existing) {
      fs.unlinkSync(req.file.path);
      return res.status(409).json({
        error: `This Part already has a G-code for ${printer_model}. Delete the existing one before uploading a replacement.`,
      });
    }

    // ams_slot: -1 = external spool, 0–N = AMS slot, null = not applicable (non-Bambu)
    const parsedAmsSlot = ams_slot !== undefined && ams_slot !== '' ? parseInt(ams_slot, 10) : null;

    const parsedMaterialGrams = material_grams ? parseFloat(material_grams) : null;
    // allowed_groups: JSON array string e.g. '["MK4S Farm","XL Farm"]', or null = all groups
    const parsedAllowedGroups = allowed_groups && allowed_groups !== '' ? allowed_groups : null;
    const parsedRequiredMaterial = required_material && required_material !== '' ? required_material.trim() : null;
    const parsedRequiredColor    = required_color    && required_color    !== '' ? required_color.trim()    : null;

    const gcode = db.prepare(`
      INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, material_grams, ams_slot, allowed_groups, required_material, required_color, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      part_id,
      printer_model,
      req.file.originalname,
      req.file.filename,
      parseInt(parts_per_plate, 10),
      est_print_secs ? parseInt(est_print_secs, 10) : null,
      parsedMaterialGrams,
      parsedAmsSlot,
      parsedAllowedGroups,
      parsedRequiredMaterial,
      parsedRequiredColor,
      Date.now()
    );

    res.status(201).json(db.prepare('SELECT * FROM gcodes WHERE id = ?').get(gcode.lastInsertRowid));
  });

  // PUT /api/gcodes/:id — update est_print_secs and/or material_grams
  // Accepts human-readable strings ("2h15m", "45g") or raw numbers; omitting a field leaves it unchanged.
  router.put('/:id', (req, res) => {
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!gcode) return res.status(404).json({ error: 'G-code not found' });

    let estPrintSecs = gcode.est_print_secs;
    if ('print_time' in req.body) {
      if (!req.body.print_time) {
        estPrintSecs = null;
      } else {
        estPrintSecs = normalizePrintTime(req.body.print_time);
        if (estPrintSecs === null) {
          return res.status(400).json({ error: 'Cannot parse print time. Use formats like "2h15m", "90m", or "1:30:00".' });
        }
      }
    }

    let materialGrams = gcode.material_grams;
    if ('material_grams' in req.body) {
      if (!req.body.material_grams) {
        materialGrams = null;
      } else {
        materialGrams = normalizeMaterialGrams(req.body.material_grams);
        if (materialGrams === null) {
          return res.status(400).json({ error: 'Cannot parse material. Use formats like "45g", "45.5g", or "1.2kg".' });
        }
      }
    }

    // allowed_groups / required_material / required_color: present-in-body wins; absent = keep existing
    const allowedGroups      = 'allowed_groups'      in req.body ? (req.body.allowed_groups      || null) : gcode.allowed_groups;
    const requiredMaterial   = 'required_material'   in req.body ? (req.body.required_material   || null) : gcode.required_material;
    const requiredColor      = 'required_color'      in req.body ? (req.body.required_color       || null) : gcode.required_color;

    db.prepare('UPDATE gcodes SET est_print_secs = ?, material_grams = ?, allowed_groups = ?, required_material = ?, required_color = ? WHERE id = ?')
      .run(estPrintSecs, materialGrams, allowedGroups, requiredMaterial, requiredColor, req.params.id);

    res.json(db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id));
  });

  // DELETE /api/gcodes/:id - remove a G-code from its Part. Does NOT delete the
  // file: if other Parts reuse the same file it just drops this row; if this was
  // the only usage the row is kept as an unattached Library entry (part_id NULL).
  // Permanent deletion is DELETE /api/gcodes/:id/file (from the G-code Library).
  router.delete('/:id', (req, res) => {
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!gcode) return res.status(404).json({ error: 'G-code not found' });

    const activeJob = db.prepare(
      "SELECT id FROM jobs WHERE gcode_id = ? AND status IN ('queued', 'uploading', 'printing') LIMIT 1"
    ).get(req.params.id);
    if (activeJob) {
      return res.status(409).json({ error: 'Cannot remove - this G-code has an active job in progress.' });
    }

    const otherUsage = db.prepare(
      'SELECT 1 FROM gcodes WHERE filepath = ? AND id != ? LIMIT 1'
    ).get(gcode.filepath, req.params.id);

    if (otherUsage) {
      // Another Part still references the file - just drop this row.
      db.prepare("UPDATE jobs SET gcode_id = NULL WHERE gcode_id = ?").run(req.params.id);
      db.prepare('DELETE FROM gcodes WHERE id = ?').run(req.params.id);
    } else {
      // Last usage - keep the file in the Library, now unattached.
      db.prepare('UPDATE gcodes SET part_id = NULL WHERE id = ?').run(req.params.id);
    }
    res.json({ success: true });
  });

  // DELETE /api/gcodes/:id/file - permanently delete the file from the Library:
  // removes every row that references it (across all Parts) and the file on disk.
  router.delete('/:id/file', (req, res) => {
    const gcode = db.prepare('SELECT * FROM gcodes WHERE id = ?').get(req.params.id);
    if (!gcode) return res.status(404).json({ error: 'G-code not found' });

    // Block deletion while any usage of this file is actively printing.
    const activeJob = db.prepare(`
      SELECT j.id FROM jobs j
      JOIN gcodes g ON g.id = j.gcode_id
      WHERE g.filepath = ? AND j.status IN ('queued', 'uploading', 'printing')
      LIMIT 1
    `).get(gcode.filepath);
    if (activeJob) {
      return res.status(409).json({ error: 'Cannot delete - this file has an active job in progress.' });
    }

    // Detach historical jobs from every row referencing this file, then remove
    // all those rows and the physical file.
    const rowIds = db.prepare('SELECT id FROM gcodes WHERE filepath = ?').all(gcode.filepath).map(r => r.id);
    const detach = db.prepare('UPDATE jobs SET gcode_id = NULL WHERE gcode_id = ?');
    for (const id of rowIds) detach.run(id);
    db.prepare('DELETE FROM gcodes WHERE filepath = ?').run(gcode.filepath);

    const gcodeFilename = gcode.filepath.split(/[\\/]/).pop();
    const fullPath = path.join(GCODE_DIR, gcodeFilename);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
    res.json({ success: true });
  });

  return router;
};
