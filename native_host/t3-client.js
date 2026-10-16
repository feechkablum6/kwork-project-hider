// Связь с T3 Code на этом маке: будильщик отправляет сообщение в чат агента.
// Ключ доступа выпускается на одну пачку побудок (5 минут, только чаты) и сразу
// отзывается: на диске он не хранится. Протокол — тот же, что у приложения T3.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const T3_HOME = path.join(os.homedir(), '.t3');
const T3_BIN = process.env.KPH_T3_BIN || path.join(T3_HOME, 'bin', 't3');
const RUNTIME_PATH = path.join(T3_HOME, 'userdata', 'server-runtime.json');
const CLI_TIMEOUT_MS = 20_000;
const WS_TIMEOUT_MS = 15_000;
const PROTOCOL_HEADER = 'x-t3-orchestration-protocol';
const PROTOCOL_VERSION = '2';
const SESSION_LABEL = 'kwork-wake';

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(T3_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('t3 не ответил'));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`t3 ${args.slice(0, 3).join(' ')}: код ${code} ${stderr.trim().slice(0, 200)}`));
      }
    });
  });
}

// Адрес сервера T3 берётся из его файла запуска: порт может смениться.
function serverOrigin() {
  const runtime = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
  const origin = String(runtime?.origin || '').replace(/\/$/, '');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
    throw new Error('T3 Code не запущен на этом маке');
  }

  return origin;
}

// Один и тот же номер на одну побудку: повтор после обрыва T3 узнает как уже
// принятую команду, а не создаст второе сообщение.
function stableUuid(seed) {
  const hex = crypto.createHash('sha256').update(String(seed)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function issueSession() {
  const output = await runCli([
    'auth', 'session', 'issue',
    '--scope', 'orchestration:read', '--scope', 'orchestration:operate',
    '--ttl', '5m', '--label', SESSION_LABEL, '--json',
  ]);
  const issued = JSON.parse(output);
  if (!issued?.token || !issued?.sessionId) {
    throw new Error('T3 не выдал ключ доступа');
  }

  return { token: issued.token, sessionId: issued.sessionId };
}

async function revokeSession(sessionId) {
  await runCli(['auth', 'session', 'revoke', sessionId]).catch(() => undefined);
}

async function getJson(origin, token, route) {
  const response = await fetch(`${origin}${route}`, {
    headers: { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: PROTOCOL_VERSION },
    signal: AbortSignal.timeout(WS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`T3 ${route}: ${response.status}`);
  }

  return response.json();
}

async function dispatchCommand(origin, token, command) {
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(WS_TIMEOUT_MS),
  });
  if (!ticketResponse.ok) {
    throw new Error(`T3 не выдал вход в канал: ${ticketResponse.status}`);
  }

  const { ticket } = await ticketResponse.json();
  const url = `${origin.replace(/^http/, 'ws')}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=${PROTOCOL_VERSION}`;

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const finish = (error, value) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Канал уже закрыт.
      }

      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('T3 не ответил на команду')), WS_TIMEOUT_MS);

    socket.onopen = () => {
      socket.send(JSON.stringify({ _tag: 'Request', id: '1', tag: 'orchestration.dispatchCommand', headers: [], payload: command }));
    };
    socket.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (frame?._tag === 'Ping') {
        socket.send(JSON.stringify({ _tag: 'Pong' }));
        return;
      }

      if (frame?._tag !== 'Exit' || String(frame.requestId) !== '1') {
        return;
      }

      if (frame.exit?._tag === 'Success') {
        finish(null, frame.exit.value);
      } else {
        const detail = JSON.stringify(frame.exit?.cause || frame.exit || {}).slice(0, 300);
        finish(new Error(`T3 отклонил команду ${command.type}: ${detail}`));
      }
    };
    socket.onerror = () => finish(new Error('канал T3 оборвался'));
    socket.onclose = () => finish(new Error('канал T3 закрылся без ответа'));
  });
}

// Всё общение с T3 — внутри одной сессии: ключ отзывается и при ошибке.
async function withT3(work) {
  const origin = serverOrigin();
  const session = await issueSession();
  try {
    return await work({
      shell: () => getJson(origin, session.token, '/api/orchestration/shell'),
      thread: (threadId, view = 'bounded') => getJson(origin, session.token, `/api/orchestration/threads/${encodeURIComponent(threadId)}/${view}`),
      dispatch: (command) => dispatchCommand(origin, session.token, command),
    });
  } finally {
    await revokeSession(session.sessionId);
  }
}

// createdBy T3 у внешнего входа всё равно ставит 'user'; побудку от сообщений
// пользователя отличает creationSource 'server' (wake-core, isEngaged).
function messageCommand({ seed, threadId, text }) {
  return {
    type: 'message.dispatch',
    createdBy: 'user',
    creationSource: 'server',
    commandId: stableUuid(`${seed}:message-command`),
    threadId,
    messageId: stableUuid(`${seed}:message`),
    text,
    attachments: [],
    dispatchMode: { type: 'queue_after_active' },
    deliveryIntent: 'auto',
  };
}

function threadCreateCommand({ seed, projectId, title, modelSelection }) {
  return {
    type: 'thread.create',
    createdBy: 'user',
    creationSource: 'server',
    commandId: stableUuid(`${seed}:thread-command`),
    threadId: stableUuid(`${seed}:thread`),
    projectId,
    title,
    modelSelection,
    runtimeMode: 'full-access',
    interactionMode: 'default',
    branch: null,
    worktreePath: null,
  };
}

module.exports = {
  PROTOCOL_VERSION,
  T3_BIN,
  WS_TIMEOUT_MS,
  getJson,
  issueSession,
  messageCommand,
  revokeSession,
  serverOrigin,
  stableUuid,
  threadCreateCommand,
  withT3,
};
