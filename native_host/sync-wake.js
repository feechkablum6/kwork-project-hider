// Выгрузка переписки по запросу агента. Хук сводки кладёт заявку файлом в
// data/sync-requests, мост передаёт её расширению по открытому порту, а ответ
// расширения кладёт в data/sync-done/<номер>.json — хук ждёт именно его.

const fs = require('node:fs');
const path = require('node:path');

const REQUESTS_DIR = 'sync-requests';
const DONE_DIR = 'sync-done';
// Хук ждёт ответа секунды; заявку старше двух минут уже никто не ждёт.
const REQUEST_TTL_MS = 2 * 60 * 1000;
// Заявка без ответа уходит расширению снова: расширение могло перезапуститься.
const RESEND_MS = 20 * 1000;
const DONE_TTL_MS = 5 * 60 * 1000;
const CLEAN_EVERY_MS = 60 * 1000;

function safeId(value) {
  const id = String(value || '');
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

function readJsonFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const files = [];
  for (const name of names) {
    // Хук пишет через временный файл и rename: недописанные не читаются.
    if (!name.endsWith('.json')) {
      continue;
    }

    const filePath = path.join(dir, name);
    try {
      files.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs, data: JSON.parse(fs.readFileSync(filePath, 'utf8')) });
    } catch {
      files.push({ filePath, mtimeMs: 0, data: null });
    }
  }

  return files;
}

function remove(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Файл мог удалить хук; это не ошибка.
  }
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function nicksOf(data) {
  return (Array.isArray(data?.nicks) ? data.nicks : [])
    .map((nick) => String(nick || '').trim().toLowerCase())
    .filter(Boolean);
}

function createSyncWake({ serviceDir, send, now = Date.now }) {
  const requestsDir = path.join(serviceDir, REQUESTS_DIR);
  const doneDir = path.join(serviceDir, DONE_DIR);
  const sent = new Map();
  let lastClean = 0;

  function sendRequests(time) {
    const ids = [];
    const nicks = new Set();
    for (const { filePath, mtimeMs, data } of readJsonFiles(requestsDir)) {
      const id = safeId(data?.id);
      const at = Date.parse(data?.at) || mtimeMs;
      if (!id || !(time - at <= REQUEST_TTL_MS)) {
        remove(filePath);
        if (id) sent.delete(id);
        continue;
      }

      if (sent.has(id) && time - sent.get(id) < RESEND_MS) {
        continue;
      }

      sent.set(id, time);
      ids.push(id);
      nicksOf(data).forEach((nick) => nicks.add(nick));
    }

    if (ids.length > 0) {
      send({ push: 'sync', requestIds: ids, nicks: [...nicks] });
    }
  }

  function cleanDone(time) {
    for (const { filePath, mtimeMs } of readJsonFiles(doneDir)) {
      if (time - mtimeMs > DONE_TTL_MS) {
        remove(filePath);
      }
    }
  }

  function tick() {
    const time = now();
    sendRequests(time);
    if (time - lastClean >= CLEAN_EVERY_MS) {
      lastClean = time;
      cleanDone(time);
    }
  }

  // Ответ пишется до удаления заявки: хук, увидев его, заявку уже не ждёт.
  function done(message) {
    const at = new Date(now()).toISOString();
    for (const value of Array.isArray(message?.requestIds) ? message.requestIds : []) {
      const id = safeId(value);
      if (!id) {
        continue;
      }

      writeAtomic(path.join(doneDir, `${id}.json`), { id, ok: message.ok !== false, error: message.error || null, at });
      remove(path.join(requestsDir, `${id}.json`));
      sent.delete(id);
    }
  }

  return { tick, done };
}

module.exports = {
  DONE_DIR,
  REQUESTS_DIR,
  RESEND_MS,
  createSyncWake,
};
