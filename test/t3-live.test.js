const test = require('node:test');
const assert = require('node:assert/strict');
const { applyShellItem, createT3Live, nextSequence } = require('../native_host/t3-live.js');
const t3Client = require('../native_host/t3-client.js');

const snapshot = (threads, projects = [{ id: 'p1', title: 'A' }]) => ({ kind: 'snapshot', snapshot: { schemaVersion: 2, snapshotSequence: 10, threads, archivedThreads: [], projects } });

test('копия списка чатов T3 следует событиям подписки как сервер', () => {
  let mirror = applyShellItem(null, { kind: 'thread.updated', sequence: 1, location: 'active', thread: { id: 't0' } });
  assert.equal(mirror, null, 'до полного снимка событиям не к чему примениться');

  mirror = applyShellItem(mirror, snapshot([{ id: 't1', title: 'старый' }]));
  const before = mirror;
  // Снимок с resolvedRepositoryIdentityRoots только дополняет проекты: чаты остаются.
  mirror = applyShellItem(mirror, { ...snapshot([], [{ id: 'p1', repositoryIdentity: 'r' }]), resolvedRepositoryIdentityRoots: ['/x'] });
  assert.deepEqual(mirror.threads, [{ id: 't1', title: 'старый' }]);
  assert.deepEqual(mirror.projects, [{ id: 'p1', title: 'A', repositoryIdentity: 'r' }]);

  mirror = applyShellItem(mirror, { kind: 'thread.updated', sequence: 11, location: 'active', thread: { id: 't1', title: 'новый' } });
  mirror = applyShellItem(mirror, { kind: 'thread.updated', sequence: 12, location: 'active', thread: { id: 't2' } });
  assert.deepEqual(mirror.threads.map((thread) => thread.title || thread.id), ['новый', 't2']);

  mirror = applyShellItem(mirror, { kind: 'thread.updated', sequence: 13, location: 'archive', thread: { id: 't2' } });
  assert.deepEqual(mirror.threads.map((thread) => thread.id), ['t1']);
  assert.deepEqual(mirror.archivedThreads.map((thread) => thread.id), ['t2']);

  mirror = applyShellItem(mirror, { kind: 'thread.removed', sequence: 14, location: 'active', threadId: 't1' });
  mirror = applyShellItem(mirror, { kind: 'project.updated', sequence: 15, project: { id: 'p2' } });
  mirror = applyShellItem(mirror, { kind: 'project.removed', sequence: 16, projectId: 'p1' });
  assert.deepEqual(mirror.threads, []);
  assert.deepEqual(mirror.projects, [{ id: 'p2' }]);
  // Запоздалое дополнение удалённый проект не возвращает.
  mirror = applyShellItem(mirror, { ...snapshot([], [{ id: 'p1', repositoryIdentity: 'r2' }]), resolvedRepositoryIdentityRoots: ['/x'] });
  assert.deepEqual(mirror.projects, [{ id: 'p2' }]);

  // Прежняя копия не меняется: побудка, взявшая её, видит целый снимок.
  assert.deepEqual(before.threads, [{ id: 't1', title: 'старый' }]);
  // Полный снимок заменяет всё.
  assert.deepEqual(applyShellItem(mirror, snapshot([{ id: 't9' }])).threads, [{ id: 't9' }]);
});

test('без живой связи побудка идёт старым путём', async () => {
  const logs = [];
  const live = createT3Live({
    log: (line) => logs.push(line),
    t3: {
      serverOrigin: () => { throw new Error('T3 Code не запущен на этом маке'); },
      withT3: async (work) => work({ shell: async () => ({ via: 'old' }) }),
    },
  });
  const result = await live.withT3((api) => api.shell());
  assert.deepEqual(result, { via: 'old' });
  live.close();
  assert.match(logs.join('\n'), /T3 Code не запущен/);
});

test('курсор догонки двигают события и полный снимок, но не дополнение проектов', () => {
  assert.equal(nextSequence(5, { kind: 'thread.updated', sequence: 7 }), 7);
  assert.equal(nextSequence(7, { kind: 'thread.updated', sequence: 6 }), 7);
  assert.equal(nextSequence(9, snapshot([])), 10);
  // При догонке сервер шлёт дополнение с номером «по сей день» раньше пропущенных событий.
  assert.equal(nextSequence(5, { ...snapshot([]), resolvedRepositoryIdentityRoots: ['/x'] }), 5);
});

// Будильщик больше не ходит в T3, но файл ещё не удалён (уберём после живой проверки Claude Code).
test('одна побудка — одни и те же номера команд: повтор не создаёт второе сообщение', () => {
  const first = t3Client.messageCommand({ seed: 'w1', threadId: 't', text: 'x' });
  const again = t3Client.messageCommand({ seed: 'w1', threadId: 't', text: 'x' });
  assert.equal(first.commandId, again.commandId);
  assert.equal(first.messageId, again.messageId);
  assert.match(first.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Побудка — служебное сообщение: T3 не считает его сообщением пользователя.
  assert.equal(first.creationSource, 'server');
});
