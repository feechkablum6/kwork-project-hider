// YouGile в изолированном мире: передаёт чаты из yougile-main.js мосту и показывает
// панель «Черновик агента» над полем ввода открытого чата. Части и их состояние — та же
// логика, что на Kwork (reply-core.js); кнопка ставит «Ответить»/«Цитировать» и текст
// в поле, а отправляет всегда пользователь.
(function initYougileContent() {
  'use strict';

  const reply = globalThis.KworkReplyCore;
  const yougile = globalThis.KphYougileCore;
  if (!reply || !yougile || window.top !== window || !globalThis.chrome?.runtime?.sendMessage) return;

  const MAIN_SOURCE = 'kph-yougile-main';
  const COMMAND_SOURCE = 'kph-yougile-panel';
  const SKIPS_KEY = 'replyPanelSkips';
  const COLLAPSED_KEY = 'replyPanelCollapsed';
  const POLL_MS = 4000;
  const FORCE_WINDOW_MS = 15000;
  const REQUEST_MS = 5000;

  const waiting = new Map();
  let snapshot = null;
  let chat = null;
  let skips = {};
  let collapsed = false;
  let panel = null;
  let signature = '';
  let status = { text: '', tone: '' };
  let pending = false;
  let force = null;
  // Что панель последней вставила в поле этого чата: свою прошлую вставку она меняет сама.
  const inserted = {};

  function alive() {
    return Boolean(globalThis.chrome?.runtime?.id);
  }

  function send(message) {
    return new Promise((resolve) => {
      if (!alive()) return resolve(null);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError;
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function askMain(kind, payload = {}) {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        resolve(null);
      }, REQUEST_MS);
      waiting.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      window.postMessage({ source: COMMAND_SOURCE, kind, requestId, ...payload }, window.location.origin);
    });
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.source !== MAIN_SOURCE) return;
    if (data.kind === 'result') {
      const done = waiting.get(data.requestId);
      waiting.delete(data.requestId);
      done?.(data.result);
      return;
    }

    // Сообщение могла прислать и сама страница: дальше идут только ключи чатов YouGile.
    if (data.kind === 'dialog' && yougile.isDialogKey(data.dialog?.key)) {
      const response = await send({ type: 'kph-yougile-dialog', dialog: data.dialog });
      window.postMessage({ source: COMMAND_SOURCE, kind: 'saved', key: data.dialog.key, signature: data.signature, ok: Boolean(response?.ok) }, window.location.origin);
    }
  });

  // ---------- черновик ----------

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (result) => {
          void chrome.runtime.lastError;
          resolve(result || {});
        });
      } catch {
        resolve({});
      }
    });
  }

  function storageSet(values) {
    try {
      chrome.storage.local.set(values, () => void chrome.runtime.lastError);
    } catch {
      // Расширение перезагружено — пропуск запомнится после обновления страницы.
    }
  }

  function currentDraft() {
    const draft = snapshot?.draft;
    return draft ? { ...draft, skipped: skips[draft.id] || [] } : null;
  }

  function progressOf(draft) {
    return draft ? reply.draftProgress(draft, snapshot.messages || [], {
      clientId: snapshot.clientId || null,
      dialogKey: snapshot.dialogKey || null,
      selfId: snapshot.selfId || chat?.selfId || null,
      events: [],
    }) : null;
  }

  async function refresh() {
    if (document.hidden || !alive()) return;
    const state = await askMain('state');
    chat = state?.chat || null;
    let found = null;
    for (const key of (chat?.keys || []).filter(yougile.isDialogKey)) {
      const response = await send({ type: 'kph-get-draft', dialogKey: key });
      if (response?.draft) {
        found = response;
        break;
      }
    }

    const before = snapshot?.draft?.id || null;
    snapshot = found;
    if ((snapshot?.draft?.id || null) !== before) status = { text: '', tone: '' };
    render();
  }

  // ---------- панель ----------

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, onClick) {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function anchor() {
    return document.querySelector('.chat-item-input');
  }

  function remove() {
    panel?.remove();
    panel = null;
    signature = '';
  }

  function render() {
    const draft = currentDraft();
    const progress = progressOf(draft);
    const target = anchor();
    if (!draft || !progress || progress.stale || progress.finished || !target?.parentElement) {
      remove();
      return;
    }

    const view = reply.panelView(draft, progress);
    const nextSignature = JSON.stringify([view, collapsed, status, pending]);
    if (panel?.isConnected && panel.nextElementSibling === target && signature === nextSignature) return;
    signature = nextSignature;

    const root = element('section', `kph-draft kph-draft--yougile${collapsed ? ' kph-draft--collapsed' : ''}`);
    root.setAttribute('aria-label', 'Черновик агента');
    const head = element('div', 'kph-draft__head');
    head.append(element('span', 'kph-draft__title', view.title));
    if (view.counter) head.append(element('span', 'kph-draft__counter', view.counter));
    const toggle = button('kph-draft__link', collapsed ? 'Показать части' : 'Свернуть', () => {
      collapsed = !collapsed;
      storageSet({ [COLLAPSED_KEY]: collapsed });
      render();
    });
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const dismiss = button('kph-draft__link', 'Скрыть черновик', () => {
      skips[draft.id] = draft.parts.map((part) => part.n);
      storageSet({ [SKIPS_KEY]: trimSkips(skips) });
      render();
    });
    head.append(toggle, dismiss);
    root.append(head);

    if (!collapsed) {
      const list = element('ol', 'kph-draft__parts');
      for (const row of view.rows) {
        const item = element('li', `kph-draft__part kph-draft__part--${row.state}`);
        if (row.state === 'current') item.setAttribute('aria-current', 'step');
        const number = element('span', 'kph-draft__num', row.state === 'done' ? '' : row.state === 'skipped' ? '–' : String(row.n));
        number.setAttribute('aria-label', row.state === 'done' ? `Часть ${row.n} отправлена` : row.state === 'skipped' ? `Часть ${row.n} пропущена` : `Часть ${row.n}`);
        const body = element('div', 'kph-draft__body');
        const line = element('div', 'kph-draft__line');
        line.append(element('span', 'kph-draft__mode', row.label));
        if (row.target) line.append(element('span', 'kph-draft__target kph-draft__target--static', row.target));
        if (row.state === 'skipped') line.append(element('span', 'kph-draft__flag', 'пропущена'));
        body.append(line);
        if (row.text) body.append(element('div', 'kph-draft__text', row.text));
        item.append(number, body);
        list.append(item);
      }

      root.append(list);
    }

    const actions = element('div', 'kph-draft__actions');
    if (progress.current) {
      const prepare = button('kph-draft__prepare', pending ? 'Готовлю…' : view.button, () => prepareCurrent());
      prepare.disabled = pending;
      const skip = button('kph-draft__skip', 'Пропустить', () => skipCurrent());
      skip.disabled = pending;
      actions.append(prepare, skip);
    }

    const live = element('span', `kph-draft__status${status.tone ? ` kph-draft__status--${status.tone}` : ''}`, status.text);
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    actions.append(live);
    root.append(actions);

    const focused = panel?.contains(document.activeElement) ? document.activeElement.className : null;
    if (panel?.isConnected) panel.remove();
    target.parentElement.insertBefore(root, target);
    panel = root;
    if (focused) panel.querySelector(`.${String(focused).split(' ')[0]}`)?.focus({ preventScroll: true });
  }

  function setStatus(text, tone = '') {
    status = { text, tone };
    render();
  }

  function trimSkips(all) {
    return Object.fromEntries(Object.entries(all).slice(-30));
  }

  function skipCurrent() {
    const draft = currentDraft();
    const progress = progressOf(draft);
    if (!draft || !progress?.current) return;
    skips[draft.id] = [...new Set([...(skips[draft.id] || []), progress.current.n])];
    storageSet({ [SKIPS_KEY]: trimSkips(skips) });
    status = { text: '', tone: '' };
    force = null;
    render();
  }

  async function prepareCurrent() {
    const draft = currentDraft();
    const part = progressOf(draft)?.current;
    if (!draft || !part || pending || !chat) return;
    let targetId = null;
    let twinAuthor = null;
    if (part.mode === 'reply' || part.mode === 'quote') {
      const matches = part.target ? reply.matchingMessages(snapshot.messages || [], part.target, {
        clientId: snapshot.clientId || null,
        dialogKey: snapshot.dialogKey || null,
        selfId: snapshot.selfId || chat.selfId || null,
      }) : [];
      const message = matches.at(-1);
      if (!message) {
        setStatus('Не нашёл сообщение, на которое отвечает эта часть. Ответьте вручную или пропустите часть', 'warn');
        return;
      }

      targetId = message.id;
      // Такой текст прислали несколько человек: черновик не говорит, кому из них ответ.
      if (new Set(matches.map((item) => item.authorId || item.authorName)).size > 1) {
        twinAuthor = message.authorName || 'последнего написавшего';
      }
    }

    const forced = Boolean(force && force.draftId === draft.id && force.n === part.n && Date.now() < force.until);
    pending = true;
    render();
    const result = await askMain('prepare', {
      chatId: chat.id,
      mode: part.mode,
      targetId,
      snippet: part.mode === 'quote' ? part.target : null,
      text: part.text,
      previous: inserted[chat.id] || '',
      force: forced,
    });
    pending = false;
    if (result?.ok) {
      inserted[chat.id] = part.text;
      force = null;
      if (twinAuthor) {
        setStatus(`Часть ${part.n} в поле ответом на сообщение «${twinAuthor}»: такой же текст писали несколько человек. Если отвечаете другому, выберите его сообщение сами`, 'warn');
      } else {
        setStatus(`Часть ${part.n} в поле. Проверьте и отправьте сами`, 'ok');
      }
      return;
    }

    if (result?.reason === 'busy') force = { draftId: draft.id, n: part.n, until: Date.now() + FORCE_WINDOW_MS };
    setStatus(result?.message || 'Страница не ответила. Обновите её и попробуйте ещё раз', 'warn');
  }

  // Расширение перезапустилось: страница потеряла с ним связь, и чаты больше не сохраняются.
  // Поле пустое — вкладка обновляется сама (и скрытая, не чаще раза в минуту), иначе плашка и ждём отправки.
  const RELOAD_KEY = 'kphOrphanReloadAt';
  let notice = null;
  let emptySeen = false;
  function checkOrphan() {
    if (alive()) return false;
    remove();
    let lastReloadAt = 0;
    try {
      lastReloadAt = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
    } catch {
      // Хранилище вкладки недоступно — защита от обновлений по кругу слабее, но не нужна.
    }

    // Набранное в поле сообщения и выбранные файлы YouGile сам сохраняет в черновик чата, поэтому
    // мешают обновлению только редакторы с текстом и поле, где сейчас набирают (название задачи и т. п.):
    // заполненные поля без курсора — уже сохранённые значения, иначе вкладка не обновилась бы никогда.
    // Фокус берётся из activeElement: в скрытой вкладке он остаётся, а класс ck-focused CKEditor снимает.
    const active = document.activeElement;
    const typing = active?.matches?.('textarea, input:not([type]), input[type="text"]') ? [active.value] : [];
    const editable = active?.closest?.('[contenteditable="true"]');
    const editors = [...document.querySelectorAll('.chat-item-input .ck-editor__editable'), ...(editable ? [editable] : [])];
    const fields = [...editors.map((field) => field.innerHTML), ...typing];
    const action = reply.orphanAction({ fields, files: 0, lastReloadAt, now: Date.now() });
    // Поле опустело после плашки — возможно, YouGile очистил его по Enter, а отправка ещё идёт:
    // обновление, только если и на следующей проверке пусто.
    if (action === 'reload' && notice && !emptySeen) {
      emptySeen = true;
      return true;
    }

    if (action === 'reload') {
      try {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      } catch {
        // См. выше.
      }
      window.location.reload();
      return true;
    }

    emptySeen = false;
    showReloadNotice();
    return true;
  }

  function showReloadNotice() {
    const target = anchor();
    if (!target || (notice?.isConnected && notice.nextElementSibling === target)) return;
    notice?.remove();
    notice = element('section', 'kph-draft kph-draft--orphan');
    notice.setAttribute('aria-label', 'Черновик агента');
    const head = element('div', 'kph-draft__head');
    head.append(element('span', 'kph-draft__title', 'Расширение обновилось'));
    const actions = element('div', 'kph-draft__actions');
    actions.append(button('kph-draft__prepare', 'Обновить страницу', () => window.location.reload()));
    const text = element('span', 'kph-draft__status kph-draft__status--warn', 'Без обновления чаты YouGile не сохраняются и черновики агента здесь не появятся. Текст в поле сообщения YouGile сохранит сам, остальное набранное сначала сохраните.');
    text.setAttribute('role', 'status');
    actions.append(text);
    notice.append(head, actions);
    target.parentElement.insertBefore(notice, target);
  }

  storageGet([SKIPS_KEY, COLLAPSED_KEY]).then((stored) => {
    skips = stored[SKIPS_KEY] || {};
    collapsed = Boolean(stored[COLLAPSED_KEY]);
    refresh();
    setInterval(() => {
      if (!checkOrphan()) refresh();
    }, POLL_MS);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
})();
