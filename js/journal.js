/* ============================================================
   journal.js — Trade journal with localStorage persistence
   Tracks signals you choose to log and computes performance in
   R-multiples (risk units). 2:1 winner = +2R, stop = -1R.
   ============================================================ */

const KEY = 'btcQuantJournal_v1';

/** Read all trades (newest first). */
export function getTrades() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function save(trades) {
  try { localStorage.setItem(KEY, JSON.stringify(trades)); } catch (e) { /* quota */ }
}

/** Log a new trade from a signal + its plan. Returns the trade. */
export function addTrade(signal, tf) {
  if (!signal || !signal.plan) return null;
  const trades = getTrades();
  const t = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    time: Date.now(),
    tf,
    dir: signal.direction,
    entry: signal.plan.entry,
    stop: signal.plan.stop,
    tp1: signal.plan.tp1,
    tp2: signal.plan.tp2,
    riskPct: signal.plan.riskPct,
    conviction: signal.conviction,
    status: 'open',     // open | win2 | win1 | loss | be
    r: null,
  };
  trades.unshift(t);
  save(trades);
  return t;
}

/** Set the outcome of a trade. outcome: 'win2'|'win1'|'loss'|'be'|'open' */
export function resolveTrade(id, outcome) {
  const rMap = { win2: 2, win1: 1, loss: -1, be: 0, open: null };
  const trades = getTrades();
  const t = trades.find((x) => x.id === id);
  if (!t) return;
  t.status = outcome;
  t.r = rMap[outcome];
  save(trades);
}

export function deleteTrade(id) {
  save(getTrades().filter((x) => x.id !== id));
}

export function clearAll() { save([]); }

/** Aggregate performance stats. */
export function getStats() {
  const trades = getTrades();
  const closed = trades.filter((t) => t.status !== 'open');
  const wins = closed.filter((t) => t.r > 0);
  const losses = closed.filter((t) => t.r < 0);
  const totalR = closed.reduce((s, t) => s + (t.r || 0), 0);
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  return {
    total: trades.length,
    open: trades.length - closed.length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    totalR,
    avgR: closed.length ? totalR / closed.length : 0,
  };
}

/**
 * Live unrealized R for an open trade given the current price.
 * R = (priceMove in trade direction) / initial risk.
 */
export function liveR(trade, price) {
  if (!price) return null;
  const risk = Math.abs(trade.entry - trade.stop) || 1e-9;
  const move = trade.dir === 'long' ? price - trade.entry : trade.entry - price;
  return move / risk;
}
