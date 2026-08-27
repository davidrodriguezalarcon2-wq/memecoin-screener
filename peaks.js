// peaks.js — rastrea el precio MÁXIMO de cada token desde que se detectó.
// Se llama en cada pasada del screener: coge los tokens de la ventana de seguimiento,
// consulta su precio actual y, si supera el máximo guardado, lo actualiza en Supabase.
// Así el backtest sabe cuánto llegó a subir de verdad, no solo el precio a las 24h.

const { getTrackable, updateOutcome, ready } = require('./db');
const { fetchPairsForTokens, bestPairPerToken } = require('./sources');

async function trackPeaks(cfg) {
  if (!ready(cfg) || !cfg.peaks?.enabled) return 0;

  const rows = await getTrackable(cfg, cfg.peaks.trackHours);
  if (!rows.length) return 0;

  const mints = rows.map((r) => r.mint);
  const rawPairs = await fetchPairsForTokens(cfg.chain, mints);
  const byMint = new Map();
  for (const t of bestPairPerToken(rawPairs, mints)) byMint.set(t.address, t.pair);

  let updated = 0;
  for (const row of rows) {
    const pair = byMint.get(row.mint);
    if (!pair) continue;
    const cur = Number(pair.priceUsd) || 0;
    const prevPeak = Number(row.peak_price) || Number(row.entry_price) || 0;
    if (cur > 0 && cur > prevPeak) {
      const entry = Number(row.entry_price) || 0;
      const gain = entry > 0 ? Math.round(((cur - entry) / entry) * 100) : 0;
      try {
        await updateOutcome(cfg, row.mint, { peak_price: cur, peak_gain_pct: gain, peak_at: new Date().toISOString() });
        updated++;
      } catch (e) {
        console.error(`Fallo actualizando pico de ${row.mint}:`, e.message);
      }
    }
  }
  return updated;
}

module.exports = { trackPeaks };
