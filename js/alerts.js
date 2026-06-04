/* ============================================================
   alerts.js — Sound + browser notifications for new signals
   Sound is synthesized with the Web Audio API (no asset files).
   ============================================================ */

let audioCtx = null;
let enabled = true;

export function setAlertsEnabled(v) { enabled = v; }
export function alertsEnabled() { return enabled; }

/** Lazily create the AudioContext (must be after a user gesture). */
function ctx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  return audioCtx;
}

/** Unlock audio on first user interaction (autoplay policies). */
export function primeAudio() {
  const c = ctx();
  if (c && c.state === 'suspended') c.resume();
}

/** Play a short multi-tone chime. dir: 'long' | 'short'. */
export function playAlertSound(dir = 'long') {
  if (!enabled) return;
  const c = ctx();
  if (!c) return;
  if (c.state === 'suspended') c.resume();

  // ascending notes for long (bullish), descending for short (bearish)
  const notes = dir === 'long' ? [523.25, 659.25, 783.99] : [783.99, 659.25, 523.25];
  const now = c.currentTime;
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = now + i * 0.13;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.24);
  });
}

/** Ask for notification permission (call from a user gesture). */
export function requestNotifyPermission() {
  if (!('Notification' in window)) return Promise.resolve('unsupported');
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Promise.resolve(Notification.permission);
  }
  return Notification.requestPermission();
}

/** Fire a browser notification for a signal. */
export function notifySignal(signal, tf) {
  if (!enabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const dir = signal.direction === 'long' ? 'LONG ▲' : 'SHORT ▼';
  const p = signal.plan;
  const body = p
    ? `Entrada ${fmt(p.entry)} · SL ${fmt(p.stop)} · TP2 ${fmt(p.tp2)} · Convicción ${signal.conviction}%`
    : signal.message;
  try {
    const n = new Notification(`Señal BTC ${dir} (${tf.toUpperCase()})`, {
      body,
      tag: 'btc-quant-signal',
      requireInteraction: false,
    });
    setTimeout(() => n.close(), 9000);
  } catch (e) { /* ignore */ }
}

function fmt(v) {
  return v == null ? '—' : '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
