// Транспорт будильщика: чаты Claude Desktop (метаданные, открытые чаты и их сокеты), сообщение в
// сокет открытого чата, пустой чат для клиента, которого в Desktop ещё нет, и показ его в Desktop
// ссылкой resume или уведомлением. Всё, что трогает систему (список процессов, `open`, уведомление,
// передний план), принимается параметрами, чтобы тесты подменяли это без настоящего Desktop.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// Мост запускает Chrome с бедным PATH: terminal-notifier стоит в homebrew-каталоге.
const EXTRA_PATH = '/opt/homebrew/bin:/usr/local/bin';

// Каталог журналов claude: путь папки, где каждый символ не [A-Za-z0-9] заменён на «-».
function projectSlug(dir) {
  return String(dir).replace(/[^A-Za-z0-9]/g, '-');
}

// Сколько живёт процесс по полю etime `ps`: `[[дд-]чч:]мм:сс`.
function elapsedMs(etime) {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!match) return null;
  const [, days = 0, hours = 0, minutes, seconds] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

// pid, возраст и аргументы всех процессов; `-ww` — без обрезки по ширине экрана.
function listProcesses() {
  const out = childProcess.execFileSync('ps', ['-axww', '-o', 'pid=,etime=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const processes = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match) processes.push({ pid: Number(match[1]), ageMs: elapsedMs(match[2]), args: match[3] });
  }

  return processes;
}

function openUrl(url) {
  const child = childProcess.spawn('/usr/bin/open', ['-g', url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

// Уведомление macOS, по нажатию открывает url (terminal-notifier из Homebrew; group — одно уведомление
// на чат). Нет terminal-notifier или он сбоит — report(причина), а чат добавится, когда пользователь выйдет
// из Desktop.
function notifyUser({ title, message, url, group }, report = () => {}) {
  const child = childProcess.spawn('terminal-notifier', ['-title', title, '-message', message, '-open', url, '-group', group, '-sound', 'default'], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, PATH: [process.env.PATH, EXTRA_PATH].filter(Boolean).join(':') },
  });
  child.on('error', (error) => report(error?.message || String(error)));
  child.on('exit', (code) => {
    if (code) report(`код выхода ${code}`);
  });
  child.unref();
}

const DESKTOP_BUNDLE = 'com.anthropic.claudefordesktop';
const DELIVER_TIMEOUT_MS = 5000;

// Claude Desktop сейчас на переднем плане (пользователь в нём работает). Не узнали — нет.
function desktopInFront() {
  try {
    const asn = childProcess.execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8', timeout: 2000 }).trim();
    const info = childProcess.execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', asn], { encoding: 'utf8', timeout: 2000 });
    return info.includes(`"${DESKTOP_BUNDLE}"`);
  } catch {
    return false;
  }
}

// Сколько пользователь не трогает мышь и клавиатуру (HIDIdleTime, наносекунды). Не узнали — 0:
// считаем, что он за компьютером.
function userIdleMs() {
  try {
    const out = childProcess.execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime'], { encoding: 'utf8', timeout: 2000 });
    const match = /"HIDIdleTime" = (\d+)/.exec(out);
    return match ? Number(match[1]) / 1e6 : 0;
  } catch {
    return 0;
  }
}

const WAKE_TEXT = '[Kwork-побудка';
const SERVICE_TEXT = '[Kwork-служебное]';

// Записи журнала (по строке JSON), в тексте которых есть needle; оборванные и чужие строки пропускаются.
function parseRecords(text, needle = '') {
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{') || !line.includes(needle)) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Строка оборвана на чтении.
    }
  }

  return records;
}

// Время последней записи пользователя или ассистента в журнале: читаем с конца кусками,
// журналы бывают в десятки мегабайт.
const TAIL_START_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 16 * 1024 * 1024;

function lastRecordAt(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return 0;
  }

  try {
    const size = fs.fstatSync(fd).size;
    for (let span = TAIL_START_BYTES; ; span *= 4) {
      const from = Math.max(0, size - span);
      const buffer = Buffer.alloc(size - from);
      fs.readSync(fd, buffer, 0, buffer.length, from);
      const text = buffer.toString('utf8');
      const records = parseRecords(text, '"timestamp"');
      // Служебная просьба будильщика и ответ на неё — не работа: ответ ассистента в счёт, только если
      // его ход начат не такой просьбой (иначе чат давнего заказа стал бы «последним, где работали»).
      const service = text.includes(SERVICE_TEXT);
      let answer = 0;
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        const at = Date.parse(record.timestamp);
        if (!Number.isFinite(at)) continue;
        if (!service) {
          if (isLive(record)) return at;
        } else if (isRealAssistant(record)) {
          answer ||= at;
        } else if (isPrompt(record)) {
          if (isService(record)) answer = 0;
          else if (answer) return answer;
          else if (isLiveUser(record)) return at;
        }
      }

      if (from === 0 || span >= TAIL_MAX_BYTES) return answer;
    }
  } catch {
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

// Настоящий ответ ассистента: ошибку API (лимит, обрыв связи) claude пишет в журнал тоже записью
// assistant, но с isApiErrorMessage и моделью <synthetic> — это не ответ и не работа в чате.
function isRealAssistant(record) {
  return record.type === 'assistant' && !record.isApiErrorMessage && record.message?.model !== '<synthetic>';
}

const blocksOf = (record) => {
  const content = record.message?.content;
  return Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
};
const hasText = (record, marker) => blocksOf(record).some((block) => typeof block?.text === 'string' && block.text.includes(marker));

// Запись, которой начинается ход: сообщение в чат, а не результат инструмента и не служебная запись.
function isPrompt(record) {
  return record.type === 'user' && !record.isMeta && !blocksOf(record).some((block) => block?.type === 'tool_result');
}

// Просьба будильщика открытому чату поднять диспетчера.
function isService(record) {
  return hasText(record, SERVICE_TEXT);
}

// Настоящее сообщение человека: не результат инструмента, не служебная запись и не наши побудка или просьба.
function isLiveUser(record) {
  return isPrompt(record) && !hasText(record, WAKE_TEXT) && !isService(record);
}

// Живая работа в чате: ответ ассистента или сообщение человека.
function isLive(record) {
  return isRealAssistant(record) || (record.type === 'user' && isLiveUser(record));
}

function createClaudeRunner({ env = process.env, home = os.homedir(), processes = listProcesses, open = openUrl, notify = notifyUser, front = desktopInFront, idle = userIdleMs, log = () => {} } = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const projectsDir = path.join(configDir, 'projects');
  const sessionsDir = path.join(configDir, 'sessions');
  const desktopSessionsDir = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');

  // claude берёт каталог по настоящему cwd; имя на диске бывает в NFC и в NFD.
  function cwdVariants(dir) {
    let real = dir;
    try {
      real = fs.realpathSync(dir);
    } catch {
      // Папки нет — остаётся путь как есть.
    }

    return [...new Set([real, dir].flatMap((item) => [item, item.normalize('NFC'), item.normalize('NFD')]))];
  }

  // Журнал чата { file, mtimeMs, size } или null, если чата в этой папке нет.
  function transcript(dir, sessionId) {
    if (!dir || !sessionId) return null;
    for (const candidate of cwdVariants(dir)) {
      const file = path.join(projectsDir, projectSlug(candidate), `${sessionId}.jsonl`);
      try {
        const stat = fs.statSync(file);
        return { file, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        // Другая запись имени папки.
      }
    }

    return null;
  }

  // Самый свежий чат папки заказа: { sessionId, at } по времени последней живой записи
  // (сообщение человека или ответ ассистента) в журналах любых чатов, в том числе чатов самого
  // пользователя в Desktop; null — чатов нет. По mtime нельзя: Desktop, держащий чат, сам
  // дописывает служебные записи, и журнал выглядит свежим без всякой работы.
  // only(sessionId) — отбор чатов; без него — все чаты папки.
  function latestChat(dir, only = () => true) {
    const files = [];
    for (const candidate of cwdVariants(dir)) {
      const projectDir = path.join(projectsDir, projectSlug(candidate));
      let names = [];
      try {
        names = fs.readdirSync(projectDir).filter((name) => name.endsWith('.jsonl'));
      } catch {
        // Каталога журналов у этой записи имени нет.
      }

      for (const name of names) {
        try {
          files.push({ file: path.join(projectDir, name), sessionId: name.slice(0, -'.jsonl'.length), mtimeMs: fs.statSync(path.join(projectDir, name)).mtimeMs });
        } catch {
          // Журнал удалили между чтением каталога и stat.
        }
      }
    }

    // Запись не может быть новее файла: журналы, которые не свежее найденного, не читаются.
    let best = null;
    for (const { file, sessionId, mtimeMs } of files.sort((left, right) => right.mtimeMs - left.mtimeMs)) {
      if (best && mtimeMs <= best.at) break;
      if (!only(sessionId)) continue;
      const at = lastRecordAt(file);
      if (at > 0 && (!best || at > best.at)) best = { sessionId, at };
    }

    return best;
  }

  // Когда в папке заказа последний раз работали; 0 — чатов нет.
  function lastActivity(dir) {
    return latestChat(dir)?.at || 0;
  }

  // Чаты, открытые сейчас в Claude Desktop: реестр живых сессий claude (~/.claude/sessions/<pid>.json)
  // с адресом входящих сообщений. pid сверяется со списком процессов: номера переиспользуются,
  // а запись умершего процесса может остаться. Чаты T3, терминала и наши фоновые — не в счёт.
  function openChats() {
    let names;
    try {
      names = fs.readdirSync(sessionsDir).filter((name) => /^\d+\.json$/.test(name));
    } catch {
      return [];
    }

    // Запись упавшего процесса, чей номер занял другой процесс, — не чат.
    const alive = new Map(processes().map((item) => [item.pid, item.args]));
    const chats = [];
    for (const name of names) {
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), 'utf8'));
        if (entry.entrypoint === 'claude-desktop' && /claude/i.test(alive.get(entry.pid) || '') && entry.sessionId && entry.messagingSocketPath && entry.cwd) {
          chats.push({ pid: entry.pid, sessionId: entry.sessionId, cwd: entry.cwd, socket: entry.messagingSocketPath, status: entry.status || null, updatedAt: entry.updatedAt || 0 });
        }
      } catch {
        // Запись пишется прямо сейчас — увидим на следующем такте.
      }
    }

    return chats;
  }

  // Открытый в Desktop чат заказа: сам этот чат, а в папке заказа (anyInDir) — любой открытый там
  // чат пользователя; из нескольких — где последняя живая запись (процессы Desktop живут долго,
  // «открыт» ещё не значит «пользователь в нём»), при равенстве — этот. null — открытого нет.
  // Чужой процесс без живой переписки — не чат: Desktop, не запустив чат при занятых чатах,
  // поднимает в его папке временный процесс со своим номером, и побудка там пропала бы.
  function openChat(dir, sessionId, anyInDir) {
    const variants = new Set(cwdVariants(dir));
    const candidates = openChats().filter((item) => item.sessionId === sessionId || (anyInDir && cwdVariants(item.cwd).some((variant) => variants.has(variant))));
    let best = null;
    for (const item of candidates) {
      const file = transcript(item.cwd, item.sessionId);
      const at = file ? lastRecordAt(file.file) : 0;
      if (item.sessionId !== sessionId && at === 0) continue;
      if (!best || at > best.at || (at === best.at && item.sessionId === sessionId)) best = { item, at };
    }

    return best?.item || null;
  }

  // Свободный открытый чат Desktop внутри папки root с живой перепиской, кроме чата except и папок avoid;
  // из таких — с самой старой записью: в самом свежем скорее всего сейчас пишет пользователь. null — такого
  // нет. Занятый или ждущий ответа пользователя чат держит входящее в очереди; временный процесс Desktop
  // без переписки — не чат (см. openChat).
  function openChatUnder(root, except, avoid = []) {
    const inside = (dir, bases) => cwdVariants(dir).some((variant) => bases.some((base) => variant === base || variant.startsWith(`${base}/`)));
    const roots = cwdVariants(root);
    const avoided = avoid.flatMap(cwdVariants);
    let best = null;
    for (const item of openChats()) {
      if (item.sessionId === except || (item.status && item.status !== 'idle') || !inside(item.cwd, roots) || inside(item.cwd, avoided)) continue;
      const file = transcript(item.cwd, item.sessionId);
      const at = file ? lastRecordAt(file.file) : 0;
      if (at > 0 && (!best || at < best.at)) best = { item, at };
    }

    return best?.item || null;
  }

  // Сообщение в открытый чат — так же, как его шлёт другая сессия Claude: строка auth с ключом
  // этого чата (~/.claude/sessions/<pid>.<…>.key), затем строка user. Ключ нигде не печатается.
  // Чат Desktop без подтверждений примет сообщение сразу только при crossSessionInbound: "accept"
  // в ~/.claude/settings.json, иначе оно ждёт кнопки «Доставить» в самом чате.
  function deliver(chat, text) {
    let token = '';
    try {
      const keyName = fs.readdirSync(sessionsDir).find((name) => name.startsWith(`${chat.pid}.`) && name.endsWith('.key'));
      if (keyName) token = fs.readFileSync(path.join(sessionsDir, keyName), 'utf8').trim();
    } catch {
      // Без ключа чат решит сам: примет или отложит.
    }

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: chat.socket });
      socket.setTimeout(DELIVER_TIMEOUT_MS, () => socket.destroy(new Error('чат не принял сообщение вовремя')));
      socket.on('error', reject);
      socket.on('connect', () => {
        socket.end(`${JSON.stringify({ type: 'auth', token })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`, resolve);
      });
    });
  }

  // Дошло ли сообщение до чата: метка побудки в его журнале после позиции from — в записи `user`
  // (свободный чат) или во вложении `queued_command` (занятый чат вставляет сообщение из очереди в
  // свой ход). Запись очереди (`queue-operation`) не в счёт: прерванный ход сбрасывает очередь.
  const delivered = (record) => record.type === 'user' || (record.type === 'attachment' && record.attachment?.type === 'queued_command');

  function received(file, from, marker) {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(Math.max(0, fs.fstatSync(fd).size - from));
        fs.readSync(fd, buffer, 0, buffer.length, from);
        return buffer.includes(marker) && parseRecords(buffer.toString('utf8'), marker).some(delivered);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  // Чаты из списка Claude Desktop по номеру CLI: Map cliSessionId → { localId, archived, cwd }.
  // localId (local_…) — номер чата для инструментов Desktop (send_message).
  function desktopChats() {
    const chats = new Map();
    const walk = (dir, depth) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 2) walk(full, depth + 1);
        else if (depth === 2 && /^local_.*\.json$/.test(entry.name)) {
          try {
            const meta = JSON.parse(fs.readFileSync(full, 'utf8'));
            if (typeof meta.cliSessionId === 'string') chats.set(meta.cliSessionId, { localId: meta.sessionId, archived: meta.isArchived === true, cwd: meta.cwd || null, title: meta.title || null });
          } catch {
            // Desktop переписывает файл прямо сейчас.
          }
        }
      }
    };
    walk(desktopSessionsDir, 0);
    return chats;
  }

  function inDesktop(sessionId) {
    return desktopChats().has(sessionId);
  }

  // Чат держит чужой процесс — терминал или наш `claude -p` (`--resume <id>`, `--session-id <id>`); процесс
  // самого Desktop (`--resume=<id>`) не в счёт: в свой чат Desktop доставит сам.
  function holders(sessionId) {
    return processes().filter(({ args }) => [`--resume ${sessionId}`, `--session-id ${sessionId}`].some((flag) => args.includes(flag)));
  }

  // Сколько работает Claude Desktop (возраст его главного процесса); null — Desktop не запущен.
  function desktopAgeMs() {
    const main = processes().find(({ args }) => /Claude\.app\/Contents\/MacOS\/Claude(\s|$)/.test(args));
    return main ? main.ageMs ?? Infinity : null;
  }

  // Пустой чат: журнал с названием (custom-title — его Desktop берёт в список) и вводной строкой, без
  // запуска модели. В список Desktop его добавляет openInDesktop, работает агент уже там.
  function seed({ dir, sessionId, name, text, at }) {
    const [cwd] = cwdVariants(dir);
    const file = path.join(projectsDir, projectSlug(cwd), `${sessionId}.jsonl`);
    const records = [
      { type: 'custom-title', customTitle: name, sessionId },
      { type: 'user', parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'cli', uuid: crypto.randomUUID(), timestamp: new Date(at).toISOString(), cwd, sessionId, message: { role: 'user', content: text } },
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''), { flag: 'wx' });
  }

  function openInDesktop(sessionId) {
    open(`claude://resume?session=${sessionId}`);
  }

  return { deliver, desktopChats, desktopInFront: front, desktopAgeMs, userIdleMs: idle, holders, inDesktop, lastActivity, latestChat, newSessionId: () => crypto.randomUUID(), notify: (note) => notify(note, (why) => log(`уведомление не показано (terminal-notifier): ${why}`)), openChat, openChatUnder, openInDesktop, received, seed, transcript };
}

module.exports = {
  createClaudeRunner,
  elapsedMs,
  listProcesses,
  projectSlug,
};
