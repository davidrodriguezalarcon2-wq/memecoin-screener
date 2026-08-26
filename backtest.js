#!/usr/bin/env node
// backtest.js — re-evalúa los candidatos guardados en Supabase que ya tienen edad
// suficiente (por defecto 24h), mira qué precio/liquidez tienen AHORA, clasifica el
// resultado (rug / pump / flat / dead) y escribe un informe agregado por bucket de score.
//
// Objetivo: responder con DATOS si tus umbrales aciertan. Si el bucket 75+ ruguea menos
// y pumpea más que el 45-59, el score funciona. Si no, hay que afinar config.js.
//
// Uso:  node backtest.js

const cfg = require('./config');
const { getPending, updateOutcome, ready } = require('./db');
const { fetchPairsForTokens, bestPairPerToken } = require('./sources');

// Clasifica el resultado de un candidato. Función pura -> fácil de testear.
function classifyOutcome(row, current, bt) {
  // Sin par actual = liquidez desaparecida / deslistado -> rug.
  if (!current) {
    return { outcome: 'rug', last_price: 0, current_liq_usd: 0, max_gain_pct: -100 };
  }
  const entryPrice = Number(row.entry_price) || 0;
  const curPrice = Number(current.priceUsd) || 0;
  const curLiq = current.liquidity?.usd ?? 0;
  const gain = entryPrice > 0 ? ((curPrice - entryPrice) / entryPrice) * 100 : 0;

  const rugFloor = Math.max(bt.rugLiqFloorUsd, (Number(row.entry_liq_usd) || 0) * (bt.rugLiqFloorPct / 100));
  let outcome;
  if (curLiq < rugFloor) outcome = 'rug';
  else if (gain >= bt.pumpGainPct) outcome = 'pump';
  else if (gain <= bt.deadLossPct) outcome = 'dead';
  else outcome = 'flat';

  return { outcome, last_price: curPrice, current_liq_usd: Math.round(curLiq), max_gain_pct: Math.round(gain) };
}

function bucketOf(score) {
  if (score >= 75) return '75+';
  if (score >= 60) return '60-74';
  return '45-59';
}

function pct(n, total) { return total ? Math.round((n / total) * 100) : 0; }

function printReport(evaluated) {
  console.log(`\n=== Backtest · ${evaluated.length} candidatos evaluados ===\n`);
  if (!evaluated.length) return console.log('No hay candidatos con edad suficiente todavía. Espera 24h y reintenta.\n');

  const buckets = { '75+': [], '60-74': [], '45-59': [] };
  for (const e of evaluated) buckets[bucketOf(e.entry_score)].push(e);

  const line = (label, arr) => {
    if (!arr.length) return `  ${label.padEnd(7)} sin datos`;
    const rug = arr.filter((x) => x.outcome === 'rug').length;
    const pump = arr.filter((x) => x.outcome === 'pump').length;
    const gains = arr.map((x) => x.max_gain_pct).sort((a, b) => a - b);
    const avg = Math.round(gains.reduce((s, x) => s + x, 0) / gains.length);
    const med = gains[Math.floor(gains.length / 2)];
    return `  ${label.padEnd(7)} n=${String(arr.length).padStart(3)}  rug ${String(pct(rug, arr.length)).padStart(3)}%  pump ${String(pct(pump, arr.length)).padStart(3)}%  gain medio ${avg > 0 ? '+' : ''}${avg}%  mediana ${med > 0 ? '+' : ''}${med}%`;
  };

  console.log('Por bucket de score (más alto debería = menos rug, más pump):');
  console.log(line('75+', buckets['75+']));
  console.log(line('60-74', buckets['60-74']));
  console.log(line('45-59', buckets['45-59']));

  const all = evaluated;
  const rug = all.filter((x) => x.outcome === 'rug').length;
  const pump = all.filter((x) => x.outcome === 'pump').length;
  console.log(`\nTotal: ${all.length} · rugs ${pct(rug, all.length)}% · pumps ${pct(pump, all.length)}%`);
  console.log('');
}

async function main() {
  if (!ready(cfg)) {
    console.log('⚠️  Supabase no configurado. Rellena url y serviceKey en config.js.');
    return;
  }

  const pending = await getPending(cfg);
  if (!pending.length) {
    console.log('No hay candidatos pendientes con edad >= ' + cfg.backtest.minAgeHours + 'h.');
    return;
  }
  console.log(`Evaluando ${pending.length} candidatos...`);

  // Trae el estado actual de todos los mints de una tanda.
  const mints = pending.map((r) => r.mint);
  const rawPairs = await fetchPairsForTokens(cfg.chain, mints);
  const currentByMint = new Map();
  for (const t of bestPairPerToken(rawPairs, mints)) currentByMint.set(t.address, t.pair);

  const evaluated = [];
  for (const row of pending) {
    const current = currentByMint.get(row.mint) || null;
    const result = classifyOutcome(row, current, cfg.backtest);
    try {
      await updateOutcome(cfg, row.mint, { ...result, checked_at: new Date().toISOString() });
      evaluated.push({ entry_score: row.entry_score, ...result });
    } catch (e) {
      console.error(`Fallo actualizando ${row.symbol}:`, e.message);
    }
  }

  printReport(evaluated);
}

module.exports = { classifyOutcome, bucketOf };

if (require.main === module) main().catch((e) => console.error('Error:', e.message));
