// Мост между расширением и диском: принимает переписки по протоколу native messaging
// и раскладывает их в папку, указанную при установке (install.bat).

const fs = require('node:fs');
const path = require('node:path');

const { encodeFrame, decodeFrames } = require('./frames.js');
const { handleCommand } = require('./store.js');
const { handleSessionSync } = require('./session-push.js');

const CONFIG_PATH = path.join(__dirname, 'bridge-config.json');
const LOG_PATH = path.join(__dirname, 'bridge.log');

let buffer = Buffer.alloc(0);
let pending = 0;
let inputClosed = false;

function log(line) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // Лог не должен ломать работу моста.
  }
}

function readDirs() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const targetDir = String(config?.targetDir || '').trim();
  if (!targetDir) {
    throw new Error('в bridge-config.json не указана папка переписок');
  }

  return { targetDir, projectsDir: String(config?.projectsDir || '').trim() };
}

function respond(payload) {
  process.stdout.write(encodeFrame(payload));
}

// Идентификатор запроса возвращается как есть: по нему расширение узнаёт свой
// ответ, когда ждёт данные от моста, а не просто отправляет команду.
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function exitWhenIdle() {
  if (inputClosed && pending === 0) process.exit(0);
}

// Передача входа в Kwork на сервер робота идёт по ssh и занимает секунды, поэтому отдельно
// от синхронных команд записи на диск; процесс не завершается, пока она не закончилась.
function processSessionSync(message) {
  const id = message?.id ?? null;
  pending += 1;
  handleSessionSync(message, { config: readConfig() })
    .then(
      (result) => respond({ ok: true, id, command: 'syncSession', ...result }),
      (error) => {
        const reason = error?.message || String(error);
        log(`вход на сервер не передан: ${reason}`);
        respond({ ok: false, id, command: 'syncSession', error: reason });
      },
    )
    .finally(() => {
      pending -= 1;
      exitWhenIdle();
    });
}

function processMessage(message) {
  const id = message?.id ?? null;
  if (message?.command === 'syncSession') {
    processSessionSync(message);
    return;
  }

  try {
    const result = handleCommand(readDirs(), message);
    respond({ ok: true, id, command: message?.command || null, ...result });
  } catch (error) {
    const reason = error?.message || String(error);
    log(`ошибка: ${reason}`);
    respond({ ok: false, id, command: message?.command || null, error: reason });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  const { messages, rest } = decodeFrames(buffer);
  buffer = rest;
  for (const message of messages) {
    processMessage(message);
  }
});

process.stdin.on('end', () => {
  inputClosed = true;
  exitWhenIdle();
});
process.on('uncaughtException', (error) => {
  log(`сбой: ${error?.stack || error}`);
  process.exit(1);
});
