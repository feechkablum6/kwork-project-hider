(function initKworkPayoutCore(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.KworkPayoutCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPayoutCore() {
  const NBSP = '\u00A0';
  const MOSCOW_TZ = 'Europe/Moscow';
  const MONTHS = {
    января: 0,
    февраля: 1,
    марта: 2,
    апреля: 3,
    мая: 4,
    июня: 5,
    июля: 6,
    августа: 7,
    сентября: 8,
    октября: 9,
    ноября: 10,
    декабря: 11,
  };

  function parseAmount(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value
      .replace(/[−–—]/g, '-')
      .replace(/\s+/g, '')
      .replace(/₽/g, '')
      .replace(/руб\.?/gi, '')
      .replace(',', '.');

    if (!normalized || !/^-?\d+(\.\d+)?$/.test(normalized)) {
      return null;
    }

    const amount = Number(normalized);
    return Number.isFinite(amount) ? amount : null;
  }

  function collectPendingWithdrawals(operations) {
    if (!Array.isArray(operations)) {
      return [];
    }

    const pending = [];

    for (const operation of operations) {
      if (!operation || operation.type !== 'withdraw') {
        continue;
      }

      const status = operation.operation_status ?? operation.wd_status;
      if (status !== 'new') {
        continue;
      }

      const rawAmount = operation.operationAmount ?? operation.price;
      const parsed = parseAmount(rawAmount);
      if (parsed === null) {
        continue;
      }

      const amount = Math.abs(parsed);
      if (!Number.isFinite(amount) || amount === 0) {
        continue;
      }

      pending.push({
        amount,
        createdAt: typeof operation.time === 'string' ? operation.time : '',
        payoutDateText: typeof operation.getDateWithdrawByDate === 'string'
          ? operation.getDateWithdrawByDate
          : null,
      });
    }

    return pending;
  }

  function sumWithdrawals(list) {
    if (!Array.isArray(list)) {
      return 0;
    }

    return list.reduce((total, item) => total + (Number(item?.amount) || 0), 0);
  }

  function formatMoney(amount) {
    const rubles = Math.floor(Math.abs(Number(amount) || 0));
    const grouped = String(rubles).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
    return `${grouped} ₽`;
  }

  function moscowParts(date) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: MOSCOW_TZ,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    const parts = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== 'literal') {
        parts[part.type] = Number(part.value);
      }
    }
    return parts;
  }

  function moscowDayNumber(date) {
    const parts = moscowParts(date);
    return Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000;
  }

  function parsePayoutDate(text, now) {
    if (typeof text !== 'string' || !text.trim()) {
      return null;
    }

    const match = text.toLowerCase().match(
      /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:.*?(\d{1,2}):(\d{2}))?/,
    );
    if (!match) {
      return null;
    }

    const day = Number(match[1]);
    const month = MONTHS[match[2]];
    const hour = match[3] === undefined ? 23 : Number(match[3]);
    const minute = match[4] === undefined ? 0 : Number(match[4]);
    if (!Number.isInteger(day) || day < 1 || day > 31 || month === undefined) {
      return null;
    }

    const reference = now instanceof Date ? now : new Date();
    const nowParts = moscowParts(reference);
    const nowTime = reference.getTime();

    function build(candidateYear) {
      return new Date(Date.UTC(candidateYear, month, day, hour - 3, minute));
    }

    let best = null;
    let bestDistance = Infinity;
    for (const candidateYear of [nowParts.year - 1, nowParts.year, nowParts.year + 1]) {
      const date = build(candidateYear);
      if (Number.isNaN(date.getTime())) {
        continue;
      }

      const distance = Math.abs(date.getTime() - nowTime);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = date;
      }
    }

    return best;
  }

  function pluralize(count, one, few, many) {
    const abs = Math.abs(count) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) {
      return many;
    }
    if (last === 1) {
      return one;
    }
    if (last >= 2 && last <= 4) {
      return few;
    }
    return many;
  }

  function describeDelay(payoutDate, now) {
    if (!(payoutDate instanceof Date) || Number.isNaN(payoutDate.getTime())) {
      return null;
    }

    const reference = now instanceof Date ? now : new Date();
    if (payoutDate.getTime() < reference.getTime()) {
      return null;
    }

    const days = moscowDayNumber(payoutDate) - moscowDayNumber(reference);
    if (days < 0) {
      return null;
    }
    if (days === 0) {
      return 'сегодня';
    }
    if (days === 1) {
      return 'завтра';
    }

    return `через ${days} ${pluralize(days, 'день', 'дня', 'дней')}`;
  }

  function capitalizeFirst(text) {
    if (!text) {
      return text;
    }
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function buildPayoutState(operations, now) {
    const pending = collectPendingWithdrawals(operations);
    const total = sumWithdrawals(pending);
    if (pending.length === 0 || total === 0) {
      return null;
    }

    const amountText = formatMoney(total);
    const payoutDateText = pending.find((item) => item.payoutDateText)?.payoutDateText ?? null;
    const parsedDate = parsePayoutDate(payoutDateText, now);
    const delayText = parsedDate ? describeDelay(parsedDate, now) : null;
    const label = delayText ? `${amountText} · ${delayText}` : amountText;

    const count = pending.length;
    const tooltipLines = [
      `Заявок на вывод: ${count}`,
    ];
    if (payoutDateText) {
      tooltipLines.push(capitalizeFirst(payoutDateText));
    }
    for (const item of pending) {
      const when = item.createdAt || 'без даты';
      tooltipLines.push(`${when} — ${formatMoney(item.amount)}`);
    }

    return {
      total,
      amountText,
      delayText,
      payoutDateText,
      count,
      label,
      tooltip: tooltipLines.join('\n'),
    };
  }

  return {
    collectPendingWithdrawals,
    sumWithdrawals,
    formatMoney,
    parsePayoutDate,
    describeDelay,
    buildPayoutState,
  };
});
