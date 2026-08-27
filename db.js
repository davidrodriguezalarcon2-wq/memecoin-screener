// db.js — cliente de Supabase por API REST (PostgREST), sin dependencias.
// Usa la service_role key: es SECRETA y solo va aquí, en el servidor. Nunca en la PWA.

function base(cfg) {
  return `${cfg.supabase.url.replace(/\/+$/, '')}/rest/v1/${cfg.supabase.table}`;
}
function headers(cfg, extra = {}) {
  const key = cfg.supabase.serviceKey;
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}
function ready(cfg) {
  return !!(cfg.supabase?.enabled && cfg.supabase.url && cfg.supabase.serviceKey);
}

function toRow(c, cfg) {
  const sec = typeof c.security === 'object' && c.security ? c.security : null;
  return {
    mint: c.mint,
    symbol: c.symbol,
    name: c.name,
    entry_score: c.score,
    entry_price: c.priceUsd != null ? Number(c.priceUsd) : null,
    entry_liq_usd: c.liqUsd,
    entry_vol_h1: c.volH1,
    entry_chg_1h: c.chg1h,
    top_holder_pct: sec ? sec.topHolderPct ?? null : null,
    lp_locked_pct: sec ? sec.lpLockedPct ?? null : null,
    risk: sec ? sec.risk : 'sin datos',
    is_pumpfun: c.isPumpfun ?? null,
    pumpfun_url: c.pumpfunUrl ?? null,
    dex_url: c.dexUrl ?? null,
    breakdown: c.breakdown ?? null,
  };
}

// Inserta candidatos nuevos. Ignora los que ya existen (conserva la 1ª detección = entrada).
async function saveCandidates(cfg, candidates) {
  if (!ready(cfg) || !candidates.length) return 0;
  const rows = candidates.map((c) => toRow(c, cfg));
  const res = await fetch(`${base(cfg)}?on_conflict=mint`, {
    method: 'POST',
    headers: headers(cfg, { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase insert HTTP ${res.status}: ${await res.text()}`);
  return rows.length;
}

// Candidatos con antigüedad suficiente y aún sin evaluar.
async function getPending(cfg) {
  if (!ready(cfg)) throw new Error('Supabase no configurado (url + serviceKey en config.js)');
  const cutoff = new Date(Date.now() - cfg.backtest.minAgeHours * 3600000).toISOString();
  const url = `${base(cfg)}?select=*&checked_at=is.null&detected_at=lt.${encodeURIComponent(cutoff)}`;
  const res = await fetch(url, { headers: headers(cfg) });
  if (!res.ok) throw new Error(`Supabase select HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function updateOutcome(cfg, mint, fields) {
  const url = `${base(cfg)}?mint=eq.${encodeURIComponent(mint)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: headers(cfg, { Prefer: 'return=minimal' }),
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`Supabase update HTTP ${res.status}: ${await res.text()}`);
}

// Anti-spam persistente (sobrevive entre ejecuciones/cron): de una lista de mints,
// devuelve los que AÚN no han sido alertados (alerted=false en Supabase).
async function getAlertableMints(cfg, mints) {
  if (!ready(cfg) || !mints.length) return [];
  const inList = mints.map((m) => encodeURIComponent(m)).join(',');
  const url = `${base(cfg)}?select=mint&alerted=eq.false&mint=in.(${inList})`;
  const res = await fetch(url, { headers: headers(cfg) });
  if (!res.ok) throw new Error(`Supabase getAlertable HTTP ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows.map((r) => r.mint);
}

// Marca esos mints como ya alertados, para no repetir la alerta en futuras pasadas.
async function markAlerted(cfg, mints) {
  if (!ready(cfg) || !mints.length) return;
  const inList = mints.map((m) => encodeURIComponent(m)).join(',');
  const url = `${base(cfg)}?mint=in.(${inList})`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: headers(cfg, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ alerted: true }),
  });
  if (!res.ok) throw new Error(`Supabase markAlerted HTTP ${res.status}: ${await res.text()}`);
}

// Tokens detectados dentro de la ventana de seguimiento (para rastrear su pico).
async function getTrackable(cfg, hours) {
  if (!ready(cfg)) return [];
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const url = `${base(cfg)}?select=mint,entry_price,peak_price&detected_at=gt.${encodeURIComponent(cutoff)}`;
  const res = await fetch(url, { headers: headers(cfg) });
  if (!res.ok) throw new Error(`Supabase getTrackable HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = { saveCandidates, getPending, updateOutcome, getAlertableMints, markAlerted, getTrackable, ready };
