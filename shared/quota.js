export const DEFAULT_DAILY_LIMIT = 2;

export function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function clampDailyLimit(value, fallback = DEFAULT_DAILY_LIMIT) {
  const number = Number(value);
  if (number === 1 || number === 2) return number;
  return fallback === 1 ? 1 : 2;
}

export function normalizeAccountQuota(account = {}, defaultLimit = DEFAULT_DAILY_LIMIT) {
  const today = todayKey();
  const dailyLimit = clampDailyLimit(account.dailyLimit, defaultLimit);
  const sameDay = account.sentDate === today;
  const sentToday = sameDay ? Math.max(0, Number(account.sentToday) || 0) : 0;
  const remaining = Math.max(0, dailyLimit - sentToday);
  return {
    ...account,
    dailyLimit,
    sentToday,
    sentDate: today,
    remaining,
    quotaFull: remaining <= 0,
  };
}
