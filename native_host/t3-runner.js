'use strict';

// Транспорт побудки в T3 Code (13.11.2026: пользователь ушёл с Claude Desktop на T3): чаты и проекты — CLI,
// сообщение — канал приложения T3 (`t3-client.js`): занятый чат получает его steer в идущий ход, свободный —
// сразу новым ходом. Ни сокетов, ни диспетчера не нужно: принятое сервером T3 считается доставленным.

const { execFile, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { messageCommand, withT3 } = require('./t3-client');

const T3_TIMEOUT_MS = 30 * 1000;
// Новый чат при холодном T3 стартует дольше; убитый по сроку старт мог успеть завести чат — повтор дал бы второй.
const T3_START_TIMEOUT_MS = 2 * 60 * 1000;
const T3_MODEL = ['--provider', 'claudeAgent', '--model', 'claude-opus-5-5'];
// Чаты задач по расписанию и побочные чаты — не чаты заказа (t3-task.sh в agent-stack, импорт из Desktop).
const NOT_ORDER_CHAT = ['<scheduled-task', 'Background (from the session', 'Подборка проектов Kwork', 'Подборка заказов FL.ru', 'Разбор откликов Kwork', 'Разбор Директа'];

function run(bin, args, input, timeout = T3_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // Первая строка ошибки T3 — суть («Thread … was not found.», «ProjectAlreadyExistsError: …»).
        const why = String(stderr || stdout || error.message).trim().split('\n').find((line) => line.trim()) || error.message;
        reject(Object.assign(new Error(`t3 ${args.slice(0, 2).join(' ')}: ${why.slice(0, 300)}`), { t3: why }));
        return;
      }
      resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// Процесс сервера T3 Code: номер из server-runtime.json и он правда T3 (после перезагрузки номер занимает другой).
function serverPid(home) {
  try {
    const pid = Number(JSON.parse(fs.readFileSync(path.join(home, '.t3', 'userdata', 'server-runtime.json'), 'utf8')).pid);
    return pid && execFileSync('/bin/ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).includes('T3 Code') ? pid : null;
  } catch {
    return null;
  }
}

function createT3Runner({
  home = os.homedir(),
  bin = path.join(home, '.t3', 'bin', 't3'),
  exec = run,
  server = () => serverPid(home),
  session = withT3,
} = {}) {
  const t3 = (args, input, timeout) => exec(bin, args, input, timeout);

  // Папка без своего проекта T3 отдала бы чаты проекта-родителя (корня Kwork): проект заводим заранее.
  async function ensureProject(dir, title) {
    try {
      await t3(['project', 'add', dir, '--title', title]);
    } catch (error) {
      if (!/ProjectAlreadyExists/.test(error.t3 || '')) throw error;
    }
  }

  return {
    // → номер процесса сервера T3 Code или null (закрыт): CLI без него не работает.
    serverPid: server,
    // Номер чата Desktop (журнал Claude) — тот же чат в T3: T3 импортировал чаты Desktop.
    threadId: (id) => (String(id).includes(':') ? String(id) : `import:claudeAgent:${id}`),
    ensureProject,
    // Самый свежий чат заказа в его проекте T3, кроме задач по расписанию и побочных чатов, или null.
    async latestThread(dir, title) {
      await ensureProject(dir, title);
      const threads = JSON.parse(await t3(['thread', 'list', '--project', dir, '--json']));
      const own = threads.filter((thread) => !thread.parentThreadId && !NOT_ORDER_CHAT.some((prefix) => String(thread.title || '').startsWith(prefix)));
      own.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
      return own[0]?.threadId || null;
    },
    // → true: T3 принял сообщение; false: такого чата в T3 нет (удалён, в архиве) — нужен другой.
    // deliveryIntent 'auto' (messageCommand): идёт ход — steer в него, нет — новый ход сразу; `t3 thread send`
    // умеет только очередь. message.dispatch удалённый и архивный чат не проверяет (CLI через MCP проверял) —
    // читаем чат сами. Номер команды свежий, как у CLI: отказ T3 по старому номеру залип бы до нового сообщения.
    async send(threadId, text) {
      try {
        return await session(async (t3) => {
          let thread;
          try {
            thread = (await t3.thread(threadId)).projection?.thread;
          } catch (error) {
            if (/: 404$/.test(error.message)) return false;
            throw error;
          }
          if (!thread) throw new Error(`T3 не отдал чат ${threadId}`);
          if (thread.deletedAt || thread.archivedAt) return false;
          await t3.dispatch(messageCommand({ seed: crypto.randomUUID(), threadId, text }));
          return true;
        });
      } catch (error) {
        if (/No orchestration projection exists/.test(error.message)) return false;
        throw error;
      }
    },
    // Проект T3 со всеми его чатами — только по точному пути (чужой путь T3 не подменяет родителем:
    // ProjectNotFoundError); проекта нет — уже убран.
    async removeProject(dir) {
      try {
        await t3(['project', 'remove', '--force', dir]);
      } catch (error) {
        if (!/ProjectNotFound/.test(error.t3 || '')) throw error;
      }
    },
    // Новый чат с первым сообщением → номер чата.
    async start(dir, title, text) {
      await ensureProject(dir, title);
      const out = JSON.parse(await t3(['thread', 'start', dir, '-', '--title', title, ...T3_MODEL, '--json'], text, T3_START_TIMEOUT_MS));
      if (!out.threadId) throw new Error('t3 thread start: нет номера чата в ответе');
      return out.threadId;
    },
  };
}

module.exports = {
  NOT_ORDER_CHAT,
  createT3Runner,
};
