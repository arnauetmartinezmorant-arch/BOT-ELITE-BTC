/* ============================================================
   app.js — UI orchestration & chart rendering
   ============================================================ */

import { fetchCandles, fetchTicker, TF_SECONDS } from './data.js';
import { computeIndicators } from './indicators.js';
import { generateSignal, timeframeBias } from './signals.js';
import { setAlertsEnabled, primeAudio, playAlertSound, requestNotifyPermission, notifySignal } from './alerts.js';
import { getTrades, addTrade, resolveTrade, deleteTrade, clearAll, getStats, liveR } from './journal.js';

const LWC = window.LightweightCharts;

const state = {
  tf: '4h',
  risk: 'equilibrado',
  candles: [],
  ind: null,
  signal: null,
  source: '—',
  mtfBias: null,
  autoRefresh: true,
  showEMA: true,
  showLevels: true,
  loading: false,
  lastAlertKey: null,
  lastLoggedKey: null,
  livePrice: null,
};

const MTF_LIST = ['15m', '1h', '4h', '1d', '1w'];

let chart, candleSeries, ema21Series, ema50Series, ema200Series;
let priceLines = [];
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
    timeScale: { borderColor: 'rgba(148,163,184,0.15)', timeVisible: true, secondsVisible: false },
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
  // Reposition every animation frame so the boxes track price on pan AND zoom.
  const overlayLoop = () => { updateTradeOverlay(); requestAnimationFrame(overlayLoop); };
  requestAnimationFrame(overlayLoop);
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
  const s = state.signal;
  const show = state.showLevels && s && s.plan;
  overlayEl.style.display = show ? 'block' : 'none';
  if (!show) return;

  const p = s.plan;
  const W = $('chart').clientWidth;
  const H = $('chart').clientHeight;
  const psW = priceScaleWidth();
  const paneW = Math.max(60, W - psW);
  const boxW = Math.min(paneW * 0.46, 300);
  const left = Math.max(0, paneW - boxW);

  const clampY = (y) => Math.max(0, Math.min(H, y));
  const yE = clampY(candleSeries.priceToCoordinate(p.entry));
  const ySL = clampY(candleSeries.priceToCoordinate(p.stop));
  const yTP = clampY(candleSeries.priceToCoordinate(p.tp2));

  const set = (el, css) => { const n = overlayEl.querySelector(`[data-el="${el}"]`); Object.assign(n.style, css); return n; };
  const isLong = s.direction === 'long';

  // green profit zone: between entry and TP2
  set('tp', { left: left + 'px', width: boxW + 'px', top: Math.min(yE, yTP) + 'px', height: Math.abs(yTP - yE) + 'px' });
  // red loss zone: between entry and SL
  set('sl', { left: left + 'px', width: boxW + 'px', top: Math.min(yE, ySL) + 'px', height: Math.abs(ySL - yE) + 'px' });
  // entry line
  set('entryLine', { left: left + 'px', width: boxW + 'px', top: yE + 'px' });

  const pct = (target) => ((target - p.entry) / p.entry * 100);
  const tpEl = set('tpTag', { left: (left + 5) + 'px', top: yTP + 'px' });
  tpEl.textContent = `TP ${fmtPrice(p.tp2)}  ${pct(p.tp2) >= 0 ? '+' : ''}${pct(p.tp2).toFixed(2)}%`;
  const eEl = set('entryTag', { left: (left + 5) + 'px', top: yE + 'px' });
  eEl.textContent = `${isLong ? 'LONG' : 'SHORT'} · ${fmtPrice(p.entry)}`;
  const slEl = set('slTag', { left: (left + 5) + 'px', top: ySL + 'px' });
  slEl.textContent = `SL ${fmtPrice(p.stop)}  ${pct(p.stop).toFixed(2)}%`;
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

  if (!state._fitted) { chart.timeScale().fitContent(); state._fitted = true; }
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

function renderLegend() {
  if (!state.ind) return;
  const L = state.ind.last;
  $('chartLegend').innerHTML = `
    <span style="color:#f7931a">EMA21 <b>${fmtPrice(L.ema21)}</b></span>
    <span style="color:#6366f1">EMA50 <b>${fmtPrice(L.ema50)}</b></span>
    <span style="color:#e2e8f0">EMA200 <b>${fmtPrice(L.ema200)}</b></span>`;
}

/* ---------------------- UI renderers ---------------------- */
function renderSignal() {
  const s = state.signal;
  const card = $('signalCard');
  const dir = $('signalDir');
  const fill = $('convictionFill');

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
    $('signalConviction').textContent = `${s.message} · ${s.profile}`;
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

  // log-trade button: enabled only when there is an actionable plan
  const logBtn = $('logTradeBtn');
  const key = s.plan ? `${state.tf}:${s.direction}:${Math.round(s.plan.entry)}` : null;
  if (s.plan) {
    logBtn.disabled = false;
    const already = key === state.lastLoggedKey;
    logBtn.classList.toggle('logged', already);
    logBtn.querySelector('span').textContent = already ? '✓ Trade registrado' : 'Registrar este trade en el diario';
  } else {
    logBtn.disabled = true;
    logBtn.classList.remove('logged');
    logBtn.querySelector('span').textContent = 'Registrar este trade en el diario';
  }
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

    renderChart();
    renderSignal();
    renderIndicators();
    renderPatterns();
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
    renderChartLive();
    renderSignal();
    renderIndicators();
    renderPatterns();
    maybeAlert(state.signal);
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
  $('toggleAuto').addEventListener('change', (e) => {
    state.autoRefresh = e.target.checked;
    setupAutoRefresh();
  });
  $('toggleAlerts').addEventListener('change', (e) => {
    setAlertsEnabled(e.target.checked);
    if (e.target.checked) { primeAudio(); requestNotifyPermission(); }
  });

  // log current signal as a trade
  $('logTradeBtn').addEventListener('click', () => {
    const s = state.signal;
    if (!s || !s.plan) return;
    addTrade(s, state.tf);
    state.lastLoggedKey = `${state.tf}:${s.direction}:${Math.round(s.plan.entry)}`;
    renderSignal();
    renderJournal();
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

  // prime audio + notifications on first interaction anywhere
  window.addEventListener('pointerdown', primeAudio, { once: true });
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
  bindControls();
  renderJournal();
  requestNotifyPermission();
  analyze();
  setupAutoRefresh();
  pollTicker();
  setInterval(pollTicker, 15000);

  // catch up instantly when the user comes back to the tab
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.autoRefresh) {
      if (!wsAlive) connectLiveStream();
      pollTicker();
    }
  });
}

document.addEventListener('DOMContentLoaded', boot);
