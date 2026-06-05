/* ============================================================
   news.js — Market news layer
   Fetches market-moving crypto + macro headlines (client-side, no
   API key needed) and classifies each one as bullish / bearish /
   neutral with an "impact" flag, so the terminal can surface the
   news that tends to move BTC. Falls back across sources and finally
   to a synthetic feed so the panel always works offline.

   IMPORTANT: this module is purely informational. It does NOT feed
   the signal engine (same "thinking" as before) — it only adds
   context next to the chart.
   ============================================================ */

/* ---------------------- classification dictionaries ---------------------- */
const BULLISH = [
  'surge', 'soar', 'rally', 'bullish', 'breakout', 'break out', 'adopt', 'approval',
  'approve', 'inflow', 'record high', 'all-time high', 'all time high', 'ath', 'buy',
  'accumulat', 'partnership', 'upgrade', 'institutional', 'long', 'pump', 'gain',
  'rebound', 'recover', 'optimis', 'bull run', 'green', 'soars', 'jumps', 'spike',
  'rise', 'rises', 'climbs', 'tops', 'demand', 'reserve', 'treasury buys',
];
const BEARISH = [
  'crash', 'plunge', 'dump', 'bearish', 'selloff', 'sell-off', 'hack', 'exploit',
  'lawsuit', 'ban', 'crackdown', 'liquidat', 'outflow', 'fud', 'fear', 'drop',
  'fall', 'falls', 'decline', 'warning', 'downgrade', 'short', 'collapse', 'bankrupt',
  'default', 'slump', 'tumble', 'sinks', 'sells', 'red', 'fraud', 'scam', 'seize',
  'hacked', 'breach', 'sue', 'charges', 'probe', 'investigation',
];
// Words that tend to produce big, fast moves regardless of direction.
const HIGH_IMPACT = [
  'sec', 'etf', 'fed', 'federal reserve', 'interest rate', 'rate cut', 'rate hike',
  'cpi', 'inflation', 'fomc', 'powell', 'regulation', 'regulatory', 'lawsuit', 'hack',
  'exploit', 'halving', 'blackrock', 'microstrategy', 'strategy ', 'tether', 'usdt',
  'binance', 'coinbase', 'liquidation', 'whale', 'treasury', 'spot etf', 'unemployment',
  'jobs report', 'gdp', 'recession', 'default', 'ceasefire', 'war', 'tariff', 'trump',
];

/* ---------------------- net helpers ---------------------- */
async function fetchWithTimeout(url, ms = 8000, type = 'json') {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: '*/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return type === 'text' ? await res.text() : await res.json();
  } finally {
    clearTimeout(id);
  }
}

/* ---------------------- classification ---------------------- */
function classify(title, body) {
  const text = `${title} ${body || ''}`.toLowerCase();
  let bull = 0, bear = 0;
  for (const w of BULLISH) if (text.includes(w)) bull++;
  for (const w of BEARISH) if (text.includes(w)) bear++;
  let impact = 'normal';
  for (const w of HIGH_IMPACT) { if (text.includes(w)) { impact = 'high'; break; } }

  let sentiment = 'neutral';
  if (bull > bear) sentiment = 'bull';
  else if (bear > bull) sentiment = 'bear';
  const score = bull - bear;            // signed magnitude of the lean
  return { sentiment, impact, score, bull, bear };
}

function normalize(raw) {
  const title = (raw.title || '').trim();
  if (!title) return null;
  const cls = classify(title, raw.body);
  return {
    id: String(raw.id || raw.url || title),
    title,
    url: raw.url || '#',
    source: raw.source || 'Cripto',
    time: raw.time || Date.now(),       // ms epoch
    body: (raw.body || '').slice(0, 220),
    sentiment: cls.sentiment,
    impact: cls.impact,
    score: cls.score,
  };
}

/* ---------------------- sources ---------------------- */
const NEWS_SOURCES = [
  {
    name: 'CryptoCompare',
    fetch: async () => {
      const j = await fetchWithTimeout(
        'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest', 8000);
      const data = (j && (j.Data || j.data)) || [];
      return data.map((n) => normalize({
        id: n.id || n.guid,
        title: n.title,
        url: n.url || n.guid,
        source: (n.source_info && n.source_info.name) || n.source || 'CryptoCompare',
        time: (Number(n.published_on) || 0) * 1000,
        body: n.body,
      })).filter(Boolean);
    },
  },
  {
    // RSS fallback via a public CORS proxy. Aggregates major crypto media.
    name: 'RSS',
    fetch: async () => {
      const feeds = [
        ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
        ['Cointelegraph', 'https://cointelegraph.com/rss'],
        ['Bitcoin Magazine', 'https://bitcoinmagazine.com/feed'],
      ];
      const proxy = (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`;
      const all = [];
      await Promise.all(feeds.map(async ([name, url]) => {
        try {
          const xml = await fetchWithTimeout(proxy(url), 9000, 'text');
          parseRSS(xml, name).forEach((it) => all.push(it));
        } catch (e) { /* skip this feed */ }
      }));
      if (!all.length) throw new Error('RSS vacío');
      return all;
    },
  },
];

function parseRSS(xmlText, sourceName) {
  const out = [];
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const items = doc.querySelectorAll('item, entry');
    items.forEach((it) => {
      const get = (sel) => {
        const el = it.querySelector(sel);
        return el ? (el.textContent || '').trim() : '';
      };
      const title = get('title');
      let link = get('link');
      if (!link) { const l = it.querySelector('link'); if (l) link = l.getAttribute('href') || ''; }
      const dateStr = get('pubDate') || get('published') || get('updated');
      const t = dateStr ? Date.parse(dateStr) : Date.now();
      const body = get('description') || get('summary') || get('content');
      const item = normalize({
        title, url: link, source: sourceName,
        time: isNaN(t) ? Date.now() : t,
        body: body.replace(/<[^>]+>/g, ' '),   // strip any HTML
      });
      if (item) out.push(item);
    });
  } catch (e) { /* malformed feed */ }
  return out;
}

/* ---------------------- ranking + dedupe ---------------------- */
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.title.toLowerCase().slice(0, 70);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/**
 * Fetch the latest market news. Tries each source in order and returns
 * { items, source }. `items` is sorted newest-first.
 */
export async function fetchNews(limit = 40) {
  for (const src of NEWS_SOURCES) {
    try {
      const items = await src.fetch();
      if (items && items.length) {
        const clean = dedupe(items).sort((a, b) => b.time - a.time).slice(0, limit);
        if (clean.length) return { items: clean, source: src.name };
      }
    } catch (e) {
      console.warn(`[news] ${src.name} falló:`, e.message);
    }
  }
  return { items: syntheticNews(), source: 'Simulado' };
}

/**
 * Aggregate sentiment across the most recent headlines. Recent + high-impact
 * items weigh more. Returns { label, score, bull, bear, high }.
 */
export function aggregateSentiment(items, lookback = 18) {
  const recent = items.slice(0, lookback);
  let bull = 0, bear = 0, high = 0, weighted = 0;
  recent.forEach((it, idx) => {
    const recencyW = 1 - idx / (lookback * 1.4);          // newest weigh most
    const impactW = it.impact === 'high' ? 1.8 : 1;
    const w = Math.max(0.2, recencyW) * impactW;
    if (it.sentiment === 'bull') { bull++; weighted += w; }
    else if (it.sentiment === 'bear') { bear++; weighted -= w; }
    if (it.impact === 'high') high++;
  });
  let label = 'neutral';
  if (weighted > 0.8) label = 'bull';
  else if (weighted < -0.8) label = 'bear';
  return { label, score: Math.round(weighted * 10) / 10, bull, bear, high };
}

/* ---------------------- offline fallback ---------------------- */
/** Plausible demo headlines so the panel always shows something offline. */
function syntheticNews() {
  const now = Date.now();
  const mins = (m) => now - m * 60000;
  const seed = [
    { title: 'Los flujos del ETF de Bitcoin al contado se mantienen positivos por tercera semana', source: 'Demo', time: mins(3), body: 'Continúan las entradas institucionales según los proveedores de fondos.' },
    { title: 'La Reserva Federal mantiene los tipos de interés; el mercado descuenta posibles recortes', source: 'Demo', time: mins(11), body: 'Los activos de riesgo reaccionan al tono de la Fed sobre la inflación.' },
    { title: 'Una gran ballena acumula BTC tras la caída, según datos on-chain', source: 'Demo', time: mins(26), body: 'Las wallets de gran tamaño aumentan posiciones en medio de la volatilidad.' },
    { title: 'Un exchange reporta un incidente de seguridad; los fondos de usuarios estarían a salvo', source: 'Demo', time: mins(48), body: 'La plataforma investiga un posible exploit en un contrato.' },
    { title: 'Microestrategia anuncia una nueva compra de Bitcoin para su tesorería', source: 'Demo', time: mins(72), body: 'La empresa amplía su reserva corporativa de BTC.' },
    { title: 'El dato de inflación (CPI) llega por debajo de lo esperado y anima al mercado', source: 'Demo', time: mins(95), body: 'Las criptomonedas suben tras el informe macroeconómico.' },
  ];
  return seed.map(normalize).filter(Boolean);
}
