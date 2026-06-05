/* ============================================================
   index.js — Telegram alert bot.
   Reuses the SAME analysis engine as the web app (js/*.js) and
   posts a signal to each mode's own Telegram channel.

   Two ways to run:
   - Always-on (Railway / your PC):  npm start
   - Once per call (GitHub Actions cron):  RUN_ONCE=1 node server/index.js

   Signals are evaluated on the last CLOSED candle (no repaint) and
   de-duplicated by direction change, with state persisted to a JSON
   file so cron runs don't spam the same alert.
   ============================================================ */

import { readFileSync, writeFileSync } from 'node:fs';
import { fetchCandles } from '../js/data.js';
import { computeIndicators } from '../js/indicators.js';
import { generateSignal, timeframeBias } from '../js/signals.js';
import { CONFIG } from './config.js';
import { sendTelegram } from './telegram.js';
import { formatSignal } from './format.js';

const MODES = ['conservador', 'premium'];
const MTF_LIST = ['15m', '1h', '4h', '1d', '1w'];
const STATE_FILE = process.env.STATE_FILE || new URL('./state.json', import.meta.url).pathname;
const RUN_ONCE = process.env.RUN_ONCE === '1' || process.env.RUN_ONCE === 'true';

let lastDir = loadState(); // `${mode}:${tf}` -> 'long' | 'short' | 'none'

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}
function saveState() {
  try { writeFileSync(STATE_FILE, JSON.stringify(lastDir)); } catch (e) { /* ignore */ }
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

async function checkTimeframe(tf) {
  const { candles, source } = await fetchCandles(tf, 400);
  if (source === 'Simulado' && !CONFIG.dryRun) {
    console.warn(`[${tf}] sin datos reales de mercado; se omite este ciclo`);
    return;
  }
  const closed = closedOnly(candles);
  const ind = computeIndicators(closed);
  const mtf = await mtfBiasFor(tf);

  for (const mode of activeModes()) {
    let sig;
    try { sig = generateSignal(closed, ind, mode, mtf); } catch (e) { continue; }
    const key = `${mode}:${tf}`;
    const dir = sig.direction; // 'long' | 'short' | 'none'

    // Only alert when the direction CHANGES (e.g. none→long, long→short).
    if (dir === lastDir[key]) continue;
    lastDir[key] = dir;
    if (dir === 'none' || !sig.plan) continue;

    const ok = await sendTelegram(CONFIG.channels[mode], formatSignal(mode, tf, sig));
    console.log(`[${new Date().toISOString()}] ${mode}/${tf} → ${dir.toUpperCase()} ` +
      `conv ${sig.conviction}% ${ok ? '· enviado' : '· NO enviado'}`);
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

start();
