/* ============================================================
   index.js — Telegram alert bot.
   Reuses the SAME analysis engine as the web app (js/*.js) and
   posts a signal to each mode's own Telegram channel.

   Two ways to run:
   - Always-on (Railway / your PC):  npm start
   - Once per call (GitHub Actions cron):  RUN_ONCE=1 node server/index.js

   Signals are evaluated on the last CLOSED candle (no repaint) and
   de-duplicated by direction change. After an entry, the bot keeps
   tracking that trade and alerts when price hits TP1 (→ stop to
   break-even), TP2, the Stop Loss, break-even, or when the signal
   flips against it. State is persisted to a JSON file so cron runs
   don't spam or lose track of open trades.
   ============================================================ */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchCandles } from '../js/data.js';
import { computeIndicators } from '../js/indicators.js';
import { generateSignal, timeframeBias } from '../js/signals.js';
import { CONFIG } from './config.js';
import { sendTelegram } from './telegram.js';
import { formatSignal, formatExit, formatReversal, formatHeartbeat } from './format.js';

const MODES = ['conservador', 'premium'];
const MTF_LIST = ['15m', '1h', '4h', '1d', '1w'];
const STATE_FILE = process.env.STATE_FILE || new URL('./state.json', import.meta.url).pathname;
const RUN_ONCE = process.env.RUN_ONCE === '1' || process.env.RUN_ONCE === 'true';

// Persisted state per `${mode}:${tf}`:  { dir, trade }
//   dir   : last signalled direction ('long' | 'short' | 'none')
//   trade : the OPEN trade we are tracking, or null. Shape:
//           { dir, entry, stop, tp1, tp2, openTime, checkedTime, tp1Hit }
let STATE = loadState();

function loadState() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) || {}; } catch (e) { raw = {}; }
  // Migrate the old flat format ({ "mode:tf": "long" }) to the new shape.
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '__meta') { out.__meta = v || {}; continue; }   // keep metadata as-is
    out[k] = typeof v === 'string'
      ? { dir: v, trade: null }
      : { dir: v.dir || 'none', trade: v.trade || null };
  }
  return out;
}
function saveState() {
  try { writeFileSync(STATE_FILE, JSON.stringify(STATE)); } catch (e) { /* ignore */ }
}

function activeModes() { return MODES.filter((m) => CONFIG.channels[m]); }

// Last data source seen (Binance/OKX/…); shown in the heartbeat.
let LAST_SOURCE = '—';

/** Collect the trades the bot is currently tracking, for the heartbeat. */
function openTradesSummary() {
  const out = [];
  for (const [key, st] of Object.entries(STATE)) {
    if (st && st.trade) {
      const [mode, tf] = key.split(':');
      out.push({ mode, tf, dir: st.trade.dir, entry: st.trade.entry });
    }
  }
  return out;
}

/**
 * Send a periodic "I'm alive" message so you know the bot is running even
 * when there are no new signals. Throttled by HEARTBEAT_HOURS and persisted
 * in STATE so cron runs don't spam it. Sent to every active channel.
 */
async function maybeHeartbeat() {
  const h = CONFIG.heartbeatHours;
  if (!h && h !== -1) return;                 // 0 → disabled
  const meta = STATE.__meta || (STATE.__meta = {});
  const now = Date.now();
  const due = h === -1 || !meta.lastHeartbeat || (now - meta.lastHeartbeat) >= h * 3600000;
  if (!due) return;

  const modes = activeModes();
  const msg = formatHeartbeat({
    time: now,
    timeframes: CONFIG.timeframes,
    modes,
    source: LAST_SOURCE,
    openTrades: openTradesSummary(),
  });
  // Prefer the conservador channel; fall back to whatever is configured.
  const targets = modes.length ? [CONFIG.channels[modes[0]]] : [];
  for (const chat of targets) {
    const ok = await sendTelegram(chat, msg);
    console.log(`[${new Date().toISOString()}] 💓 heartbeat ${ok ? '· enviado' : '· NO enviado'}`);
  }
  meta.lastHeartbeat = now;
}


/** Drop the still-forming last candle so signals are based on CLOSED data. */
function closedOnly(candles) { return candles.length > 1 ? candles.slice(0, -1) : candles; }

/** Bias from timeframes ABOVE the given one (for Premium's MTF requirement). */
async function mtfBiasFor(tf) {
  const idx = MTF_LIST.indexOf(tf);
  const scope = idx >= 0 && idx < MTF_LIST.length - 1 ? MTF_LIST.slice(idx + 1) : MTF_LIST;
  let up = 0, down = 0;
  for (const t of scope) {
    try {
      const { candles, source } = await fetchCandles(t, 260);
      if (source === 'Simulado') continue;
      const b = timeframeBias(closedOnly(candles), computeIndicators(closedOnly(candles)));
      if (b.dir === 'bull') up++; else if (b.dir === 'bear') down++;
    } catch (e) { /* skip this tf */ }
  }
  return { up, down, total: scope.length, score: up - down };
}

/**
 * Walk the CLOSED candles printed after a trade's last check and detect
 * whether any of its levels were touched (no repaint). The cursor
 * `checkedTime` advances so each candle is evaluated exactly once.
 * Returns { events, closed, tp1Hit, stop, checkedTime }.
 */
export function evaluateTrade(trade, closed) {
  const isLong = trade.dir === 'long';
  let stop = trade.stop;
  let tp1Hit = !!trade.tp1Hit;
  const since = trade.checkedTime || trade.openTime || 0;
  const events = [];
  let isClosed = false;
  let seen = since;

  for (const c of closed) {
    if (c.time <= since) continue; // only candles not yet evaluated
    seen = c.time;
    if (isLong) {
      if (c.low <= stop) { events.push({ type: tp1Hit ? 'be' : 'sl', price: stop, time: c.time }); isClosed = true; break; }
      if (c.high >= trade.tp2) {
        if (!tp1Hit) events.push({ type: 'tp1', price: trade.tp1, time: c.time });
        events.push({ type: 'tp2', price: trade.tp2, time: c.time }); isClosed = true; break;
      }
      if (!tp1Hit && c.high >= trade.tp1) { tp1Hit = true; stop = trade.entry; events.push({ type: 'tp1', price: trade.tp1, time: c.time }); }
    } else {
      if (c.high >= stop) { events.push({ type: tp1Hit ? 'be' : 'sl', price: stop, time: c.time }); isClosed = true; break; }
      if (c.low <= trade.tp2) {
        if (!tp1Hit) events.push({ type: 'tp1', price: trade.tp1, time: c.time });
        events.push({ type: 'tp2', price: trade.tp2, time: c.time }); isClosed = true; break;
      }
      if (!tp1Hit && c.low <= trade.tp1) { tp1Hit = true; stop = trade.entry; events.push({ type: 'tp1', price: trade.tp1, time: c.time }); }
    }
  }
  return { events, closed: isClosed, tp1Hit, stop, checkedTime: seen };
}

/**
 * PURE state machine for one mode+tf in a single cycle. Given the previous
 * persisted state, the fresh signal and the closed candles, it decides which
 * alerts to emit and the next state — with NO I/O. This is what makes the
 * de-duplication logic unit-testable.
 *
 * Returns { st, actions } where actions is an ordered list of:
 *   { kind:'exit', ev, trade }        → a TP1/TP2/SL/BE lifecycle event
 *   { kind:'reversal', newDir, trade} → open trade invalidated by a flip
 *   { kind:'entry', trade }           → a fresh signal to alert + open
 */
export function stepTradeState(prev, sig, closed, lastClosedTime) {
  const st = { dir: (prev && prev.dir) || 'none', trade: (prev && prev.trade) || null };
  const dir = sig.direction; // 'long' | 'short' | 'none'
  const actions = [];
  let justClosed = false;

  // 1) Track the lifecycle of a trade we already alerted (TP1/TP2/SL/BE).
  if (st.trade) {
    const res = evaluateTrade(st.trade, closed);
    st.trade = { ...st.trade, tp1Hit: res.tp1Hit, stop: res.stop, checkedTime: res.checkedTime };
    const tradeAtEvent = st.trade;
    for (const ev of res.events) actions.push({ kind: 'exit', ev, trade: tradeAtEvent });
    if (res.closed) {
      // Reset the direction so a FRESH signal in the SAME direction alerts
      // again on a later cycle (instead of being silently de-duplicated).
      // `justClosed` prevents re-entering on the very same candle (whipsaw).
      st.trade = null;
      st.dir = 'none';
      justClosed = true;
    }
  }

  // 2) Direction change → close-on-reversal and/or open a new trade.
  if (!justClosed && dir !== st.dir) {
    if (st.trade && dir !== st.trade.dir) {
      actions.push({ kind: 'reversal', newDir: dir, trade: st.trade });
      st.trade = null;
    }
    st.dir = dir;
    if (dir !== 'none' && sig.plan) {
      const trade = {
        dir,
        entry: sig.plan.entry,
        stop: sig.plan.stop,
        tp1: sig.plan.tp1,
        tp2: sig.plan.tp2,
        openTime: lastClosedTime,
        checkedTime: lastClosedTime,
        tp1Hit: false,
      };
      st.trade = trade;
      actions.push({ kind: 'entry', trade });
    }
  }

  return { st, actions };
}

async function checkTimeframe(tf) {
  const { candles, source } = await fetchCandles(tf, 400);
  if (source === 'Simulado' && !CONFIG.dryRun) {
    console.warn(`[${tf}] sin datos reales de mercado; se omite este ciclo`);
    return;
  }
  LAST_SOURCE = source;
  const closed = closedOnly(candles);
  const ind = computeIndicators(closed);
  const mtf = await mtfBiasFor(tf);
  const lastClosedTime = closed.length ? closed[closed.length - 1].time : 0;

  for (const mode of activeModes()) {
    let sig;
    try { sig = generateSignal(closed, ind, mode, mtf); } catch (e) { continue; }
    const key = `${mode}:${tf}`;
    const chat = CONFIG.channels[mode];
    const stamp = () => new Date().toISOString();

    const { st, actions } = stepTradeState(STATE[key], sig, closed, lastClosedTime);
    STATE[key] = st;

    for (const a of actions) {
      if (a.kind === 'exit') {
        const ok = await sendTelegram(chat, formatExit(mode, tf, a.trade, a.ev));
        console.log(`[${stamp()}] ${mode}/${tf} → ${a.ev.type.toUpperCase()} @ ${a.ev.price} ${ok ? '· enviado' : '· NO enviado'}`);
      } else if (a.kind === 'reversal') {
        const ok = await sendTelegram(chat, formatReversal(mode, tf, a.trade, a.newDir));
        console.log(`[${stamp()}] ${mode}/${tf} → CIERRE POR CAMBIO DE SEÑAL ${ok ? '· enviado' : '· NO enviado'}`);
      } else if (a.kind === 'entry') {
        const ok = await sendTelegram(chat, formatSignal(mode, tf, sig));
        console.log(`[${stamp()}] ${mode}/${tf} → ${sig.direction.toUpperCase()} ` +
          `conv ${sig.conviction}% ${ok ? '· enviado' : '· NO enviado'}`);
      }
    }
  }
}

async function loop() {
  for (const tf of CONFIG.timeframes) {
    try { await checkTimeframe(tf); } catch (e) { console.error(`[loop] ${tf}:`, e.message); }
  }
  try { await maybeHeartbeat(); } catch (e) { console.error('[heartbeat]', e.message); }
  saveState();
}

async function start() {
  const modes = activeModes();
  console.log('═══════════════════════════════════════════');
  console.log(' BTC Quant · Bot de alertas a Telegram');
  console.log('═══════════════════════════════════════════');
  console.log('  Temporalidades :', CONFIG.timeframes.join(', '));
  console.log('  Canales activos:', modes.length ? modes.join(', ') : '(NINGUNO — configura TELEGRAM_CHAT_*)');
  console.log('  Modo ejecución :', RUN_ONCE ? 'UNA VEZ (cron)' : 'CONTINUO', CONFIG.dryRun ? '· DRY_RUN' : '');
  if (!CONFIG.botToken && !CONFIG.dryRun) {
    console.error('  ⚠️  Falta TELEGRAM_BOT_TOKEN (ver server/.env.example).');
  }
  console.log('───────────────────────────────────────────');

  await loop();
  if (RUN_ONCE) { console.log('Ciclo único completado.'); return; }
  setInterval(loop, CONFIG.intervalSec * 1000);
}

// Only auto-run when executed directly (so the module stays importable/testable).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start();
}
