/* ============================================================
   app.js — UI orchestration & chart rendering
   ============================================================ */

import { fetchCandles, fetchTicker, TF_SECONDS } from './data.js';
import { computeIndicators } from './indicators.js';
import { generateSignal, timeframeBias } from './signals.js';
import { setAlertsEnabled, primeAudio, playAlertSound, requestNotifyPermission, notifySignal, notifyText } from './alerts.js';
import { getTrades, addTrade, resolveTrade, deleteTrade, clearAll, getStats, liveR } from './journal.js';
import { detectLiquidity } from './liquidity.js';
import { fetchNews, aggregateSentiment } from './news.js';
import { createLiquidationFeed } from './liquidations.js';
import { computeLiquidationHeatmap, heatmapColor } from './heatmap.js';

const LWC = window.LightweightCharts;

const state = {
  tf: '4h',
  risk: 'conservador',
  candles: [],
  ind: null,
  signal: null,
  source: '—',
  mtfBias: null,
  autoRefresh: true,
  showEMA: true,
  showLevels: true,
  showLiquidity: true,
  showLiquidations: true,
  loading: false,
  lastAlertKey: null,
  lastLoggedKey: null,
  livePrice: null,
  activeTrades: {},
  liquidity: null,
  news: [],
  newsSource: '—',
  newsUpdatedAt: 0,
  newsFilter: 'all',
  newsAlerts: (() => { try { return localStorage.getItem('btc_news_alerts') !== '0'; } catch (e) { return true; } })(),
  liquidations: { events: [], totalLong: 0, totalShort: 0, alive: false },
  heatmap: null,
};

const MTF_LIST = ['15m', '1h', '4h', '1d', '1w'];

let chart, candleSeries, ema21Series, ema50Series, ema200Series;
let priceLines = [];
let liqLines = [];
let liqSig = '';
let liqFeed = null;
let heatmapCanvas = null;
let heatmapCtx = null;
let heatmapSig = '';
let heatmapLastCandleTime = 0;
let heatmapTip = null;
let refreshTimer = null;
let tickerTimer = null;

/* ---------------------- helpers ---------------------- */
const $ = (id) => document.getElementById(id);
const fmtPrice = (v) =>
  v == null || isNaN(v) ? '—' : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (v, d = 2) => (v == null || isNaN(v) ? '—' : v.toFixed(d));

function setStatus(text, kind) {
  $('connStatus').textContent = text;
  const dot = $('connDot');
  dot.className = 'status-dot' + (kind ? ' ' + kind : '');
}

/* ---------------------- chart setup ---------------------- */
function initChart() {
  const el = $('chart');
  chart = LWC.createChart(el, {
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#94a3b8', fontFamily: 'JetBrains Mono, monospace' },
    grid: { vertLines: { color: 'rgba(148,163,184,0.06)' }, horzLines: { color: 'rgba(148,163,184,0.06)' } },
    rightPriceScale: { borderColor: 'rgba(148,163,184,0.15)' },
    timeScale: { borderColor: 'rgba(148,163,184,0.15)', timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 8 },
    crosshair: { mode: LWC.CrosshairMode.Normal },
    autoSize: true,
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: '#16c784', downColor: '#ea3943',
    borderUpColor: '#16c784', borderDownColor: '#ea3943',
    wickUpColor: '#16c784', wickDownColor: '#ea3943',
  });

  ema21Series = chart.addLineSeries({ color: '#f7931a', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  ema50Series = chart.addLineSeries({ color: '#6366f1', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  ema200Series = chart.addLineSeries({ color: '#e2e8f0', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

  // overlay layer for the TradingView-style position box (green/red zones)
  buildTradeOverlay();
  buildHeatmapCanvas();
  // Reposition every animation frame so the boxes track price on pan AND zoom.
  const overlayLoop = () => { updateTradeOverlay(); drawHeatmap(); requestAnimationFrame(overlayLoop); };
  requestAnimationFrame(overlayLoop);
}

/* ---------------------- liquidation heatmap canvas ---------------------- */
function buildHeatmapCanvas() {
  const host = $('chart');
  heatmapCanvas = document.createElement('canvas');
  heatmapCanvas.className = 'liq-heatmap';
  // sits BEHIND the candles (chart background is transparent)
  host.insertBefore(heatmapCanvas, host.firstChild);
  heatmapCtx = heatmapCanvas.getContext('2d');

  // hover tooltip (price + estimated liquidation $ at the cursor level)
  heatmapTip = document.createElement('div');
  heatmapTip.className = 'liq-tip';
  heatmapTip.style.display = 'none';
  host.appendChild(heatmapTip);
  chart.subscribeCrosshairMove(onCrosshairMove);
}

/** Nearest heatmap band (within one bin) to a given price. */
function nearestHeatBin(price) {
  const hm = state.heatmap;
  if (!hm || !hm.bins.length) return null;
  let best = null, bestD = hm.binSize;
  for (const b of hm.bins) {
    const d = Math.abs(b.price - price);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

function fmtTipDate(t) {
  const secs = typeof t === 'number' ? t : null;
  if (secs == null) return '';
  const d = new Date(secs * 1000);
  if (isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Show "Precio + Apalancamiento Liquidación ($)" when hovering the heatmap. */
function onCrosshairMove(param) {
  if (!heatmapTip) return;
  const hm = state.heatmap;
  if (!state.showLiquidations || !hm || !hm.bins.length || !param.point || param.point.x < 0 || param.point.y < 0) {
    heatmapTip.style.display = 'none';
    return;
  }
  const price = candleSeries.coordinateToPrice(param.point.y);
  if (price == null) { heatmapTip.style.display = 'none'; return; }
  const bin = nearestHeatBin(price);
  const usd = bin ? bin.usd : 0;
  heatmapTip.innerHTML = `<div class="liq-tip-date">${fmtTipDate(param.time)}</div>
    <div class="liq-tip-row"><span class="dot price"></span>Precio<b>${fmtPrice(price)}</b></div>
    <div class="liq-tip-row"><span class="dot liq"></span>Apal. Liquidación<b>${usd > 0 ? fmtUsdShort(usd) : '—'}</b></div>`;

  const host = $('chart');
  const W = host.clientWidth, H = host.clientHeight;
  const tw = 210, th = 78;
  let left = param.point.x + 16;
  let top = param.point.y + 16;
  if (left + tw > W) left = param.point.x - tw - 16;
  if (top + th > H) top = param.point.y - th - 16;
  heatmapTip.style.left = Math.max(4, left) + 'px';
  heatmapTip.style.top = Math.max(4, top) + 'px';
  heatmapTip.style.display = 'block';
}

/**
 * Paint the liquidation heatmap. Bands are anchored to fixed PRICE levels
 * (computed from history) and only follow the chart's pan/zoom via
 * priceToCoordinate — they never drift with the live price.
 */
function drawHeatmap() {
  if (!heatmapCanvas || !heatmapCtx) return;
  const host = $('chart');
  const W = host.clientWidth;
  const H = host.clientHeight;
  const hm = state.heatmap;
  const show = state.showLiquidations && hm && hm.bins && hm.bins.length && hm.max > 0;

  // keep canvas pixel size in sync with the container (DPR-aware)
  const dpr = window.devicePixelRatio || 1;
  if (heatmapCanvas.width !== Math.round(W * dpr) || heatmapCanvas.height !== Math.round(H * dpr)) {
    heatmapCanvas.width = Math.round(W * dpr);
    heatmapCanvas.height = Math.round(H * dpr);
    heatmapCanvas.style.width = W + 'px';
    heatmapCanvas.style.height = H + 'px';
    heatmapSig = '';   // force redraw after resize
  }

  if (!show) { heatmapCtx.clearRect(0, 0, heatmapCanvas.width, heatmapCanvas.height); return; }

  const paneW = Math.max(40, W - priceScaleWidth());
  const yTop = candleSeries.priceToCoordinate(hm.priceMax);
  const yBot = candleSeries.priceToCoordinate(hm.priceMin);
  if (yTop == null || yBot == null) return;

  // redraw only when something visibly changed (perf): size + price mapping + data
  const sig = `${W}x${H}:${yTop.toFixed(1)}:${yBot.toFixed(1)}:${hm.bins.length}:${hm.max.toFixed(2)}`;
  if (sig === heatmapSig) return;
  heatmapSig = sig;

  const ctx = heatmapCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const ts = chart.timeScale();
  const bandPx = Math.abs((yBot - yTop) / Math.max(1, hm.bins.length)) + 1.2;

  for (const b of hm.bins) {
    const raw = b.weight / hm.max;                 // 0..1 intensity
    if (raw < 0.03) continue;
    const t = Math.pow(raw, 0.72);                 // gamma: make mid/high bands pop
    const yc = candleSeries.priceToCoordinate(b.price);
    if (yc == null) continue;
    let x0 = 0;
    try { const xc = ts.timeToCoordinate(b.startTime); if (xc != null && xc > 0) x0 = xc; } catch (e) {}
    const { r, g, b: bb } = heatmapColor(t);
    const alpha = Math.min(0.88, 0.05 + t * 0.85);
    ctx.fillStyle = `rgba(${r},${g},${bb},${alpha})`;
    ctx.fillRect(x0, yc - bandPx / 2, paneW - x0, bandPx);
  }
}

/* ---------------------- trade position overlay ---------------------- */
let overlayEl = null;
function buildTradeOverlay() {
  const host = $('chart');
  overlayEl = document.createElement('div');
  overlayEl.className = 'trade-overlay';
  overlayEl.innerHTML = `
    <div class="trade-box tp" data-el="tp"></div>
    <div class="trade-box sl" data-el="sl"></div>
    <div class="trade-line entry" data-el="entryLine"></div>
    <div class="trade-tag tp" data-el="tpTag"></div>
    <div class="trade-tag entry" data-el="entryTag"></div>
    <div class="trade-tag sl" data-el="slTag"></div>`;
  host.appendChild(overlayEl);
}

function priceScaleWidth() {
  try { return chart.priceScale('right').width() || 64; } catch (e) { return 64; }
}

function updateTradeOverlay() {
  if (!overlayEl) return;
  const at = currentActiveTrade();
  // Boxes are drawn ONLY for a taken (frozen) trade on THIS timeframe+mode.
  const show = state.showLevels && at;
  overlayEl.style.display = show ? 'block' : 'none';
  if (!show) return;

  const W = $('chart').clientWidth;
  const H = $('chart').clientHeight;
  const psW = priceScaleWidth();
  const paneW = Math.max(60, W - psW);
  const boxW = Math.min(paneW * 0.4, 240);
  const left = Math.max(0, paneW - boxW);

  const yE = candleSeries.priceToCoordinate(at.entry);
  const ySLraw = candleSeries.priceToCoordinate(at.stop);
  const yTPraw = candleSeries.priceToCoordinate(at.tp2);
  if (yE == null || ySLraw == null || yTPraw == null) { overlayEl.style.display = 'none'; return; }
  const clampY = (y) => Math.max(-4, Math.min(H + 4, y));
  const ye = clampY(yE), ySL = clampY(ySLraw), yTP = clampY(yTPraw);

  const set = (el, css) => { const n = overlayEl.querySelector(`[data-el="${el}"]`); Object.assign(n.style, css); return n; };

  // green profit zone (entry → TP2) and red loss zone (entry → SL)
  set('tp', { left: left + 'px', width: boxW + 'px', top: Math.min(ye, yTP) + 'px', height: Math.abs(yTP - ye) + 'px' });
  set('sl', { left: left + 'px', width: boxW + 'px', top: Math.min(ye, ySL) + 'px', height: Math.abs(ySL - ye) + 'px' });
  set('entryLine', { left: left + 'px', width: boxW + 'px', top: ye + 'px' });

  // Labels: right-aligned next to the price axis and placed OUTSIDE the boxes
  // (above/below their lines) so they never cover the green/red zones or candles.
  const pct = (t) => ((t - at.entry) / at.entry * 100);
  const rightCss = { left: 'auto', right: (psW + 4) + 'px', transform: 'none' };
  const tpEl = set('tpTag', { ...rightCss, top: (yTP < ye ? yTP - 17 : yTP + 3) + 'px' });
  tpEl.textContent = `TP ${fmtPrice(at.tp2)}  ${pct(at.tp2) >= 0 ? '+' : ''}${pct(at.tp2).toFixed(2)}%`;
  const eEl = set('entryTag', { ...rightCss, top: (ye - 8) + 'px' });
  eEl.textContent = `Entrada ${fmtPrice(at.entry)}`;
  const slEl = set('slTag', { ...rightCss, top: (ySL > ye ? ySL + 3 : ySL - 17) + 'px' });
  slEl.textContent = `SL ${fmtPrice(at.stop)}  ${pct(at.stop).toFixed(2)}%`;
}

function renderChart() {
  const c = state.candles;
  candleSeries.setData(c.map((x) => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close })));

  if (state.showEMA && state.ind) {
    const mk = (arr) => c.map((x, i) => (arr[i] != null ? { time: x.time, value: arr[i] } : null)).filter(Boolean);
    ema21Series.setData(mk(state.ind.ema21));
    ema50Series.setData(mk(state.ind.ema50));
    ema200Series.setData(mk(state.ind.ema200));
  } else {
    ema21Series.setData([]); ema50Series.setData([]); ema200Series.setData([]);
  }

  // clear old price lines
  priceLines.forEach((pl) => candleSeries.removePriceLine(pl));
  priceLines = [];

  // S/R levels stay as subtle dotted lines (the trade itself is the green/red box)
  if (state.showLevels && state.signal && state.signal.analysis) {
    const lv = state.signal.analysis.levels;
    if (lv.nearestSupport) priceLines.push(candleSeries.createPriceLine({ price: lv.nearestSupport.price, color: 'rgba(22,199,132,0.35)', lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title: 'Sop' }));
    if (lv.nearestResistance) priceLines.push(candleSeries.createPriceLine({ price: lv.nearestResistance.price, color: 'rgba(234,57,67,0.35)', lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title: 'Res' }));
  }

  // liquidity pools drawn as dashed price lines (managed separately so they
  // don't fight with the S/R lines above)
  drawLiquidity(true);

  // real-time liquidation markers (anchored to candle times) + heatmap is
  // painted by the rAF loop using fixed price levels
  rebuildLiqMarkers();

  if (!state._fitted) {
    // Show the most recent ~140 candles (not all 400) for a clean, readable view.
    const n = c.length;
    if (n > 150) chart.timeScale().setVisibleLogicalRange({ from: n - 140, to: n + 6 });
    else chart.timeScale().fitContent();
    state._fitted = true;
  }
  updateTradeOverlay();
  renderLegend();
}

/** Incremental chart update for live ticks (preserves zoom/pan). */
function renderChartLive() {
  const c = state.candles;
  const i = c.length - 1;
  const last = c[i];
  candleSeries.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
  if (state.showEMA && state.ind) {
    if (state.ind.ema21[i] != null) ema21Series.update({ time: last.time, value: state.ind.ema21[i] });
    if (state.ind.ema50[i] != null) ema50Series.update({ time: last.time, value: state.ind.ema50[i] });
    if (state.ind.ema200[i] != null) ema200Series.update({ time: last.time, value: state.ind.ema200[i] });
  }
  // refresh S/R lines occasionally via full render path is skipped here for performance
  updateTradeOverlay();
  renderLegend();
}

/* ---------------------- liquidity pool lines on chart ---------------------- */
function clearLiqLines() {
  liqLines.forEach((pl) => { try { candleSeries.removePriceLine(pl); } catch (e) {} });
  liqLines = [];
}

/**
 * Draw the most relevant untapped liquidity pools as dashed price lines.
 * @param {boolean} force - rebuild even if the pool set is unchanged.
 */
function drawLiquidity(force = false) {
  if (!candleSeries) return;
  const liq = state.liquidity;
  const lines = state.showLiquidity && liq ? liq.lines : [];
  const sig = lines.map((l) => `${l.side}:${l.price}`).join('|') + ':' + state.showLiquidity;
  if (!force && sig === liqSig) return;     // nothing changed → avoid flicker
  liqSig = sig;
  clearLiqLines();
  for (const l of lines) {
    const buy = l.side === 'buy';
    liqLines.push(candleSeries.createPriceLine({
      price: l.price,
      color: buy ? 'rgba(34,227,255,0.55)' : 'rgba(255,61,143,0.55)',
      lineWidth: 1,
      lineStyle: LWC.LineStyle.Dashed,
      axisLabelVisible: true,
      title: l.label,
    }));
  }
}

/* ---------------------- liquidation markers on chart ---------------------- */
/** Snap a liquidation timestamp (ms) to a candle time on the current chart. */
function snapToCandleTime(tsMs) {
  const arr = state.candles;
  if (!arr.length) return null;
  const tsec = Math.floor(tsMs / 1000);
  const last = arr[arr.length - 1];
  if (tsec >= last.time) return last.time;          // live → forming candle
  const tf = TF_SECONDS[state.tf] || 14400;
  let bucket = Math.floor(tsec / tf) * tf;
  if (bucket < arr[0].time) bucket = arr[0].time;
  return bucket;
}

/** Rebuild the liquidation markers on the candle series from the live feed. */
function rebuildLiqMarkers() {
  if (!candleSeries) return;
  if (!state.showLiquidations) { try { candleSeries.setMarkers([]); } catch (e) {} return; }
  const evs = (state.liquidations && state.liquidations.events) || [];
  // aggregate USD by candle time + side so cascades don't spam the chart
  const agg = new Map();
  for (const e of evs) {
    const t = snapToCandleTime(e.time);
    if (t == null) continue;
    const key = t + '|' + e.side;
    agg.set(key, (agg.get(key) || 0) + e.usd);
  }
  const markers = [];
  for (const [key, usd] of agg) {
    const [tStr, side] = key.split('|');
    const isLong = side === 'long';
    markers.push({
      time: +tStr,
      position: isLong ? 'belowBar' : 'aboveBar',
      color: isLong ? '#ea3943' : '#16c784',
      shape: isLong ? 'arrowDown' : 'arrowUp',
      size: usd >= 1e6 ? 2 : 1,
      text: usd >= 250000 ? fmtUsdShort(usd) : '',
    });
  }
  markers.sort((a, b) => a.time - b.time);
  try { candleSeries.setMarkers(markers); } catch (e) {}
}

function fmtUsdShort(n) {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(n);
}

/* ---------------------- themes ---------------------- */
const THEMES = {
  futuristic: { up: '#00ffa3', down: '#ff2d74', ema21: '#22e3ff', ema50: '#ff3df0', ema200: '#c4d3f5', text: '#94a3b8', grid: 'rgba(148,163,184,0.06)', border: 'rgba(148,163,184,0.15)' },
  minimal:    { up: '#16a34a', down: '#e5484d', ema21: '#d97706', ema50: '#4f46e5', ema200: '#94a3b8', text: '#5b6678', grid: 'rgba(15,23,42,0.07)', border: 'rgba(15,23,42,0.14)' },
};
let themeColors = THEMES.futuristic;

function applyChartColors() {
  if (!candleSeries) return;
  candleSeries.applyOptions({
    upColor: themeColors.up, downColor: themeColors.down,
    borderUpColor: themeColors.up, borderDownColor: themeColors.down,
    wickUpColor: themeColors.up, wickDownColor: themeColors.down,
  });
  ema21Series.applyOptions({ color: themeColors.ema21 });
  ema50Series.applyOptions({ color: themeColors.ema50 });
  ema200Series.applyOptions({ color: themeColors.ema200 });
  if (state.ind) renderLegend();
}

function applyTheme(name) {
  if (!THEMES[name]) name = 'futuristic';
  themeColors = THEMES[name];
  document.body.classList.remove('theme-futuristic', 'theme-minimal');
  document.body.classList.add('theme-' + name);
  try { localStorage.setItem('btcQuantTheme', name); } catch (e) {}
  document.querySelectorAll('#themeSelector .tf-btn').forEach((b) => b.classList.toggle('active', b.dataset.theme === name));
  applyChartColors();
  if (chart) {
    chart.applyOptions({
      layout: { textColor: themeColors.text },
      grid: { vertLines: { color: themeColors.grid }, horzLines: { color: themeColors.grid } },
      rightPriceScale: { borderColor: themeColors.border },
      timeScale: { borderColor: themeColors.border },
    });
  }
}

function renderLegend() {
  if (!state.ind) return;
  const L = state.ind.last;
  $('chartLegend').innerHTML = `
    <span style="color:${themeColors.ema21}">EMA21 <b>${fmtPrice(L.ema21)}</b></span>
    <span style="color:${themeColors.ema50}">EMA50 <b>${fmtPrice(L.ema50)}</b></span>
    <span style="color:${themeColors.ema200}">EMA200 <b>${fmtPrice(L.ema200)}</b></span>`;
}

/* ---------------------- UI renderers ---------------------- */
function renderSignal() {
  const s = state.signal;
  // When a trade is taken on THIS timeframe+mode, show the FROZEN trade.
  const at = currentActiveTrade();
  if (at) { renderActiveTrade(at); return; }

  const card = $('signalCard');
  const dir = $('signalDir');
  const fill = $('convictionFill');

  $('activeTradeStatus').style.display = 'none';
  $('signalReasons').style.display = '';
  $('statScoreLabel').textContent = 'Confluencia';
  $('signalTime').textContent = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

  card.className = 'signal-card ' + (s.direction === 'none' ? 'neutral' : s.direction);
  fill.style.width = s.conviction + '%';
  fill.style.background = s.direction === 'long' ? 'var(--long)' : s.direction === 'short' ? 'var(--short)' : 'var(--neutral)';

  if (s.direction === 'none') {
    dir.textContent = 'SIN TRADE';
    $('signalConviction').textContent = `${s.message} · Convicción ${s.conviction}%`;
    $('lvlEntry').textContent = '—'; $('lvlSL').textContent = '—';
    $('lvlTP1').textContent = '—'; $('lvlTP2').textContent = '—';
    $('statRR').textContent = '—'; $('statRisk').textContent = '—';
    $('statScore').textContent = fmtNum(s.absScore, 1);
  } else {
    dir.textContent = s.direction === 'long' ? 'LONG ▲' : 'SHORT ▼';
    $('signalConviction').textContent = `Sugerencia en vivo del bot · ${s.profile}`;
    const p = s.plan;
    $('lvlEntry').textContent = fmtPrice(p.entry);
    $('lvlSL').textContent = fmtPrice(p.stop);
    $('lvlTP1').textContent = fmtPrice(p.tp1);
    $('lvlTP2').textContent = fmtPrice(p.tp2);
    $('statRR').textContent = '2 : 1';
    $('statRisk').textContent = fmtNum(p.riskPct, 2) + '%';
    $('statScore').textContent = `${s.conviction}%`;
  }

  $('signalReasons').innerHTML = s.reasons
    .map((r) => `<div class="reason ${r.cls}"><span class="reason-icon">${r.icon}</span><span>${r.text}</span></div>`)
    .join('');

  // hint: you have frozen trades open on other timeframe/mode views
  const others = Object.values(state.activeTrades).filter((t) => `${t.tf}:${t.risk}` !== activeKey());
  if (others.length) {
    const list = others.map((t) => `${t.tf.toUpperCase()}/${labelForRisk(t.risk)}`).join(', ');
    $('signalConviction').textContent += ` · 🔒 Activo en ${list}`;
  }

  // button: take (freeze) the current suggestion as a real trade
  const logBtn = $('logTradeBtn');
  logBtn.classList.remove('danger', 'logged');
  if (s.plan) {
    logBtn.disabled = false;
    logBtn.querySelector('span').textContent = 'Tomar este trade (congelar)';
  } else {
    logBtn.disabled = true;
    logBtn.querySelector('span').textContent = 'Esperando una señal válida…';
  }
}

/* ---------------------- active (frozen) trades ---------------------- */
/* Trades are stored per "timeframe:mode" key, so a frozen trade only shows
 * on the exact timeframe AND risk mode it was taken on. */
const ACTIVE_KEY = 'btcQuantActiveTrades_v2';

function activeKey(tf = state.tf, risk = state.risk) { return `${tf}:${risk}`; }
function currentActiveTrade() { return state.activeTrades[activeKey()] || null; }
function hasAnyActiveTrade() { return Object.keys(state.activeTrades).length > 0; }
const RISK_LABELS = { normal: 'Normal', conservador: 'Conservador', premium: 'Premium' };
function labelForRisk(r) { return RISK_LABELS[r] || r; }

function saveActiveTrade() {
  try {
    if (hasAnyActiveTrade()) localStorage.setItem(ACTIVE_KEY, JSON.stringify(state.activeTrades));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch (e) { /* ignore */ }
}
function loadActiveTrade() {
  try { const raw = localStorage.getItem(ACTIVE_KEY); if (raw) state.activeTrades = JSON.parse(raw) || {}; } catch (e) {}
}

function takeTrade() {
  const s = state.signal;
  if (!s || !s.plan || currentActiveTrade()) return;   // one trade per tf+mode
  const jt = addTrade(s, state.tf);   // log frozen snapshot to the journal
  state.activeTrades[activeKey()] = {
    id: jt ? jt.id : 'at-' + Date.now(),
    dir: s.direction,
    entry: s.plan.entry, stop: s.plan.stop, tp1: s.plan.tp1, tp2: s.plan.tp2,
    riskPct: s.plan.riskPct, conviction: s.conviction,
    tf: state.tf, risk: state.risk, time: Date.now(), mfe: 0, lastEvent: null,
  };
  saveActiveTrade();
  renderSignal();
  renderJournal();
  updateTradeOverlay();
}

function closeActiveTrade() {
  const at = currentActiveTrade();
  if (!at) return;
  const t = getTrades().find((x) => x.id === at.id);
  if (t && t.status === 'open') {
    const price = state.livePrice || at.entry;
    const isLong = at.dir === 'long';
    const r = liveR(at, price);
    let outcome = 'be';
    if (isLong ? price >= at.tp2 : price <= at.tp2) outcome = 'win2';
    else if (isLong ? price <= at.stop : price >= at.stop) outcome = 'loss';
    else if (r >= 0.9) outcome = 'win1';
    else if (r <= -0.9) outcome = 'loss';
    else outcome = 'be';   // small +/- moves count as break-even (honest stats)
    resolveTrade(at.id, outcome);
  }
  delete state.activeTrades[activeKey()];
  saveActiveTrade();
  renderJournal();
  renderSignal();
  updateTradeOverlay();
}

function renderActiveTrade(at) {
  const card = $('signalCard');
  const fill = $('convictionFill');

  card.className = 'signal-card ' + at.dir;
  $('signalTime').textContent = new Date(at.time).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  $('signalDir').textContent = at.dir === 'long' ? 'LONG ▲' : 'SHORT ▼';
  $('signalConviction').textContent = `TRADE ACTIVO · congelado · ${at.tf.toUpperCase()} · ${labelForRisk(at.risk)}`;
  fill.style.width = at.conviction + '%';
  fill.style.background = at.dir === 'long' ? 'var(--long)' : 'var(--short)';

  // FROZEN levels — these never move once the trade is taken
  $('lvlEntry').textContent = fmtPrice(at.entry);
  $('lvlSL').textContent = fmtPrice(at.stop);
  $('lvlTP1').textContent = fmtPrice(at.tp1);
  $('lvlTP2').textContent = fmtPrice(at.tp2);
  $('statRR').textContent = '2 : 1';
  $('statRisk').textContent = fmtNum(at.riskPct, 2) + '%';
  $('statScoreLabel').textContent = 'Convicción';
  $('statScore').textContent = at.conviction + '%';

  $('signalReasons').style.display = 'none';
  $('activeTradeStatus').style.display = 'block';
  updateActiveTradeStatus();

  const logBtn = $('logTradeBtn');
  logBtn.disabled = false;
  logBtn.classList.remove('logged');
  logBtn.classList.add('danger');
  logBtn.querySelector('span').textContent = 'Cerrar trade';
}

/** Live P&L tracker for the active trade. Updates the status block ONLY;
 *  the frozen entry/SL/TP levels above are never touched. */
function updateActiveTradeStatus() {
  const at = currentActiveTrade();
  if (!at) return;
  const price = state.livePrice || at.entry;
  const isLong = at.dir === 'long';
  const r = liveR(at, price);
  const movePct = (isLong ? price - at.entry : at.entry - price) / at.entry * 100;
  at.mfe = Math.max(at.mfe || 0, r);

  const hitTP2 = isLong ? price >= at.tp2 : price <= at.tp2;
  const hitTP1 = isLong ? price >= at.tp1 : price <= at.tp1;
  const hitSL = isLong ? price <= at.stop : price >= at.stop;

  let status, cls, icon, eventKey = null;
  if (at.lastEvent === 'tp2' || hitTP2) { status = 'TP2 alcanzado · objetivo cumplido (+2R)'; cls = 'pos'; icon = '🎯'; eventKey = 'tp2'; }
  else if (at.lastEvent === 'sl' || hitSL) { status = 'Stop Loss alcanzado (-1R)'; cls = 'neg'; icon = '🛑'; eventKey = 'sl'; }
  else if (hitTP1) { status = 'TP1 alcanzado (+1R) · puedes asegurar parte'; cls = 'pos'; icon = '✅'; }
  else if (at.mfe >= 0.4 && r <= 0.12 && r >= -0.12) { status = 'Se dio la vuelta a BREAK-EVEN'; cls = 'warn'; icon = '⚠️'; eventKey = 'be'; }
  else if (r > 0.05) { status = 'En ganancia'; cls = 'pos'; icon = '📈'; }
  else if (r < -0.05) { status = 'En pérdida'; cls = 'neg'; icon = '📉'; }
  else { status = 'En break-even'; cls = 'neutral'; icon = '➖'; }

  // fire a one-time alert + auto-resolve journal on terminal/important events
  if (eventKey && at.lastEvent !== eventKey) {
    at.lastEvent = eventKey;
    if (eventKey === 'tp2') { resolveTrade(at.id, 'win2'); renderJournal(); playAlertSound('long'); }
    else if (eventKey === 'sl') { resolveTrade(at.id, 'loss'); renderJournal(); playAlertSound('short'); }
    else if (eventKey === 'be') { playAlertSound('short'); }
    notifyText(`Trade ${at.dir.toUpperCase()} · ${at.tf.toUpperCase()} · ${labelForRisk(at.risk)}`, status);
    saveActiveTrade();
  }

  const rTxt = (r >= 0 ? '+' : '') + r.toFixed(2) + 'R';
  const mTxt = (movePct >= 0 ? '+' : '') + movePct.toFixed(2) + '%';
  const el = $('activeTradeStatus');
  el.className = 'active-status ' + cls;
  el.innerHTML = `
    <div class="as-head"><span class="as-icon">${icon}</span><span class="as-status">${status}</span></div>
    <div class="as-metrics">
      <div><span>Precio actual</span><b>${fmtPrice(price)}</b></div>
      <div><span>P&L</span><b class="${r >= 0 ? 'pos' : 'neg'}">${rTxt}</b></div>
      <div><span>Movimiento</span><b class="${movePct >= 0 ? 'pos' : 'neg'}">${mTxt}</b></div>
      <div><span>Máx. a favor</span><b>${(at.mfe >= 0 ? '+' : '') + at.mfe.toFixed(2)}R</b></div>
    </div>`;
}

const IND_DEFS = [
  { key: 'rsi', name: 'RSI (14)', fmt: (L) => fmtNum(L.rsi, 1),
    sig: (L) => (L.rsi == null ? 'neutral' : L.rsi > 70 ? 'bear' : L.rsi < 30 ? 'bull' : L.rsi > 50 ? 'bull' : 'bear'),
    desc: (L) => (L.rsi == null ? '' : L.rsi > 70 ? 'Sobrecompra' : L.rsi < 30 ? 'Sobreventa' : 'Neutral') },
  { key: 'macd', name: 'MACD', fmt: (L) => fmtNum(L.macdHist, 1),
    sig: (L) => (L.macdHist == null ? 'neutral' : L.macdHist > 0 ? 'bull' : 'bear'),
    desc: (L) => (L.macdHist == null ? '' : L.macdHist > 0 ? 'Histograma positivo' : 'Histograma negativo') },
  { key: 'adx', name: 'ADX', fmt: (L) => fmtNum(L.adx, 0),
    sig: (L) => (L.adx == null ? 'neutral' : L.adx > 25 ? 'bull' : 'neutral'),
    desc: (L) => (L.adx == null ? '' : L.adx > 25 ? 'Tendencia fuerte' : 'Tendencia débil') },
  { key: 'stoch', name: 'Estocástico', fmt: (L) => fmtNum(L.stochK, 0),
    sig: (L) => (L.stochK == null ? 'neutral' : L.stochK > 80 ? 'bear' : L.stochK < 20 ? 'bull' : 'neutral'),
    desc: (L) => (L.stochK == null ? '' : L.stochK > 80 ? 'Sobrecompra' : L.stochK < 20 ? 'Sobreventa' : 'Medio') },
  { key: 'ema', name: 'Estructura EMA', fmt: (L) => (L.ema21 > L.ema50 ? 'Alcista' : 'Bajista'),
    sig: (L) => (L.ema21 == null || L.ema50 == null ? 'neutral' : L.ema21 > L.ema50 ? 'bull' : 'bear'),
    desc: (L) => 'EMA21 vs EMA50' },
  { key: 'vol', name: 'Volumen rel.', fmt: (L) => fmtNum(L.relVol, 2) + 'x',
    sig: (L) => (L.relVol > 1.4 ? 'bull' : L.relVol < 0.7 ? 'bear' : 'neutral'),
    desc: (L) => (L.relVol > 1.4 ? 'Por encima de media' : L.relVol < 0.7 ? 'Bajo' : 'Normal') },
];

function renderIndicators() {
  const L = state.ind.last;
  $('indicatorsGrid').innerHTML = IND_DEFS.map((d) => {
    const sig = d.sig(L);
    const sigText = sig === 'bull' ? 'Alcista' : sig === 'bear' ? 'Bajista' : 'Neutral';
    return `<div class="ind-card">
      <div class="ind-head"><span class="ind-name">${d.name}</span><span class="ind-signal ${sig}">${sigText}</span></div>
      <div class="ind-value">${d.fmt(L)}</div>
      <div class="ind-desc">${d.desc(L)}</div>
    </div>`;
  }).join('');
}

function renderPatterns() {
  const list = $('patternsList');
  const patterns = state.signal.analysis.patterns;
  const trend = state.signal.analysis.trend;

  const items = [];
  // trend as the first "pattern"
  items.push({
    name: trend.label,
    dir: trend.dir === 'up' ? 'bull' : trend.dir === 'down' ? 'bear' : 'neutral',
    conf: trend.strength,
    desc: `Fuerza de tendencia ${trend.strength}/100 · ADX ${Math.round(trend.adx)}`,
    icon: trend.dir === 'up' ? '📈' : trend.dir === 'down' ? '📉' : '➡️',
  });
  for (const p of patterns) {
    items.push({ ...p, icon: iconFor(p) });
  }

  $('patternCount').textContent = items.length;
  if (!items.length) { list.innerHTML = '<div class="empty-state">Sin patrones relevantes ahora mismo.</div>'; return; }
  list.innerHTML = items.map((p) => `
    <div class="pattern ${p.dir}">
      <div class="pattern-icon">${p.icon}</div>
      <div class="pattern-body">
        <div class="pattern-name">${p.name}</div>
        <div class="pattern-desc">${p.desc}</div>
      </div>
      <div class="pattern-conf">${Math.round(p.conf)}%</div>
    </div>`).join('');
}

function iconFor(p) {
  const n = p.name.toLowerCase();
  if (n.includes('bandera')) return '🚩';
  if (n.includes('triángulo')) return '📐';
  if (n.includes('liquidez') || n.includes('manipul')) return '🎯';
  if (n.includes('compresión')) return '🧨';
  if (n.includes('martillo')) return '🔨';
  if (n.includes('estrella')) return '⭐';
  if (n.includes('envolvente')) return '🕯️';
  if (n.includes('doji')) return '✚';
  return p.dir === 'bull' ? '▲' : p.dir === 'bear' ? '▼' : '◆';
}

function renderMTF(results) {
  $('mtfGrid').innerHTML = MTF_LIST.map((tf) => {
    const r = results[tf];
    if (!r) return `<div class="mtf-cell neutral loading"><div class="mtf-tf">${tf.toUpperCase()}</div><div class="mtf-arrow">·</div><div class="mtf-label">…</div></div>`;
    const cls = r.dir;
    const arrow = r.dir === 'bull' ? '▲' : r.dir === 'bear' ? '▼' : '■';
    const label = r.dir === 'bull' ? 'Alcista' : r.dir === 'bear' ? 'Bajista' : 'Neutral';
    return `<div class="mtf-cell ${cls}"><div class="mtf-tf">${tf.toUpperCase()}</div><div class="mtf-arrow">${arrow}</div><div class="mtf-label">${label}</div></div>`;
  }).join('');
}

/* ---------------------- liquidity pools panel ---------------------- */
function renderLiquidity() {
  const host = $('liquidityList');
  if (!host) return;
  const liq = state.liquidity;
  if (!liq || !liq.pools.length) {
    $('liquidityCount').textContent = '0';
    $('liqMeta').textContent = state.source === 'Simulado' ? 'Datos simulados' : 'En tiempo real';
    host.innerHTML = '<div class="empty-state">Calculando zonas de liquidez…</div>';
    return;
  }

  $('liquidityCount').textContent = String(liq.untapped);
  $('liqMeta').textContent = `${liq.untapped} sin barrer · ${liq.pools.length} totales`;

  const nearestBuyP = liq.nearestBuy ? liq.nearestBuy.price : null;
  const nearestSellP = liq.nearestSell ? liq.nearestSell.price : null;

  // show up to 12 closest pools so the panel stays readable
  const rows = liq.pools.slice(0, 12).map((p) => {
    const isTarget = p.price === nearestBuyP || p.price === nearestSellP;
    const sideTxt = p.side === 'buy' ? 'BSL' : 'SSL';
    const sideSub = p.side === 'buy' ? 'arriba' : 'abajo';
    const dist = (p.distPct >= 0 ? '+' : '') + p.distPct.toFixed(2) + '%';
    const distCls = p.distPct >= 0 ? 'up' : 'down';
    const status = p.swept ? 'Barrida' : 'Sin barrer';
    const statusCls = p.swept ? 'swept' : 'untapped';
    const touches = p.equal ? `×${p.touches} igual` : `×${p.touches}`;
    return `<div class="liq-row ${p.side} ${p.swept ? 'swept' : ''} ${isTarget ? 'target' : ''}">
      <div class="liq-side">${sideTxt}${isTarget ? ' 🎯' : ''}</div>
      <div class="liq-price">${fmtPrice(p.price)}<small>${sideSub} · ${touches}</small>
        <div class="liq-strength"><i style="width:${p.strength}%"></i></div>
      </div>
      <div class="liq-dist ${distCls}">${dist}</div>
      <div class="liq-status ${statusCls}">${status}</div>
    </div>`;
  }).join('');
  host.innerHTML = rows;
}

/* ---------------------- liquidations panel ---------------------- */
function renderLiquidations() {
  const host = $('liqList');
  if (!host) return;
  const lq = state.liquidations || { events: [], totalLong: 0, totalShort: 0, alive: false };

  // status dot + tag
  const dot = $('liqLiveDot');
  if (dot) dot.className = 'status-dot' + (lq.alive ? ' live' : (lq.events.length ? '' : ' error'));
  const tag = $('liqStatTag');
  if (tag) {
    tag.textContent = lq.alive ? 'en vivo' : (lq.events.length ? 'reconectando' : 'conectando…');
    tag.className = 'tag ' + (lq.alive ? '' : 'tag-muted');
  }

  // totals + dominance bar (since session start)
  const tot = lq.totalLong + lq.totalShort;
  $('liqLongTotal').textContent = fmtUsdShort(lq.totalLong || 0);
  $('liqShortTotal').textContent = fmtUsdShort(lq.totalShort || 0);
  const longShare = tot > 0 ? (lq.totalLong / tot) * 100 : 50;
  const domL = $('liqDomLong'); const domS = $('liqDomShort');
  if (domL) domL.style.width = longShare.toFixed(1) + '%';
  if (domS) domS.style.width = (100 - longShare).toFixed(1) + '%';

  if (!lq.events.length) {
    host.innerHTML = `<div class="empty-state">${lq.alive
      ? 'Conectado. Esperando liquidaciones de BTC perp…'
      : 'Conectando al stream de liquidaciones de Binance Futures… (si tu red bloquea Binance, no aparecerán).'}</div>`;
    return;
  }

  host.innerHTML = lq.events.slice(0, 30).map((e) => {
    const isLong = e.side === 'long';
    const t = new Date(e.time).toLocaleTimeString('es-ES');
    const big = e.usd >= 1e6 ? ' big' : '';
    return `<div class="liqx-row ${e.side}${big}">
      <span class="liqx-badge ${e.side}">${isLong ? 'LONG REKT' : 'SHORT REKT'}</span>
      <span class="liqx-px">${fmtPrice(e.price)}</span>
      <span class="liqx-usd">${fmtUsdShort(e.usd)}</span>
      <span class="liqx-time">${t}</span>
    </div>`;
  }).join('');
}

/* ---------------------- market news panel ---------------------- */
function relTime(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} d`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderNews() {
  const host = $('newsList');
  if (!host) return;
  const items = state.news || [];

  // aggregate sentiment tag
  const tag = $('newsSentimentTag');
  if (items.length) {
    const agg = aggregateSentiment(items);
    const lbl = agg.label === 'bull' ? '▲ Sesgo alcista' : agg.label === 'bear' ? '▼ Sesgo bajista' : '◆ Neutral';
    tag.textContent = `${lbl}${agg.high ? ' · ⚡' + agg.high : ''}`;
    tag.className = 'tag news-sentiment-tag ' + agg.label;
  } else {
    tag.textContent = '—';
    tag.className = 'tag tag-muted';
  }

  $('newsSource').textContent = state.newsSource;

  // filter
  const f = state.newsFilter;
  const filtered = items.filter((it) => {
    if (f === 'all') return true;
    if (f === 'high') return it.impact === 'high';
    return it.sentiment === f;
  });

  if (!filtered.length) {
    host.innerHTML = `<div class="empty-state">${items.length ? 'Sin noticias en este filtro.' : 'No se pudieron cargar noticias ahora mismo.'}</div>`;
    return;
  }

  host.innerHTML = filtered.slice(0, 40).map((it) => {
    const sentTxt = it.sentiment === 'bull' ? '▲ Alcista' : it.sentiment === 'bear' ? '▼ Bajista' : '◆ Neutral';
    const highBadge = it.impact === 'high' ? '<span class="news-badge high">⚡ Impacto</span>' : '';
    const body = it.body ? `<div class="news-body">${escapeHtml(it.body)}</div>` : '';
    const safeUrl = it.url && it.url !== '#' ? encodeURI(it.url) : '#';
    return `<a class="news-item ${it.sentiment} ${it.impact === 'high' ? 'high' : ''}" href="${safeUrl}" target="_blank" rel="noopener noreferrer" data-time="${it.time}">
      <div class="news-top">
        <span class="news-src">${escapeHtml(it.source)}</span>
        <span class="news-badge ${it.sentiment}">${sentTxt}</span>
        ${highBadge}
        <span class="news-time" data-rel="${it.time}">${relTime(it.time)}</span>
      </div>
      <div class="news-title">${escapeHtml(it.title)}</div>
      ${body}
    </a>`;
  }).join('');
}

/** Refresh just the relative timestamps + "updated ago" label every second. */
function tickNewsClock() {
  if (state.newsUpdatedAt) {
    const dot = $('newsLiveDot');
    const fresh = Date.now() - state.newsUpdatedAt < 90000;   // <90s = live
    if (dot) dot.className = 'status-dot' + (fresh ? ' live' : ' error');
    const up = $('newsUpdated');
    if (up) up.textContent = state.news.length ? relTime(state.newsUpdatedAt) : '—';
  }
  document.querySelectorAll('#newsList [data-rel]').forEach((el) => {
    el.textContent = relTime(+el.dataset.rel);
  });
}

/* ---------------------- multi-timeframe ---------------------- */
async function computeMTF() {
  const results = {};
  renderMTF(results);
  await Promise.all(MTF_LIST.map(async (tf) => {
    try {
      const { candles } = await fetchCandles(tf, 260);
      const ind = computeIndicators(candles);
      results[tf] = timeframeBias(candles, ind);
    } catch (e) {
      results[tf] = { dir: 'neutral', score: 0 };
    }
    renderMTF(results);
  }));

  // bias from timeframes ABOVE the current one
  const idx = MTF_LIST.indexOf(state.tf);
  const higher = idx >= 0 ? MTF_LIST.slice(idx + 1) : MTF_LIST.slice(2);
  let up = 0, down = 0;
  const scope = higher.length ? higher : MTF_LIST;
  for (const tf of scope) {
    const r = results[tf];
    if (!r) continue;
    if (r.dir === 'bull') up++; else if (r.dir === 'bear') down++;
  }
  const total = scope.length;
  return { up, down, total, score: (up - down) };
}

/* ---------------------- main analyze loop ---------------------- */
async function analyze(opts = {}) {
  if (state.loading) return;
  const silent = opts.silent === true && state.candles.length > 0;
  state.loading = true;
  $('refreshBtn').classList.add('spinning');
  if (!silent) { $('chartLoader').classList.remove('hidden'); setStatus('Analizando…', ''); }

  try {
    const { candles, source } = await fetchCandles(state.tf, 400);
    state.candles = candles;
    state.source = source;
    state.ind = computeIndicators(candles);

    // multi-timeframe bias (runs in parallel internally)
    const mtfBias = await computeMTF();
    state.mtfBias = mtfBias;

    state.signal = generateSignal(candles, state.ind, state.risk, mtfBias);
    state.liquidity = detectLiquidity(candles);
    state.heatmap = computeLiquidationHeatmap(candles);
    heatmapLastCandleTime = candles[candles.length - 1].time;
    heatmapSig = '';   // force heatmap repaint for the new data

    renderChart();
    renderSignal();
    renderIndicators();
    renderPatterns();
    renderLiquidity();
    renderLiquidations();
    renderJournal();

    // fire alert when a NEW actionable signal appears
    maybeAlert(state.signal);

    // header price (use last candle if no live ticker)
    const L = state.ind.last;
    if (!tickerTimer) updatePriceHeader(L.price, null);

    $('dataSource').textContent = source;
    $('lastUpdate').textContent = new Date().toLocaleTimeString('es-ES');
    setStatus(source === 'Simulado' ? 'Datos simulados (en vivo)' : 'En vivo · conectando stream…', source === 'Simulado' ? 'error' : 'live');

    // (re)connect the realtime stream for this timeframe after loading history
    if (!silent && state.autoRefresh) connectLiveStream();
  } catch (e) {
    console.error(e);
    setStatus('Error: ' + e.message, 'error');
  } finally {
    state.loading = false;
    $('refreshBtn').classList.remove('spinning');
    if (!silent) $('chartLoader').classList.add('hidden');
  }
}

/* ---------------------- LIVE ENGINE (WebSocket + REST fallback) ---------------------- */
let ws = null;
let wsAlive = false;
let restPollTimer = null;
let recomputeTimer = null;
let wsReconnectTimer = null;

const BINANCE_WS = { '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d','1w':'1w' };

/** Open a realtime kline stream for the current timeframe (TradingView-style). */
function connectLiveStream() {
  closeLiveStream();
  // Demo/offline data has no real stream → drive it locally.
  if (state.source === 'Simulado') { startRestPolling(); return; }

  const interval = BINANCE_WS[state.tf] || '4h';
  try {
    ws = new WebSocket(`wss://stream.binance.com:9443/ws/btcusdt@kline_${interval}`);
    ws.onopen = () => {
      wsAlive = true;
      stopRestPolling();
      setStatus('En vivo · streaming en tiempo real', 'live');
    };
    ws.onmessage = (ev) => {
      try { const d = JSON.parse(ev.data); if (d && d.k) applyLiveKline(d.k); } catch (e) {}
    };
    ws.onerror = () => { wsAlive = false; };
    ws.onclose = () => {
      wsAlive = false;
      startRestPolling();                 // keep updating while WS is down
      scheduleReconnect();
    };
    // If the socket doesn't open quickly (blocked region), fall back to polling.
    setTimeout(() => { if (!wsAlive) startRestPolling(); }, 5000);
  } catch (e) {
    startRestPolling();
  }
}

function scheduleReconnect() {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    if (state.autoRefresh && !document.hidden) connectLiveStream();
  }, 8000);
}

function closeLiveStream() {
  if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
  wsAlive = false;
}

/** Apply one realtime kline from the WS stream to the chart instantly. */
function applyLiveKline(k) {
  const c = {
    time: Math.floor(k.t / 1000),
    open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v,
  };
  const arr = state.candles;
  if (!arr.length) return;
  const last = arr[arr.length - 1];
  if (c.time === last.time) arr[arr.length - 1] = c;       // update forming candle
  else if (c.time > last.time) arr.push(c);                // new candle started
  else return;
  if (arr.length > 800) state.candles = arr.slice(-800);

  // instant, smooth candle update (like TradingView) without resetting zoom/pan
  candleSeries.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
  state.livePrice = c.close;
  $('livePrice').textContent = fmtPrice(c.close);
  $('lastUpdate').textContent = new Date().toLocaleTimeString('es-ES');
  refreshJournalLive();
  if (currentActiveTrade()) updateActiveTradeStatus();   // smooth live P&L (levels stay frozen)
  state._needRecompute = true;             // indicators/signal refresh on throttle
}

/** REST fallback: poll the latest candles when WS is unavailable. */
function startRestPolling() {
  if (restPollTimer) return;
  restPollTimer = setInterval(async () => {
    if (document.hidden || state.loading) return;
    if (state.source === 'Simulado') { evolveSyntheticLast(); return; }
    try {
      const { candles, source } = await fetchCandles(state.tf, 2);
      if (source === 'Simulado' || !candles || !candles.length) return;
      mergeCandles(candles);
      const last = state.candles[state.candles.length - 1];
      candleSeries.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
      state.livePrice = last.close;
      $('livePrice').textContent = fmtPrice(last.close);
      $('lastUpdate').textContent = new Date().toLocaleTimeString('es-ES');
      refreshJournalLive();
      if (currentActiveTrade()) updateActiveTradeStatus();
      state._needRecompute = true;
      if (!wsAlive) setStatus('En vivo · sondeo (cada 3s)', 'live');
    } catch (e) { /* transient */ }
  }, 3000);
}
function stopRestPolling() {
  if (restPollTimer) { clearInterval(restPollTimer); restPollTimer = null; }
}

/** Throttled recompute of indicators/signal/patterns from the live candles. */
function startRecomputeLoop() {
  if (recomputeTimer) return;
  recomputeTimer = setInterval(() => {
    if (document.hidden || !state._needRecompute || !state.candles.length) return;
    state._needRecompute = false;
    state.ind = computeIndicators(state.candles);
    state.signal = generateSignal(state.candles, state.ind, state.risk, state.mtfBias);
    state.liquidity = detectLiquidity(state.candles);
    // recompute the heatmap ONLY when a new candle closes (anchored to price,
    // so it must not jitter with every live tick)
    const lastT = state.candles[state.candles.length - 1].time;
    if (lastT !== heatmapLastCandleTime) {
      state.heatmap = computeLiquidationHeatmap(state.candles);
      heatmapLastCandleTime = lastT;
      heatmapSig = '';
    }
    renderChartLive();
    drawLiquidity();              // refresh chart lines only if pools changed
    renderSignal();
    renderIndicators();
    renderPatterns();
    renderLiquidity();
    maybeAlert(state.signal);
    if (currentActiveTrade()) saveActiveTrade();
  }, 1200);
}
function stopRecomputeLoop() {
  if (recomputeTimer) { clearInterval(recomputeTimer); recomputeTimer = null; }
}

function mergeCandles(incoming) {
  const arr = state.candles;
  for (const c of incoming) {
    const idx = arr.findIndex((x) => x.time === c.time);
    if (idx >= 0) arr[idx] = c;
    else if (c.time > arr[arr.length - 1].time) arr.push(c);
  }
  if (arr.length > 800) state.candles = arr.slice(-800);
}

/** Demo-mode price movement so the chart breathes when offline. */
function evolveSyntheticLast() {
  const arr = state.candles;
  if (!arr.length) return;
  const last = arr[arr.length - 1];
  const step = last.close * 0.0006;
  last.close = Math.round(Math.max(1, last.close + (Math.random() - 0.5) * 2 * step) * 100) / 100;
  last.high = Math.max(last.high, last.close);
  last.low = Math.min(last.low, last.close);
  candleSeries.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
  state.livePrice = last.close;
  $('livePrice').textContent = fmtPrice(last.close);
  refreshJournalLive();
  if (currentActiveTrade()) updateActiveTradeStatus();
  state._needRecompute = true;
}

function updatePriceHeader(price, changePct) {
  state.livePrice = price;
  $('livePrice').textContent = fmtPrice(price);
  const ch = $('priceChange');
  if (changePct != null) {
    ch.textContent = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
    ch.className = 'price-change ' + (changePct >= 0 ? 'up' : 'down');
  }
  // keep open-trade P&L fresh
  refreshJournalLive();
}

/* ---------------------- alerts ---------------------- */
function maybeAlert(signal) {
  // While a trade is active, we don't alert on new suggestions (you're already in).
  if (currentActiveTrade()) return;
  const key = signal.direction === 'none' ? `${state.tf}:none` : `${state.tf}:${signal.direction}`;
  if (key === state.lastAlertKey) return;        // same state, no spam
  const prev = state.lastAlertKey;
  state.lastAlertKey = key;
  if (prev === null) return;                      // don't alert on first load
  if (signal.direction === 'none') return;        // only alert on actionable signals
  playAlertSound(signal.direction);
  notifySignal(signal, state.tf);
}

/* ---------------------- journal ---------------------- */
function renderJournal() {
  const trades = getTrades();
  const st = getStats();
  const sign = (v) => (v > 0 ? '+' : '') + v.toFixed(2);
  const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

  $('journalStats').innerHTML = `
    <div class="jstat"><span class="jstat-label">Trades</span><span class="jstat-val">${st.total}</span></div>
    <div class="jstat"><span class="jstat-label">Abiertos</span><span class="jstat-val">${st.open}</span></div>
    <div class="jstat"><span class="jstat-label">Win rate</span><span class="jstat-val ${st.winRate >= 50 ? 'pos' : st.closed ? 'neg' : ''}">${st.closed ? st.winRate.toFixed(0) + '%' : '—'}</span></div>
    <div class="jstat"><span class="jstat-label">Ganados / Perdidos</span><span class="jstat-val">${st.wins} / ${st.losses}</span></div>
    <div class="jstat"><span class="jstat-label">Resultado total</span><span class="jstat-val ${cls(st.totalR)}">${st.closed ? sign(st.totalR) + 'R' : '—'}</span></div>
    <div class="jstat"><span class="jstat-label">R medio</span><span class="jstat-val ${cls(st.avgR)}">${st.closed ? sign(st.avgR) + 'R' : '—'}</span></div>`;

  const list = $('journalList');
  if (!trades.length) {
    list.innerHTML = '<div class="empty-state">Aún no has registrado trades. Cuando aparezca una señal, pulsa “Registrar este trade”.</div>';
    return;
  }

  list.innerHTML = trades.map((t) => {
    const date = new Date(t.time).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const dirTxt = t.dir === 'long' ? 'LONG' : 'SHORT';
    let right;
    if (t.status === 'open') {
      const r = liveR(t, state.livePrice);
      const rTxt = r == null ? '—' : (r > 0 ? '+' : '') + r.toFixed(2) + 'R';
      right = `
        <div class="jlive ${r == null ? '' : r >= 0 ? 'pos' : 'neg'}" data-live="${t.id}">${rTxt}</div>
        <div class="jactions">
          <button class="jbtn win" data-act="win2" data-id="${t.id}">TP2 +2R</button>
          <button class="jbtn win" data-act="win1" data-id="${t.id}">TP1 +1R</button>
          <button class="jbtn loss" data-act="loss" data-id="${t.id}">SL -1R</button>
          <button class="jbtn" data-act="be" data-id="${t.id}">BE</button>
          <button class="jbtn del" data-act="del" data-id="${t.id}">✕</button>
        </div>`;
    } else {
      const label = { win2: 'TP2 +2R', win1: 'TP1 +1R', loss: 'SL -1R', be: 'BE 0R' }[t.status] || t.status;
      right = `
        <span class="jstatus-badge ${t.status}">${label}</span>
        <div class="jactions">
          <button class="jbtn" data-act="open" data-id="${t.id}">Reabrir</button>
          <button class="jbtn del" data-act="del" data-id="${t.id}">✕</button>
        </div>`;
    }
    return `<div class="jrow ${t.dir} ${t.status !== 'open' ? t.status : ''}">
      <div class="jdir">${dirTxt}<small>${t.tf.toUpperCase()} · ${date}</small></div>
      <div class="jlevels">E <b>${fmtPrice(t.entry)}</b> · SL <b>${fmtPrice(t.stop)}</b> · TP2 <b>${fmtPrice(t.tp2)}</b><br>Riesgo ${fmtNum(t.riskPct, 2)}% · Convicción ${t.conviction}%</div>
      <div>${right}</div>
    </div>`;
  }).join('');
}

/** Update only the live R numbers of open trades without full re-render. */
function refreshJournalLive() {
  if (!state.livePrice) return;
  getTrades().forEach((t) => {
    if (t.status !== 'open') return;
    const el = document.querySelector(`[data-live="${t.id}"]`);
    if (!el) return;
    const r = liveR(t, state.livePrice);
    if (r == null) return;
    el.textContent = (r > 0 ? '+' : '') + r.toFixed(2) + 'R';
    el.className = 'jlive ' + (r >= 0 ? 'pos' : 'neg');
  });
}

async function pollTicker() {
  const t = await fetchTicker();
  if (t) {
    tickerTimer = true;
    updatePriceHeader(t.price, t.changePct);
  }
}

/* ---------------------- news loop ---------------------- */
let newsTimer = null;
let newsClockTimer = null;
let newsLoading = false;
const seenNewsIds = new Set();
let newsPrimed = false;

/**
 * Fire a sound + notification when genuinely NEW high-impact headlines arrive.
 * The first successful load only primes the "seen" set (no alert blast on open),
 * and alerts respect both the master 🔔 toggle and the per-panel news toggle.
 */
function maybeNewsAlert(items) {
  if (!items || !items.length) return;
  if (!newsPrimed) {                       // first load → remember, don't alert
    items.forEach((it) => seenNewsIds.add(it.id));
    newsPrimed = true;
    return;
  }
  const fresh = items.filter((it) => !seenNewsIds.has(it.id));
  items.forEach((it) => seenNewsIds.add(it.id));
  if (seenNewsIds.size > 600) {            // keep the set bounded across a session
    seenNewsIds.clear();
    items.forEach((it) => seenNewsIds.add(it.id));
  }
  if (!state.newsAlerts) return;           // news alerts muted by the user

  const hot = fresh.filter((it) => it.impact === 'high');
  if (!hot.length) return;

  const dir = hot[0].sentiment === 'bear' ? 'short' : 'long';
  playAlertSound(dir);
  hot.slice(0, 2).forEach((it) => {
    const tag = it.sentiment === 'bull' ? '▲' : it.sentiment === 'bear' ? '▼' : '◆';
    notifyText(`⚡ Noticia de alto impacto ${tag}`, `${it.source}: ${it.title}`);
  });
  flashNewsAlert(hot.length);
}

/** Brief visual cue on the news panel when a high-impact alert fires. */
function flashNewsAlert(count) {
  const panel = document.querySelector('.news-panel');
  if (!panel) return;
  panel.classList.add('news-flash');
  setTimeout(() => panel.classList.remove('news-flash'), 1400);
  const tag = $('newsSentimentTag');
  if (tag) { tag.classList.add('news-tag-ping'); setTimeout(() => tag.classList.remove('news-tag-ping'), 1400); }
}

async function pollNews() {
  if (newsLoading) return;
  newsLoading = true;
  try {
    const { items, source } = await fetchNews(40);
    if (items && items.length) {
      state.news = items;
      state.newsSource = source;
      state.newsUpdatedAt = Date.now();
      renderNews();
      maybeNewsAlert(items);
    } else if (!state.news.length) {
      renderNews();
    }
  } catch (e) {
    console.warn('[news] fallo al actualizar:', e.message);
  } finally {
    newsLoading = false;
  }
}

function startNewsLoop() {
  pollNews();                                   // immediate first load
  if (newsTimer) clearInterval(newsTimer);
  newsTimer = setInterval(() => { if (!document.hidden) pollNews(); }, 30000);
  if (newsClockTimer) clearInterval(newsClockTimer);
  newsClockTimer = setInterval(tickNewsClock, 1000);   // live relative times
}

/* ---------------------- liquidations feed ---------------------- */
function onLiquidationsUpdate(s) {
  state.liquidations = s;
  renderLiquidations();
  if (state.showLiquidations) rebuildLiqMarkers();   // ≤1 event/sec from Binance, cheap
}

function startLiquidationsFeed() {
  if (liqFeed) return;
  liqFeed = createLiquidationFeed({ onUpdate: onLiquidationsUpdate, max: 60 });
  liqFeed.start();
}

/* ---------------------- controls ---------------------- */
function bindControls() {
  $('tfSelector').addEventListener('click', (e) => {
    const btn = e.target.closest('.tf-btn');
    if (!btn) return;
    document.querySelectorAll('#tfSelector .tf-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.tf = btn.dataset.tf;
    state._fitted = false;        // re-fit the chart for the new timeframe
    state.lastAlertKey = null;    // don't fire an alert just because we switched TF
    $('chartTf').textContent = btn.textContent;
    analyze();
  });

  $('riskSelector').addEventListener('click', (e) => {
    const btn = e.target.closest('.tf-btn');
    if (!btn) return;
    document.querySelectorAll('#riskSelector .tf-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.risk = btn.dataset.risk;
    if (state.ind) {
      state.signal = generateSignal(state.candles, state.ind, state.risk, state.mtfBias);
      renderSignal(); renderChart(); renderPatterns();
    }
  });

  $('refreshBtn').addEventListener('click', analyze);

  $('toggleEMA').addEventListener('change', (e) => { state.showEMA = e.target.checked; renderChart(); });
  $('toggleLevels').addEventListener('change', (e) => { state.showLevels = e.target.checked; renderChart(); });
  $('toggleLiquidity').addEventListener('change', (e) => { state.showLiquidity = e.target.checked; drawLiquidity(true); });
  $('toggleLiquidations').addEventListener('change', (e) => { state.showLiquidations = e.target.checked; heatmapSig = ''; rebuildLiqMarkers(); });
  $('toggleAuto').addEventListener('change', (e) => {
    state.autoRefresh = e.target.checked;
    setupAutoRefresh();
  });
  $('toggleAlerts').addEventListener('change', (e) => {
    setAlertsEnabled(e.target.checked);
    if (e.target.checked) { primeAudio(); requestNotifyPermission(); }
  });

  // take (freeze) the current signal as a trade, or close the active one
  $('logTradeBtn').addEventListener('click', () => {
    primeAudio();
    if (currentActiveTrade()) closeActiveTrade();
    else takeTrade();
  });

  // journal actions (event delegation)
  $('journalList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;
    if (act === 'del') deleteTrade(id);
    else resolveTrade(id, act);
    renderJournal();
  });

  $('clearJournalBtn').addEventListener('click', () => {
    if (confirm('¿Vaciar todo el diario de trades? Esta acción no se puede deshacer.')) {
      clearAll();
      renderJournal();
    }
  });

  // news filter chips
  const nf = $('newsFilters');
  if (nf) nf.addEventListener('click', (e) => {
    const btn = e.target.closest('.news-chip');
    if (!btn) return;
    nf.querySelectorAll('.news-chip').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.newsFilter = btn.dataset.filter;
    renderNews();
  });

  // per-panel toggle for high-impact news alerts
  const nat = $('newsAlertToggle');
  if (nat) {
    const paintNat = () => {
      nat.classList.toggle('active', state.newsAlerts);
      nat.textContent = state.newsAlerts ? '🔔' : '🔕';
      nat.title = state.newsAlerts
        ? 'Alertas de noticias de alto impacto: ACTIVAS (clic para silenciar)'
        : 'Alertas de noticias de alto impacto: silenciadas (clic para activar)';
    };
    paintNat();
    nat.addEventListener('click', () => {
      state.newsAlerts = !state.newsAlerts;
      try { localStorage.setItem('btc_news_alerts', state.newsAlerts ? '1' : '0'); } catch (e) {}
      paintNat();
      primeAudio();   // unlock audio on this gesture so future alerts sound
    });
  }

  // prime audio + notifications on first interaction anywhere
  window.addEventListener('pointerdown', primeAudio, { once: true });

  // theme selector (Futurista / Neón)
  $('themeSelector').addEventListener('click', (e) => {
    const btn = e.target.closest('.tf-btn');
    if (!btn) return;
    applyTheme(btn.dataset.theme);
  });

  // fullscreen for just the chart panel
  $('fullscreenBtn').addEventListener('click', () => {
    const el = document.querySelector('.chart-panel');
    const inFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (!inFs) {
      (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    }
  });
  const onFsChange = () => {
    const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    $('fullscreenBtn').classList.toggle('active', inFs);
    $('fullscreenBtn').title = inFs ? 'Salir de pantalla completa' : 'Pantalla completa';
    // give the layout a tick, then keep the latest candles in view + reposition boxes
    setTimeout(() => { if (chart) { try { chart.timeScale().scrollToRealTime(); } catch (e) {} updateTradeOverlay(); } }, 120);
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
}

function setupAutoRefresh() {
  // clear everything first
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  stopRestPolling();
  stopRecomputeLoop();

  if (state.autoRefresh) {
    startRecomputeLoop();                 // throttled indicator/signal refresh from live data
    connectLiveStream();                  // realtime candles (WS, REST fallback)
    // full re-analysis incl. multi-timeframe bias, quietly in the background
    refreshTimer = setInterval(() => { if (!document.hidden) analyze({ silent: true }); }, 300000);
  } else {
    closeLiveStream();                    // pause the realtime stream
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  }
}

/* ---------------------- boot ---------------------- */
function boot() {
  if (!LWC) { setStatus('No se pudo cargar el motor de gráficos', 'error'); return; }
  initChart();
  let savedTheme = 'futuristic';
  try { savedTheme = localStorage.getItem('btcQuantTheme') || 'futuristic'; } catch (e) {}
  applyTheme(savedTheme);
  bindControls();
  loadActiveTrade();        // restore a frozen trade across reloads
  renderJournal();
  requestNotifyPermission();
  analyze();
  setupAutoRefresh();
  pollTicker();
  setInterval(pollTicker, 15000);
  startNewsLoop();
  startLiquidationsFeed();

  // catch up instantly when the user comes back to the tab
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.autoRefresh) {
      if (!wsAlive) connectLiveStream();
      pollTicker();
      pollNews();
    }
  });
}

document.addEventListener('DOMContentLoaded', boot);
