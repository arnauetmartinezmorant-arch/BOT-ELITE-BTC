/* ============================================================
   format.js — builds the Telegram message for a signal.
   ============================================================ */

function fmt(v) {
  return v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MODE_EMOJI = { normal: '🟦', conservador: '🟩', premium: '⭐' };

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
