/* ============================================================
   liquidity.js — Liquidity pool detection (BSL / SSL)
   Reuses the SAME swing logic the signal engine uses (findSwings
   from patterns.js) so it shares the bot's "thinking". It does NOT
   alter signals — it only maps where resting liquidity sits:

     • Buy-side liquidity (BSL)  → above price, over equal/recent highs
       (where breakout buys + short stops rest).
     • Sell-side liquidity (SSL) → below price, under equal/recent lows
       (where long stops + breakdown sells rest).

   Each pool is tagged "untapped" (resting) or "swept" (already taken),
   with strength (touches) and distance to price. The chart overlay
   draws the most relevant untapped pools as price lines.
   ============================================================ */

import { findSwings } from './patterns.js';

/**
 * Cluster swing points (highs or lows) into liquidity pools by price
 * proximity (equal highs / equal lows = stronger pool).
 */
function clusterPools(points, tol) {
  if (!points.length) return [];
  const pts = points.slice().sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of pts) {
    const c = clusters.find((cl) => Math.abs(cl.price - p.price) <= tol);
    if (c) {
      c.price = (c.price * c.touches + p.price) / (c.touches + 1);
      c.touches++;
      c.lastIndex = Math.max(c.lastIndex, p.i);
      c.lastTime = Math.max(c.lastTime, p.time);
    } else {
      clusters.push({ price: p.price, touches: 1, lastIndex: p.i, lastTime: p.time });
    }
  }
  return clusters;
}

/**
 * Detect liquidity pools from a candle array.
 * @returns {{
 *   pools: Array, buySide: Array, sellSide: Array,
 *   nearestBuy: Object|null, nearestSell: Object|null,
 *   untapped: number, lines: Array
 * }}
 */
export function detectLiquidity(candles, opts = {}) {
  const empty = { pools: [], buySide: [], sellSide: [], nearestBuy: null, nearestSell: null, untapped: 0, lines: [] };
  const n = candles ? candles.length : 0;
  if (n < 30) return empty;

  const price = candles[n - 1].close;
  const tol = price * (opts.tolPct || 0.0035);      // 0.35% → "equal" levels
  const buffer = price * 0.0004;                    // tiny wick buffer for "swept"
  const { highs, lows } = findSwings(candles, 2);

  // Build pools for each side.
  const make = (clusters, side) => clusters.map((c) => {
    // A pool is "swept" once price has traded through it AFTER it last formed.
    let swept = false;
    for (let j = c.lastIndex + 1; j < n; j++) {
      if (side === 'buy' ? candles[j].high >= c.price + buffer
                         : candles[j].low <= c.price - buffer) { swept = true; break; }
    }
    const distPct = ((c.price - price) / price) * 100;
    const recency = 1 - Math.min(1, (n - 1 - c.lastIndex) / n);   // 0..1, newer = higher
    const strength = Math.min(100, Math.round(c.touches * 26 + recency * 30 + (c.touches >= 2 ? 14 : 0)));
    return {
      side,                       // 'buy' (above) | 'sell' (below)
      price: Math.round(c.price * 100) / 100,
      touches: c.touches,
      equal: c.touches >= 2,      // equal highs/lows = magnet
      swept,
      distPct,                    // signed % from current price
      strength,
      lastTime: c.lastTime,
    };
  });

  let buySide = make(clusterPools(highs, tol), 'buy');
  let sellSide = make(clusterPools(lows, tol), 'sell');

  // Keep the meaningful pools: equal-level magnets, or recent single swings
  // that still sit on the correct side of price (untapped targets).
  const keep = (p) => p.equal || (p.side === 'buy' ? p.distPct > 0 : p.distPct < 0);
  buySide = buySide.filter(keep);
  sellSide = sellSide.filter(keep);

  // Sort each side by proximity to price.
  const byDist = (a, b) => Math.abs(a.distPct) - Math.abs(b.distPct);
  buySide.sort(byDist);
  sellSide.sort(byDist);

  // Nearest UNTAPPED pool on each side relative to price.
  const nearestBuy = buySide.find((p) => !p.swept && p.distPct > 0) || null;
  const nearestSell = sellSide.find((p) => !p.swept && p.distPct < 0) || null;

  const pools = [...buySide, ...sellSide].sort(byDist);
  const untapped = pools.filter((p) => !p.swept).length;

  // Lines to draw on the chart: the strongest untapped pools, capped so the
  // chart stays readable. Always include the two nearest targets.
  const maxLines = opts.maxLines || 6;
  const untappedPools = pools.filter((p) => !p.swept);
  const ranked = untappedPools
    .slice()
    .sort((a, b) => b.strength - a.strength || Math.abs(a.distPct) - Math.abs(b.distPct));
  const chosen = new Set();
  const lines = [];
  const pushLine = (p) => {
    if (!p || chosen.has(p)) return;
    chosen.add(p);
    lines.push({
      price: p.price,
      side: p.side,
      label: `${p.side === 'buy' ? 'BSL' : 'SSL'}${p.equal ? ' ⨉' + p.touches : ''}`,
    });
  };
  pushLine(nearestBuy);
  pushLine(nearestSell);
  for (const p of ranked) { if (lines.length >= maxLines) break; pushLine(p); }

  return { pools, buySide, sellSide, nearestBuy, nearestSell, untapped, lines };
}
