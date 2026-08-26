#!/usr/bin/env node
// test-alert.js — envía una alerta de prueba (Telegram/webhook) sin pasar por
// todo el pipeline de descubrimiento. Útil para verificar que config.js/alerts.js
// están bien conectados antes de esperar a que aparezca un candidato real.

const cfg = require('./config');
const { maybeAlert } = require('./alerts');

const fakeCandidate = {
  symbol: 'TEST',
  name: 'Test Token',
  mint: `test-${Date.now()}`, // único cada vez: no choca con el cooldown de alertas reales
  score: 99,
  ageMin: 5,
  liqUsd: 12345,
  volH1: 6789,
  priceUsd: '0.000123',
  chg1h: 42,
  security: { topHolderPct: 10.5, lpLockedPct: 100, risk: 'ok' },
  breakdown: {},
  isPumpfun: false,
  pumpfunUrl: null,
  dexUrl: 'https://dexscreener.com/solana/TEST',
};

maybeAlert(cfg, [fakeCandidate])
  .then((sent) => {
    console.log(sent
      ? `Enviada ${sent} alerta de prueba.`
      : 'No se envió nada (revisa alerts.enabled / minScore / webhookUrl-telegram en config.js).');
  })
  .catch((e) => console.error('Error al probar la alerta:', e.message));
