// Транспорт будильщика: чаты Claude Desktop (метаданные, открытые чаты и их сокеты), сообщение в
// сокет открытого чата, `claude -p` для чата, которого в Desktop ещё нет, и показ его в Desktop
// ссылкой resume. Всё, что трогает систему (запуск, список процессов, `open`, передний план),
// принимается параметрами, чтобы тесты подменяли это без настоящего claude.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT = 'high';
// Мост запускает Chrome с бедным PATH: claude и его помощникам нужны homebrew-каталоги.
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
      const records = parseRecords(buffer.toString('utf8'), '"timestamp"');
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const at = Date.parse(records[index].timestamp);
        if (Number.isFinite(at) && isLive(records[index])) return at;
      }

      if (from === 0 || span >= TAIL_MAX_BYTES) return 0;
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

// Настоящее сообщение человека: не результат инструмента, не служебная запись и не наша побудка.
function isLiveUser(record) {
  if (record.isMeta) return false;
  const content = record.message?.content;
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
  return !blocks.some((block) => block?.type === 'tool_result' || (typeof block?.text === 'string' && block.text.includes(WAKE_TEXT)));
}

// Живая работа в чате: ответ ассистента или сообщение человека.
function isLive(record) {
  return isRealAssistant(record) || (record.type === 'user' && isLiveUser(record));
}

function createClaudeRunner({ env = process.env, home = os.homedir(), spawn = childProcess.spawn, processes = listProcesses, open = openUrl, front = desktopInFront, idle = userIdleMs, log = () => {} } = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const projectsDir = path.join(configDir, 'projects');
  const sessionsDir = path.join(configDir, 'sessions');
  const desktopSessionsDir = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  const bin = env.KPH_CLAUDE_BIN || path.join(home, '.local', 'bin', 'claude');
  const model = env.KPH_CLAUDE_MODEL || DEFAULT_MODEL;
  const effort = env.KPH_CLAUDE_EFFORT || DEFAULT_EFFORT;

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

  // Дошло ли сообщение до чата: запись user с меткой побудки в его журнале после позиции from. Запись
  // очереди занятого чата (queue-operation) не в счёт: прерванный ход сбрасывает очередь.
  function received(file, from, marker) {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(Math.max(0, fs.fstatSync(fd).size - from));
        fs.readSync(fd, buffer, 0, buffer.length, from);
        return buffer.includes(marker) && parseRecords(buffer.toString('utf8'), marker).some((record) => record.type === 'user');
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
            if (typeof meta.cliSessionId === 'string') chats.set(meta.cliSessionId, { localId: meta.sessionId, archived: meta.isArchived === true, cwd: meta.cwd || null });
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

  // Ответил ли агент на побудку — по итогу самого запуска, а не по журналу чата: с
  // `--output-format json` claude последней строкой лога пишет {"type":"result","is_error":…}.
  // Ошибка API и лимит дают is_error: true (subtype при этом "success"), обрыв процесса — нет
  // строки итога. Лог дописывается при каждом запуске чата, поэтому читаем с позиции запуска.
  function succeeded(logFile, from) {
    let text;
    try {
      const fd = fs.openSync(logFile, 'r');
      try {
        const buffer = Buffer.alloc(Math.max(0, fs.fstatSync(fd).size - from));
        fs.readSync(fd, buffer, 0, buffer.length, from);
        text = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }

    const result = parseRecords(text, '"type":"result"').filter((record) => record.type === 'result').at(-1);
    return result?.is_error === false;
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

  // pid совпал и это запуск именно этого чата: номера процессов переиспользуются.
  function isRunning(pid, sessionId) {
    return processes().some((item) => item.pid === pid && item.args.includes(sessionId));
  }

  // Новый чат: { sessionId }; продолжить: { sessionId, resume: true }.
  // name — название чата (запись custom-title в журнале); Desktop берёт его при добавлении в список.
  function start({ dir, text, sessionId, resume = false, name, logFile }) {
    const session = resume ? ['--resume', sessionId] : ['--session-id', sessionId];
    const args = ['-p', ...session, ...(name ? ['--name', name] : []), '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--model', model, '--effort', effort, text];
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'a');
    const logFrom = fs.fstatSync(fd).size;
    let child;
    try {
      // PWD по папке заказа: Stop-хук решает по "$PWD", а от моста он достался бы чужой.
      child = spawn(bin, args, { cwd: dir, env: { ...env, PWD: dir, PATH: [env.PATH, EXTRA_PATH].filter(Boolean).join(':') }, detached: true, stdio: ['ignore', fd, fd] });
    } finally {
      fs.closeSync(fd);
    }

    // Без обработчика ошибка запуска (нет бинаря) уронила бы весь мост.
    child.on('error', (error) => log(`claude не запущен: ${error?.message || error}`));
    child.unref();
    if (!child.pid) throw new Error(`claude не запустился (${bin})`);
    return { pid: child.pid, logFrom };
  }

  function openInDesktop(sessionId) {
    open(`claude://resume?session=${sessionId}`);
  }

  return { deliver, desktopChats, desktopInFront: front, desktopAgeMs, userIdleMs: idle, holders, inDesktop, isRunning, lastActivity, latestChat, newSessionId: () => crypto.randomUUID(), openChat, openInDesktop, received, start, succeeded, transcript };
}

module.exports = {
  createClaudeRunner,
  elapsedMs,
  listProcesses,
  projectSlug,
};
