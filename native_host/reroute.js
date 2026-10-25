// Пересылка побудки в другой заказ клиента. У клиента несколько заказов, и побудка ушла в чат
// того, где работали последним; агент видит, что сообщение про другой заказ, и оставляет заявку
// с номером побудки (scripts/kwork-reroute.mjs). Будильщик (waker.js) возвращает отметки
// разобранного на те, что были до неё, и будит чат названного заказа теми же сообщениями.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REROUTE_DIR = 'reroute-requests';
// Имя папки диалога и заказа: без разделителей пути и переводов строки; номер побудки — из её текста.
const NAME = /^(?!\.\.?$)[^/\\\r\n]{1,100}$/;
const WAKE_ID = /^\w{1,40}$/;

// Одна заявка на побудку: новая заменяет прежнюю.
function writeRequest(serviceDir, { slug, wakeId, order, at }) {
  const name = crypto.createHash('sha256').update(`${slug}:${wakeId}`).digest('hex').slice(0, 16);
  const filePath = path.join(serviceDir, REROUTE_DIR, `${name}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ slug: String(slug), wakeId: String(wakeId), order: String(order), at }));
  fs.renameSync(temp, filePath);
  return filePath;
}

function listRequests(serviceDir) {
  const dir = path.join(serviceDir, REROUTE_DIR);
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
      if (NAME.test(request?.slug) && WAKE_ID.test(request?.wakeId) && NAME.test(request?.order) && Number.isFinite(request.at)) {
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
  NAME,
  REROUTE_DIR,
  WAKE_ID,
  listRequests,
  writeRequest,
};
