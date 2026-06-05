/* ============================================================
   format.js — builds the Telegram message for a signal.
   ============================================================ */

function fmt(v) {
  return v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MODE_EMOJI = { conservador: '🟩', premium: '⭐' };

/** Returns an HTML-formatted Telegram message for a fired signal. */
export function formatSignal(mode, tf, s) {
  const dirTxt = s.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
  const p = s.plan;
  return [
    `${MODE_EMOJI[mode] || ''} <b>${dirTxt} · BTC/USDT · ${tf.toUpperCase()}</b>`,
    `Modo <b>${s.profile}</b> · Convicción <b>${s.conviction}%</b>` +
      (s.confirmations != null ? ` · ${s.confirmations}/9 indicadores` : ''),
    '',
    `🎯 Entrada: <code>${fmt(p.entry)}</code>`,
    `🛑 Stop Loss: <code>${fmt(p.stop)}</code>  (riesgo ${p.riskPct.toFixed(2)}%)`,
    `✅ TP1 (1:1): <code>${fmt(p.tp1)}</code>`,
    `🏁 TP2 (2:1): <code>${fmt(p.tp2)}</code>`,
    '',
    `${s.message}`,
    '',
    '<i>⚠️ No es asesoramiento financiero. Gestiona tu riesgo.</i>',
  ].join('\n');
}

/**
 * Message for a lifecycle event of an OPEN trade the bot is tracking.
 * ev.type: 'tp1' | 'tp2' | 'sl' | 'be'
 */
export function formatExit(mode, tf, trade, ev) {
  const dirTxt = trade.dir === 'long' ? 'LONG' : 'SHORT';
  const head = `${MODE_EMOJI[mode] || ''} <b>BTC/USDT · ${tf.toUpperCase()} · ${dirTxt}</b>`;
  const lines = [head, ''];

  if (ev.type === 'tp1') {
    lines.push(
      '🎯 <b>TP1 alcanzado (1:1)</b> · +1R',
      `Precio: <code>${fmt(ev.price)}</code>`,
      'Stop movido a <b>break-even</b> (entrada): operación sin riesgo. 🔒',
    );
  } else if (ev.type === 'tp2') {
    lines.push(
      '🏁 <b>TP2 alcanzado (2:1)</b> · +2R ✅',
      `Precio: <code>${fmt(ev.price)}</code>`,
      'Operación <b>CERRADA con beneficio</b>. 🎉',
    );
  } else if (ev.type === 'sl') {
    lines.push(
      '🛑 <b>Stop Loss alcanzado</b> · −1R',
      `Precio: <code>${fmt(ev.price)}</code>`,
      'Operación <b>CERRADA</b>. A por la siguiente. 💪',
    );
  } else if (ev.type === 'be') {
    lines.push(
      '⚖️ <b>Salida en break-even</b> · 0R',
      `Precio: <code>${fmt(ev.price)}</code>`,
      'El precio volvió a la entrada tras el TP1. Operación <b>CERRADA sin pérdidas</b>.',
    );
  }
  return lines.join('\n');
}

/**
 * Message when the live signal flips against an open trade (manual/auto
 * close): the confluence no longer supports the position.
 * newDir: 'long' | 'short' | 'none'
 */
export function formatReversal(mode, tf, trade, newDir) {
  const dirTxt = trade.dir === 'long' ? 'LONG' : 'SHORT';
  const newTxt = newDir === 'long' ? '🟢 LONG' : newDir === 'short' ? '🔴 SHORT' : '⏸ SIN TRADE';
  return [
    `${MODE_EMOJI[mode] || ''} <b>BTC/USDT · ${tf.toUpperCase()} · ${dirTxt}</b>`,
    '',
    '🔄 <b>Señal invalidada · cambio de dirección</b>',
    `La confluencia ya no respalda la operación ${dirTxt}. Nuevo estado: <b>${newTxt}</b>.`,
    'Cierre sugerido de la posición abierta.',
  ].join('\n');
}
