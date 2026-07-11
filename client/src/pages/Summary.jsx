import { useState, useCallback } from 'react';
import { useToast } from '../useToast';

// ── Formatting helpers ─────────────────────────────────────────────────────────

function formatMaterial(grams) {
  if (grams == null) return '—';
  if (grams < 1000) return `${Math.round(grams)} g`;
  return `${(grams / 1000).toFixed(1)} kg`;
}

function formatHours(h) {
  if (h == null) return '—';
  return `${h} h`;
}

function formatAge(ms) {
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

// ── Subcomponents ──────────────────────────────────────────────────────────────

function StatCard({ label, value }) {
  return (
    <div style={{
      background: '#131720', border: '1px solid #1e2433', borderRadius: 8,
      padding: '12px 14px', flex: '1 1 130px', minWidth: 130,
    }}>
      <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: '#e2e8f0', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
    </div>
  );
}

const thSx = {
  textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 600,
  color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em',
  borderBottom: '1px solid #2d3748', whiteSpace: 'nowrap',
};
const tdSx = {
  padding: '9px 10px', fontSize: 13, color: '#e2e8f0',
  borderBottom: '1px solid #1e2433', fontVariantNumeric: 'tabular-nums',
};

// ── Page ───────────────────────────────────────────────────────────────────────

export default function Summary() {
  const [showToast, toastEl] = useToast();
  const [data, setData]       = useState(null);   // { stats, summary, cached, generated_at }
  const [loading, setLoading] = useState(false);
  // A missing API key is a persistent config problem, not a transient failure, so it
  // gets a fixed panel instead of a toast that disappears on its own.
  const [configError, setConfigError] = useState(null);

  // Deliberately no fetch on mount: forcing a summary costs money, so the operator
  // decides when to pay for it. That is the whole point of the button.
  const load = useCallback(async (force = false) => {
    setLoading(true);
    setConfigError(null);
    try {
      const res  = await fetch(`/api/summary/weekly${force ? '?refresh=1' : ''}`);
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 503) {
          setConfigError(body.error || 'The server is missing its Anthropic API key.');
        } else {
          showToast(`Could not generate the summary: ${body.error || res.status}`, 'error');
        }
        return;
      }

      setData(body);
      if (force) showToast('Summary refreshed');
    } catch (err) {
      showToast('Could not reach the server', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const stats = data?.stats;

  const btnSx = {
    background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6,
    padding: '8px 16px', fontSize: 13, fontWeight: 600,
    cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1,
  };

  return (
    <div>
      {toastEl}

      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Weekly Summary</h1>
      <p style={{ color: '#64748b', fontSize: 13, marginTop: 0, marginBottom: 16 }}>
        The last 7 days of the farm, summarised by Claude. The result is cached for an hour,
        so coming back to this page does not run a new query.
      </p>

      {configError && (
        <div style={{
          background: '#3f1d1d', border: '1px solid #7f1d1d', borderRadius: 8,
          padding: '12px 14px', marginBottom: 16, color: '#fca5a5', fontSize: 13,
        }}>
          <strong style={{ color: '#f87171' }}>Not configured.</strong> {configError}
          <div style={{ color: '#94a3b8', marginTop: 6, fontSize: 12 }}>
            Set <code style={{ fontFamily: 'monospace' }}>ANTHROPIC_API_KEY</code> in the server
            environment and restart the container.
          </div>
        </div>
      )}

      {/* Initial state: the operator decides when to spend a query */}
      {!data && !configError && (
        <div style={{
          background: '#131720', border: '1px solid #1e2433', borderRadius: 8,
          padding: '32px 20px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 15, color: '#e2e8f0', fontWeight: 600, marginBottom: 6 }}>
            No summary yet
          </div>
          <div style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
            Generating one sends this week's numbers to Claude.
          </div>
          <button onClick={() => load(false)} disabled={loading} style={btnSx}>
            {loading ? 'Generating…' : 'Generate summary'}
          </button>
          {loading && (
            <div style={{ fontSize: 12, color: '#475569', marginTop: 10 }}>
              This can take a few seconds.
            </div>
          )}
        </div>
      )}

      {data && (
        <>
          {/* Claude's prose */}
          <div style={{
            background: '#131720', border: '1px solid #1e2433', borderRadius: 8,
            padding: '16px 18px', marginBottom: 16,
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              gap: 10, flexWrap: 'wrap', marginBottom: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>The week</span>
                <span style={{ fontSize: 11, color: '#475569' }}>{formatAge(data.generated_at)}</span>
                {data.cached && (
                  <span style={{
                    background: '#1e2433', border: '1px solid #2d3748', borderRadius: 3,
                    padding: '1px 6px', fontSize: 10, color: '#64748b',
                  }}>
                    cached
                  </span>
                )}
              </div>
              <button onClick={() => load(true)} disabled={loading} style={{ ...btnSx, padding: '6px 12px', fontSize: 12 }}>
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            <p style={{
              margin: 0, fontSize: 14, lineHeight: 1.65, color: '#e2e8f0', whiteSpace: 'pre-line',
            }}>
              {data.summary}
            </p>
          </div>

          {/* The raw numbers Claude was given */}
          {stats && (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                <StatCard label="Jobs"          value={stats.trabajos_completados} />
                <StatCard label="Parts"         value={stats.piezas} />
                <StatCard label="Machine hours" value={stats.horas_maquina} />
                <StatCard label="Material"      value={formatMaterial(stats.material_gramos)} />
                <StatCard label="Failures"      value={stats.fallas} />
              </div>

              {stats.por_impresora?.length > 0 && (
                <div style={{
                  background: '#131720', border: '1px solid #1e2433',
                  borderRadius: 8, overflow: 'hidden',
                }}>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
                      <thead>
                        <tr>
                          <th style={thSx}>Printer</th>
                          <th style={thSx}>Model</th>
                          <th style={{ ...thSx, textAlign: 'right' }}>Jobs</th>
                          <th style={{ ...thSx, textAlign: 'right' }}>Parts</th>
                          <th style={{ ...thSx, textAlign: 'right' }}>Hours</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.por_impresora.map((p) => (
                          <tr key={p.nombre}>
                            <td style={{ ...tdSx, fontWeight: 600 }}>{p.nombre}</td>
                            <td style={{ ...tdSx, color: '#64748b', fontFamily: 'monospace', fontSize: 12 }}>
                              {p.modelo}
                            </td>
                            <td style={{ ...tdSx, textAlign: 'right' }}>{p.trabajos}</td>
                            <td style={{ ...tdSx, textAlign: 'right' }}>{p.piezas}</td>
                            <td style={{ ...tdSx, textAlign: 'right', color: '#94a3b8' }}>{formatHours(p.horas)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
