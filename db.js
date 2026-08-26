// db.js — persiste los candidatos de cada pasada en Supabase (tabla `candidates`).
// Usa la API REST de PostgREST directamente (sin el SDK de supabase-js) para no
// añadir dependencias. Igual que alerts.js: si falla, no bloquea el resto del
// pipeline, solo se registra el error en consola.

// `entry_*` representa las condiciones en el momento en que el screener detectó
// el token por primera vez. No se deben sobrescribir en pasadas posteriores -por
// eso el insert usa resolution=ignore-duplicates, no merge-duplicates-: si el
// mismo mint reaparece en otra pasada, la fila ya existente se deja intacta.
// `checked_at`/`last_price`/`current_liq_usd`/`max_gain_pct`/`outcome`/`alerted`
// son terreno de un proceso de seguimiento posterior que este archivo no
// implementa todavía (comparar entrada vs. estado actual para ver si acertó).
function toRow(c) {
  const sec = typeof c.security === 'string' ? {} : c.security;
  return {
    mint: c.mint,
    symbol: c.symbol,
    name: c.name,
    detected_at: new Date().toISOString(),
    entry_score: c.score,
    entry_price: c.priceUsd,
    entry_liq_usd: c.liqUsd,
    entry_vol_h1: c.volH1,
    entry_chg_1h: c.chg1h,
    top_holder_pct: sec.topHolderPct ?? null,
    lp_locked_pct: sec.lpLockedPct ?? null,
    risk: sec.risk ?? null,
    is_pumpfun: c.isPumpfun ?? false,
    pumpfun_url: c.pumpfunUrl ?? null,
    dex_url: c.dexUrl ?? null,
    breakdown: c.breakdown ?? null,
  };
}

// Insert-only por `mint`: requiere una unique constraint (o PK) sobre esa
// columna para que on_conflict + ignore-duplicates evite duplicar candidatos
// ya vistos, sin tocar su snapshot de entrada original.
async function saveCandidates(cfg, candidates) {
  const s = cfg.supabase;
  if (!s?.enabled || !candidates?.length) return 0;

  const rows = candidates.map(toRow);
  const url = `${s.url}${s.table}?on_conflict=mint`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: s.serviceKey,
      authorization: `Bearer ${s.serviceKey}`,
      prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  return rows.length;
}

function ready(cfg) {
  const s = cfg.supabase;
  return !!(s?.enabled && s?.url && s?.serviceKey);
}

// Candidatos guardados con edad >= cfg.backtest.minAgeHours que aún no se revisaron.
async function getPending(cfg) {
  const s = cfg.supabase;
  const cutoff = new Date(Date.now() - cfg.backtest.minAgeHours * 3600000).toISOString();
  const params = new URLSearchParams({
    select: 'mint,symbol,entry_score,entry_price,entry_liq_usd',
    checked_at: 'is.null',
    detected_at: `lte.${cutoff}`,
  });

  const res = await fetch(`${s.url}${s.table}?${params}`, {
    headers: { apikey: s.serviceKey, authorization: `Bearer ${s.serviceKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Escribe el resultado del backtest (checked_at/last_price/current_liq_usd/max_gain_pct/outcome)
// para un mint concreto.
async function updateOutcome(cfg, mint, patch) {
  const s = cfg.supabase;
  const res = await fetch(`${s.url}${s.table}?mint=eq.${encodeURIComponent(mint)}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      apikey: s.serviceKey,
      authorization: `Bearer ${s.serviceKey}`,
      prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase HTTP ${res.status} ${body.slice(0, 300)}`);
  }
}

module.exports = { saveCandidates, ready, getPending, updateOutcome };
