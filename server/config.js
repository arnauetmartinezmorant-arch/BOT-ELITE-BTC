/* ============================================================
   config.js — Telegram bot configuration from environment vars.
   Copy server/.env.example and set the variables before running.
   ============================================================ */

export const CONFIG = {
  // Telegram bot token from @BotFather
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',

  // One channel/chat per risk mode (each mode posts to its own channel)
  channels: {
    conservador: process.env.TELEGRAM_CHAT_CONSERVADOR || '',
    premium: process.env.TELEGRAM_CHAT_PREMIUM || '',
  },

  // Timeframes to watch (comma separated). Each is analysed every cycle.
  // 5m is the fastest sensible TF for the 5-min cron (faster confirmations).
  timeframes: (process.env.TIMEFRAMES || '5m,15m,1h,4h')
    .split(',').map((s) => s.trim()).filter(Boolean),

  // How often to scan the market (seconds). Min 20s to respect rate limits.
  intervalSec: Math.max(20, Number(process.env.CHECK_INTERVAL_SEC || 60)),

  // Don't re-send the same direction for the same mode+tf within this window.
  cooldownMs: Math.max(1, Number(process.env.COOLDOWN_MIN || 30)) * 60000,

  // "Estoy vivo" message so you know the bot is running even with no signals.
  //   HEARTBEAT_HOURS=0   → disabled
  //   HEARTBEAT_HOURS=24  → at most one heartbeat per 24h (default)
  //   HEARTBEAT_HOURS=-1  → every run (handy for the manual "Run workflow" test)
  heartbeatHours: process.env.HEARTBEAT_HOURS != null ? Number(process.env.HEARTBEAT_HOURS) : 24,

  // When true, prints messages to the console instead of calling Telegram.
  dryRun: process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true',
};
