// Будильщик агентов. Живёт в мосте постоянного порта расширения и раз в пару
// секунд смотрит переписки, которые мост только что записал (data/wake-dirty).
// Последним писал клиент, и это ещё не разобрано — будит чат агента в T3 и
// кладёт уведомление в Telegram. Состояние выводится из переписки на диске,
// поэтому сбой T3, сети или самого моста побудку не теряет: она ждёт повтора.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../src/inbox-core.js');
const wakeCore = require('./wake-core.js');
const outbox = require('./outbox.js');
const { WAKE_DIRTY_DIR } = require('./store.js');

const STATE_FILE = 'wake-state.json';
const LOCK_FILE = 'wake.lock';
const ORDER_FILES = ['CLAUDE.md', 'AGENTS.md', 'ROADMAP.md', 'README.md', 'STATE.md'];
const ORDER_FILE_BYTES = 40 * 1024;
const INBOX_LINK = /kwork\.ru\/(?:new_)?inbox\/([A-Za-z0-9_.-]{2,40})/gi;
const ALERT_AFTER_ATTEMPTS = 3;
const DEFAULT_MODEL = Object.freeze({ instanceId: 'claudeAgent', model: 'claude-opus-5-5' });
const PROJECT_ROOT = path.resolve(__dirname, '..');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, filePath);
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// Будильщик один на мак: второй мост (второй профиль Chrome) ждёт, пока
// первый не закроется, иначе оба будили бы одни и те же чаты.
function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      process.once('exit', () => {
        try {
          if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) fs.rmSync(lockPath, { force: true });
        } catch {
          // Замок уже снят.
        }
      });
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const owner = Number(fs.readFileSync(lockPath, 'utf8').trim());
      if (owner === process.pid) {
        return true;
      }

      if (owner && isAlive(owner)) {
        return false;
      }

      fs.rmSync(lockPath, { force: true });
    }
  }

  return false;
}

function shortId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

function createWaker({ targetDir, kworkRoot, config, t3, push, log = () => {}, now = Date.now, onCollected = () => {} }) {
  const serviceDir = path.join(targetDir, 'data');
  const statePath = path.join(serviceDir, STATE_FILE);
  const dirtyDir = path.join(serviceDir, WAKE_DIRTY_DIR);
  const lockPath = path.join(serviceDir, LOCK_FILE);
  const rulesPath = path.join(kworkRoot, 'docs', 'побудка.md');
  const mapPath = path.join(kworkRoot, 'docs', 'заказы-клиенты.md');
  const chatScript = path.join(PROJECT_ROOT, 'scripts', 'kwork-chat.mjs');
  const sender = outbox.createOutboxSender({ serviceDir, config, ...(push ? { push } : {}) });
  let owner = false;
  let running = false;

  function readRecord(slug) {
    return readJson(path.join(targetDir, slug, core.DIALOG_DATA_NAME));
  }

  function loadState() {
    const state = readJson(statePath) || {};
    return { baselineDone: Boolean(state.baselineDone), handled: state.handled || {}, notified: state.notified || {}, pending: state.pending || {}, rootThreads: state.rootThreads || {} };
  }

  // Первый запуск ничего не будит: всё, что уже лежит на диске, считается
  // разобранным. Иначе включение побудки разбудило бы чаты по старой переписке.
  function baseline(state) {
    for (const slug of listDirs(targetDir)) {
      const last = readRecord(slug)?.messages?.at?.(-1);
      if (last?.id) {
        state.handled[slug] = String(last.id);
        state.notified[slug] = String(last.id);
      }
    }

    state.baselineDone = true;
  }

  function ordersForNick(slug) {
    const map = (() => {
      try {
        return wakeCore.parseOrderMap(fs.readFileSync(mapPath, 'utf8'));
      } catch {
        return {};
      }
    })();
    const orders = [];
    for (const [folder, done] of [[wakeCore.ACTIVE_DIR, false], [wakeCore.DONE_DIR, true]]) {
      const base = path.join(kworkRoot, folder);
      for (const name of listDirs(base)) {
        const dir = path.join(base, name);
        const nicks = new Set((map[name]?.nicks || []).map((nick) => core.buildDialogSlug(nick)));
        for (const file of ORDER_FILES) {
          try {
            const text = fs.readFileSync(path.join(dir, file), 'utf8').slice(0, ORDER_FILE_BYTES);
            for (const match of text.matchAll(INBOX_LINK)) nicks.add(core.buildDialogSlug(match[1]));
          } catch {
            // Файла нет — смотрим следующий.
          }
        }

        if (nicks.has(slug)) {
          orders.push({ name, dir, done, deploy: map[name]?.deploy ?? null });
        }
      }
    }

    return orders;
  }

  // Новый чат берёт модель и режим с последнего чата пользователя: так он
  // работает так же, как обычные чаты заказов.
  function threadDefaults(shell) {
    const latest = wakeCore.chooseThread((shell.threads || []).map((thread) => ({ ...thread, projectId: 'any' })), 'any', { includeSettled: true });
    return latest?.modelSelection?.model ? { modelSelection: latest.modelSelection } : { modelSelection: DEFAULT_MODEL };
  }

  const claimedDir = path.join(dirtyDir, '.claimed');

  // В Telegram — сообщения клиента, о которых ещё не сообщали. Тихая запись
  // (агент получил, пользователь в чате) в Telegram не идёт: робот на сервере
  // только отмечает сообщения доставленными и сам о них уже не напомнит.
  function notifyFresh(state, slug, record, pend, { quiet = false } = {}) {
    const notifiedIndex = pend.messages.findIndex((message) => String(message.id) === String(state.notified[slug]));
    const fresh = pend.messages.slice(notifiedIndex + 1);
    if (fresh.length > 0) {
      outbox.enqueue(serviceDir, {
        id: `client:${slug}:${pend.lastId}`,
        kind: 'client',
        ...(quiet ? { quiet: true } : {}),
        nick: record.key || slug,
        url: record.url || `https://kwork.ru/inbox/${slug}`,
        messages: fresh.map((message) => ({
          id: String(message.id),
          time: message.time,
          text: String(message.text || ''),
          files: Array.isArray(message.attachments) ? message.attachments.length : 0,
        })),
      });
      state.notified[slug] = pend.lastId;
    }
  }

  // Побудка привязана к последнему сообщению: пришло новое — это новая
  // побудка с новыми номерами команд, иначе T3 принял бы её за повтор старой.
  function trackPending(state, slug, pend) {
    const previous = state.pending[slug];
    state.pending[slug] = previous?.lastId === pend.lastId
      ? previous
      : { wakeId: shortId(`${slug}:${pend.lastId}`), lastId: pend.lastId, attempts: 0, nextAt: now() };
    return state.pending[slug];
  }

  // Отметки захватываются переносом в .claimed до чтения переписки: запись,
  // случившаяся после захвата, ставит новую отметку, и её увидит следующий
  // такт. Сравнивать содержимое не нужно — гонки «прочитал, а удалил чужое» нет.
  function claimDirty() {
    let names;
    try {
      names = fs.readdirSync(dirtyDir);
    } catch {
      return [];
    }

    fs.mkdirSync(claimedDir, { recursive: true });
    for (const name of names) {
      if (name.startsWith('.')) continue;
      try {
        fs.renameSync(path.join(dirtyDir, name), path.join(claimedDir, name));
      } catch {
        // Отметку уже забрали или её нет — следующий такт разберётся.
      }
    }

    // Захваченные прошлым запуском и не разобранные (мост упал) — тоже здесь.
    return fs.readdirSync(claimedDir);
  }

  function collectDirty(state) {
    const claimed = claimDirty();
    for (const slug of claimed) {
      const record = readRecord(slug);
      const pend = record ? wakeCore.findPendingWake(record, state.handled[slug]) : null;
      if (!pend) {
        // Ответили или писать некому — побудка по диалогу снята.
        delete state.pending[slug];
        continue;
      }

      // В Telegram сообщение уходит из побудки: там уже видно, работает ли
      // пользователь с агентом сам.
      trackPending(state, slug, pend);
    }

    return claimed;
  }

  async function wakeDue(state) {
    const due = Object.entries(state.pending).filter(([, item]) => item.nextAt <= now());
    if (due.length === 0) {
      return;
    }

    try {
      await t3.withT3(async (api) => {
        const shell = await api.shell();
        for (let [slug, item] of due) {
          // Перед побудкой — свежий взгляд: пользователь мог уже ответить.
          const record = readRecord(slug);
          const pend = record ? wakeCore.findPendingWake(record, state.handled[slug]) : null;
          if (!pend) {
            delete state.pending[slug];
            continue;
          }

          // Пока ждали T3, клиент мог дописать: тогда будится уже новый состав.
          item = trackPending(state, slug, pend);

          try {
            const route = wakeCore.planRoute({ orders: ordersForNick(slug), projects: shell.projects, threads: shell.threads, kworkRoot, rootThreadId: state.rootThreads[slug] });
            if (route.kind === 'none') {
              throw new Error('в T3 нет проекта Kwork');
            }

            // Пользователь в чате с агентом — сообщение только агенту; иначе
            // Telegram сразу, не дожидаясь T3.
            const quiet = await userIsWorking(api, route, shell.threads);
            if (!quiet) {
              notifyFresh(state, slug, record, pend);
            }

            const text = wakeCore.buildWakeText({
              wakeId: item.wakeId,
              nick: record.key || slug,
              record,
              messages: pend.messages,
              route,
              dialogDir: path.join(targetDir, slug),
              chatScript,
              rulesPath,
              quiet,
            });
            let threadId = route.threadId;
            if (route.kind === 'create') {
              const title = route.root ? `Kwork: ${record.key || slug}` : `${route.order.name}: сообщение клиента`;
              const create = t3.threadCreateCommand({ seed: item.wakeId, projectId: route.projectId, title, ...threadDefaults(shell) });
              // Чат клиента в корне Kwork запоминается до создания и сразу на
              // диск: следующая побудка этого клиента идёт туда же, пока
              // пользователь не уберёт его в settled, даже если мост упадёт.
              if (route.root) {
                state.rootThreads[slug] = create.threadId;
                writeAtomic(statePath, state);
              }

              await api.dispatch(create);
              threadId = create.threadId;
            }

            await api.dispatch(t3.messageCommand({ seed: item.wakeId, threadId, text }));
            state.handled[slug] = pend.lastId;
            // Агент получил — Telegram об этих сообщениях уже не нужен, и когда
            // пользователь отойдёт, они не придут задним числом.
            if (quiet) notifyFresh(state, slug, record, pend, { quiet: true });
            delete state.pending[slug];
            log(`побудка ${slug}: ${route.kind}${route.reason ? ` (${route.reason})` : ''}${quiet ? ', без Telegram' : ''}`);
          } catch (error) {
            // Агенту не дошло — Telegram страхует.
            notifyFresh(state, slug, record, pend);
            fail(state, slug, item, error);
          }
        }
      });
    } catch (error) {
      for (const [slug, item] of due) {
        if (state.pending[slug] !== item) continue;
        notifyPending(state, slug);
        fail(state, slug, item, error);
      }
    }
  }

  function notifyPending(state, slug) {
    const record = readRecord(slug);
    const pend = record ? wakeCore.findPendingWake(record, state.handled[slug]) : null;
    if (pend) notifyFresh(state, slug, record, pend);
  }

  // Не прочитали чат — считаем, что пользователя нет: лишний Telegram лучше
  // пропущенного сообщения.
  async function userIsWorking(api, route, threads) {
    if (route.kind !== 'thread' || !wakeCore.mayBeEngaged((threads || []).find((thread) => thread.id === route.threadId), now())) {
      return false;
    }

    try {
      const bounded = await api.thread(route.threadId);
      return wakeCore.isEngaged(bounded?.projection?.messages, now());
    } catch (error) {
      log(`чат ${route.threadId} не прочитан: ${error?.message || error}`);
      return false;
    }
  }

  function fail(state, slug, item, error) {
    item.attempts += 1;
    item.nextAt = now() + wakeCore.nextAttemptDelayMs(item.attempts);
    item.error = String(error?.message || error).slice(0, 200);
    log(`побудка ${slug} не удалась: ${item.error}`);
    if (item.attempts === ALERT_AFTER_ATTEMPTS) {
      outbox.enqueue(serviceDir, {
        id: `alert:${slug}:${item.lastId}`,
        kind: 'alert',
        text: `Не удалось разбудить агента по сообщению ${slug}: ${item.error}. Продолжаю пробовать.`,
      });
    }
  }

  async function tick() {
    if (running) {
      return;
    }

    running = true;
    try {
      if (!owner) {
        owner = acquireLock(lockPath);
        if (!owner) return;
      }

      const state = loadState();
      if (!state.baselineDone) {
        baseline(state);
        writeAtomic(statePath, state);
        fs.rmSync(dirtyDir, { recursive: true, force: true });
        return;
      }

      const dirty = collectDirty(state);
      onCollected();
      writeAtomic(statePath, state);
      // Захваченные отметки снимаются только после записи состояния: упади
      // мост раньше — диалог просто проверится ещё раз.
      for (const slug of dirty) fs.rmSync(path.join(claimedDir, slug), { force: true });

      await wakeDue(state);
      writeAtomic(statePath, state);
      await sender.flush().catch((error) => log(`Telegram: ${error?.message || error}`));
    } finally {
      running = false;
    }
  }

  return { tick };
}

module.exports = {
  createWaker,
};
