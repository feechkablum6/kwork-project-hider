// Отметка «ждём клиента»: агент оставляет заявку (scripts/kwork-snooze.mjs), будильщик
// переносит её в своё состояние (snoozed по ключу маршрута), а ответ клиента снимает
// отметку и будит агента. У Claude Desktop нет «отложить чат» снаружи, поэтому отметка
// живёт только в состоянии будильщика (waker.js).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SNOOZE_DIR = 'snooze-requests';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// Ответ по работе — до суток, оплата и приёмка — до трёх: дольше отметка не держится.
const MAX_SNOOZE_MS = 72 * HOUR;
const MIN_SNOOZE_MS = MINUTE;
const UNITS = { m: MINUTE, h: HOUR, d: 24 * HOUR };

// «24h», «3d», «90m» или точное время ISO → момент в мс; вне рамок — null.
function parseSnoozeUntil(value, now) {
  const text = String(value || '').trim();
  const relative = /^(\d{1,4})\s*([mhd])$/i.exec(text);
  const until = relative
    ? now + Number(relative[1]) * UNITS[relative[2].toLowerCase()]
    : /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : NaN;
  if (!Number.isFinite(until) || until - now < MIN_SNOOZE_MS || until - now > MAX_SNOOZE_MS) {
    return null;
  }

  return until;
}

function requestPath(serviceDir, key) {
  const name = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
  return path.join(serviceDir, SNOOZE_DIR, `${name}.json`);
}

// Одна заявка на маршрут: новая заменяет прежнюю.
function writeRequest(serviceDir, { key, until, at }) {
  const filePath = requestPath(serviceDir, key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ key: String(key), until, at }));
  fs.renameSync(temp, filePath);
  return filePath;
}

function listRequests(serviceDir) {
  const dir = path.join(serviceDir, SNOOZE_DIR);
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }

  const requests = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const request = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (request?.key && Number.isFinite(request.until) && Number.isFinite(request.at)) {
        requests.push({ ...request, filePath });
        continue;
      }
    } catch {
      // Битая заявка — выбрасывается ниже.
    }

    fs.rmSync(filePath, { force: true });
  }

  return requests;
}

module.exports = {
  MAX_SNOOZE_MS,
  SNOOZE_DIR,
  listRequests,
  parseSnoozeUntil,
  writeRequest,
};
