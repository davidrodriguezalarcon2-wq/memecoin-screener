// sources.js — clientes de las APIs públicas y gratuitas.
//   - DEX Screener: descubre tokens nuevos + datos de mercado (liquidez, volumen, txns).
//   - RugCheck: datos de seguridad on-chain (autoridades, holders, LP bloqueado).
// Ambas son públicas y no requieren API key. Si alguna cambia el esquema de respuesta,
// los campos están accedidos de forma defensiva (?.) para que no explote todo.

const DEX = 'https://api.dexscreener.com';
const RUGCHECK = 'https://api.rugcheck.xyz/v1';

async function getJSON(url, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Tokens recién listados / promocionados (buen caladero de memecoins nuevas).
async function fetchNewTokenAddresses(chain) {
  const [profiles, boosts] = await Promise.allSettled([
    getJSON(`${DEX}/token-profiles/latest/v1`),
    getJSON(`${DEX}/token-boosts/latest/v1`),
  ]);

  const addrs = new Set();
  const collect = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (item?.chainId === chain && item?.tokenAddress) addrs.add(item.tokenAddress);
    }
  };
  if (profiles.status === 'fulfilled') collect(profiles.value);
  if (boosts.status === 'fulfilled') collect(boosts.value);
  return [...addrs];
}

// Datos de mercado de una tanda de tokens (DEX Screener acepta hasta 30 por llamada).
async function fetchPairsForTokens(chain, addresses) {
  const pairs = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30).join(',');
    const data = await getJSON(`${DEX}/latest/dex/tokens/${batch}`).catch(() => null);
    if (data?.pairs) pairs.push(...data.pairs.filter((p) => p.chainId === chain));
  }
  return pairs;
}

// Por token puede haber varios pares; nos quedamos con el de mayor liquidez.
// IMPORTANTE: el token que pedimos puede venir como baseToken o como quoteToken
// del par (el orden depende de cómo se creó el pool, no de cuál nos interesa).
// Por eso recibimos `tokenAddresses` (las direcciones que realmente pedimos) y
// resolvemos, para cada par, cuál lado es "nuestro" token -en vez de asumir
// siempre baseToken-. Devolvemos {address, symbol, name, pair} ya resuelto para
// que el resto del código no tenga que volver a adivinar de qué lado está.
//
// Nota: si el token solo aparece como quoteToken, campos del par como
// `priceUsd`/`priceChange` siguen describiendo la cotización base/quote tal
// como la reporta DexScreener; úsalos con algo de cautela para esos casos
// puntuales (es una limitación de la fuente de datos, no de este código).
function bestPairPerToken(pairs, tokenAddresses) {
  const wanted = new Set(tokenAddresses);
  const byToken = new Map();
  for (const p of pairs) {
    const baseAddr = p?.baseToken?.address;
    const quoteAddr = p?.quoteToken?.address;
    const isBase = wanted.has(baseAddr);
    const addr = isBase ? baseAddr : (wanted.has(quoteAddr) ? quoteAddr : null);
    if (!addr) continue;

    const liq = p?.liquidity?.usd ?? 0;
    const cur = byToken.get(addr);
    if (!cur || liq > (cur.pair?.liquidity?.usd ?? 0)) {
      byToken.set(addr, {
        address: addr,
        symbol: isBase ? p?.baseToken?.symbol : p?.quoteToken?.symbol,
        name: isBase ? p?.baseToken?.name : p?.quoteToken?.name,
        pair: p,
      });
    }
  }
  return [...byToken.values()];
}

// Seguridad on-chain. Esquema defensivo: RugCheck ha cambiado campos en el pasado.
async function fetchRugCheck(mint) {
  try {
    const r = await getJSON(`${RUGCHECK}/tokens/${mint}/report`, { timeoutMs: 10000 });
    const topHolderPct = Array.isArray(r?.topHolders) && r.topHolders.length
      ? Number(r.topHolders[0]?.pct ?? 0)
      : null;
    const lpLockedPct = r?.markets?.[0]?.lp?.lpLockedPct ?? null;
    return {
      ok: true,
      mintAuthority: r?.mintAuthority ?? r?.token?.mintAuthority ?? null,
      freezeAuthority: r?.freezeAuthority ?? r?.token?.freezeAuthority ?? null,
      topHolderPct,
      lpLockedPct: lpLockedPct == null ? null : Number(lpLockedPct),
      riskLevel: (r?.risks || []).some((x) => x?.level === 'danger') ? 'danger'
                : (r?.risks || []).some((x) => x?.level === 'warn') ? 'warn' : 'ok',
      normalisedScore: r?.score_normalised ?? r?.score ?? null,
    };
  } catch {
    return { ok: false }; // si falla, seguimos sin bloquear (lo marcamos como desconocido)
  }
}

module.exports = { fetchNewTokenAddresses, fetchPairsForTokens, bestPairPerToken, fetchRugCheck };
