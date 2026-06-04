/* ============================================================
   data.js — Market data layer
   Fetches BTC/USDT candles from public exchange APIs (client-side,
   no API key needed). Falls back across mirrors, and finally to a
   realistic synthetic generator so the UI always works offline.
   ============================================================ */

// Public REST endpoints that serve OHLCV klines without auth.
const SOURCES = [
  {
    name: 'Binance',
    url: (interval, limit) =>
      `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`,
    parse: (rows) => rows.map((r) => ({
      time: Math.floor(r[0] / 1000),
      open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
    })),
  },
  {
    name: 'Binance US',
    url: (interval, limit) =>
      `https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`,
    parse: (rows) => rows.map((r) => ({
      time: Math.floor(r[0] / 1000),
      open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
    })),
  },
  {
    name: 'OKX',
    interval: (tf) => ({ '1m':'1m','5m':'5m','15m':'15m','1h':'1H','4h':'4H','1d':'1D','1w':'1W' }[tf] || '4H'),
    url: function (tf, limit) {
      return `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=${this.interval(tf)}&limit=${Math.min(limit,300)}`;
    },
    parse: (json) => json.data.map((r) => ({
      time: Math.floor(+r[0] / 1000),
      open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
    })).reverse(),
    wrapped: true,
  },
];

const TF_SECONDS = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
};

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

/**
 * Fetch candles for a timeframe. Tries each source in order.
 * Returns { candles, source }.
 */
export async function fetchCandles(tf = '4h', limit = 400) {
  for (const src of SOURCES) {
    try {
      const url = typeof src.url === 'function' ? src.url(tf, limit) : src.url;
      const json = await fetchWithTimeout(url);
      const rows = src.wrapped ? json : json;
      const candles = src.parse(rows);
      if (candles && candles.length > 20) {
        return { candles: candles.slice(-limit), source: src.name };
      }
    } catch (e) {
      // try next source
      console.warn(`[data] ${src.name} falló:`, e.message);
    }
  }
  // Last resort: synthetic but realistic data
  return { candles: generateSyntheticCandles(tf, limit), source: 'Simulado' };
}

/**
 * Realistic synthetic OHLCV using geometric brownian motion + regime
 * shifts so charts/indicators/patterns behave plausibly when offline.
 */
export function generateSyntheticCandles(tf = '4h', limit = 400) {
  const step = TF_SECONDS[tf] || 14400;
  const now = Math.floor(Date.now() / 1000);
  const start = now - step * (limit - 1);
  const candles = [];
  let price = 64000 + (Math.random() - 0.5) * 6000;
  let drift = (Math.random() - 0.5) * 0.0008;
  const baseVol = 0.012 * Math.sqrt(step / 14400);

  for (let i = 0; i < limit; i++) {
    if (Math.random() < 0.04) drift = (Math.random() - 0.5) * 0.0016; // regime shift
    const vol = baseVol * (0.6 + Math.random() * 0.9);
    const ret = drift + (Math.random() - 0.5) * 2 * vol;
    const open = price;
    const close = Math.max(1000, open * (1 + ret));
    const hi = Math.max(open, close) * (1 + Math.random() * vol * 0.8);
    const lo = Math.min(open, close) * (1 - Math.random() * vol * 0.8);
    const volume = 50 + Math.random() * 400 * (1 + Math.abs(ret) * 60);
    candles.push({
      time: start + i * step,
      open: round(open), high: round(hi), low: round(lo), close: round(close),
      volume: round(volume),
    });
    price = close;
  }
  return candles;
}

function round(v) { return Math.round(v * 100) / 100; }

/** Fetch just the latest ticker price (fast). Falls back to last candle. */
export async function fetchTicker() {
  try {
    const j = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', 6000);
    return {
      price: +j.lastPrice,
      changePct: +j.priceChangePercent,
      source: 'Binance',
    };
  } catch (e) {
    return null;
  }
}

export { TF_SECONDS };
