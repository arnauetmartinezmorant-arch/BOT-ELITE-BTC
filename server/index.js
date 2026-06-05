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
import { formatSignal, formatExit, formatReversal } from './format.js';

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
    out[k] = typeof v === 'string'
      ? { dir: v, trade: null }
      : { dir: v.dir || 'none', trade: v.trade || null };
  }
  return out;
}
function saveState() {
  try { writeFileSync(STATE_FILE, JSON.stringify(STATE)); } catch (e) { /* ignore */ }
}
function entryFor(key) {
  if (!STATE[key]) STATE[key] = { dir: 'none', trade: null };
  return STATE[key];
}

function activeModes() { return MODES.filter((m) => CONFIG.channels[m]); }

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

async function checkTimeframe(tf) {
  const { candles, source } = await fetchCandles(tf, 400);
  if (source === 'Simulado' && !CONFIG.dryRun) {
    console.warn(`[${tf}] sin datos reales de mercado; se omite este ciclo`);
    return;
  }
  const closed = closedOnly(candles);
  const ind = computeIndicators(closed);
  const mtf = await mtfBiasFor(tf);
  const lastClosedTime = closed.length ? closed[closed.length - 1].time : 0;

  for (const mode of activeModes()) {
    let sig;
    try { sig = generateSignal(closed, ind, mode, mtf); } catch (e) { continue; }
    const key = `${mode}:${tf}`;
    const st = entryFor(key);
    const dir = sig.direction; // 'long' | 'short' | 'none'
    const chat = CONFIG.channels[mode];
    const stamp = () => new Date().toISOString();

    // 1) Track the lifecycle of a trade we already alerted (TP1/TP2/SL/BE).
    if (st.trade) {
      const res = evaluateTrade(st.trade, closed);
      st.trade.tp1Hit = res.tp1Hit;
      st.trade.stop = res.stop;
      st.trade.checkedTime = res.checkedTime;
      for (const ev of res.events) {
        const ok = await sendTelegram(chat, formatExit(mode, tf, st.trade, ev));
        console.log(`[${stamp()}] ${mode}/${tf} → ${ev.type.toUpperCase()} @ ${ev.price} ${ok ? '· enviado' : '· NO enviado'}`);
      }
      if (res.closed) st.trade = null;
    }

    // 2) Direction change → close-on-reversal and/or open a new trade.
    if (dir !== st.dir) {
      // The live signal flipped against an open trade → warn it's invalidated.
      if (st.trade && dir !== st.trade.dir) {
        const ok = await sendTelegram(chat, formatReversal(mode, tf, st.trade, dir));
        console.log(`[${stamp()}] ${mode}/${tf} → CIERRE POR CAMBIO DE SEÑAL ${ok ? '· enviado' : '· NO enviado'}`);
        st.trade = null;
      }
      st.dir = dir;

      if (dir !== 'none' && sig.plan) {
        const ok = await sendTelegram(chat, formatSignal(mode, tf, sig));
        st.trade = {
          dir,
          entry: sig.plan.entry,
          stop: sig.plan.stop,
          tp1: sig.plan.tp1,
          tp2: sig.plan.tp2,
          openTime: lastClosedTime,
          checkedTime: lastClosedTime,
          tp1Hit: false,
        };
        console.log(`[${stamp()}] ${mode}/${tf} → ${dir.toUpperCase()} ` +
          `conv ${sig.conviction}% ${ok ? '· enviado' : '· NO enviado'}`);
      }
    }
  }
}

async function loop() {
  for (const tf of CONFIG.timeframes) {
    try { await checkTimeframe(tf); } catch (e) { console.error(`[loop] ${tf}:`, e.message); }
  }
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
