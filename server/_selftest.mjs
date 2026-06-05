/* Offline smoke test: verifies the analysis → message pipeline without
   network or Telegram. Run with: npm run selftest */

import { generateSyntheticCandles } from '../js/data.js';
import { computeIndicators } from '../js/indicators.js';
import { generateSignal } from '../js/signals.js';
import { formatSignal, formatExit, formatReversal } from './format.js';
import { evaluateTrade, stepTradeState } from './index.js';

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

/* ── Regression: re-notify a FRESH signal in the SAME direction after close ──
   Bug: after a LONG closed (e.g. via SL), state kept dir='long', so the next
   LONG was silently de-duplicated and never alerted. */
const longSig = { direction: 'long', conviction: 80, plan: { entry: 100, stop: 90, tp1: 110, tp2: 120 } };
const noneSig = { direction: 'none', conviction: 0, plan: null };
const cc = (time, low, high) => ({ time, low, high, open: low, close: high, volume: 1 });

// Cycle 1: fresh LONG with no prior state → must emit an entry.
let s1 = stepTradeState(undefined, longSig, [cc(10, 99, 101)], 10);
check('Ciclo 1: nueva señal LONG → avisa entrada', s1.actions.some((a) => a.kind === 'entry') && s1.st.trade);

// Cycle 2: price hits the stop loss → must emit an SL exit and clear the trade.
let s2 = stepTradeState(s1.st, noneSig, [cc(20, 88, 95)], 20);
check('Ciclo 2: toca Stop Loss → avisa cierre y libera la operación',
  s2.actions.some((a) => a.kind === 'exit' && a.ev.type === 'sl') && !s2.st.trade && s2.st.dir === 'none');

// Cycle 3: a NEW long appears later → must alert AGAIN (this was the bug).
let s3 = stepTradeState(s2.st, longSig, [cc(30, 99, 101)], 30);
check('Ciclo 3: nuevo LONG tras el cierre → VUELVE a avisar (bug corregido)',
  s3.actions.some((a) => a.kind === 'entry') && s3.st.trade);

// Anti-whipsaw: if the SL is hit AND the signal is LONG again in the SAME
// cycle, it must close but NOT immediately re-open in that same cycle.
let sWhip = stepTradeState(s1.st, longSig, [cc(20, 88, 95)], 20);
check('No reentra en el MISMO ciclo del cierre (anti-whipsaw)',
  sWhip.actions.some((a) => a.kind === 'exit' && a.ev.type === 'sl') &&
  !sWhip.actions.some((a) => a.kind === 'entry'));

console.log('\n──── Ejemplo de mensajes de cierre ────');
console.log(formatExit('premium', '1h', LONG, { type: 'tp2', price: 120 }));
console.log('---');
console.log(formatReversal('conservador', '4h', LONG, 'short'));

console.log(failures === 0 ? '\n✅ Ciclo de vida de operaciones OK.' : `\n❌ ${failures} comprobación(es) fallida(s).`);
process.exit(failures === 0 ? 0 : 1);
