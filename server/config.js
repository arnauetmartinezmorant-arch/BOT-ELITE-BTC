/* ============================================================
   config.js — Telegram bot configuration from environment vars.
   Copy server/.env.example and set the variables before running.
   ============================================================ */

export const CONFIG = {
  // Telegram bot token from @BotFather
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',

  // One channel/chat per risk mode (each mode posts to its own channel)
  channels: {
    normal: process.env.TELEGRAM_CHAT_NORMAL || '',
    conservador: process.env.TELEGRAM_CHAT_CONSERVADOR || '',
    premium: process.env.TELEGRAM_CHAT_PREMIUM || '',
  },

  // Timeframes to watch (comma separated). Each is analysed every cycle.
  timeframes: (process.env.TIMEFRAMES || '15m,1h,4h')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // How often to scan the market (seconds). Min 20s to respect rate limits.
  intervalSec: Math.max(20, Number(process.env.CHECK_INTERVAL_SEC || 60)),

  // Don't re-send the same direction for the same mode+tf within this window.
  cooldownMs: Math.max(1, Number(process.env.COOLDOWN_MIN || 30)) * 60000,

  // When true, prints messages to the console instead of calling Telegram.
  dryRun: process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true',
};
