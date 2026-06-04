/* ============================================================
   signals.js — Confluence-based signal engine
   Combines indicators + patterns + multi-timeframe bias into a
   single high-conviction LONG / SHORT / NO-TRADE decision with
   entry, stop loss and take profits at a 2:1 reward/risk ratio.
   ============================================================ */

import { detectAllPatterns } from './patterns.js';

/** Risk profiles tune how strict the bot is before it fires a trade.
 *  - Normal:      sensible default, balanced frequency.
 *  - Conservador: stricter, fewer & safer trades.
 *  - Premium:     ultra-selective. Only a couple of A+ trades a day — needs
 *                 huge confluence (many indicators aligned + trend + higher
 *                 timeframes agreeing + a confirming pattern). */
const RISK_PROFILES = {
  normal:      { minScore: 4.5, minConviction: 58, atrMult: 1.4, label: 'Normal',
                 minConfirmations: 4 },
  conservador: { minScore: 6.0, minConviction: 70, atrMult: 1.6, label: 'Conservador',
                 minConfirmations: 6 },
  premium:     { minScore: 7.0, minConviction: 80, atrMult: 1.8, label: 'Premium',
                 minConfirmations: 8, requireMTF: true, minAdx: 25 },
};

/** Count how many independent confirmations point the same way (max 9).
 *  Used by the Premium profile to demand overwhelming agreement. */
function countConfirmations(ind, analysis, dir) {
  const L = ind.last;
  const bull = dir === 'long';
  let c = 0;
  if (L.ema21 != null && L.ema50 != null && (bull ? L.ema21 > L.ema50 : L.ema21 < L.ema50)) c++;     // EMA structure
  if (L.ema200 != null && (bull ? L.price > L.ema200 : L.price < L.ema200)) c++;                      // macro EMA200
  if (L.rsi != null && (bull ? L.rsi > 50 : L.rsi < 50)) c++;                                         // RSI side
  if (L.macdHist != null && (bull ? L.macdHist > 0 : L.macdHist < 0)) c++;                            // MACD
  if (L.stochK != null && L.stochD != null && (bull ? L.stochK > L.stochD : L.stochK < L.stochD)) c++;// Stochastic
  if (L.adx != null && L.adx > 22) c++;                                                               // trend strength
  if (L.relVol > 1.2) c++;                                                                            // volume
  if (analysis.patterns.some((p) => p.dir === (bull ? 'bull' : 'bear'))) c++;                         // candle/chart pattern
  if (analysis.trend.dir === (bull ? 'up' : 'down')) c++;                                             // overall trend
  return c;
}

/**
 * Build a weighted confluence score. Positive = bullish, negative = bearish.
 * Returns { score, factors: [{label, weight, dir}] }
 */
function scoreConfluence(candles, ind, analysis, mtfBias) {
  const i = ind.index;
  const L = ind.last;
  const factors = [];
  const add = (label, weight, dir) => factors.push({ label, weight, dir });

  // 1) Trend (EMA structure)
  if (analysis.trend.dir === 'up') add(`${analysis.trend.label} (ADX ${Math.round(analysis.trend.adx)})`, 2.2, 'bull');
  else if (analysis.trend.dir === 'down') add(`${analysis.trend.label} (ADX ${Math.round(analysis.trend.adx)})`, 2.2, 'bear');

  // 2) Price vs EMA200 (macro filter)
  if (L.ema200 != null) {
    if (L.price > L.ema200) add('Precio sobre EMA200 (sesgo macro alcista)', 1.3, 'bull');
    else add('Precio bajo EMA200 (sesgo macro bajista)', 1.3, 'bear');
  }

  // 3) EMA9 / EMA21 cross momentum
  if (L.ema9 != null && L.ema21 != null) {
    if (L.ema9 > L.ema21) add('Momentum corto alcista (EMA9>EMA21)', 1.0, 'bull');
    else add('Momentum corto bajista (EMA9<EMA21)', 1.0, 'bear');
  }

  // 4) RSI
  if (L.rsi != null) {
    if (L.rsi < 30) add(`RSI sobreventa (${L.rsi.toFixed(0)})`, 1.4, 'bull');
    else if (L.rsi > 70) add(`RSI sobrecompra (${L.rsi.toFixed(0)})`, 1.4, 'bear');
    else if (L.rsi > 50) add(`RSI con sesgo alcista (${L.rsi.toFixed(0)})`, 0.5, 'bull');
    else add(`RSI con sesgo bajista (${L.rsi.toFixed(0)})`, 0.5, 'bear');
  }

  // 5) MACD histogram
  if (L.macdHist != null) {
    const prevHist = ind.macd.hist[i - 1];
    if (L.macdHist > 0 && (prevHist == null || L.macdHist >= prevHist)) add('MACD alcista y creciente', 1.1, 'bull');
    else if (L.macdHist < 0 && (prevHist == null || L.macdHist <= prevHist)) add('MACD bajista y decreciente', 1.1, 'bear');
  }

  // 6) Stochastic
  if (L.stochK != null && L.stochD != null) {
    if (L.stochK < 20 && L.stochK > L.stochD) add('Estocástico girando desde sobreventa', 0.9, 'bull');
    else if (L.stochK > 80 && L.stochK < L.stochD) add('Estocástico girando desde sobrecompra', 0.9, 'bear');
  }

  // 7) Volume confirmation
  if (L.relVol > 1.4) {
    const lastDir = candles[i].close >= candles[i].open ? 'bull' : 'bear';
    add(`Volumen elevado (${L.relVol.toFixed(1)}x) confirma`, 0.8, lastDir);
  }

  // 8) Patterns
  for (const p of analysis.patterns) {
    if (p.dir === 'neutral') continue;
    add(`Patrón: ${p.name}`, (p.conf / 100) * 2.0, p.dir);
  }

  // 9) Proximity to support / resistance
  const { nearestSupport, nearestResistance } = analysis.levels;
  if (nearestSupport && (L.price - nearestSupport.price) / L.price < 0.012) {
    add(`Apoyo en soporte ${fmt(nearestSupport.price)} (${nearestSupport.touches} toques)`, 1.2, 'bull');
  }
  if (nearestResistance && (nearestResistance.price - L.price) / L.price < 0.012) {
    add(`Rechazo en resistencia ${fmt(nearestResistance.price)} (${nearestResistance.touches} toques)`, 1.2, 'bear');
  }

  // 10) Multi-timeframe bias (higher TFs)
  if (mtfBias && mtfBias.score) {
    if (mtfBias.score > 0) add(`Marcos superiores alcistas (${mtfBias.up}/${mtfBias.total})`, Math.min(2.2, mtfBias.score), 'bull');
    else if (mtfBias.score < 0) add(`Marcos superiores bajistas (${mtfBias.down}/${mtfBias.total})`, Math.min(2.2, -mtfBias.score), 'bear');
  }

  let score = 0;
  for (const f of factors) score += f.dir === 'bull' ? f.weight : -f.weight;
  return { score, factors };
}

function fmt(v) {
  if (v == null || isNaN(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Compute entry / stop / targets for a direction using ATR + structure.
 * TP2 is fixed at 2:1 reward:risk; TP1 at 1:1.
 */
function buildTradePlan(dir, ind, analysis, profile) {
  const L = ind.last;
  const entry = L.price;
  const atr = L.atr || entry * 0.01;
  const { nearestSupport, nearestResistance } = analysis.levels;

  let stop;
  if (dir === 'long') {
    // stop below structure or ATR, whichever is safer (further)
    const atrStop = entry - atr * profile.atrMult;
    const structStop = nearestSupport ? nearestSupport.price - atr * 0.25 : atrStop;
    stop = Math.min(atrStop, structStop);
  } else {
    const atrStop = entry + atr * profile.atrMult;
    const structStop = nearestResistance ? nearestResistance.price + atr * 0.25 : atrStop;
    stop = Math.max(atrStop, structStop);
  }

  const risk = Math.abs(entry - stop);
  const tp1 = dir === 'long' ? entry + risk : entry - risk;       // 1:1
  const tp2 = dir === 'long' ? entry + risk * 2 : entry - risk * 2; // 2:1

  return {
    entry,
    stop,
    tp1,
    tp2,
    risk,
    riskPct: (risk / entry) * 100,
    rr: 2,
  };
}

/**
 * Main entry point. Returns a full signal object for the UI.
 *  signal.direction: 'long' | 'short' | 'none'
 */
export function generateSignal(candles, ind, riskKey = 'normal', mtfBias = null) {
  const profile = RISK_PROFILES[riskKey] || RISK_PROFILES.normal;
  const analysis = detectAllPatterns(candles, ind);
  const { score, factors } = scoreConfluence(candles, ind, analysis, mtfBias);

  const absScore = Math.abs(score);
  const rawDir = score > 0 ? 'long' : 'short';

  // Conviction: how strongly factors agree in one direction (0-100)
  const total = factors.reduce((s, f) => s + f.weight, 0) || 1;
  const aligned = factors.filter((f) => (f.dir === 'bull') === (score > 0))
    .reduce((s, f) => s + f.weight, 0);
  const agreement = (aligned / total) * 100;
  const conviction = Math.round(Math.min(100, (absScore / 9) * 55 + agreement * 0.45));

  // base gate
  let passes = absScore >= profile.minScore && conviction >= profile.minConviction;

  // Premium extra gates: demand overwhelming, multi-source agreement
  const confirmations = countConfirmations(ind, analysis, rawDir);
  let blockReason = null;
  if (passes && profile.minConfirmations && confirmations < profile.minConfirmations) {
    passes = false;
    blockReason = `${profile.label} exige ${profile.minConfirmations}/9 indicadores alineados (hay ${confirmations}).`;
  }
  if (passes && profile.minAdx && (ind.last.adx == null || ind.last.adx < profile.minAdx)) {
    passes = false;
    blockReason = `${profile.label} exige tendencia fuerte (ADX ≥ ${profile.minAdx}).`;
  }
  if (passes && profile.requireMTF && mtfBias) {
    const agree = (rawDir === 'long' && mtfBias.score > 0) || (rawDir === 'short' && mtfBias.score < 0);
    if (!agree) { passes = false; blockReason = `${profile.label} exige que los marcos superiores acompañen.`; }
  }

  // Build reasons (top factors by weight)
  const sorted = [...factors].sort((a, b) => b.weight - a.weight);
  const reasons = sorted.slice(0, 6).map((f) => ({
    text: f.label,
    cls: f.dir === 'bull' ? 'bull' : 'bear',
    icon: f.dir === 'bull' ? '▲' : '▼',
  }));

  if (!passes) {
    let message;
    if (blockReason) message = blockReason;
    else if (absScore < profile.minScore) message = `Confluencia insuficiente (${absScore.toFixed(1)} / ${profile.minScore} requerido).`;
    else message = `Convicción insuficiente (${conviction}% / ${profile.minConviction}% requerido).`;
    return {
      direction: 'none',
      conviction,
      score,
      absScore,
      confirmations,
      analysis,
      reasons: reasons.length ? reasons : [{ text: 'Sin confluencia suficiente. El bot espera una mejor oportunidad.', cls: 'warn', icon: '⏸' }],
      message,
      profile: profile.label,
      plan: null,
    };
  }

  const plan = buildTradePlan(rawDir, ind, analysis, profile);

  return {
    direction: rawDir,
    conviction,
    score,
    absScore,
    confirmations,
    analysis,
    plan,
    reasons,
    message: profile.requireMTF
      ? `Trade Premium A+ · ${confirmations}/9 indicadores alineados.`
      : (rawDir === 'long'
          ? `Confluencia alcista de alta probabilidad · ${confirmations}/9 indicadores.`
          : `Confluencia bajista de alta probabilidad · ${confirmations}/9 indicadores.`),
    profile: profile.label,
  };
}

/** Lightweight per-timeframe bias used by the multi-timeframe map. */
export function timeframeBias(candles, ind) {
  const L = ind.last;
  let s = 0;
  if (L.ema21 != null && L.ema50 != null) s += L.ema21 > L.ema50 ? 1 : -1;
  if (L.ema200 != null) s += L.price > L.ema200 ? 1 : -1;
  if (L.rsi != null) s += L.rsi > 52 ? 0.5 : L.rsi < 48 ? -0.5 : 0;
  if (L.macdHist != null) s += L.macdHist > 0 ? 0.5 : -0.5;
  const dir = s >= 1 ? 'bull' : s <= -1 ? 'bear' : 'neutral';
  return { dir, score: s };
}

export { RISK_PROFILES };
