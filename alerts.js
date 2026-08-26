// alerts.js — envía una notificación al móvil cuando aparece una oportunidad fuerte.
// Anti-spam: recuerda qué tokens ya avisó (en .alerted.json) y respeta un cooldown,
// así no te machaca con el mismo token cada 60s ni tras reiniciar el proceso.
//
// Dos vías de envío (elige en config.js):
//   - webhookUrl: POST genérico -> tu n8n (que reenvía a WhatsApp vía WAHA) o Discord.
//   - telegram:  bot de Telegram directo (si lo rellenas, tiene prioridad).

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '.alerted.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch { /* no bloquear */ }
}

function formatMessage(c) {
  const sec = typeof c.security === 'string'
    ? c.security
    : `top ${c.security.topHolderPct ?? '?'}% · LP ${c.security.lpLockedPct ?? '?'}% · ${c.security.risk}`;
  const lines = [
    '🚨 Oportunidad detectada',
    `$${c.symbol}  ·  score ${c.score}`,
    `liq $${c.liqUsd} · vol1h $${c.volH1} · 1h ${c.chg1h > 0 ? '+' : ''}${c.chg1h}%`,
    sec,
  ];
  if (c.pumpfunUrl) lines.push(`pump.fun: ${c.pumpfunUrl}`);
  else lines.push(`dex: ${c.dexUrl}`);
  return lines.join('\n');
}

async function send(cfg, text) {
  const a = cfg.alerts;
  if (a.telegram?.botToken && a.telegram?.chatId) {
    const url = `https://api.telegram.org/bot${a.telegram.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: a.telegram.chatId, text }),
    });
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
    return;
  }
  if (a.webhookUrl) {
    const res = await fetch(a.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Mandamos texto + el candidato completo para que n8n pueda formatear a gusto.
      body: JSON.stringify({ text, candidate: undefined }),
    });
    if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
    return;
  }
  throw new Error('Sin destino configurado (webhookUrl o telegram)');
}

// Envía el candidato completo al webhook (útil para n8n), texto para Telegram.
async function sendRich(cfg, candidate) {
  const a = cfg.alerts;
  const text = formatMessage(candidate);
  if (a.telegram?.botToken && a.telegram?.chatId) return send(cfg, text);
  if (a.webhookUrl) {
    const res = await fetch(a.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, candidate }),
    });
    if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
    return;
  }
  throw new Error('Sin destino configurado (webhookUrl o telegram)');
}

async function maybeAlert(cfg, candidates) {
  const a = cfg.alerts;
  if (!a?.enabled) return 0;

  const state = loadState();
  const now = Date.now();
  const cooldownMs = (a.cooldownMinutes ?? 120) * 60000;
  let sent = 0;

  for (const c of candidates) {
    if (c.score < (a.minScore ?? 75)) continue;      // no es lo bastante fuerte
    const last = state[c.mint];
    if (last && now - last < cooldownMs) continue;    // ya avisado hace poco
    try {
      await sendRich(cfg, c);
      state[c.mint] = now;
      sent++;
      console.log(`🔔 Alerta enviada: $${c.symbol} (score ${c.score})`);
    } catch (e) {
      console.error(`Fallo al enviar alerta de $${c.symbol}:`, e.message);
    }
  }
  saveState(state);
  return sent;
}

module.exports = { maybeAlert, formatMessage };
