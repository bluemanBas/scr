// Extracts the slicer-embedded preview image from a G-code file, if present.
// No external dependencies - pure Buffer parsing + Node's zlib.
//
// Supported:
//   .bgcode - Prusa binary G-code (https://github.com/prusa3d/libbgcode)
//   .gcode - PrusaSlicer/SuperSlicer text G-code (base64 PNG in comments)
// Not yet supported: .3mf (zip - would need a zip reader).
//
// Returns { mime, buffer } for the best available image, or null if none.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK_GCODE     = 1;
const BLOCK_THUMBNAIL = 5;
// Thumbnail formats: 0=PNG, 1=JPG, 2=QOI. QOI isn't browser-native, so we skip it.
const THUMB_MIME = { 0: 'image/png', 1: 'image/jpeg' };

// ── Prusa binary G-code (.bgcode) ──────────────────────────────────────────────
function extractFromBgcode(buf) {
  if (buf.length < 10 || buf.toString('ascii', 0, 4) !== 'GCDE') return null;
  const checksumType = buf.readUInt16LE(8); // 0=none, 1=crc32
  let off = 10;
  let best = null; // prefer PNG, then largest area

  while (off + 8 <= buf.length) {
    const type = buf.readUInt16LE(off);
    // Thumbnails always precede the G-code blocks, so once we hit G-code we're done.
    if (type === BLOCK_GCODE) break;

    const compression  = buf.readUInt16LE(off + 2);
    const uncompressed = buf.readUInt32LE(off + 4);
    let p = off + 8;
    let compressed = null;
    if (compression !== 0) { compressed = buf.readUInt32LE(p); p += 4; }

    let fmt = null, w = 0, h = 0;
    if (type === BLOCK_THUMBNAIL) {
      fmt = buf.readUInt16LE(p); w = buf.readUInt16LE(p + 2); h = buf.readUInt16LE(p + 4);
      p += 6;
    } else {
      p += 2; // metadata blocks carry a 2-byte encoding param
    }

    const dataLen = compression !== 0 ? compressed : uncompressed;
    if (dataLen == null || p + dataLen > buf.length) break; // malformed - bail
    const dataStart = p, dataEnd = p + dataLen;

    if (type === BLOCK_THUMBNAIL && THUMB_MIME[fmt] && (compression === 0 || compression === 1)) {
      let data = buf.subarray(dataStart, dataEnd);
      if (compression === 1) { try { data = zlib.inflateSync(data); } catch (_) { data = null; } }
      if (data) {
        const score = (fmt === 0 ? 1e9 : 0) + w * h; // PNG wins over JPG, then bigger
        if (!best || score > best.score) best = { mime: THUMB_MIME[fmt], buffer: Buffer.from(data), score };
      }
    }

    off = dataEnd + (checksumType === 1 ? 4 : 0);
  }
  return best ? { mime: best.mime, buffer: best.buffer } : null;
}

// ── PrusaSlicer/SuperSlicer text G-code (.gcode) ────────────────────────────────
// Thumbnails are base64 PNG between "; thumbnail begin WxH SIZE" and "; thumbnail end".
function extractFromTextGcode(buf) {
  const text = buf.toString('latin1');
  const re = /; thumbnail begin (\d+)x(\d+) \d+\r?\n([\s\S]*?); thumbnail end/g;
  let m, best = null;
  while ((m = re.exec(text)) !== null) {
    const w = +m[1], h = +m[2];
    const b64 = m[3].split('\n').map(l => l.replace(/^\s*;\s?/, '').trim()).join('');
    try {
      const data = Buffer.from(b64, 'base64');
      if (data.length && (!best || w * h > best.area)) best = { mime: 'image/png', buffer: data, area: w * h };
    } catch (_) { /* skip bad block */ }
  }
  return best ? { mime: best.mime, buffer: best.buffer } : null;
}

function extractThumbnail(filePath) {
  let buf;
  try { buf = fs.readFileSync(filePath); } catch (_) { return null; }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.bgcode') return extractFromBgcode(buf);
  if (ext === '.gcode')  return extractFromTextGcode(buf);
  return null; // .3mf and others not supported yet
}

module.exports = { extractThumbnail };
