/* Offline smoke test: verifies the analysis → message pipeline without
   network or Telegram. Run with: npm run selftest */

import { generateSyntheticCandles } from '../js/data.js';
import { computeIndicators } from '../js/indicators.js';
import { generateSignal } from '../js/signals.js';
import { formatSignal } from './format.js';

const modes = ['normal', 'conservador', 'premium'];
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
