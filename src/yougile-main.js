// YouGile в MAIN world: чаты из памяти приложения (window.api — его же объект для
// скриптов компании) → yougile-content.js → мост. Новое приходит событием синхронизации
// приложения; раз в минуту — сверка на случай пропуска. Тут же руки панели черновика:
// «Ответить»/«Цитировать» на сообщение и текст в поле. Отправляет всегда пользователь.
(function initYougileMain() {
  'use strict';

  const core = globalThis.KphYougileCore;
  const SOURCE = 'kph-yougile-main';
  const COMMAND_SOURCE = 'kph-yougile-panel';
  const SCAN_MS = 60 * 1000;
  // Сорвавшееся сохранение (мост не ответил) повторяется полной выгрузкой.
  const RESEND_MS = 10 * 60 * 1000;
  if (!core || window.top !== window) return;

  const saved = new Map();
  const inFlight = new Set();
  let scanTimer = null;
  let resendAt = Date.now() + RESEND_MS;

  function app() {
    const api = window.api;
    return api?.Sync?.listSandboxes && api.ChatUtils?.getPersonalAndGroupChatsFromSandboxes && api.SyncEvents?.addAnyListener ? api : null;
  }

  function post(message) {
    window.postMessage({ source: SOURCE, ...message }, window.location.origin);
  }

  function companyTitle(sandbox) {
    const hub = Object.values(sandbox.entities || {}).find((item) => item && sandbox.getType(item) === 'company');
    return hub?.title || '';
  }

  // Все чаты, которые видит пользователь: групповые, личные и чаты задач. Личный чат
  // лежит в «Profile», а не в компании: его ключи — по каждой компании собеседника.
  function listChats(api) {
    const sandboxes = api.Sync.listSandboxes({ withMessenger: true });
    const profileId = api.Sync.getProfile?.()?.companyId || null;
    const companies = sandboxes.filter((sandbox) => sandbox.companyId !== profileId);
    const titles = new Map(companies.map((sandbox) => [sandbox.companyId, companyTitle(sandbox)]));
    const keyFor = (companyId, chatId) => core.dialogKey(titles.get(companyId), companyId, chatId);
    // Имя — как его показывает сам мессенджер; у записи сотрудника в title лежит его номер.
    const userName = (id) => {
      const name = id ? api.Accounts?.getName?.(id) : null;
      return name && name !== '—' && name !== id ? name : null;
    };
    const chats = [];
    const add = (hub, companyIds, title, hash) => {
      const keys = companyIds.map((companyId) => keyFor(companyId, hub.id || hub.realId)).filter(Boolean);
      if (keys.length === 0 || !hub?.chat?.messages) return;
      chats.push({ hub, keys, title, url: `https://ru.yougile.com/team/messenger#${hash}:${core.chatShortId(hub.id || hub.realId)}`, userName });
    };

    const { userChats, groupChats } = api.ChatUtils.getPersonalAndGroupChatsFromSandboxes(sandboxes, { personal: true, groupChats: true });
    for (const chat of groupChats) {
      add(api.Sync.get({ companyId: chat.companyId }, true)?.entities?.[chat.chatId], [chat.companyId], `${titles.get(chat.companyId)} · ${chat.chatName}`, 'chat');
    }

    for (const chat of userChats) {
      if (chat.isSavedMessages) continue;
      const own = companies.filter((sandbox) => sandbox.isUserInCompany?.(chat.userId));
      const hub = api.Sync.get({ companyId: chat.companyId }, true)?.entities?.[chat.chatId];
      add(hub, own.map((sandbox) => sandbox.companyId), `${own.map((sandbox) => titles.get(sandbox.companyId)).join(', ')} · личный чат с ${chat.userName || chat.chatName}`, 'direct');
    }

    for (const sandbox of companies) {
      for (const hub of Object.values(sandbox.entities || {})) {
        if (hub?.chat?.messages?.size > 0 && sandbox.getType(hub) === 'task') {
          add(hub, [sandbox.companyId], `${titles.get(sandbox.companyId)} · задача «${hub.title || ''}»`, 'chat');
        }
      }
    }

    return chats;
  }

  function toDialog(api, chat) {
    const messages = core.normalizeMessages([...chat.hub.chat.messages.values()], chat.userName);
    if (messages.length === 0) return null;
    const [key, ...alternatives] = chat.keys;
    const selfId = api.globals?.currentUserId || null;
    // Последнее прочитанное в YouGile: при первой записи чата старое прочитанное не будит агента.
    // Так же считает сам YouGile: сообщения старше 100 дней — прочитанные.
    const seenAt = selfId ? Number(chat.hub.chat.getLastSeenMessage?.(selfId)) || 0 : 0;
    return {
      key,
      alternatives,
      source: 'yougile',
      title: chat.title,
      url: chat.url,
      selfId,
      seenUntil: seenAt > 0 ? new Date(seenAt).toISOString() : null,
      updatedAt: new Date().toISOString(),
      messages,
    };
  }

  function scan() {
    const api = app();
    if (!api) return;
    if (Date.now() >= resendAt) {
      saved.clear();
      inFlight.clear();
      resendAt = Date.now() + RESEND_MS;
    }

    let chats = [];
    try {
      chats = listChats(api);
    } catch {
      // Приложение ещё не собрало данные — следующий раз.
      return;
    }

    for (const chat of chats) {
      const dialog = toDialog(api, chat);
      if (!dialog) continue;
      const signature = JSON.stringify(dialog.messages.map((message) => [message.id, message.text, message.replyTo?.id]));
      if (saved.get(dialog.key) === signature || inFlight.has(dialog.key)) continue;
      inFlight.add(dialog.key);
      post({ kind: 'dialog', dialog, signature });
    }
  }

  function schedule() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 500);
  }

  // ---------- руки панели черновика ----------

  function editorField() {
    const fields = [...document.querySelectorAll('.chat-item-input .ck-editor__editable')];
    return fields.find((field) => field.ckeditorInstance && field.isConnected)?.ckeditorInstance || null;
  }

  function editorText(editor) {
    return core.htmlToText(editor?.getData?.() || '');
  }

  function same(left, right) {
    const flat = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    return flat(left) === flat(right);
  }

  function openedChat(api) {
    const hub = api.ChatUtils.getOpenedChatHub?.();
    if (!hub) return null;
    const id = hub.id || hub.realId;
    const chat = listChats(api).find((item) => (item.hub.id || item.hub.realId) === id);
    return chat ? { hub, chat } : null;
  }

  function state() {
    const api = app();
    const opened = api ? openedChat(api) : null;
    if (!opened) return { chat: null };
    const editor = editorField();
    return {
      chat: { id: opened.hub.id || opened.hub.realId, keys: opened.chat.keys, selfId: api.globals?.currentUserId || null },
      field: editorText(editor),
      hasField: Boolean(editor),
    };
  }

  // mode: reply — «Ответить» на сообщение, quote — ответ с цитатой куска, plain — без ответа.
  // В поле свой текст пользователя — не трогаем без второго нажатия (force).
  function prepare({ chatId, mode, targetId, snippet, text, previous, force }) {
    const api = app();
    const opened = api ? openedChat(api) : null;
    if (!opened || (opened.hub.id || opened.hub.realId) !== chatId) return { ok: false, reason: 'chat', message: 'Откройте чат этого черновика' };
    const editor = editorField();
    if (!editor) return { ok: false, reason: 'field', message: 'Не нашёл поле ввода сообщения' };
    const current = editorText(editor);
    if (current && !force && !same(current, previous) && !same(current, text)) {
      return { ok: false, reason: 'busy', message: 'В поле уже есть ваш текст. Нажмите ещё раз, чтобы заменить его' };
    }

    const hubId = opened.hub.id || opened.hub.realId;
    let target;
    if (mode === 'reply' || mode === 'quote') {
      target = opened.hub.chat.messages.get(Number(targetId)) || opened.hub.chat.messages.get(String(targetId));
      if (!target) return { ok: false, reason: 'target', message: 'Сообщение не загружено в чате — прокрутите переписку выше' };
    }

    // Тот же путь, что у пунктов «Ответить» и «Цитировать» в меню сообщения: без цели — ответ снимается.
    api.EventBus.dispatch(api.events.chatQuoteRequestedEvent(target, mode === 'quote' && snippet ? core.textToHtml(snippet) : undefined, hubId));
    editor.setData(core.textToHtml(text));
    editor.model.change((writer) => writer.setSelection(writer.createPositionAt(editor.model.document.getRoot(), 'end')));
    editor.editing.view.focus();
    return { ok: true };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.source !== COMMAND_SOURCE) return;
    if (data.kind === 'saved') {
      inFlight.delete(data.key);
      if (data.ok) saved.set(data.key, data.signature);
      return;
    }

    let result;
    try {
      result = data.kind === 'state' ? state() : data.kind === 'prepare' ? prepare(data) : null;
    } catch (error) {
      result = { ok: false, reason: 'error', message: `Не получилось: ${error?.message || error}` };
    }

    if (result) post({ kind: 'result', requestId: data.requestId, result });
  });

  // Приложение собирает window.api после загрузки страницы — ждём его до минуты.
  let waited = 0;
  const boot = setInterval(() => {
    const api = app();
    waited += 1;
    if (!api && waited < 60) return;
    clearInterval(boot);
    if (!api) return;
    api.SyncEvents.addAnyListener(schedule, { debounceTime: 1000, label: 'kph-yougile' });
    setInterval(scan, SCAN_MS);
    scan();
  }, 1000);
})();
