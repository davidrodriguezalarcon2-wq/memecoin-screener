#!/usr/bin/env node
// screener.js — orquestador. Flujo:
//   1) descubre tokens nuevos en Solana (DEX Screener)
//   2) trae sus datos de mercado
//   3) enriquece con seguridad on-chain (RugCheck)
//   4) aplica filtros duros -> descarta rugs/basura
//   5) puntúa momentum -> rankea candidatos
//   6) imprime tabla con enlaces para que TÚ investigues antes de tocar nada
//
// Uso:  node screener.js            (una pasada)
//       node screener.js --watch    (cada 60s)
//       node screener.js --json     (salida JSON para pipear a Supabase/n8n)

const cfg = require('./config');
const { fetchNewTokenAddresses, fetchPairsForTokens, bestPairPerToken, fetchRugCheck } = require('./sources');
const { passesFilters, scoreMomentum, ageMinutes } = require('./scoring');
const { maybeAlert, sendAlert } = require('./alerts');
const { saveCandidates, getAlertableMints, markAlerted } = require('./db');

const asJSON = process.argv.includes('--json');
const watch = process.argv.includes('--watch');

// Limitador de concurrencia sencillo para no saturar RugCheck.
async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function runOnce() {
  const addrs = await fetchNewTokenAddresses(cfg.chain);
  if (!addrs.length) {
    if (!asJSON) console.log('No se encontraron tokens nuevos en esta pasada.');
    return [];
  }

  const rawPairs = await fetchPairsForTokens(cfg.chain, addrs);
  const tokens = bestPairPerToken(rawPairs, addrs);

  // Enriquecer con seguridad (opcional).
  const safeties = cfg.run.enrichWithRugCheck
    ? await mapLimit(tokens, cfg.run.rugCheckConcurrency, (t) => fetchRugCheck(t.address))
    : tokens.map(() => ({ ok: false }));

  const candidates = [];
  tokens.forEach((token, idx) => {
    const safety = safeties[idx];
    const pair = token.pair;
    const { pass } = passesFilters(pair, safety, cfg);
    if (!pass) return;
    const { score, breakdown } = scoreMomentum(pair, safety, cfg);
    if (score < cfg.run.minScoreToShow) return;
    const mint = token.address;
    // Los mints de pump.fun terminan en "pump". Si no, no tiene página en pump.fun.
    const isPumpfun = typeof mint === 'string' && mint.toLowerCase().endsWith('pump');
    candidates.push({
      symbol: token.symbol,
      name: token.name,
      mint,
      score,
      ageMin: Math.round(ageMinutes(pair)),
      liqUsd: Math.round(pair.liquidity?.usd ?? 0),
      volH1: Math.round(pair.volume?.h1 ?? 0),
      priceUsd: pair.priceUsd,
      chg1h: pair.priceChange?.h1 ?? 0,
      security: safety?.ok
        ? {
            topHolderPct: safety.topHolderPct == null ? null : +safety.topHolderPct.toFixed(1),
            lpLockedPct: safety.lpLockedPct == null ? null : +safety.lpLockedPct.toFixed(1),
            risk: safety.riskLevel,
          }
        : 'sin datos',
      breakdown,
      isPumpfun,
      pumpfunUrl: isPumpfun ? `https://pump.fun/coin/${mint}` : null,
      dexUrl: pair.url || `https://dexscreener.com/${cfg.chain}/${pair.pairAddress}`,
    });
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates; // lista completa ordenada; el recorte para mostrar se hace en main()
}

function printTable(rows) {
  const stamp = new Date().toLocaleTimeString('es-ES');
  console.log(`\n=== Screener memecoins · ${stamp} · ${rows.length} candidatos ===`);
  console.log('(candidatos para INVESTIGAR, no señales de compra)\n');
  if (!rows.length) return console.log('Nada supera el umbral ahora mismo.\n');
  for (const r of rows) {
    const sec = typeof r.security === 'string'
      ? r.security
      : `top:${r.security.topHolderPct ?? '?'}% lp:${r.security.lpLockedPct ?? '?'}% ${r.security.risk}`;
    console.log(
      `[${String(r.score).padStart(3)}] $${(r.symbol || '?').padEnd(10)} ` +
      `edad:${r.ageMin}m liq:$${r.liqUsd} vol1h:$${r.volH1} 1h:${r.chg1h > 0 ? '+' : ''}${r.chg1h}%`,
    );
    console.log(`      seguridad: ${sec}`);
    if (r.pumpfunUrl) console.log(`      pump.fun: ${r.pumpfunUrl}`);
    console.log(`      dexscreener: ${r.dexUrl}`);
  }
  console.log('');
}

async function main() {
  const all = await runOnce().catch((e) => {
    console.error('Error en la pasada:', e.message);
    return [];
  });

  const supaOn = !!(cfg.supabase?.enabled && cfg.supabase.url && cfg.supabase.serviceKey);

  // 1) Guardar en Supabase primero (insert-once por mint). Necesario antes de alertar
  //    con dedup, porque el anti-spam consulta el estado 'alerted' de esas filas.
  if (supaOn) {
    await saveCandidates(cfg, all)
      .then((n) => { if (n && !asJSON) console.log(`💾 ${n} candidatos enviados a Supabase.`); })
      .catch((e) => console.error('Error guardando en Supabase:', e.message));
  }

  // 2) Alertas.
  if (cfg.alerts?.enabled) {
    if (supaOn) {
      // Anti-spam persistente vía Supabase (sobrevive entre ejecuciones del cron).
      const highScore = all.filter((c) => c.score >= (cfg.alerts.minScore ?? 75));
      if (highScore.length) {
        try {
          const alertable = new Set(await getAlertableMints(cfg, highScore.map((c) => c.mint)));
          const toSend = highScore.filter((c) => alertable.has(c.mint));
          for (const c of toSend) {
            await sendAlert(cfg, c);
            if (!asJSON) console.log(`🔔 Alerta enviada: $${c.symbol} (score ${c.score})`);
          }
          if (toSend.length) await markAlerted(cfg, toSend.map((c) => c.mint));
        } catch (e) {
          console.error('Error en alertas (Supabase):', e.message);
        }
      }
    } else {
      // Respaldo local (archivo .alerted.json) cuando Supabase está desactivado.
      await maybeAlert(cfg, all).catch((e) => console.error('Error en alertas:', e.message));
    }
  }

  const rows = all.slice(0, cfg.run.maxResults);
  if (asJSON) console.log(JSON.stringify(rows, null, 2));
  else printTable(rows);
}

if (watch) {
  main();
  setInterval(main, 60000);
} else {
  main();
}
