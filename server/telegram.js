/* ============================================================
   telegram.js — minimal Telegram Bot API sender (no deps).
   ============================================================ */

import { CONFIG } from './config.js';

/** Send an HTML message to a Telegram chat/channel id. */
export async function sendTelegram(chatId, text) {
  if (CONFIG.dryRun) {
    console.log(`\n──── [DRY_RUN] mensaje para ${chatId || '(sin canal)'} ────\n${text}\n`);
    return true;
  }
  if (!CONFIG.botToken) { console.warn('[telegram] Falta TELEGRAM_BOT_TOKEN'); return false; }
  if (!chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error('[telegram] error', res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('[telegram] fallo de red:', e.message);
    return false;
  }
}
