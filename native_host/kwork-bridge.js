// Мост между расширением и диском: принимает переписки по протоколу native messaging
// и раскладывает их в папку, указанную при установке (install.bat).

const fs = require('node:fs');
const path = require('node:path');

const { encodeFrame, decodeFrames } = require('./frames.js');
const { handleCommand } = require('./store.js');
const { createSyncWake } = require('./sync-wake.js');
const { createWaker } = require('./waker.js');
const { createClaudeRunner } = require('./claude-runner.js');

const CONFIG_PATH = path.join(__dirname, 'bridge-config.json');
const LOG_PATH = path.join(__dirname, 'bridge.log');

let buffer = Buffer.alloc(0);
let syncWake = null;
let waker = null;

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


// Заявки агентов слушает только мост постоянного порта фонового скрипта: он
// присылает subscribe. Одноразовый мост (разовая команда расширения) заявки не трогает,
// иначе забрал бы их и ответил мимо расширения.
const WAKE_TICK_MS = 1000;

function startSyncWake() {
  if (syncWake) {
    return;
  }

  syncWake = createSyncWake({
    serviceDir: path.join(readDirs().targetDir, 'data'),
    send: respond,
  });
  const timer = setInterval(() => {
    try {
      syncWake.tick();
    } catch (error) {
      log(`заявки агентов: ${error?.message || error}`);
    }
  }, WAKE_TICK_MS);
  // Таймер не держит мост: закрылся порт — процесс выходит, как раньше.
  timer.unref();

  const { targetDir } = readDirs();
  const config = readConfig();
  waker = createWaker({
    targetDir,
    kworkRoot: String(config.kworkRoot || '').trim() || path.dirname(targetDir),
    runner: createClaudeRunner({ log }),
    log,
  });
  setInterval(runWaker, WAKER_TICK_MS).unref();
}

const WAKER_TICK_MS = 2000;

function runWaker() {
  waker?.tick().catch((error) => log(`будильщик: ${error?.message || error}`));
}

function processMessage(message) {
  const id = message?.id ?? null;
  if (message?.command === 'subscribe') {
    try {
      startSyncWake();
    } catch (error) {
      log(`заявки агентов не слушаются: ${error?.message || error}`);
    }

    return;
  }

  if (message?.command === 'sync-done') {
    try {
      syncWake?.done(message);
      respond({ ok: true, id, command: 'sync-done' });
    } catch (error) {
      respond({ ok: false, id, command: 'sync-done', error: error?.message || String(error) });
    }

    return;
  }

  try {
    const result = handleCommand(readDirs(), message);
    respond({ ok: true, id, command: message?.command || null, ...result });
    // Новая переписка или событие заказа — будильщик смотрит сразу, не дожидаясь своего такта.
    if (message?.command === 'save-dialog' || (message?.command === 'save-order-events' && result?.saved)) {
      runWaker();
    }
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

process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (error) => {
  log(`сбой: ${error?.stack || error}`);
  process.exit(1);
});
