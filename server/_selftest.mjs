/* Offline smoke test: verifies the analysis → message pipeline without
   network or Telegram. Run with: npm run selftest */

import { generateSyntheticCandles } from '../js/data.js';
import { computeIndicators } from '../js/indicators.js';
import { generateSignal } from '../js/signals.js';
import { formatSignal, formatExit, formatReversal } from './format.js';
import { evaluateTrade } from './index.js';

const modes = ['conservador', 'premium'];
let shown = 0;
for (let i = 0; i < 50 && shown < 3; i++) {
  const candles = generateSyntheticCandles('1h', 400);
  const ind = computeIndicators(candles);
  for (const m of modes) {
    const s = generateSignal(candles, ind, m, { up: 3, down: 0, total: 3, score: 2 });
    if (s.direction !== 'none' && s.plan && shown < 3) {
      console.log(formatSignal(m, '1h', s));
      console.log('---');
      shown++;
    }
  }
}
console.log(shown > 0 ? `\n✅ Pipeline OK — ${shown} mensajes de ejemplo generados.` : '\n(No se generaron señales en esta muestra; reintenta.)');

/* ── Trade lifecycle tests (deterministic) ───────────────────────────────── */
// A LONG trade: entry 100, stop 90, tp1 110, tp2 120 (1R = 10).
const LONG = { dir: 'long', entry: 100, stop: 90, tp1: 110, tp2: 120, openTime: 0, checkedTime: 0, tp1Hit: false };
const c = (time, low, high) => ({ time, low, high, open: low, close: high, volume: 1 });
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}

// 1) Stop loss hit.
let r = evaluateTrade({ ...LONG }, [c(1, 88, 95)]);
check('LONG → Stop Loss detectado y cerrado', r.closed && r.events.length === 1 && r.events[0].type === 'sl');

// 2) TP1 then TP2 across two candles.
r = evaluateTrade({ ...LONG }, [c(1, 100, 112), c(2, 115, 121)]);
check('LONG → TP1 y luego TP2 (cierre con beneficio)',
  r.closed && r.events.some((e) => e.type === 'tp1') && r.events.some((e) => e.type === 'tp2'));

// 3) TP1 hit (stop to break-even), then price returns to entry → break-even close.
r = evaluateTrade({ ...LONG }, [c(1, 105, 111), c(2, 99, 108)]);
check('LONG → TP1 y luego break-even (0R, sin pérdidas)',
  r.closed && r.events[0].type === 'tp1' && r.events.some((e) => e.type === 'be'));

// 4) Cursor advances and no duplicate alerts when nothing new happens.
let t = { ...LONG };
let step = evaluateTrade(t, [c(1, 101, 105)]);
t = { ...t, tp1Hit: step.tp1Hit, stop: step.stop, checkedTime: step.checkedTime };
let step2 = evaluateTrade(t, [c(1, 101, 105)]); // same candle again
check('Cursor evita alertas duplicadas', step.events.length === 0 && step2.events.length === 0);

// 5) Message formatters render for every event type.
const allMsgs = ['tp1', 'tp2', 'sl', 'be'].every((type) => formatExit('premium', '1h', LONG, { type, price: 110 }).includes('BTC/USDT'));
check('formatExit genera mensaje para tp1/tp2/sl/be', allMsgs);
check('formatReversal genera mensaje', formatReversal('conservador', '4h', LONG, 'short').includes('invalidada'));

console.log('\n──── Ejemplo de mensajes de cierre ────');
console.log(formatExit('premium', '1h', LONG, { type: 'tp2', price: 120 }));
console.log('---');
console.log(formatReversal('conservador', '4h', LONG, 'short'));

console.log(failures === 0 ? '\n✅ Ciclo de vida de operaciones OK.' : `\n❌ ${failures} comprobación(es) fallida(s).`);
process.exit(failures === 0 ? 0 : 1);
