// config.js — todos los umbrales en un solo sitio para que los tunees a tu gusto.
// Filosofía: los "hard filters" ELIMINAN candidatos (evitar rugs). El scoring RANKEA
// lo que sobrevive. Ninguno de estos números es mágico: son puntos de partida razonables.

module.exports = {
  chain: 'solana',

  // ---- FILTROS DUROS (si falla alguno, el token se descarta) ----
  filters: {
    minLiquidityUsd: 8000,      // por debajo, demasiado fácil de rugear / manipular
    maxLiquidityUsd: 2_000_000, // por encima, ya no es "temprano" (opcional)
    minAgeMinutes: 3,           // deja pasar los primeros minutos de caos/snipers
    maxAgeHours: 48,            // más viejo = ya no es "antes del boom"
    minH1Txns: 30,              // sin actividad no hay nada que detectar
    maxTopHolderPct: 25,        // 1 wallet con >25% = riesgo de dump brutal (via RugCheck)
    rejectIfMintAuthority: true,   // puede acuñar tokens infinitos -> rug
    rejectIfFreezeAuthority: true, // puede congelar TUS tokens -> honeypot
    requireSecurityData: true,     // FAIL-CLOSED: si RugCheck no responde, descarta el token.
                                   //   true  = más seguro, pero pierdes tokens muy nuevos sin indexar.
                                   //   false = fail-open, aparecen marcados "sin datos" (menos seguro).
    maxPriceChangeH1: 400,      // si ya hizo +400% en 1h, probablemente llegas tarde
  },

  // ---- PESOS DEL SCORE DE MOMENTUM (deben sumar ~1.0) ----
  weights: {
    volumeToLiquidity: 0.30, // rotación: cuánto se mueve vs. cuánta liquidez hay
    buyPressure: 0.25,       // ratio compras/ventas en la última hora
    makerGrowth: 0.15,       // nº de traders únicos (proxy de interés real)
    freshMomentum: 0.15,     // subida de precio reciente pero NO agotada
    liquidityHealth: 0.15,   // liquidez decente sin estar ya inflada
  },

  // ---- COMPORTAMIENTO ----
  run: {
    minScoreToShow: 45,   // 0-100; sube esto para ser más selectivo
    maxResults: 15,
    enrichWithRugCheck: true, // enriquecer con datos de seguridad on-chain
    rugCheckConcurrency: 4,   // no martillees su API
  },

  // ---- ALERTAS AL MÓVIL ----
  // Solo avisa de oportunidades FUERTES (umbral más alto que minScoreToShow).
  // Los SECRETOS se leen de variables de entorno (nunca escritos aquí).
  alerts: {
    enabled: true,
    minScore: 75,          // solo dispara alerta con score >= esto
    cooldownMinutes: 120,  // no repetir el MISMO token en este tiempo (anti-spam)
    // Opción A: webhook de n8n -> WhatsApp vía tu WAHA (o Discord).
    webhookUrl: process.env.ALERT_WEBHOOK_URL || '',
    // Opción B (alternativa): bot de Telegram. Si está relleno, tiene prioridad.
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || '',
    },
  },

  // ---- SUPABASE (guardar candidatos para backtesting) ----
  supabase: {
    enabled: true,
    url: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '', // service_role — SECRETA, solo servidor
    table: 'candidates',
  },

  // ---- BACKTEST (cómo se clasifica el resultado de cada candidato) ----
  backtest: {
    minAgeHours: 24,      // solo evalúa candidatos con al menos esta antigüedad
    rugLiqFloorPct: 20,   // si la liquidez cae por debajo del 20% de la de entrada -> rug
    rugLiqFloorUsd: 1000, // ...o por debajo de este absoluto -> rug
    pumpGainPct: 100,     // ganancia >= +100% (2x) cuenta como "pump"
    deadLossPct: -80,     // pérdida <= -80% cuenta como "muerto"
  },

  // ---- SEGUIMIENTO DEL PICO ----
  // En cada pasada, re-consulta el precio de los tokens detectados en esta ventana
  // y actualiza su máximo si ha subido. Da un backtest honesto (captura el pico real).
  peaks: {
    enabled: true,
    trackHours: 24, // sigue rastreando el pico durante 24h desde la detección
  },
};
