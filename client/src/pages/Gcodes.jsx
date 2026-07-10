import { useState, useEffect, useCallback } from 'react';
import { useConfirm } from '../useConfirm';
import { useToast } from '../useToast';
import EmptyState from '../components/EmptyState';

// ── Formatting helpers ─────────────────────────────────────────────────────────

function formatDuration(secs) {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function formatMaterial(grams) {
  if (grams == null) return '—';
  if (grams < 1000) return `${Math.round(grams)} g`;
  return `${(grams / 1000).toFixed(2).replace(/\.?0+$/, '')} kg`;
}

function formatSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

// Full-width preview for the gallery cards (404 → "no preview" panel).
function GalleryThumb({ id, height = 200 }) {
  const [ok, setOk] = useState(true);
  const box = { width: '100%', height, background: '#0f172a', borderBottom: '1px solid #1e2433', display: 'block' };
  if (!ok) return (
    <div style={{ ...box, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 44, opacity: 0.35 }}>
      🖼️
    </div>
  );
  return <img src={`/api/gcodes/${id}/thumbnail`} alt="" loading="lazy" onError={() => setOk(false)} style={{ ...box, objectFit: 'contain' }} />;
}

export default function Gcodes() {
  const [confirm, confirmModal] = useConfirm();
  const [toast, toastEl]        = useToast();
  const [gcodes, setGcodes]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery]     = useState('');

  const fetchLibrary = useCallback(async () => {
    try {
      const res = await fetch('/api/gcodes/library');
      if (!res.ok) throw new Error('Failed to fetch G-code library');
      setGcodes(await res.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchLibrary(); }, [fetchLibrary]);

  async function deleteFile(gc) {
    const inUse = gc.use_count > 0;
    const ok = await confirm({
      title: 'Delete G-code file',
      message: inUse
        ? `"${gc.filename}" is used by ${gc.use_count} part${gc.use_count !== 1 ? 's' : ''}. Deleting removes the file everywhere and from disk. This cannot be undone.`
        : `Permanently delete "${gc.filename}" from disk? This cannot be undone.`,
      confirmLabel: 'Delete file',
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/gcodes/${gc.id}/file`, { method: 'DELETE' });
    if (res.ok) {
      toast('File deleted');
      fetchLibrary();
    } else {
      const d = await res.json().catch(() => ({}));
      toast(d.error || 'Delete failed', 'error');
    }
  }

  const filtered = query.trim()
    ? gcodes.filter(gc => {
        const q = query.trim().toLowerCase();
        return gc.filename.toLowerCase().includes(q)
          || (gc.printer_model || '').toLowerCase().includes(q)
          || (gc.project_names || '').toLowerCase().includes(q);
      })
    : gcodes;

  const inputSx = {
    background: '#1e2433', border: '1px solid #2d3748', borderRadius: 4,
    padding: '5px 10px', color: '#e2e8f0', fontSize: 13, outline: 'none', width: 220,
  };

  return (
    <div>
      {confirmModal}
      {toastEl}
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>G-codes</h1>
      <p style={{ color: '#64748b', fontSize: 13, marginTop: 0, marginBottom: 16 }}>
        Every uploaded G-code file. Each file appears once — reusing it across projects never duplicates it.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search file, model, project…"
          style={inputSx}
        />
        <span style={{ color: '#475569', fontSize: 13 }}>
          {filtered.length} file{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {loading && <p style={{ color: '#64748b' }}>Loading…</p>}

      {!loading && gcodes.length === 0 && (
        <EmptyState
          title="No G-code files yet"
          hint="Upload a G-code to a part in a project and it will show up here. From then on you can reuse it in any project without uploading again."
          actionLabel="Go to Projects"
          actionTo="/projects"
        />
      )}

      {!loading && gcodes.length > 0 && filtered.length === 0 && (
        <p style={{ color: '#64748b' }}>No files match “{query}”.</p>
      )}

      {filtered.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14 }}>
          {filtered.map(gc => (
            <div key={gc.id} style={{ background: '#131720', border: '1px solid #1e2433', borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <GalleryThumb id={gc.id} height={200} />
              <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                <div title={gc.filename} style={{ fontSize: 13.5, fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {gc.filename}
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 12, color: '#94a3b8' }}>
                  <span style={{ background: '#0f172a', border: '1px solid #2d3748', borderRadius: 3, padding: '1px 6px', fontSize: 11, fontFamily: 'monospace', color: '#64748b' }}>
                    {gc.printer_model}
                  </span>
                  <span>{gc.parts_per_plate}× plate</span>
                  {gc.est_print_secs ? <span>· {formatDuration(gc.est_print_secs)}</span> : null}
                  {gc.material_grams != null ? <span>· {formatMaterial(gc.material_grams)}</span> : null}
                </div>

                <div style={{ fontSize: 12, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={gc.project_names || ''}>
                  {gc.use_count > 0
                    ? <>Used by {gc.project_names || `${gc.use_count} part${gc.use_count !== 1 ? 's' : ''}`}</>
                    : <span style={{ color: '#475569', fontStyle: 'italic' }}>Unused</span>}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#475569' }}>
                  <span>{formatSize(gc.size_bytes)}</span>
                  <span>{formatDate(gc.created_at)}</span>
                </div>

                <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 4 }}>
                  <a
                    href={`/api/gcodes/${gc.id}/download`}
                    style={{
                      flex: 1, textAlign: 'center', background: '#1e3a5f', color: '#60a5fa', border: 'none',
                      borderRadius: 4, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'none',
                    }}
                  >
                    Download
                  </a>
                  <button
                    onClick={() => deleteFile(gc)}
                    style={{
                      background: '#7f1d1d', color: '#f87171', border: 'none', borderRadius: 4,
                      padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
