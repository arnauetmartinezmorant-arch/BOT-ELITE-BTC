/* ============================================================
   liquidations.js — Liquidations layer

   1) REAL-TIME liquidations from Binance USDⓈ-M Futures (BTCUSDT perp)
      via the public `@forceOrder` WebSocket stream — free, no API key.
      Binance retired the legacy WS host (Apr 2026), so we try several
      base URLs in order and fall back gracefully.

   2) Coinglass-style LIQUIDATION LEVELS ("liq map/heatmap") estimated
      locally from price + leverage tiers. Coinglass's real heatmap needs
      their PAID API + key and isn't reachable from a keyless browser app,
      so these levels are clearly an ESTIMATION (same concept Coinglass uses:
      where leveraged longs/shorts get force-closed).

   This module is contextual: it does NOT feed the signal engine.
   ============================================================ */

/* Tried in order; first that opens wins. Covers the new /public bases and
   the legacy single-stream path for older regions/proxies. */
const FUTURES_WS_CANDIDATES = [
  'wss://fstream.binance.com/stream?streams=btcusdt@forceOrder',
  'wss://fstream.binance.com/public/stream?streams=btcusdt@forceOrder',
  'wss://fstream.binance.com/ws/btcusdt@forceOrder',
];

/**
 * Live liquidation feed manager.
 * @param {object} opts
 * @param {(state:object)=>void} opts.onUpdate - called on every update.
 * @param {number} [opts.max=60] - max events to keep.
 */
export function createLiquidationFeed({ onUpdate, max = 60 } = {}) {
  let ws = null;
  let idx = 0;
  let alive = false;
  let stopped = false;
  let reconnectTimer = null;
  let openTimer = null;
  const events = [];                 // newest first
  let totalLong = 0;                 // USD of longs force-closed since start
  let totalShort = 0;                // USD of shorts force-closed since start
  let startedAt = Date.now();
  let lastError = null;

  const getState = () => ({ events: events.slice(), totalLong, totalShort, alive, startedAt, lastError });
  const emit = () => { if (onUpdate) onUpdate(getState()); };

  function handle(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    // combined-stream wraps payload in {stream,data}; single-stream is flat
    const o = (msg && msg.data && msg.data.o) || (msg && msg.o) || null;
    if (!o) return;
    const price = parseFloat(o.ap || o.p);
    const qty = parseFloat(o.z || o.q || o.l);
    if (!price || !qty) return;
    // side SELL => a LONG was force-sold; side BUY => a SHORT was force-bought
    const isLong = String(o.S).toUpperCase() === 'SELL';
    const usd = price * qty;
    events.unshift({ time: o.T || msg.E || Date.now(), side: isLong ? 'long' : 'short', price, qty, usd });
    if (events.length > max) events.length = max;
    if (isLong) totalLong += usd; else totalShort += usd;
    emit();
  }

  function connect() {
    if (stopped) return;
    const url = FUTURES_WS_CANDIDATES[idx % FUTURES_WS_CANDIDATES.length];
    try {
      ws = new WebSocket(url);
      ws.onopen = () => { alive = true; lastError = null; emit(); };
      ws.onmessage = (e) => handle(e.data);
      ws.onerror = () => { alive = false; lastError = 'error de conexión'; };
      ws.onclose = () => { alive = false; emit(); scheduleReconnect(); };
      // if it doesn't open within 6s, rotate to the next candidate URL
      clearTimeout(openTimer);
      openTimer = setTimeout(() => { if (!alive && ws) { try { ws.onclose = null; ws.close(); } catch (e) {} idx++; scheduleReconnect(); } }, 6000);
    } catch (e) {
      lastError = 'no se pudo abrir el stream';
      idx++;
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
  }

  return {
    start() { stopped = false; startedAt = Date.now(); connect(); },
    stop() {
      stopped = true;
      clearTimeout(openTimer);
      clearTimeout(reconnectTimer); reconnectTimer = null;
      if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
      alive = false;
    },
    getState,
  };
}

/* ---------------------- liquidation level estimation ---------------------- */
const DEFAULT_TIERS = [100, 50, 25];
const MMR = 0.004;   // ~maintenance-margin approximation for BTC perps

/**
 * Estimate where leveraged positions get liquidated relative to the current
 * price (the magnets that Coinglass's liq map highlights).
 * @returns {Array<{side,leverage,price,distPct,intensity,label}>}
 */
export function estimateLiquidationLevels(price, opts = {}) {
  if (!price || price <= 0) return [];
  const tiers = opts.tiers || DEFAULT_TIERS;
  const out = [];
  for (const L of tiers) {
    const frac = 1 / L - MMR;                 // distance to liquidation as a fraction
    if (frac <= 0) continue;
    const longLiq = price * (1 - frac);       // longs liquidate BELOW price
    const shortLiq = price * (1 + frac);      // shorts liquidate ABOVE price
    const intensity = Math.min(1, L / 100);   // higher leverage = denser cluster, closer to price
    out.push({ side: 'long', leverage: L, price: round2(longLiq), distPct: ((longLiq - price) / price) * 100, intensity, label: `Liq Long ${L}x` });
    out.push({ side: 'short', leverage: L, price: round2(shortLiq), distPct: ((shortLiq - price) / price) * 100, intensity, label: `Liq Short ${L}x` });
  }
  return out;
}

function round2(n) { return Math.round(n * 100) / 100; }
