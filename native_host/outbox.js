// Очередь уведомлений в Telegram. Сообщение клиента, итог агента или сбой побудки
// сначала ложатся файлом в data/outbox на маке, а уже потом пачкой уходят по ssh
// роботу kwork-hunter на сервер (он и пишет в Telegram). Нет сети — файлы ждут,
// ничего не теряется. На сервере повтор той же записи отсекается по её номеру.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { pushOverSsh } = require('./session-push.js');

const OUTBOX_DIR = 'outbox';
const REMOTE = Object.freeze({ sshHost: 'firstbyte', dir: '/srv/apps/kwork-hunter/data/outbox' });
const MAX_BATCH = 50;
const MAX_BACKOFF_MS = 15 * 60 * 1000;

function safeName(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, filePath);
}

// Положить запись в очередь. Номер записи стабилен: повтор того же события
// перезапишет тот же файл, а не добавит второе уведомление.
function enqueue(serviceDir, item) {
  if (!item?.id || !item?.kind) {
    throw new Error('уведомление без номера или вида');
  }

  const entry = { ...item, at: item.at || new Date().toISOString() };
  writeAtomic(path.join(serviceDir, OUTBOX_DIR, `${safeName(item.id)}.json`), entry);
  return entry;
}

function resolveRemote(config) {
  const remote = { ...REMOTE, ...(config?.outboxTarget || {}) };
  if (!/^[A-Za-z0-9._@-]+$/.test(remote.sshHost) || !/^\/[A-Za-z0-9._/-]+$/.test(remote.dir)) {
    throw new Error('недопустимый адрес очереди уведомлений');
  }

  return remote;
}

function createOutboxSender({ serviceDir, config, push = pushOverSsh, now = Date.now }) {
  const dir = path.join(serviceDir, OUTBOX_DIR);
  let failures = 0;
  let nextAt = 0;

  // Одна пачка — один файл на сервере и одно соединение ssh.
  async function flush() {
    if (now() < nextAt) {
      return { sent: 0, waiting: true };
    }

    let names;
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().slice(0, MAX_BATCH);
    } catch {
      return { sent: 0 };
    }

    const items = [];
    for (const name of names) {
      try {
        items.push({ name, item: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) });
      } catch {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }

    if (items.length === 0) {
      return { sent: 0 };
    }

    const remote = resolveRemote(config);
    const batchId = `${Date.now()}-${safeName(items.map(({ name }) => name).join(',')).slice(0, 12)}`;
    try {
      await push({ sshHost: remote.sshHost, path: `${remote.dir}/${batchId}.json`, ensureDir: true }, JSON.stringify(items.map(({ item }) => item)));
    } catch (error) {
      failures += 1;
      nextAt = now() + Math.min(2 ** (failures - 1) * 60 * 1000, MAX_BACKOFF_MS);
      throw error;
    }

    failures = 0;
    nextAt = 0;
    for (const { name } of items) {
      fs.rmSync(path.join(dir, name), { force: true });
    }

    return { sent: items.length };
  }

  return { flush };
}

module.exports = {
  OUTBOX_DIR,
  createOutboxSender,
  enqueue,
};
