// scoring.js — el cerebro. Dos fases:
//   1) passesFilters(): elimina rugs y candidatos de baja calidad (evitar pérdidas).
//   2) scoreMomentum(): puntúa 0-100 lo que sobrevive (rankear interés temprano).
//
// IMPORTANTE: un score alto significa "candidato que merece que lo mires TÚ", NO
// "compra garantizada". El objetivo es reducir ruido, no predecir el futuro.

function ageMinutes(pair) {
  if (!pair?.pairCreatedAt) return Infinity;
  return (Date.now() - pair.pairCreatedAt) / 60000;
}

// Normaliza un valor a 0-1 con saturación en `cap`.
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ratioScore = (x, cap) => clamp01(x / cap);

function passesFilters(pair, safety, cfg) {
  const f = cfg.filters;
  const reasons = []; // por qué se descarta (útil para depurar)

  const liq = pair?.liquidity?.usd ?? 0;
  const age = ageMinutes(pair);
  const h1txns = (pair?.txns?.h1?.buys ?? 0) + (pair?.txns?.h1?.sells ?? 0);
  const pch1 = pair?.priceChange?.h1 ?? 0;

  if (liq < f.minLiquidityUsd) reasons.push(`liquidez baja ($${Math.round(liq)})`);
  if (liq > f.maxLiquidityUsd) reasons.push('liquidez demasiado alta (ya no es temprano)');
  if (age < f.minAgeMinutes) reasons.push('demasiado nuevo (<min edad)');
  if (age > f.maxAgeHours * 60) reasons.push('demasiado viejo');
  if (h1txns < f.minH1Txns) reasons.push('poca actividad (h1 txns)');
  if (pch1 > f.maxPriceChangeH1) reasons.push(`ya subió +${Math.round(pch1)}% en 1h (tarde)`);

  // Seguridad on-chain (si RugCheck respondió).
  if (safety?.ok) {
    if (f.rejectIfMintAuthority && safety.mintAuthority) reasons.push('mint authority activa (puede acuñar infinito)');
    if (f.rejectIfFreezeAuthority && safety.freezeAuthority) reasons.push('freeze authority activa (honeypot potencial)');
    if (safety.topHolderPct != null && safety.topHolderPct > f.maxTopHolderPct)
      reasons.push(`top holder ${Math.round(safety.topHolderPct)}%`);
    if (safety.riskLevel === 'danger') reasons.push('RugCheck: riesgo DANGER');
  } else if (f.requireSecurityData) {
    // FAIL-CLOSED: sin datos de seguridad no operamos a ciegas -> descartar.
    reasons.push('sin datos de seguridad (RugCheck no respondió)');
  }

  return { pass: reasons.length === 0, reasons };
}

function scoreMomentum(pair, safety, cfg) {
  const w = cfg.weights;
  const liq = pair?.liquidity?.usd ?? 1;
  const volH1 = pair?.volume?.h1 ?? 0;
  const buys = pair?.txns?.h1?.buys ?? 0;
  const sells = pair?.txns?.h1?.sells ?? 0;
  const pch1 = pair?.priceChange?.h1 ?? 0;
  const pch5 = pair?.priceChange?.m5 ?? 0;

  // 1) Rotación: volumen 1h respecto a liquidez. >2x liquidez/h = mucho interés.
  const sVol = ratioScore(volH1 / liq, 2);

  // 2) Presión compradora: fracción de compras. 0.5 = equilibrado, >0.6 = alcista.
  const total = buys + sells;
  const buyFrac = total ? buys / total : 0.5;
  const sBuy = clamp01((buyFrac - 0.45) / 0.25); // 0.45->0, 0.70->1

  // 3) Traders únicos (proxy: nº de txns; DEX Screener no da makers únicos en free).
  const sMakers = ratioScore(total, 400);

  // 4) Momentum fresco: subida reciente PERO no agotada. Premia +5m y +1h moderados.
  const freshUp = clamp01(pch5 / 30) * 0.5 + clamp01(pch1 / 80) * 0.5;
  const notExhausted = 1 - clamp01((pch1 - 150) / 250); // penaliza si ya lleva mucho
  const sFresh = clamp01(freshUp * notExhausted);

  // 5) Salud de liquidez: suficiente para entrar/salir, mejor si LP bloqueado.
  let sLiq = ratioScore(liq, 60000); // ~sube hasta 60k
  if (safety?.ok && safety.lpLockedPct != null) {
    sLiq = clamp01(sLiq * (0.6 + 0.4 * clamp01(safety.lpLockedPct / 100)));
  }

  const score =
    100 * (
      w.volumeToLiquidity * sVol +
      w.buyPressure * sBuy +
      w.makerGrowth * sMakers +
      w.freshMomentum * sFresh +
      w.liquidityHealth * sLiq
    );

  return {
    score: Math.round(score),
    breakdown: {
      rotacion: +sVol.toFixed(2),
      presionCompra: +sBuy.toFixed(2),
      actividad: +sMakers.toFixed(2),
      momentumFresco: +sFresh.toFixed(2),
      liquidez: +sLiq.toFixed(2),
    },
  };
}

module.exports = { passesFilters, scoreMomentum, ageMinutes };
