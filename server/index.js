/* ============================================================
   index.js — 24/7 Telegram alert bot.
   Reuses the SAME analysis engine as the web app (js/*.js) and
   posts a signal to each mode's own Telegram channel.
   Run with:  npm start     (set env vars first, see .env.example)
   Smoke test: npm run selftest
   ============================================================ */

import { fetchCandles } from '../js/data.js';
import { computeIndicators } from '../js/indicators.js';
import { generateSignal, timeframeBias } from '../js/signals.js';
import { CONFIG } from './config.js';
import { sendTelegram } from './telegram.js';
import { formatSignal } from './format.js';

const MODES = ['normal', 'conservador', 'premium'];
const MTF_LIST = ['15m', '1h', '4h', '1d', '1w'];
const lastSent = {}; // `${mode}:${tf}` -> { dir, time }

function activeModes() { return MODES.filter((m) => CONFIG.channels[m]); }

/** Bias from timeframes ABOVE the given one (for Premium's MTF requirement). */
async function mtfBiasFor(tf) {
  const idx = MTF_LIST.indexOf(tf);
  const scope = idx >= 0 && idx < MTF_LIST.length - 1 ? MTF_LIST.slice(idx + 1) : MTF_LIST;
  let up = 0, down = 0;
  for (const t of scope) {
    try {
      const { candles, source } = await fetchCandles(t, 260);
      if (source === 'Simulado') continue;
      const b = timeframeBias(candles, computeIndicators(candles));
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
  const ind = computeIndicators(candles);
  const mtf = await mtfBiasFor(tf);

  for (const mode of activeModes()) {
    let sig;
    try { sig = generateSignal(candles, ind, mode, mtf); } catch (e) { continue; }
    if (sig.direction === 'none' || !sig.plan) continue;

    const key = `${mode}:${tf}`;
    const now = Date.now();
    const prev = lastSent[key];
    // de-dupe: same direction within the cooldown window → skip
    if (prev && prev.dir === sig.direction && now - prev.time < CONFIG.cooldownMs) continue;
    lastSent[key] = { dir: sig.direction, time: now };

    const ok = await sendTelegram(CONFIG.channels[mode], formatSignal(mode, tf, sig));
    console.log(`[${new Date().toISOString()}] ${mode}/${tf} → ${sig.direction.toUpperCase()} ` +
      `conv ${sig.conviction}% ${ok ? '· enviado' : '· NO enviado'}`);
  }
}

async function loop() {
  for (const tf of CONFIG.timeframes) {
    try { await checkTimeframe(tf); } catch (e) { console.error(`[loop] ${tf}:`, e.message); }
  }
}

function start() {
  const modes = activeModes();
  console.log('═══════════════════════════════════════════');
  console.log(' BTC Quant · Bot de alertas a Telegram');
  console.log('═══════════════════════════════════════════');
  console.log('  Temporalidades :', CONFIG.timeframes.join(', '));
  console.log('  Canales activos:', modes.length ? modes.join(', ') : '(NINGUNO — configura TELEGRAM_CHAT_*)');
  console.log('  Intervalo      :', CONFIG.intervalSec + 's · Cooldown ' + (CONFIG.cooldownMs / 60000) + 'min');
  console.log('  Modo           :', CONFIG.dryRun ? 'DRY_RUN (solo consola)' : 'ENVÍO REAL');
  if (!CONFIG.botToken && !CONFIG.dryRun) {
    console.error('  ⚠️  Falta TELEGRAM_BOT_TOKEN (ver server/.env.example).');
  }
  console.log('───────────────────────────────────────────');
  loop();
  setInterval(loop, CONFIG.intervalSec * 1000);
}

start();
