/* ============================================================
   heatmap.js — Liquidation HEATMAP (Coinglass-style)

   Builds a liquidation heatmap ANCHORED to fixed price levels (it does
   NOT move with the live price — candles travel across it). For every
   historical candle we project where leveraged longs/shorts would be
   force-closed (price · (1 ∓ 1/L) for several leverage tiers) and we
   accumulate that estimated liquidation leverage into price bins,
   weighted by traded volume and recency.

   The result is a set of horizontal bands with an intensity that the
   renderer paints purple → blue → teal → green → yellow, exactly like a
   liquidation heatmap. Coinglass's REAL heatmap needs their paid API, so
   this is a faithful on-chart ESTIMATION using the same concept.
   ============================================================ */

// leverage tiers and their relative weight (higher leverage = tighter,
// brighter clusters near price; lower leverage = wider, fainter)
const TIERS = [
  { L: 10, w: 1.0 },
  { L: 20, w: 1.15 },
  { L: 25, w: 1.3 },
  { L: 50, w: 1.55 },
  { L: 75, w: 1.7 },
  { L: 100, w: 1.9 },
  { L: 125, w: 2.1 },
];

/**
 * @param {Array} candles - [{time, open, high, low, close, volume}]
 * @param {object} [opts]
 * @param {number} [opts.bins=170] - vertical resolution.
 * @param {number} [opts.pad=0.12] - fraction of range padded above/below.
 * @returns {{bins:Array<{price:number,weight:number,startTime:number}>, max:number, priceMin:number, priceMax:number, binSize:number}}
 */
export function computeLiquidationHeatmap(candles, opts = {}) {
  const empty = { bins: [], max: 0, priceMin: 0, priceMax: 0, binSize: 0 };
  const n = candles ? candles.length : 0;
  if (n < 20) return empty;

  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; }
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return empty;

  const pad = opts.pad != null ? opts.pad : 0.12;
  const priceMin = lo * (1 - pad);
  const priceMax = hi * (1 + pad);
  const nBins = opts.bins || 200;
  const binSize = (priceMax - priceMin) / nBins;
  if (binSize <= 0) return empty;

  const weights = new Float64Array(nBins);
  const usds = new Float64Array(nBins);         // estimated liquidation notional (USD)
  const startTimes = new Float64Array(nBins);   // earliest candle that formed the level
  startTimes.fill(0);

  // fraction of a candle's traded notional assumed to rest as leveraged
  // liquidation liquidity at the projected level (tuning constant)
  const PARTICIPATION = 0.12;

  const idxOf = (price) => Math.floor((price - priceMin) / binSize);

  // average volume for normalization (fallback to candle range if no volume)
  let volSum = 0, volCount = 0;
  for (const c of candles) { const v = c.volume || (c.high - c.low); if (v > 0) { volSum += v; volCount++; } }
  const avgVol = volCount ? volSum / volCount : 1;

  // iterate oldest → newest so the FIRST contribution to a bin marks when that
  // liquidity formed (the band then extends to the right edge, Coinglass-style)
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const recency = 0.3 + 0.7 * (i / (n - 1));            // recent candles weigh more
    const vol = (c.volume || (c.high - c.low)) / (avgVol || 1);
    const base = Math.max(0.05, vol) * recency;
    const usdVol = (c.volume || (c.high - c.low)) * c.close;   // ≈ USD traded this candle
    const price = c.close;
    for (const { L, w } of TIERS) {
      const frac = 1 / L;
      const longLiq = price * (1 - frac);                 // longs liquidate below
      const shortLiq = price * (1 + frac);                // shorts liquidate above
      const contrib = base * w;
      const usdContrib = usdVol * recency * w * PARTICIPATION;
      for (const lvl of [longLiq, shortLiq]) {
        const bi = idxOf(lvl);
        if (bi < 0 || bi >= nBins) continue;
        weights[bi] += contrib;
        usds[bi] += usdContrib;
        if (startTimes[bi] === 0) startTimes[bi] = c.time;   // first time it formed
      }
    }
  }

  // light vertical smoothing so bands blend into a gradient
  const smooth = new Float64Array(nBins);
  for (let i = 0; i < nBins; i++) {
    smooth[i] = weights[i] * 0.6
      + (weights[i - 1] || 0) * 0.2
      + (weights[i + 1] || 0) * 0.2;
  }

  let max = 0;
  for (let i = 0; i < nBins; i++) if (smooth[i] > max) max = smooth[i];

  const bins = [];
  for (let i = 0; i < nBins; i++) {
    if (smooth[i] <= 0) continue;
    bins.push({
      price: priceMin + (i + 0.5) * binSize,
      weight: smooth[i],
      usd: usds[i],
      startTime: startTimes[i] || candles[0].time,
    });
  }
  return { bins, max, priceMin, priceMax, binSize };
}

/**
 * Heatmap colour ramp. t in [0,1] → {r,g,b}.
 * dark purple → indigo → teal → green → yellow.
 */
export function heatmapColor(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    [0.00, [38, 22, 74]],     // dark purple
    [0.30, [40, 78, 160]],    // indigo/blue
    [0.55, [26, 150, 158]],   // teal
    [0.78, [92, 200, 110]],   // green
    [1.00, [250, 228, 40]],   // yellow
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return {
        r: Math.round(c0[0] + (c1[0] - c0[0]) * f),
        g: Math.round(c0[1] + (c1[1] - c0[1]) * f),
        b: Math.round(c0[2] + (c1[2] - c0[2]) * f),
      };
    }
  }
  const last = stops[stops.length - 1][1];
  return { r: last[0], g: last[1], b: last[2] };
}
