// Подмена системы для будильщика: запуск claude, список процессов, `open`, передний план,
// чаты Claude Desktop (метаданные, реестр ~/.claude/sessions и настоящий unix-сокет входящих)
// и чат-диспетчер, который передаёт побудку в журнал чата, как send_message Desktop.
// Журналы чатов пишутся на настоящий диск во временную «домашнюю» папку.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { createClaudeRunner, projectSlug } = require('../../native_host/claude-runner.js');

// hang = false: запуск «заканчивается» сразу; true: живёт, пока тест не вызовет finish.
function createFakeClaude({ home, now = Date.now, hang = false }) {
  const runs = [];
  const alive = new Set();
  const foreign = [];
  const opened = [];
  // silent = true: claude умирает, не успев создать журнал чата и итог; noAnswer = true: журнал
  // есть, но процесс оборвался без строки итога; apiError = true: агент вызвал инструмент, потом
  // ошибка API — в журнале запись об ошибке, в логе итог с is_error: true, как пишет claude.
  // front — Desktop на переднем плане; idleMs — сколько пользователь не трогает компьютер; desktopUp — Desktop
  // запущен (desktopAgeMs — сколько он работает); inbox — что пришло в открытые чаты Desktop;
  // desktopReceives = false — чат принял сообщение в сокет, но в журнал оно не попало; dispatched — что
  // диспетчер передал (dispatcherDelivers = false — получил, но не передал); schedules — команды расписания.
  const fake = { runs, opened, hang, failWith: null, silent: false, noAnswer: false, apiError: false, front: false, idleMs: 0, desktopUp: true, desktopAgeMs: 60 * 60 * 1000, inbox: [], desktopReceives: true, dispatched: [], dispatcherDelivers: true, schedules: 0 };

  const line = (record) => `${JSON.stringify(record)}\n`;
  const stamp = (at) => new Date(at).toISOString();
  const journal = (dir, sessionId) => path.join(home, '.claude', 'projects', projectSlug(fs.realpathSync(dir)), `${sessionId}.jsonl`);

  // Журнал чата в том же месте и с тем же временем, что оставил бы claude (lines — дописать записи).
  fake.touch = (dir, sessionId, at = now(), lines = '') => {
    const file = journal(dir, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines);
    fs.utimesSync(file, at / 1000, at / 1000);
  };

  // Живая запись в чате (по умолчанию — сообщение пользователя) в момент at; mtime журнала тот же.
  fake.say = (dir, sessionId, at, record = {}) => fake.touch(dir, sessionId, at, line({ type: 'user', timestamp: stamp(at), message: { role: 'user', content: 'вопрос агенту' }, ...record }));

  // Служебные записи, которые Desktop, держащий чат, дописывает сам: без времени.
  fake.service = (dir, sessionId, at) => fake.touch(dir, sessionId, at, ['last-prompt', 'mode', 'cost-state', 'atis-latch'].map((type) => line({ type, value: 'x' })).join(''));

  const spawn = (bin, args, options) => {
    if (fake.failWith) throw new Error(fake.failWith);
    const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const run = { bin, args, options, pid: 5000 + runs.length, text: args.at(-1), sessionId: flag('--session-id') || flag('--resume') };
    runs.push(run);
    if (fake.hang) alive.add(run.pid);
    if (!fake.silent) {
      // Как в настоящем журнале: метка побудки есть в записи пользователя и повторяется в
      // `last-prompt` уже после ответа.
      fake.touch(options.cwd, run.sessionId, now(), [
        line({ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(now()), content: run.text }),
        line({ type: 'user', timestamp: stamp(now()), message: { role: 'user', content: run.text } }),
        ...(fake.noAnswer ? [] : fake.apiError ? [
          line({ type: 'assistant', timestamp: stamp(now()), message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
          line({ type: 'user', timestamp: stamp(now()), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
          line({ type: 'assistant', timestamp: stamp(now()), isApiErrorMessage: true, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: Connection lost mid-response' }] } }),
        ] : [line({ type: 'assistant', timestamp: stamp(now()), message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Принял.' }] } })]),
        line({ type: 'last-prompt', lastPrompt: run.text }),
      ].join(''));
      // Итог запуска в лог (stdout), как с --output-format json: у «живого» запуска — при finish.
      if (!fake.noAnswer) {
        const result = line({ type: 'result', subtype: 'success', is_error: fake.apiError, result: fake.apiError ? 'API Error: Connection lost mid-response' : 'Принял.', session_id: run.sessionId });
        if (fake.hang) run.writeResult = ((logFd) => () => { fs.writeSync(logFd, result); fs.closeSync(logFd); })(fs.openSync(`/dev/fd/${options.stdio[1]}`, 'a'));
        else fs.writeSync(options.stdio[1], result);
      }
    }
    return { pid: run.pid, on() {}, unref() {} };
  };

  const processes = () => [
    ...(fake.desktopUp ? [{ pid: 100, ageMs: fake.desktopAgeMs, args: '/Applications/Claude.app/Contents/MacOS/Claude' }] : []),
    ...runs.filter((run) => alive.has(run.pid)).map((run) => ({ pid: run.pid, args: `${run.bin} ${run.args.slice(0, -1).join(' ')} <текст>` })),
    ...foreign,
  ];

  // Чат в списке Desktop: метаданные Desktop с его номером и папкой. Показ в Desktop кладёт их туда же.
  const desktopDirs = new Map();
  fake.addToDesktop = (sessionId, { archived = false, cwd } = {}) => {
    const dir = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
    fs.mkdirSync(dir, { recursive: true });
    if (cwd) desktopDirs.set(sessionId, cwd);
    fs.writeFileSync(path.join(dir, `local_${sessionId}.json`), JSON.stringify({ sessionId: `local_${sessionId}`, cliSessionId: sessionId, isArchived: archived, ...(cwd ? { cwd: fs.realpathSync(cwd) } : {}) }));
  };
  // Ссылка resume: чат появляется в списке Desktop или возвращается из архива (папка не меняется).
  const open = (url) => {
    opened.push(url);
    const sessionId = new URL(url).searchParams.get('session');
    fake.addToDesktop(sessionId, { cwd: desktopDirs.get(sessionId) });
  };

  // Чат открыт в Claude Desktop: процесс с --resume=<id>, запись реестра с адресом и ключом и
  // сокет, который принимает строки auth и user (принятое — в inbox и в журнал чата).
  let nextDesktopPid = 9000;
  const servers = [];
  const sessionsDir = path.join(home, '.claude', 'sessions');
  const registry = (pid) => path.join(sessionsDir, `${pid}.json`);
  // broken — запись реестра есть, а сокета нет (чат не принимает сообщения); status — idle или busy;
  // receive(text) — свой приём сообщения вместо записи в журнал чата.
  fake.openDesktopChat = (dir, sessionId, { broken = false, status = 'idle', receive } = {}) => {
    const pid = nextDesktopPid++;
    const socketPath = path.join(home, `s${pid}.sock`);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(registry(pid), JSON.stringify({ pid, sessionId, cwd: fs.realpathSync(dir), kind: 'interactive', entrypoint: 'claude-desktop', messagingSocketPath: socketPath, status, updatedAt: now() + pid }));
    fs.writeFileSync(path.join(sessionsDir, `${pid}.abc.key`), `key-${pid}\n`);
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => { buffer += chunk; });
      socket.on('end', () => {
        const [auth, user] = buffer.split('\n').filter(Boolean).map((item) => JSON.parse(item));
        fake.inbox.push({ pid, sessionId, auth, user });
        if (receive) receive(user.message.content);
        else if (fake.desktopReceives) fake.touch(dir, sessionId, now(), line({ type: 'user', timestamp: stamp(now()), message: { role: 'user', content: `Another Claude session sent a message:\n${user.message.content}` } }));
      });
    });
    if (!broken) {
      server.listen(socketPath);
      server.unref();
      servers.push(server);
    }
    foreign.push({ pid, args: `/Applications/Claude.app/Contents/MacOS/claude --output-format stream-json --resume=${sessionId}` });
    return pid;
  };
  fake.setStatus = (pid, status) => {
    const entry = JSON.parse(fs.readFileSync(registry(pid), 'utf8'));
    fs.writeFileSync(registry(pid), JSON.stringify({ ...entry, status }));
  };

  // Чат-диспетчер в Desktop (номер CLI disp-cli): команда «чат: local_<id>» дописывает текст после
  // «----» в журнал того чата, как сообщение «From Kwork-диспетчер»; команда расписания считается.
  // Как велят его правила, копию запроса с тем же номером он не передаёт.
  const seenRequests = new Set();
  fake.openDispatcher = (dir) => {
    fake.addToDesktop('disp-cli', { cwd: dir });
    return fake.openDesktopChat(dir, 'disp-cli', {
      receive(text) {
        if (text === '[Kwork-диспетчер] расписание') {
          fake.schedules += 1;
          return;
        }

        const request = /^\[Kwork-диспетчер #(\S+)\]/.exec(text)?.[1];
        if (seenRequests.has(request)) return;
        seenRequests.add(request);
        const localId = /^чат: (\S+)$/m.exec(text)?.[1];
        const body = text.slice(text.indexOf('\n----\n') + 6);
        fake.dispatched.push({ request, localId, archived: /^архив: да$/m.test(text), text: body });
        // Desktop находит журнал чата сам: ищем его в каталогах журналов.
        const sessionId = localId?.replace(/^local_/, '');
        const projects = path.join(home, '.claude', 'projects');
        const file = fs.readdirSync(projects).map((name) => path.join(projects, name, `${sessionId}.jsonl`)).find((item) => fs.existsSync(item));
        if (fake.dispatcherDelivers && file) fs.appendFileSync(file, line({ type: 'user', timestamp: stamp(now()), message: { role: 'user', content: body } }));
      },
    });
  };

  fake.closeDesktopChats = () => {
    for (const server of servers.splice(0)) server.close();
    foreign.length = 0;
  };
  // Дождаться, пока открытые чаты примут count сообщений.
  fake.waitInbox = async (count) => {
    for (let waited = 0; fake.inbox.length < count && waited < 2000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  };

  fake.runner = createClaudeRunner({ env: { PATH: '/usr/bin' }, home, spawn, processes, open, front: () => fake.front, idle: () => fake.idleMs });
  fake.finish = (pid) => {
    alive.delete(pid);
    const run = runs.find((item) => item.pid === pid);
    run?.writeResult?.();
    if (run) delete run.writeResult;
  };
  // Claude Desktop держит чат: процесс с --resume=<id>; терминал — `claude --resume <id>`.
  fake.hold = (sessionId) => foreign.push({ pid: 777, args: `/Applications/Claude.app/Contents/MacOS/claude --output-format stream-json --resume=${sessionId}` });
  fake.holdInTerminal = (sessionId) => foreign.push({ pid: 778, args: `claude --resume ${sessionId}` });
  fake.unhold = () => { foreign.length = 0; };
  return fake;
}

module.exports = { createFakeClaude };
