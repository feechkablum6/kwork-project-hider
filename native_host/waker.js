// Будильщик агентов. Живёт в мосте постоянного порта расширения и раз в пару
// секунд смотрит переписки, которые мост только что записал (data/wake-dirty).
// Последним писал клиент, и это ещё не разобрано — побудка уходит в чат заказа
// Claude Desktop: открытому чату — сразу в его сокет, спящему или архивному — через
// чат-диспетчер (dispatcher/CLAUDE.md: он передаёт её средствами самого Desktop, окно
// не переключается). Чата в Desktop ещё нет — мост заводит пустой чат и показывает его в
// Desktop (агента в фоне не запускаем), побудка доходит туда. Дошло ли — по метке
// побудки в журнале чата; не дошло — повтор. Состояние выводится из переписки на
// диске, поэтому сбой доставки или самого моста побудку не теряет.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../src/inbox-core.js');
const replyCore = require('../src/reply-core.js');
const wakeCore = require('./wake-core.js');
const snooze = require('./snooze.js');
const reroute = require('./reroute.js');
const { WAKE_DIRTY_DIR } = require('./store.js');

const STATE_FILE = 'wake-state.json';
// Версия 2: будят и свои сообщения, и события заказов. Переход отмечает всё, что уже
// на диске, разобранным, иначе первая же проверка разбудила бы чаты по старому.
const STATE_VERSION = 2;
const DRAFTS_DIR = 'drafts';
const LOCK_FILE = 'wake.lock';
// Номер чата-диспетчера в Desktop: { localId: "local_…" }.
const DISPATCHER_FILE = 'dispatcher.json';
const DISPATCHER_SCHEDULE = '[Kwork-диспетчер] расписание';
const ORDER_FILES = ['CLAUDE.md', 'AGENTS.md', 'ROADMAP.md', 'README.md', 'STATE.md'];
const ORDER_FILE_BYTES = 40 * 1024;
const INBOX_LINK = /kwork\.ru\/(?:new_)?inbox\/([A-Za-z0-9_.-]{2,40})/gi;
const PROJECT_ROOT = path.resolve(__dirname, '..');
// Агент пересылает побудку в другой заказ клиента — только пока она свежая; помнятся последние доставки.
const REROUTE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DELIVERED_KEEP = 10;
// Ссылка resume ушла, а чата в списке Desktop нет — повторить через столько, не больше SHOW_LIMIT ссылок:
// каждая выводит окно Desktop вперёд.
const SHOW_RETRY_MS = 2 * 60 * 1000;
const SHOW_LIMIT = 3;
// Побудка ушла — метка в журнале чата ждётся столько: сокет пишет сразу, диспетчеру нужен ход
// модели и запуск спящего чата. Пока чат или диспетчер заняты работой, сообщение стоит в их очереди —
// срок считается от последнего раза, когда их видели занятыми.
const CONFIRM_RECHECK_MS = 2000;
const SOCKET_CONFIRM_MS = 20 * 1000;
const DISPATCH_CONFIRM_MS = 90 * 1000;
// Диспетчер без процесса будится ссылкой resume: она выводит окно Desktop вперёд и переключает его на
// диспетчера, а при занятых чатах Desktop процесс по ней не поднимает. Поэтому ссылка — только в первые
// DESKTOP_FRESH_MS после запуска Desktop (чатов ещё нет) или когда пользователь не трогает компьютер
// USER_AWAY_MS (закрытый Desktop она тогда и запустит), не чаще раза в DISPATCHER_LINK_MS. Проверка —
// раз в DISPATCHER_CHECK_MS.
const DISPATCHER_LINK_MS = 5 * 60 * 1000;
const DESKTOP_FRESH_MS = 2 * 60 * 1000;
const DISPATCHER_CHECK_MS = 10 * 1000;
const USER_AWAY_MS = 60 * 1000;
// Desktop держит предел живых чатов: при занятом пределе ссылка только показывает диспетчера, а процесс
// не поднимает (27.10.2026 побудка так ждала 34 минуты). Сообщение от чата Desktop поднимает его и
// сверх предела — побудка ждёт диспетчера, а ссылки не было или она не помогла за RELAY_AFTER_LINK_MS,
// и открытый чат Kwork получает просьбу послать диспетчеру команду расписания, не чаще DISPATCHER_LINK_MS
// и не больше RELAY_LIMIT раз, пока диспетчер без процесса: не помогло — в чатах заказов не шумим
// RELAY_RESET_MS, потом снова.
const RELAY_AFTER_LINK_MS = 60 * 1000;
const RELAY_LIMIT = 2;
const RELAY_RESET_MS = 60 * 60 * 1000;
// Диспетчеру — только строка со ссылкой на файл с текстом побудки: текст клиента до него не доходит
// (ни подсказок модели, ни искажений при переписывании). Файлы старше WAKE_TEXT_KEEP_MS удаляются.
const WAKE_TEXTS_DIR = 'wake-texts';
const WAKE_TEXT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// Разрыв между тактами больше этого — мак спал: ожидание метки сдвигается на время сна.
const SLEEP_GAP_MS = 30 * 1000;

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


function socketGone(error) {
  return error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED';
}

function createWaker({ targetDir, kworkRoot, runner, log = () => {}, now = Date.now, onCollected = () => {} }) {
  const serviceDir = path.join(targetDir, 'data');
  const statePath = path.join(serviceDir, STATE_FILE);
  const dirtyDir = path.join(serviceDir, WAKE_DIRTY_DIR);
  const lockPath = path.join(serviceDir, LOCK_FILE);
  const rulesPath = path.join(kworkRoot, 'docs', 'побудка.md');
  const mapPath = path.join(kworkRoot, 'docs', 'заказы-клиенты.md');
  const chatScript = path.join(PROJECT_ROOT, 'scripts', 'kwork-chat.mjs');
  const rerouteScript = path.join(PROJECT_ROOT, 'scripts', 'kwork-reroute.mjs');
  let owner = false;
  let running = false;
  let dispatcherCheckedAt = 0;
  let dispatcherOpenAt = 0;
  let cleanedAt = 0;
  let lastTickAt = 0;

  function readRecord(slug) {
    return readJson(path.join(targetDir, slug, core.DIALOG_DATA_NAME));
  }

  function loadState() {
    const state = readJson(statePath) || {};
    return {
      baselineDone: Boolean(state.baselineDone),
      version: Number(state.version) || 1,
      eventsSince: state.eventsSince || null,
      handled: state.handled || {},
      eventMarks: state.eventMarks || {},
      pending: state.pending || {},
      // Чат агента по ключу маршрута: { sessionId, dir, nick, startedAt, shownAt?, shows?, gaveUp?, notifiedAt? }.
      chats: state.chats || {},
      // Отметки «ждём клиента» по ключу маршрута: { until, at }.
      snoozed: state.snoozed || {},
      // Последний увиденный процесс диспетчера и время последней ссылки resume на него.
      dispatcher: state.dispatcher || {},
      // Доставленные побудки диалога с отметками до них: [{ wakeId, key, handled, events, at }] — для
      // пересылки в другой заказ клиента.
      delivered: state.delivered || {},
      // Папка заказа, куда агент переслал побудку диалога; снимается, когда она дошла.
      reroute: state.reroute || {},
    };
  }

  function marksFor(state, slug) {
    return { handled: state.handled[slug], events: state.eventMarks[slug], eventsSince: state.eventsSince };
  }

  function findNews(state, slug, record) {
    return record ? wakeCore.findWakeNews(record, marksFor(state, slug)) : null;
  }

  // Переход на версию 2: последнее сообщение каждого диалога и все события считаются
  // разобранными, кроме диалогов, где побудка по сообщению клиента ещё ждёт отправки.
  function upgrade(state) {
    for (const slug of listDirs(targetDir)) {
      const record = readRecord(slug);
      if (!record) continue;
      const last = wakeCore.lastNumbered(record);
      if (last && !state.pending[slug]) {
        state.handled[slug] = String(last.id);
      }

      state.eventMarks[slug] = wakeCore.currentEventMarks(record);
    }

    state.eventsSince = new Date(now()).toISOString();
    state.version = STATE_VERSION;
  }

  // Первый запуск ничего не будит: всё, что уже лежит на диске, считается
  // разобранным. Иначе включение побудки разбудило бы чаты по старой переписке.
  function baseline(state) {
    for (const slug of listDirs(targetDir)) {
      const record = readRecord(slug);
      // Старые копии сообщений без номера в хвосте не мешают: отметка — по последнему с номером.
      const last = wakeCore.lastNumbered(record);
      if (last) state.handled[slug] = String(last.id);
      if (record) state.eventMarks[slug] = wakeCore.currentEventMarks(record);
    }

    state.baselineDone = true;
    state.version = STATE_VERSION;
    state.eventsSince = new Date(now()).toISOString();
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

  const claimedDir = path.join(dirtyDir, '.claimed');

  // Свои сообщения против последнего черновика агента для этого клиента: так агент
  // знает, отправил пользователь его текст, поправил или написал своё.
  function draftVerdicts(slug, record, messages) {
    const draft = readJson(path.join(serviceDir, DRAFTS_DIR, `${slug}.json`));
    const parts = Array.isArray(draft?.parts) ? draft.parts.filter((part) => ['reply', 'quote', 'plain'].includes(part.mode)) : [];
    const since = (Date.parse(draft?.at) || 0) - 2 * 60 * 1000;
    const verdicts = {};
    if (parts.length === 0) return verdicts;
    for (const message of messages) {
      if (wakeCore.isClientMessage(message, record) || message.event || (Date.parse(message.time) || 0) < since) continue;
      let best = null;
      for (const part of parts) {
        const verdict = replyCore.compareSent(part.text, message.text);
        if (verdict === replyCore.SENT_EXACT || (verdict && !best)) best = { part, verdict };
        if (verdict === replyCore.SENT_EXACT) break;
      }

      verdicts[message.id] = best
        ? `часть ${best.part.n} черновика агента — ${best.verdict === replyCore.SENT_EXACT ? 'отправлена как есть' : 'отправлена с правками'}`
        : 'своё сообщение, не из черновика агента';
    }

    return verdicts;
  }

  // Побудка привязана к последнему сообщению: пришло новое — это новая побудка с новым
  // номером. Ушедшая и ещё не подтверждённая (sent) остаётся за ней: новая ждёт её метки,
  // чтобы агент не получил одни и те же сообщения дважды.
  // salt — у пересланной побудки те же сообщения, но номер другой: диспетчер не примет его за копию.
  function trackPending(state, slug, news, salt = '') {
    const previous = state.pending[slug];
    if (previous?.key === news.key) return previous;
    state.pending[slug] = {
      wakeId: shortId(`${slug}:${news.key}${salt}`),
      key: news.key,
      lastId: news.lastId,
      attempts: 0,
      nextAt: previous?.sent ? previous.nextAt : now(),
      ...(previous?.sent ? { sent: previous.sent } : {}),
    };
    return state.pending[slug];
  }

  // Разобрано: метки сдвигаются на то, что агент получил (или что пропущено).
  // delivery — { wakeId, key: ключ маршрута }, когда побудка дошла до агента (не пропущена): её отметки до сдвига
  // запоминаются, и агент может переслать её в другой заказ клиента.
  function settle(state, slug, news, delivery = null) {
    if (delivery) {
      const delivered = (state.delivered[slug] || []).filter((entry) => now() - entry.at < REROUTE_WINDOW_MS);
      delivered.push({ ...delivery, handled: state.handled[slug] ?? null, events: state.eventMarks[slug] ?? null, at: now() });
      state.delivered[slug] = delivered.slice(-DELIVERED_KEEP);
    }

    if (news.lastId) state.handled[slug] = news.lastId;
    state.eventMarks[slug] = news.marks;
    delete state.pending[slug];
    delete state.reroute[slug];
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
      const news = findNews(state, slug, record);
      if (!news) {
        // Нового нет — побудка по диалогу снята; старые события, увиденные впервые, запоминаются.
        delete state.pending[slug];
        delete state.reroute[slug];
        if (record) state.eventMarks[slug] = wakeCore.currentEventMarks(record);
        continue;
      }

      trackPending(state, slug, news);
    }

    return claimed;
  }

  function routeFor(slug, state) {
    return wakeCore.planRoute({
      orders: ordersForNick(slug),
      kworkRoot,
      slug,
      // Где работали последним — по самому свежему журналу в папке заказа, чаты пользователя тоже в счёт.
      workedAt: (order) => runner.lastActivity(order.dir),
      preferred: state.reroute[slug] || null,
    });
  }

  // Отметка «ждём клиента» снимается любым разобранным действием по маршруту.
  function release(state, key) {
    const had = Boolean(state.snoozed[key]);
    delete state.snoozed[key];
    return had ? ', отметка «ждём клиента» снята' : '';
  }

  // Диспетчер из data/dispatcher.json: { localId, sessionId, cwd } по метаданным Desktop или null.
  function dispatcherInfo(desktop = runner.desktopChats()) {
    const localId = readJson(path.join(serviceDir, DISPATCHER_FILE))?.localId;
    if (!localId) return null;
    for (const [sessionId, chat] of desktop) {
      if (chat.localId === localId) return { localId, sessionId, cwd: chat.cwd };
    }

    return null;
  }

  // Открытый диспетчер (адрес сокета) или null. Новый процесс диспетчера (Desktop его перезапустил)
  // сначала получает команду расписания: живое расписание не даёт Desktop его усыпить.
  async function openDispatcher(state, info) {
    const open = info.cwd ? runner.openChat(info.cwd, info.sessionId, false) : null;
    if (!open) return null;
    // Диспетчер жив — следующий его сон снова разрешает просьбы к чатам Kwork.
    delete state.dispatcher.relays;
    if (state.dispatcher.pid !== open.pid) {
      await runner.deliver(open, DISPATCHER_SCHEDULE);
      state.dispatcher.pid = open.pid;
      log(`диспетчер: процесс ${open.pid}, расписание отправлено`);
    }

    return open;
  }

  // Ссылка на спящего диспетчера: true — ушла.
  function linkDispatcher(state, info, reason) {
    if (now() - (state.dispatcher.linkAt || 0) < DISPATCHER_LINK_MS) return false;
    runner.openInDesktop(info.sessionId);
    state.dispatcher.linkAt = now();
    log(`диспетчер спит — будим ссылкой (${reason})`);
    return true;
  }

  // Просьба открытому чату Kwork поднять диспетчера: true — ушла. Чаты заказов клиента (avoid) не просим:
  // побудка этого клиента ждёт, а его же чату служебный ход ни к чему (сам обмен работой не считается —
  // lastRecordAt его пропускает).
  async function relayDispatcher(state, info, reason, avoid) {
    const { dispatcher } = state;
    if (now() - (dispatcher.relayAt || 0) < DISPATCHER_LINK_MS || now() - (dispatcher.linkAt || 0) < RELAY_AFTER_LINK_MS) return false;
    // Просьбы не помогли — через RELAY_RESET_MS пробуем снова: иначе побудки ждали бы перезапуска Desktop.
    if (now() - (dispatcher.relayAt || 0) >= RELAY_RESET_MS) delete dispatcher.relays;
    if ((dispatcher.relays || 0) >= RELAY_LIMIT) {
      if (dispatcher.relays === RELAY_LIMIT) log(`диспетчер не поднялся после ${RELAY_LIMIT} просьб к чатам Kwork — ждём (${reason})`);
      dispatcher.relays = RELAY_LIMIT + 1;
      return false;
    }

    const chat = runner.openChatUnder(kworkRoot, info.sessionId, avoid);
    if (!chat) return false;
    const before = { relayAt: dispatcher.relayAt, relays: dispatcher.relays };
    dispatcher.relayAt = now();
    dispatcher.relays = (dispatcher.relays || 0) + 1;
    const text = `[Kwork-служебное] Чат-диспетчер уснул, а Claude Desktop не даёт мосту его поднять. Вызови mcp__ccd_session_mgmt__send_message: session_id «${info.localId}», message «${DISPATCHER_SCHEDULE}». Больше ничего не делай; ответ — одна строка «диспетчер поднят» или текст ошибки дословно. Правило — ${rulesPath}, раздел «Служебное: поднять диспетчер».`;
    try {
      await runner.deliver(chat, text);
    } catch (error) {
      if (!socketGone(error)) throw error;
      // Чат закрылся между выбором и отправкой — на следующем такте пробуем другой.
      Object.assign(dispatcher, before);
      return false;
    }

    log(`диспетчер спит — просим поднять его чат ${chat.cwd} (${reason})`);
    return true;
  }

  // Диспетчер должен жить, пока запущен Desktop: Desktop только что запущен — диспетчер будится сразу,
  // пока чатов ещё нет; иначе — когда пользователь отошёл. Закрытый Desktop заранее не запускаем.
  async function keepDispatcher(state) {
    if (now() - dispatcherCheckedAt < DISPATCHER_CHECK_MS) return;
    dispatcherCheckedAt = now();
    const age = runner.desktopAgeMs();
    if (age === null) return;
    const started = age < DESKTOP_FRESH_MS;
    // Полная проверка (метаданные Desktop, реестр сессий) — раз в минуту или сразу после запуска Desktop.
    if (!started && now() - dispatcherOpenAt < 6 * DISPATCHER_CHECK_MS) return;
    dispatcherOpenAt = now();
    const info = dispatcherInfo();
    if (!info) return;
    const open = await openDispatcher(state, info).catch((error) => {
      if (socketGone(error)) return null;
      throw error;
    });
    if (!open && (started || runner.userIdleMs() >= USER_AWAY_MS)) linkDispatcher(state, info, started ? 'Desktop запущен' : 'вы отошли от компьютера');
  }

  // Строка для диспетчера: шапка побудки (её собирает мост, текста клиента в ней нет) и файл с полным текстом.
  // Номер запроса — номер побудки и попытка: повтор после сбоя диспетчер передаёт, как новый запрос, а
  // одинаковый номер (копия в его очереди) — нет.
  function dispatchText(item, target, text) {
    const dir = path.join(serviceDir, WAKE_TEXTS_DIR);
    const file = path.join(dir, `${item.wakeId}.md`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text);
    const line = `${text.split('\n')[0]} Полный текст побудки — в файле ${file}: прочитай его целиком и действуй по нему.`;
    return [`[Kwork-диспетчер #${item.wakeId}.${item.attempts + 1}]`, `чат: ${target.localId}`, `архив: ${target.archived ? 'да' : 'нет'}`, '----', line].join('\n');
  }

  function cleanWakeTexts() {
    if (now() - cleanedAt < 60 * 60 * 1000) return;
    cleanedAt = now();
    const dir = path.join(serviceDir, WAKE_TEXTS_DIR);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const name of names) {
      try {
        if (now() - fs.statSync(path.join(dir, name)).mtimeMs > WAKE_TEXT_KEEP_MS) fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        // Файл уже удалён.
      }
    }
  }

  // Отправить побудку и ждать её метку в журнале чата: принятый сокетом текст ещё не значит, что
  // чат его получил. Метки разобранного сдвигаются только по метке (checkSent).
  async function send(item, target, news, deliver) {
    const from = runner.transcript(target.dir, target.sessionId)?.size || 0;
    await deliver();
    item.sent = { ...target, wakeId: item.wakeId, at: now(), from, lastId: news.lastId, marks: news.marks };
    item.nextAt = now() + CONFIRM_RECHECK_MS;
  }

  function checkSent(state, slug, item) {
    const sent = item.sent;
    const file = runner.transcript(sent.dir, sent.sessionId);
    const waited = now() - sent.at;
    if (file && runner.received(file.file, sent.from, `${wakeCore.WAKE_MARK} #${sent.wakeId}]`)) {
      delete item.sent;
      const released = release(state, sent.routeKey);
      settle(state, slug, sent, { wakeId: sent.wakeId, key: sent.routeKey });
      // Пока шла доставка, клиент мог дописать: это следующая побудка.
      const news = findNews(state, slug, readRecord(slug));
      if (news) trackPending(state, slug, news);
      log(`побудка ${slug}: дошла за ${Math.round(waited / 1000)} с${released}`);
      return;
    }

    // Чат или диспетчер посреди хода (работает или ждёт ответа пользователя — `waiting`) — сообщение ждёт
    // в их очереди, это не сбой; срок — от последнего раза, когда их видели занятыми: очередь разбирается
    // уже после конца хода.
    const working = (chat) => Boolean(chat?.status) && chat.status !== 'idle';
    const busy = working(runner.openChat(sent.dir, sent.sessionId, false))
      || Boolean(sent.dispatcher && working(runner.openChat(sent.dispatcher.cwd, sent.dispatcher.sessionId, false)));
    if (busy) sent.busyAt = now();
    const limit = sent.via === 'socket' ? SOCKET_CONFIRM_MS : DISPATCH_CONFIRM_MS;
    if (busy || now() - Math.max(sent.at, sent.busyAt || 0) < limit) {
      item.nextAt = now() + CONFIRM_RECHECK_MS;
      return;
    }

    delete item.sent;
    // Сокет не довёл — повтор через диспетчера.
    if (sent.via === 'socket') item.avoidSocket = true;
    fail(state, slug, item, new Error(`метки нет в журнале чата за ${Math.round(waited / 1000)} с (${sent.via === 'socket' ? 'сокет' : 'диспетчер'})`));
  }

  async function wakeOne(state, slug, item, record, news) {
    if (item.sent) {
      checkSent(state, slug, item);
      return;
    }

    const route = routeFor(slug, state);
    const chat = state.chats[route.key];
    const nick = record.key || slug;
    const desktop = runner.desktopChats();

    // Чат заказа один: наш прошлый, а у заказа без него — самый свежий чат Desktop его папки, в том числе
    // чат пользователя, иначе чат Desktop с названием заказа в другой папке Kwork: заказ заводят и из чата
    // в корне Kwork, и пользователь работает в нём (29.10.2026). Корень Kwork общий для всех клиентов без
    // заказа и прочей работы — там только свой чат клиента. Чаты вне Desktop (T3, терминал) не берутся.
    let sessionId = chat?.sessionId || (route.order ? runner.latestChat(route.dir, (id) => desktop.has(id))?.sessionId : null) || null;
    let dir = chat?.dir || route.dir;
    const named = !sessionId && route.order ? namedChat(desktop, route.order.name) : null;
    if (named) [sessionId, dir] = named;
    const file = runner.transcript(dir, sessionId);

    // Своё сообщение или свои опции без чата клиента — новый чат ради них не заводится:
    // агенту, который ведёт клиента, нечего поправлять. Оплата или отказ клиента
    // в той же пачке — побудка как обычно.
    const clientActed = news.reason === 'client' || news.events.some((event) => event.actor !== 'me');
    if (!clientActed && !file) {
      settle(state, slug, news);
      log(`побудка ${slug}: своё действие, чата клиента нет — пропущено`);
      return;
    }

    const text = wakeCore.buildWakeText({
      wakeId: item.wakeId,
      nick,
      record,
      messages: news.messages,
      events: news.events,
      reason: news.reason,
      verdicts: draftVerdicts(slug, record, news.messages),
      route,
      dialogDir: path.join(targetDir, slug),
      chatScript,
      rerouteScript,
      rulesPath,
    });

    // Чат открыт в Desktop (этот или, в папке заказа, другой чат пользователя) — сообщение
    // приходит прямо в него, как от другой сессии Claude, за секунду.
    const open = item.avoidSocket ? null : runner.openChat(route.dir, sessionId, Boolean(route.order));
    if (open) {
      try {
        await send(item, { via: 'socket', sessionId: open.sessionId, dir: open.cwd, routeKey: route.key }, news, () => runner.deliver(open, text));
        state.chats[route.key] = { sessionId: open.sessionId, dir: open.cwd, nick, startedAt: now() };
        log(`побудка ${slug}: ${news.reason}, в чат, открытый в Desktop`);
        return;
      } catch (error) {
        // Сокет не довёл — дальше и в повторах через диспетчера; чат только что закрыли — сразу.
        item.avoidSocket = true;
        if (!socketGone(error)) throw error;
      }
    }

    // Чат держит чужой процесс (терминал): второй писатель в журнал — нет, побудка пропускается.
    if (sessionId && runner.holders(sessionId).length > 0) {
      const released = release(state, route.key);
      settle(state, slug, news);
      log(`побудка ${slug}: чат заказа занят процессом вне Desktop — пропущено${released}`);
      return;
    }

    // Чат есть в Desktop, но спит или в архиве — через диспетчера: Desktop сам поднимает чат (даже
    // сверх своего лимита живых чатов) и показывает сообщение в нём, окно не переключается.
    const target = sessionId ? desktop.get(sessionId) : null;
    if (target) {
      const info = dispatcherInfo(desktop);
      if (!info) throw new Error('чат-диспетчер не найден в Claude Desktop (data/dispatcher.json)');
      const dispatcher = await openDispatcher(state, info).catch((error) => {
        if (socketGone(error)) return null;
        throw error;
      });
      if (!dispatcher) {
        // Пользователь за компьютером — окно не трогаем. Отошёл — ссылка будит диспетчера, а закрытый
        // Desktop запускает: агент разберёт сообщение клиента, пока пользователя нет. Ссылки нет или она
        // не помогла — просим открытый чат Kwork; такого нет — побудка ждёт, пока пользователь отойдёт,
        // откроет чат «Kwork-диспетчер» или запустит Desktop (keepDispatcher).
        const linked = runner.userIdleMs() >= USER_AWAY_MS && linkDispatcher(state, info, `побудка ${slug}`);
        const relayed = !linked && await relayDispatcher(state, info, `побудка ${slug}`, route.orders.map((order) => order.dir));
        if (!linked && !relayed && !item.waitDispatcher) {
          log(`побудка ${slug}: ${runner.desktopAgeMs() === null ? 'Desktop закрыт' : 'диспетчер спит'}, вы за компьютером — ждём`);
        }

        item.waitDispatcher = true;
        item.nextAt = now() + CONFIRM_RECHECK_MS;
        return;
      }

      await send(item, { via: 'dispatcher', sessionId, dir, routeKey: route.key, dispatcher: { sessionId: info.sessionId, cwd: info.cwd } }, news, () => runner.deliver(dispatcher, dispatchText(item, target, text)));
      state.chats[route.key] = { sessionId, dir, nick, startedAt: now() };
      log(`побудка ${slug}: ${news.reason}, через диспетчера${target.archived ? ' (чат в архиве)' : ''}${route.reason ? ` (${route.reason})` : ''}`);
      return;
    }

    // Чата в Desktop нет. Создать его оттуда Desktop не даёт, а агента в фоне не запускаем (решение
    // пользователя 29.10.2026): мост заводит пустой чат, добавляет его в список Desktop, и побудка
    // доходит туда обычным путём на следующих тактах.
    if (!file) {
      const name = route.order?.name || nick;
      const id = runner.newSessionId();
      runner.seed({ dir: route.dir, sessionId: id, name, at: now(), text: `Чат клиента ${nick} на Kwork${route.order ? ` (заказ ${route.order.name})` : ''}. Сюда приходят побудки моста, правила — ${rulesPath}.` });
      state.chats[route.key] = { sessionId: id, dir: route.dir, nick, startedAt: now() };
      writeAtomic(statePath, state);
      log(`побудка ${slug}: ${news.reason}, новый чат «${name}»${route.reason ? ` (${route.reason})` : ''}`);
    }

    showChat(state, slug, state.chats[route.key]);
    item.nextAt = now() + CONFIRM_RECHECK_MS;
  }

  // Чат Desktop с названием заказа в папке Kwork: [номер CLI, папка] или null; не из архива — первым.
  function namedChat(desktop, name) {
    let root = kworkRoot;
    try {
      root = fs.realpathSync(kworkRoot);
    } catch {
      // Папки нет — сравниваем как есть.
    }

    const inside = (cwd) => [kworkRoot, root].some((base) => cwd === base || cwd.startsWith(`${base}/`));
    // Из одноимённых — самый свежий журнал.
    const fresh = ([id, item]) => runner.transcript(item.cwd, id)?.mtimeMs || 0;
    const found = [...desktop].filter(([, item]) => item.title === name && item.cwd && inside(item.cwd)).sort((left, right) => fresh(right) - fresh(left));
    const [id, item] = found.find(([, entry]) => !entry.archived) || found[0] || [];
    return id ? [id, item.cwd] : null;
  }

  // Показ чата в Desktop ссылкой resume: Desktop добавляет его в список и переключает окно на него. Пока
  // пользователь работает в Desktop, окно не трогаем — одно уведомление, по нажатию та же ссылка; ушёл из
  // Desktop или отошёл от компьютера — показ сам. Desktop не взял чат — повтор через SHOW_RETRY_MS, после
  // SHOW_LIMIT ссылок — только уведомление: побудка ждёт, пока пользователь откроет чат сам.
  function showChat(state, slug, chat) {
    if (now() - (chat.shownAt || 0) < SHOW_RETRY_MS) return;
    const notify = (why) => {
      if (chat.notifiedAt) return;
      chat.notifiedAt = now();
      runner.notify({ title: `Kwork: новый чат ${chat.nick}`, message: 'Клиент написал — нажмите, чтобы открыть чат в Claude', url: `claude://resume?session=${chat.sessionId}`, group: `kph-${chat.sessionId}` });
      log(`побудка ${slug}: ${why} — уведомление`);
    };
    if (runner.desktopInFront() && runner.userIdleMs() < USER_AWAY_MS) return notify('чат ещё не в Desktop, вы в нём');
    if ((chat.shows || 0) >= SHOW_LIMIT) {
      // Запись о лимите — одна и отдельно от уведомления: оно могло уйти раньше, пока пользователь был в Desktop.
      if (!chat.gaveUp) log(`побудка ${slug}: Desktop не взял чат ${chat.sessionId} после ${SHOW_LIMIT} ссылок — ждём, пока вы откроете его`);
      chat.gaveUp = true;
      return notify('чат не в Desktop');
    }
    chat.shows = (chat.shows || 0) + 1;
    chat.shownAt = now();
    runner.openInDesktop(chat.sessionId);
    log(`побудка ${slug}: ссылка на чат отправлена в Desktop`);
  }

  async function wakeDue(state) {
    for (const [slug, queued] of Object.entries(state.pending)) {
      if (queued.nextAt > now()) continue;
      // Перед побудкой — свежий взгляд: клиент или пользователь могли дописать.
      const record = readRecord(slug);
      const news = findNews(state, slug, record);
      if (!news) {
        delete state.pending[slug];
        delete state.reroute[slug];
        continue;
      }

      const item = trackPending(state, slug, news);
      try {
        await wakeOne(state, slug, item, record, news);
      } catch (error) {
        fail(state, slug, item, error);
      }
    }
  }

  // Заявки агентов «ждём клиента» переезжают в состояние. Побудка после заявки
  // (клиент ответил, агент разобрал) делает её устаревшей.
  function ingestSnooze(state) {
    for (const request of snooze.listRequests(serviceDir)) {
      if (!((state.chats[request.key]?.startedAt || 0) > request.at)) {
        state.snoozed[request.key] = { until: request.until, at: request.at };
      }

      fs.rmSync(request.filePath, { force: true });
    }

    for (const [key, mark] of Object.entries(state.snoozed)) {
      if (mark.until <= now()) delete state.snoozed[key];
    }
  }

  // Заявки агентов «побудка не про этот заказ»: отметки разобранного возвращаются на те, что были до
  // названной побудки, и её сообщения и события (с более поздними) уходят в чат названного заказа
  // клиента. Одна пересылка на побудку. Пока побудка диалога в пути, заявка ждёт: иначе её
  // подтверждение сдвинуло бы отметки мимо пересылки.
  // Возвращает файлы разобранных заявок: удалять их — после записи состояния, иначе падение моста
  // между шагами потеряет пересылку.
  function ingestReroute(state) {
    const done = [];
    for (const request of reroute.listRequests(serviceDir)) {
      const { slug } = request;
      if (state.pending[slug]?.sent) continue;
      done.push(request.filePath);
      const target = routeFor(slug, state).orders.find((order) => order.name === request.order);
      const delivered = state.delivered[slug] || [];
      const index = delivered.findIndex((entry) => entry.wakeId === request.wakeId && now() - entry.at < REROUTE_WINDOW_MS);
      const entry = delivered[index];
      const refused = !target ? 'у клиента нет такого заказа'
        : !entry ? `побудки #${request.wakeId} нет среди доставленных за сутки`
          : entry.key === target.dir ? 'побудка уже в этом заказе' : null;
      if (refused) {
        log(`побудка ${slug}: пересылка в «${request.order}» отклонена — ${refused}`);
        continue;
      }

      if (entry.handled) state.handled[slug] = entry.handled;
      else delete state.handled[slug];
      if (entry.events) state.eventMarks[slug] = entry.events;
      else delete state.eventMarks[slug];
      state.delivered[slug] = delivered.slice(0, index);
      state.reroute[slug] = target.dir;
      const news = findNews(state, slug, readRecord(slug));
      if (news) trackPending(state, slug, news, `:reroute:${request.wakeId}`);
      log(`побудка ${slug}: агент переслал #${request.wakeId} в заказ ${target.name}`);
    }

    return done;
  }

  // Сбой — только запись в лог и повтор: первый сразу, дальше 1, 2, 4… минут.
  function fail(state, slug, item, error) {
    item.attempts += 1;
    item.nextAt = now() + (item.attempts === 1 ? 0 : wakeCore.nextAttemptDelayMs(item.attempts - 1));
    item.error = String(error?.message || error).slice(0, 200);
    log(`побудка ${slug} не удалась (попытка ${item.attempts}): ${item.error}`);
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

      if (state.version < STATE_VERSION) {
        upgrade(state);
        writeAtomic(statePath, state);
      }

      // Мак спал: время сна в ожидание метки не засчитывается.
      const gap = lastTickAt ? now() - lastTickAt : 0;
      lastTickAt = now();
      if (gap > SLEEP_GAP_MS) {
        for (const item of Object.values(state.pending)) {
          if (!item.sent) continue;
          item.sent.at += gap;
          if (item.sent.busyAt) item.sent.busyAt += gap;
        }
      }

      const dirty = collectDirty(state);
      onCollected();
      ingestSnooze(state);
      const rerouted = ingestReroute(state);
      writeAtomic(statePath, state);
      for (const file of rerouted) fs.rmSync(file, { force: true });
      // Захваченные отметки снимаются только после записи состояния: упади
      // мост раньше — диалог просто проверится ещё раз.
      for (const slug of dirty) fs.rmSync(path.join(claimedDir, slug), { force: true });

      await wakeDue(state);
      try {
        await keepDispatcher(state);
        cleanWakeTexts();
      } catch (error) {
        log(`диспетчер не проверен: ${error?.message || error}`);
      }

      writeAtomic(statePath, state);
    } finally {
      running = false;
    }
  }

  return { tick };
}

module.exports = {
  createWaker,
};
