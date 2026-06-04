/* ============================================================
   indicators.js — Technical indicator math
   Pure functions. Each takes arrays of numbers / candles and
   returns arrays aligned to the input (null where undefined).
   A "candle" is { time, open, high, low, close, volume }.
   ============================================================ */

/** Simple Moving Average */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential Moving Average */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (prev === null) {
      // seed with SMA once we have enough data
      if (i >= period - 1) {
        let s = 0;
        for (let j = i - period + 1; j <= i; j++) s += values[j];
        prev = s / period;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** Wilder's RSI (0-100) */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

/** MACD — returns { macd, signal, hist } arrays */
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const valid = macdLine.map((v) => (v == null ? 0 : v));
  const signalRaw = ema(valid, signalPeriod);
  const signal = macdLine.map((v, i) => (v == null ? null : signalRaw[i]));
  const hist = macdLine.map((v, i) =>
    v != null && signal[i] != null ? v - signal[i] : null
  );
  return { macd: macdLine, signal, hist };
}

/** Average True Range — volatility, used for stops */
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < 2) return out;
  const tr = new Array(candles.length).fill(0);
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { tr[i] = candles[i].high - candles[i].low; continue; }
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Bollinger Bands — { upper, middle, lower, width } */
export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const width = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sum / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = mid[i] ? (upper[i] - lower[i]) / mid[i] : null;
  }
  return { upper, middle: mid, lower, width };
}

/** Stochastic oscillator — { k, d } */
export function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  const k = new Array(candles.length).fill(null);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    k[i] = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
  }
  const kVals = k.map((v) => (v == null ? 0 : v));
  const dRaw = sma(kVals, dPeriod);
  const d = k.map((v, i) => (v == null ? null : dRaw[i]));
  return { k, d };
}

/** ADX — trend strength (0-100). Returns array. */
export function adx(candles, period = 14) {
  const len = candles.length;
  const out = new Array(len).fill(null);
  if (len < period * 2) return out;
  const plusDM = new Array(len).fill(0);
  const minusDM = new Array(len).fill(0);
  const tr = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= period; i++) { trS += tr[i]; pS += plusDM[i]; mS += minusDM[i]; }
  const dxArr = [];
  for (let i = period + 1; i < len; i++) {
    trS = trS - trS / period + tr[i];
    pS = pS - pS / period + plusDM[i];
    mS = mS - mS / period + minusDM[i];
    const pDI = trS ? (pS / trS) * 100 : 0;
    const mDI = trS ? (mS / trS) * 100 : 0;
    const dx = pDI + mDI ? (Math.abs(pDI - mDI) / (pDI + mDI)) * 100 : 0;
    dxArr.push({ i, dx });
  }
  if (dxArr.length >= period) {
    let s = 0;
    for (let j = 0; j < period; j++) s += dxArr[j].dx;
    let prev = s / period;
    out[dxArr[period - 1].i] = prev;
    for (let j = period; j < dxArr.length; j++) {
      prev = (prev * (period - 1) + dxArr[j].dx) / period;
      out[dxArr[j].i] = prev;
    }
  }
  return out;
}

/** Volume moving average and relative volume of last candle */
export function volumeProfile(candles, period = 20) {
  const vols = candles.map((c) => c.volume);
  const avg = sma(vols, period);
  const last = candles.length - 1;
  const relVol = avg[last] ? vols[last] / avg[last] : 1;
  return { avg, relVol, lastVol: vols[last] };
}

/** Compute the full indicator set for a candle series. */
export function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const macdObj = macd(closes);
  const atr14 = atr(candles, 14);
  const bb = bollinger(closes, 20, 2);
  const stoch = stochastic(candles, 14, 3);
  const adx14 = adx(candles, 14);
  const vol = volumeProfile(candles, 20);
  const i = candles.length - 1;

  return {
    index: i,
    price: closes[i],
    ema9, ema21, ema50, ema200,
    rsi14,
    macd: macdObj,
    atr14,
    bb,
    stoch,
    adx14,
    vol,
    // snapshot of latest values for convenience
    last: {
      price: closes[i],
      ema9: ema9[i], ema21: ema21[i], ema50: ema50[i], ema200: ema200[i],
      rsi: rsi14[i],
      macd: macdObj.macd[i], macdSignal: macdObj.signal[i], macdHist: macdObj.hist[i],
      atr: atr14[i],
      bbUpper: bb.upper[i], bbMiddle: bb.middle[i], bbLower: bb.lower[i], bbWidth: bb.width[i],
      stochK: stoch.k[i], stochD: stoch.d[i],
      adx: adx14[i],
      relVol: vol.relVol,
    },
  };
}
