/* ============================================================
   patterns.js — Price-action & chart pattern detection
   Works on a candle array: { time, open, high, low, close, volume }
   Returns structured findings used by the signal engine + UI.
   ============================================================ */

/** Find swing highs / lows using a lookback window (fractal style). */
export function findSwings(candles, lookback = 2) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ i, price: candles[i].high, time: candles[i].time });
    if (isLow) lows.push({ i, price: candles[i].low, time: candles[i].time });
  }
  return { highs, lows };
}

/** Linear regression slope of a value series (normalized by price). */
function slope(values) {
  const n = values.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += values[i]; sxy += i * values[i]; sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

/**
 * Trend classification from EMA stack + price-structure (HH/HL vs LH/LL).
 * Returns { dir: 'up'|'down'|'range', strength: 0-100, label }
 */
export function detectTrend(candles, ind) {
  const i = candles.length - 1;
  const { ema21, ema50, ema200 } = ind;
  const price = candles[i].close;
  let score = 0;

  // EMA alignment
  if (ema21[i] != null && ema50[i] != null) {
    if (price > ema21[i] && ema21[i] > ema50[i]) score += 2;
    else if (price < ema21[i] && ema21[i] < ema50[i]) score -= 2;
    else if (price > ema21[i]) score += 1;
    else score -= 1;
  }
  if (ema200[i] != null) score += price > ema200[i] ? 1.5 : -1.5;

  // Structure: compare recent swing highs/lows
  const { highs, lows } = findSwings(candles, 2);
  const recentHighs = highs.slice(-3);
  const recentLows = lows.slice(-3);
  if (recentHighs.length >= 2) {
    score += recentHighs[recentHighs.length - 1].price > recentHighs[0].price ? 1 : -1;
  }
  if (recentLows.length >= 2) {
    score += recentLows[recentLows.length - 1].price > recentLows[0].price ? 1 : -1;
  }

  // Slope of EMA50
  const seg = ema50.slice(-20).filter((v) => v != null);
  const sl = slope(seg) / (price || 1);
  score += sl > 0.0005 ? 1 : sl < -0.0005 ? -1 : 0;

  const adxVal = ind.adx14[i] ?? 0;
  const strength = Math.min(100, Math.round((Math.abs(score) / 6.5) * 70 + Math.min(adxVal, 40) * 0.75));

  let dir = 'range';
  if (score >= 2.5) dir = 'up';
  else if (score <= -2.5) dir = 'down';

  const labelMap = {
    up: adxVal > 25 ? 'Tendencia alcista fuerte' : 'Tendencia alcista',
    down: adxVal > 25 ? 'Tendencia bajista fuerte' : 'Tendencia bajista',
    range: 'Rango / lateral',
  };
  return { dir, strength, score, label: labelMap[dir], adx: adxVal };
}

/**
 * Support & resistance via swing clustering.
 * Returns sorted arrays of { price, touches } and nearest levels to price.
 */
export function detectLevels(candles) {
  const { highs, lows } = findSwings(candles, 2);
  const pts = [...highs.map((h) => h.price), ...lows.map((l) => l.price)];
  if (!pts.length) return { levels: [], nearestSupport: null, nearestResistance: null };
  const price = candles[candles.length - 1].close;
  const tol = price * 0.006; // 0.6% clustering tolerance
  const clusters = [];
  pts.sort((a, b) => a - b);
  for (const p of pts) {
    const c = clusters.find((cl) => Math.abs(cl.price - p) <= tol);
    if (c) {
      c.price = (c.price * c.touches + p) / (c.touches + 1);
      c.touches++;
    } else {
      clusters.push({ price: p, touches: 1 });
    }
  }
  const levels = clusters
    .filter((c) => c.touches >= 2)
    .sort((a, b) => b.touches - a.touches)
    .slice(0, 8)
    .sort((a, b) => a.price - b.price);

  let nearestSupport = null, nearestResistance = null;
  for (const l of levels) {
    if (l.price <= price && (!nearestSupport || l.price > nearestSupport.price)) nearestSupport = l;
    if (l.price >= price && (!nearestResistance || l.price < nearestResistance.price)) nearestResistance = l;
  }
  return { levels, nearestSupport, nearestResistance };
}

/** Candlestick patterns on the last few candles. */
export function detectCandlestick(candles) {
  const found = [];
  const n = candles.length;
  if (n < 3) return found;
  const c = candles[n - 1], p = candles[n - 2], p2 = candles[n - 3];
  const body = (x) => Math.abs(x.close - x.open);
  const range = (x) => x.high - x.low || 1e-9;
  const upWick = (x) => x.high - Math.max(x.close, x.open);
  const dnWick = (x) => Math.min(x.close, x.open) - x.low;

  // Bullish engulfing
  if (p.close < p.open && c.close > c.open && c.close >= p.open && c.open <= p.close) {
    found.push({ name: 'Envolvente alcista', dir: 'bull', conf: 70, desc: 'Vela verde envuelve a la roja previa: presión compradora.' });
  }
  // Bearish engulfing
  if (p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open) {
    found.push({ name: 'Envolvente bajista', dir: 'bear', conf: 70, desc: 'Vela roja envuelve a la verde previa: presión vendedora.' });
  }
  // Hammer
  if (dnWick(c) > body(c) * 2 && upWick(c) < body(c) && body(c) / range(c) < 0.4) {
    found.push({ name: 'Martillo', dir: 'bull', conf: 60, desc: 'Mecha inferior larga: rechazo de precios bajos.' });
  }
  // Shooting star
  if (upWick(c) > body(c) * 2 && dnWick(c) < body(c) && body(c) / range(c) < 0.4) {
    found.push({ name: 'Estrella fugaz', dir: 'bear', conf: 60, desc: 'Mecha superior larga: rechazo de precios altos.' });
  }
  // Doji
  if (body(c) / range(c) < 0.1) {
    found.push({ name: 'Doji', dir: 'neutral', conf: 40, desc: 'Indecisión: posible giro o pausa.' });
  }
  // Morning / evening star (3-candle)
  if (p2.close < p2.open && body(p) / range(p) < 0.3 && c.close > c.open && c.close > (p2.open + p2.close) / 2) {
    found.push({ name: 'Estrella del amanecer', dir: 'bull', conf: 72, desc: 'Patrón de giro alcista de 3 velas.' });
  }
  if (p2.close > p2.open && body(p) / range(p) < 0.3 && c.close < c.open && c.close < (p2.open + p2.close) / 2) {
    found.push({ name: 'Estrella del atardecer', dir: 'bear', conf: 72, desc: 'Patrón de giro bajista de 3 velas.' });
  }
  return found;
}

/**
 * Flag / pennant detection. A flag = strong impulse (pole) followed by a
 * shallow counter-trend consolidation. Detects bull & bear flags.
 */
export function detectFlag(candles, ind) {
  const n = candles.length;
  if (n < 30) return null;
  const price = candles[n - 1].close;
  const poleLen = 8, flagLen = 7;
  const poleStart = n - poleLen - flagLen;
  const poleEnd = n - flagLen;
  if (poleStart < 0) return null;

  const poleMove = (candles[poleEnd - 1].close - candles[poleStart].close) / candles[poleStart].close;
  const flagCloses = candles.slice(poleEnd).map((c) => c.close);
  const flagSlope = slope(flagCloses) / (price || 1);
  const flagRange = (Math.max(...flagCloses) - Math.min(...flagCloses)) / price;

  // Bull flag: big up pole, shallow down/sideways consolidation
  if (poleMove > 0.04 && flagSlope <= 0.0008 && flagRange < Math.abs(poleMove) * 0.6) {
    return { name: 'Bandera alcista', dir: 'bull', conf: 74,
      desc: 'Impulso alcista + consolidación en contra: continuación probable al alza.' };
  }
  // Bear flag
  if (poleMove < -0.04 && flagSlope >= -0.0008 && flagRange < Math.abs(poleMove) * 0.6) {
    return { name: 'Bandera bajista', dir: 'bear', conf: 74,
      desc: 'Impulso bajista + consolidación en contra: continuación probable a la baja.' };
  }
  return null;
}

/**
 * Triangle / wedge detection via converging swing trendlines.
 */
export function detectTriangle(candles) {
  const { highs, lows } = findSwings(candles, 2);
  if (highs.length < 2 || lows.length < 2) return null;
  const hi = highs.slice(-3), lo = lows.slice(-3);
  const hiSlope = slope(hi.map((h) => h.price));
  const loSlope = slope(lo.map((l) => l.price));
  const price = candles[candles.length - 1].close;
  const norm = (s) => s / (price || 1);

  if (norm(hiSlope) < -0.0004 && Math.abs(norm(loSlope)) < 0.0003) {
    return { name: 'Triángulo descendente', dir: 'bear', conf: 62, desc: 'Máximos decrecientes con soporte plano.' };
  }
  if (norm(loSlope) > 0.0004 && Math.abs(norm(hiSlope)) < 0.0003) {
    return { name: 'Triángulo ascendente', dir: 'bull', conf: 62, desc: 'Mínimos crecientes con resistencia plana.' };
  }
  if (norm(hiSlope) < -0.0004 && norm(loSlope) > 0.0004) {
    return { name: 'Triángulo simétrico', dir: 'neutral', conf: 48, desc: 'Compresión de volatilidad: ruptura inminente.' };
  }
  return null;
}

/**
 * Manipulation / liquidity grab (stop hunt) detection.
 * Detects a candle that sweeps beyond a recent swing then closes back inside,
 * a classic smart-money liquidity grab.
 */
export function detectManipulation(candles, ind) {
  const n = candles.length;
  if (n < 25) return null;
  const c = candles[n - 1];
  const window = candles.slice(n - 21, n - 1);
  const swingHigh = Math.max(...window.map((x) => x.high));
  const swingLow = Math.min(...window.map((x) => x.low));
  const relVol = ind.vol.relVol;

  // Bullish liquidity grab: wick below swing low, close back above it
  if (c.low < swingLow && c.close > swingLow && (c.close - c.low) / (c.high - c.low || 1) > 0.55) {
    return { name: 'Barrido de liquidez (abajo)', dir: 'bull', conf: relVol > 1.3 ? 78 : 66,
      desc: 'Mecha que caza stops bajo el mínimo y recupera: posible trampa bajista (manipulación).' };
  }
  // Bearish liquidity grab: wick above swing high, close back below
  if (c.high > swingHigh && c.close < swingHigh && (c.high - c.close) / (c.high - c.low || 1) > 0.55) {
    return { name: 'Barrido de liquidez (arriba)', dir: 'bear', conf: relVol > 1.3 ? 78 : 66,
      desc: 'Mecha que caza stops sobre el máximo y rechaza: posible trampa alcista (manipulación).' };
  }
  return null;
}

/** Bollinger squeeze — low volatility before expansion. */
export function detectSqueeze(candles, ind) {
  const widths = ind.bb.width.filter((w) => w != null).slice(-50);
  if (widths.length < 20) return null;
  const cur = widths[widths.length - 1];
  const min = Math.min(...widths);
  if (cur <= min * 1.15) {
    return { name: 'Compresión de Bollinger', dir: 'neutral', conf: 50,
      desc: 'Volatilidad mínima: suele preceder a un movimiento explosivo.' };
  }
  return null;
}

/** Run all detectors and return a unified list + structure info. */
export function detectAllPatterns(candles, ind) {
  const trend = detectTrend(candles, ind);
  const levels = detectLevels(candles);
  const patterns = [];

  const flag = detectFlag(candles, ind);
  if (flag) patterns.push(flag);
  const tri = detectTriangle(candles);
  if (tri) patterns.push(tri);
  const manip = detectManipulation(candles, ind);
  if (manip) patterns.push(manip);
  const squeeze = detectSqueeze(candles, ind);
  if (squeeze) patterns.push(squeeze);
  for (const cs of detectCandlestick(candles)) patterns.push(cs);

  return { trend, levels, patterns };
}
