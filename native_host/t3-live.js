// Постоянная связь будильщика с T3: ключ в памяти, живая копия списка чатов
// (orchestration.subscribeShell) и отправка команд по уже открытому каналу.
// Побудка не ждёт выдачи ключа и 5 МБ списка. Связь не готова — старый путь
// t3-client.withT3 с ключом на одну пачку.

const { spawnSync } = require('node:child_process');
const client = require('./t3-client.js');

// Канал T3 закрывается, когда истекает ключ (5 минут): новый берётся заранее.
const ROTATE_MS = 3 * 60 * 1000;
const RETRY_MIN_MS = 5 * 1000;
const RETRY_MAX_MS = 60 * 1000;

function upsert(list, item) {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

function without(list, id) {
  return list.filter((entry) => entry.id !== id);
}

// Смысл событий — как у сервера T3 (subscribeOrchestrationV2Shell): снимок без
// resolvedRepositoryIdentityRoots заменяет всё, с ним — лишь дополняет проекты.
// Копия не меняется на месте: побудка может держать прежнюю.
function applyShellItem(mirror, item) {
  if (item?.kind === 'snapshot') {
    if (item.resolvedRepositoryIdentityRoots === undefined) {
      return { ...item.snapshot, threads: item.snapshot.threads || [], archivedThreads: item.snapshot.archivedThreads || [], projects: item.snapshot.projects || [] };
    }

    // Только известные проекты: запоздалое дополнение не воскрешает удалённый,
    // новый всё равно придёт событием project.updated.
    const patch = new Map((item.snapshot.projects || []).map((project) => [project.id, project]));
    return mirror && { ...mirror, projects: mirror.projects.map((project) => (patch.has(project.id) ? { ...project, ...patch.get(project.id) } : project)) };
  }

  if (!mirror) return mirror;
  const list = item?.location === 'archive' ? 'archivedThreads' : 'threads';
  const other = list === 'threads' ? 'archivedThreads' : 'threads';
  switch (item?.kind) {
    case 'project.updated':
      return { ...mirror, projects: upsert(mirror.projects, item.project) };
    case 'project.removed':
      return { ...mirror, projects: without(mirror.projects, item.projectId) };
    case 'thread.updated':
      return { ...mirror, [list]: upsert(mirror[list], item.thread), [other]: without(mirror[other], item.thread.id) };
    case 'thread.removed':
      return { ...mirror, [list]: without(mirror[list], item.threadId) };
    default:
      return mirror;
  }
}

function itemSequence(item) {
  return Number(item?.kind === 'snapshot' ? item.snapshot?.snapshotSequence : item?.sequence) || 0;
}

function nextSequence(sequence, item) {
  if (item?.kind !== 'snapshot') return Math.max(sequence, itemSequence(item));
  return item.resolvedRepositoryIdentityRoots === undefined ? itemSequence(item) : sequence;
}

function createT3Live({ log = () => {}, t3 = client } = {}) {
  let mirror = null;
  let sequence = 0;
  let current = null;
  let connecting = false;
  let retryMs = RETRY_MIN_MS;
  let timer = null;
  const live = new Set();

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(connect, ms);
    timer.unref?.();
  }

  // Старое поколение закрывается, когда его отпустили все побудки.
  function retire(gen) {
    if (gen === current || gen.users > 0 || gen.retired) return;
    gen.retired = true;
    gen.socket.onclose = null;
    try {
      gen.socket.close();
    } catch {
      // Уже закрыт.
    }

    for (const [, wait] of gen.pending) wait.reject(new Error('канал T3 закрыт'));
    live.delete(gen);
    t3.revokeSession(gen.sessionId);
  }

  async function open(origin, session) {
    const response = await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` },
      signal: AbortSignal.timeout(t3.WS_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`T3 не выдал вход в канал: ${response.status}`);
    const { ticket } = await response.json();
    const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=${t3.PROTOCOL_VERSION}`);
    const gen = { origin, token: session.token, sessionId: session.sessionId, socket, users: 0, retired: false, pending: new Map(), nextId: 2 };
    live.add(gen);

    return new Promise((resolve, reject) => {
      const fail = setTimeout(() => retireBroken(gen, new Error('T3 не прислал список чатов')), t3.WS_TIMEOUT_MS);
      gen.settle = (error) => {
        clearTimeout(fail);
        if (error) reject(error);
        else resolve(gen);
      };
      socket.onopen = () => {
        // Смена ключа продолжает с последнего события, без нового полного снимка;
        // отметка synchronized — догнали, копии можно верить.
        const payload = mirror ? { afterSequence: sequence, requestCompletionMarker: true } : { requestCompletionMarker: true };
        socket.send(JSON.stringify({ _tag: 'Request', id: '1', tag: 'orchestration.subscribeShell', headers: [], payload }));
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

        if (frame?._tag === 'Chunk' && String(frame.requestId) === '1') {
          socket.send(JSON.stringify({ _tag: 'Ack', requestId: '1' }));
          for (const item of frame.values || []) {
            if (item?.kind === 'synchronized') {
              // Новое поколение догнало — становится текущим, прежнее уходит.
              if (current !== gen && mirror) {
                const previous = current;
                current = gen;
                if (previous) retire(previous);
                gen.settle();
              }
              continue;
            }

            // Пока живут два поколения, оба приносят одни события: применяется
            // только то, что новее уже учтённого (снимки — всегда).
            if (item?.kind !== 'snapshot' && itemSequence(item) <= sequence) continue;
            // Дополнение проектов несёт номер «по сей день» и курсор не двигает:
            // при догонке оно приходит раньше пропущенных событий чатов.
            mirror = applyShellItem(mirror, item);
            sequence = nextSequence(sequence, item);
          }
          return;
        }

        // Подписка закончилась (T3 перезапускается) — поколение больше не живое.
        if (frame?._tag === 'Exit' && String(frame.requestId) === '1') {
          retireBroken(gen, new Error('T3 закрыл подписку'));
          return;
        }

        const wait = frame?._tag === 'Exit' ? gen.pending.get(String(frame.requestId)) : null;
        if (!wait) return;
        gen.pending.delete(String(frame.requestId));
        if (frame.exit?._tag === 'Success') wait.resolve(frame.exit.value);
        else wait.reject(new Error(`T3 отклонил команду: ${JSON.stringify(frame.exit?.cause || frame.exit || {}).slice(0, 300)}`));
      };
      socket.onclose = () => retireBroken(gen, new Error('канал T3 закрылся'));
    });
  }

  function retireBroken(gen, error) {
    gen.settle?.(error);
    if (gen === current) current = null;
    gen.users = 0;
    retire(gen);
    if (!current && !connecting) schedule(retryMs);
  }

  async function connect() {
    if (connecting) return;
    connecting = true;
    try {
      const origin = t3.serverOrigin();
      const session = await t3.issueSession();
      try {
        await open(origin, session);
      } catch (error) {
        t3.revokeSession(session.sessionId);
        throw error;
      }

      retryMs = RETRY_MIN_MS;
      schedule(ROTATE_MS);
    } catch (error) {
      log(`связь с T3: ${error?.message || error}`);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      if (!current) schedule(retryMs);
      else schedule(RETRY_MIN_MS);
    } finally {
      connecting = false;
    }
  }

  function request(gen, tag, payload) {
    if (gen.retired || gen.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('канал T3 закрыт'));
    }

    const id = String(gen.nextId++);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        gen.pending.delete(id);
        reject(new Error('T3 не ответил на команду'));
      }, t3.WS_TIMEOUT_MS);
      gen.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      gen.socket.send(JSON.stringify({ _tag: 'Request', id, tag, headers: [], payload }));
    });
  }

  async function withT3(work) {
    const gen = current;
    if (!gen || !mirror) {
      if (!connecting) connect();
      return t3.withT3(work);
    }

    gen.users += 1;
    try {
      return await work({
        shell: async () => mirror,
        thread: (threadId, view = 'bounded') => t3.getJson(gen.origin, gen.token, `/api/orchestration/threads/${encodeURIComponent(threadId)}/${view}`),
        dispatch: (command) => request(gen, 'orchestration.dispatchCommand', command),
      });
    } finally {
      gen.users -= 1;
      retire(gen);
    }
  }

  // Мост закрывается — ключи отзываются сразу, не дожидаясь пяти минут.
  function close() {
    clearTimeout(timer);
    for (const gen of live) {
      spawnSync(t3.T3_BIN, ['auth', 'session', 'revoke', gen.sessionId], { stdio: 'ignore', timeout: 5000 });
    }

    live.clear();
  }

  return { close, connect, withT3 };
}

module.exports = { applyShellItem, createT3Live, nextSequence };
