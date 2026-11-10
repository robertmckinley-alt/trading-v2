const TELEGRAM_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;
const TRADE_ALERT_TYPES = new Set(['trade-opened', 'trade-closed']);

function cleanValue(value, maxLength = 500) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function getTelegramConfig(env = process.env) {
  const botToken = cleanValue(env.TELEGRAM_BOT_TOKEN, 256);
  const chatId = cleanValue(env.TELEGRAM_CHAT_ID || env.TELEGRAM_CHANNEL_ID, 128);
  const messageThreadId = cleanValue(env.TELEGRAM_MESSAGE_THREAD_ID, 32);

  return {
    botToken,
    chatId,
    messageThreadId,
    enabled: Boolean(botToken),
    ready: Boolean(botToken && chatId),
    validTokenFormat: !botToken || TELEGRAM_TOKEN_PATTERN.test(botToken)
  };
}

function formatUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const absolute = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return `${amount < 0 ? '-' : ''}$${absolute}`;
}

function formatNumber(value, suffix = '') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;
}

function alertTitle(event) {
  const key = `${event.type || ''}:${event.status || ''}`;
  const titles = {
    'trade-opened:opened': 'DoctorTrades — paper trade opened',
    'trade-closed:closed': 'DoctorTrades — paper trade closed'
  };
  return titles[key] || 'DoctorTrades — trading alert';
}

function formatTelegramAlert(event) {
  const feed = [cleanValue(event.provider), cleanValue(event.ticker)].filter(Boolean).join(' · ');
  const fields = [
    ['Strategy', cleanValue(event.strategy)],
    ['Symbol', cleanValue(event.symbol)],
    ['Side', cleanValue(event.side).toUpperCase()],
    ['Entry', formatNumber(event.entry)],
    ['Stop', formatNumber(event.stop)],
    ['Realized P&L', formatUsd(event.realizedPnlUsd)],
    ['Result', formatNumber(event.rMultiple, 'R')],
    ['Feed', feed],
    ['Details', cleanValue(event.message)],
    ['Time', cleanValue(event.at || new Date().toISOString())]
  ];

  const lines = [alertTitle(event)];
  for (const [label, value] of fields) {
    if (value !== null && value !== '') lines.push(`${label}: ${value}`);
  }
  return lines.join('\n').slice(0, 4000);
}

async function sendTelegramAlert(event, options = {}) {
  if (!TRADE_ALERT_TYPES.has(String(event?.type || ''))) {
    return { sent: false, reason: 'event-filtered' };
  }
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs || 5000);
  const config = getTelegramConfig(env);

  if (!config.enabled) return { sent: false, reason: 'not-configured' };
  if (!config.validTokenFormat) return { sent: false, reason: 'invalid-token' };
  if (!config.chatId) return { sent: false, reason: 'missing-chat-id' };
  if (typeof fetchImpl !== 'function') throw new Error('Telegram alert transport is unavailable.');

  const body = {
    chat_id: config.chatId,
    text: formatTelegramAlert(event)
  };
  if (/^\d+$/.test(config.messageThreadId)) {
    body.message_thread_id = Number(config.messageThreadId);
  }

  const response = await fetchImpl(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    }
  );
  const responseBody = await response.json().catch(() => null);
  if (!response.ok || responseBody?.ok !== true) {
    throw new Error(`Telegram Bot API rejected the alert (${response.status || 'unknown status'}).`);
  }

  return {
    sent: true,
    messageId: responseBody.result?.message_id || null
  };
}

module.exports = {
  formatTelegramAlert,
  getTelegramConfig,
  isTradeAlertEvent: (event) => TRADE_ALERT_TYPES.has(String(event?.type || '')),
  sendTelegramAlert
};
