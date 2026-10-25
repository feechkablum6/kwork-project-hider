// Панель «Черновик агента» над полем ввода на /inbox/<ник> и /track: части
// ответа агента по порядку, номера на сообщениях клиента, на которые отвечаем,
// подсветка куска под цитату и кнопка «Подготовить часть N». Кнопка только
// готовит: ставит «Ответить»/«Цитировать», вставляет текст или заполняет форму —
// отправляет всегда пользователь. Руки на странице — reply-main.js (MAIN world).
(function initKworkReplyPanel() {
  'use strict';

  const reply = globalThis.KworkReplyCore;
  const inbox = globalThis.KworkInboxCore;
  if (!reply || !/^\/(?:(?:new_)?inbox\/[^/]+|track)/.test(window.location.pathname) || !globalThis.chrome?.runtime?.sendMessage) {
    return;
  }

  const COMMAND_SOURCE = 'kph-reply-panel';
  const RESULT_SOURCE = 'kph-reply-main';
  const SKIPS_KEY = 'replyPanelSkips';
  const COLLAPSED_KEY = 'replyPanelCollapsed';
  const INSERTED_KEY = 'replyPanelInserted';
  const POLL_MS = 4000;
  const FORCE_WINDOW_MS = 15000;
  const HIGHLIGHT_NAME = 'kph-draft-quote';
  const isTrack = window.location.pathname === '/track';

  let snapshot = null;
  let progress = null;
  let skips = {};
  let collapsed = false;
  let panel = null;
  let signature = '';
  let pending = null;
  // Часть, которую панель сейчас печатает в поле, и подсказка на её конец.
  let typingFor = null;
  let status = { text: '', tone: '' };
  // Согласие заменить свой текст в поле — только для той части, где о нём спросили.
  let force = null;
  let decorateTimer = null;
  let pollTimer = null;
  let updateTimer = null;
  let loading = false;
  // Что панель последней вставила в поле этого диалога: агент поправил черновик —
  // свой устаревший текст панель меняет сама, а чужой (пользователя) не трогает.
  let inserted = {};
  let refreshedFor = null;
  // Текст своих сообщений на странице: блок сообщения Kwork не меняет.
  const pageTexts = new WeakMap();

  // ---------- данные ----------

  function pageContext() {
    if (!isTrack) {
      return { dialogKey: inbox?.extractDialogKey?.(window.location.href) || null, orderId: null };
    }

    return {
      dialogKey: document.documentElement.dataset.kphPeer || document.querySelector('.js-message-block[data-kph-peer]')?.dataset.kphPeer || null,
      orderId: new URLSearchParams(window.location.search).get('id'),
    };
  }

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

  function loadDraft() {
    const context = pageContext();
    if ((!context.dialogKey && !context.orderId) || loading) {
      return;
    }

    loading = true;
    try {
      chrome.runtime.sendMessage({ type: 'kph-get-draft', ...context }, (response) => {
        void chrome.runtime.lastError;
        loading = false;
        const before = snapshot?.draft?.id || null;
        snapshot = response?.draft ? response : null;
        update();
        const after = snapshot?.draft?.id || null;
        // Кнопку жали в ту же секунду — подмена повторится на следующем опросе.
        if (after && refreshedFor !== after) refreshField(Boolean(before) && before !== after);
      });
    } catch {
      // Расширение перезагружено: панель вернётся после обновления страницы, а до
      // тех пор старый черновик не висит — отправленное он бы уже не увидел.
      loading = false;
      stop();
      snapshot = null;
      progress = null;
      render();
    }
  }

  function dialogId() {
    return snapshot?.slug || snapshot?.dialogKey || null;
  }

  function lastInserted() {
    const id = dialogId();
    return id ? inserted[id] || null : null;
  }

  function remember(draft, part, applied) {
    const id = dialogId();
    if (!id || !['reply', 'quote', 'plain'].includes(part?.mode)) return;
    inserted = Object.fromEntries([...Object.entries(inserted).filter(([key]) => key !== id), [id, { draftId: draft.id, n: part.n, mode: applied || part.mode, target: part.target || null, text: part.text }]].slice(-30));
    storageSet({ [INSERTED_KEY]: inserted });
  }

  // Свои сообщения, которые Kwork уже показал: на диск они ложатся через секунды,
  // а отправленная часть должна закрыться сразу. Свои — по автору с диска; новый
  // диалог без своих сообщений — все, кроме клиента.
  function pageOwnMessages() {
    const clientId = snapshot?.clientId ? String(snapshot.clientId) : '';
    if (!clientId) return [];
    const mine = new Set((snapshot.messages || []).map((message) => String(message.authorId || '')).filter((id) => id && id !== clientId));
    const list = [];
    for (const block of document.querySelectorAll('.js-message-block[data-kph-key]')) {
      const [authorId, seconds] = String(block.dataset.kphKey).split(':');
      if (!authorId || authorId === clientId || (mine.size > 0 && !mine.has(authorId)) || !Number(seconds)) continue;
      let cached = pageTexts.get(block);
      if (!cached || cached.key !== block.dataset.kphKey) {
        // innerText, а не textContent: строки сообщения не слипаются в одно слово.
        cached = { key: block.dataset.kphKey, text: block.querySelector('.js-can-highlighted')?.innerText || '' };
        pageTexts.set(block, cached);
      }

      if (cached.text.trim()) list.push({ id: `page:${cached.key}`, time: new Date(Number(seconds) * 1000).toISOString(), authorId, text: cached.text });
    }

    return list;
  }

  function currentDraft() {
    if (!snapshot?.draft) return null;
    return { ...snapshot.draft, skipped: [...(snapshot.draft.skipped || []), ...(skips[snapshot.draft.id] || [])] };
  }

  function messageKey(message) {
    const seconds = Math.round((Date.parse(message?.time) || 0) / 1000);
    return message?.authorId && seconds ? `${message.authorId}:${seconds}` : null;
  }

  function targetMessage(part) {
    if (!part?.target || !snapshot) return null;
    return reply.findTargetMessage(snapshot.messages, part.target, { clientId: snapshot.clientId, dialogKey: snapshot.dialogKey });
  }

  // ---------- блоки сообщений на странице ----------

  function findBlock(part) {
    const blocks = [...document.querySelectorAll('.js-message-block')];
    const key = messageKey(targetMessage(part));
    const byKey = key ? blocks.find((block) => block.dataset.kphKey === key) : null;
    if (byKey) return byKey;
    const needle = reply.normalizeText(part.target);
    if (!needle) return null;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const text = blocks[index].querySelector('.js-can-highlighted')?.textContent || '';
      const [author] = String(blocks[index].dataset.kphKey || '').split(':');
      if (snapshot?.clientId && author && author !== String(snapshot.clientId)) continue;
      if (reply.normalizeText(text).includes(needle)) return blocks[index];
    }

    return null;
  }

  // Диапазон куска под цитату в тексте сообщения — для подсветки без правки DOM:
  // разметку сообщения Kwork сам читает при выделении, чужие узлы ему помешали бы.
  function fragmentRange(container, fragment) {
    const wanted = reply.normalizeText(fragment);
    if (!wanted) return null;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let flat = '';
    const map = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let offset = 0; offset < node.data.length; offset += 1) {
        const lower = node.data[offset].toLowerCase().replace('ё', 'е');
        const spaced = /[\s«»"“”„'`.,!?;:()[\]{}—–-]/.test(lower) ? ' ' : lower;
        if (spaced === ' ' && (flat.endsWith(' ') || flat === '')) continue;
        flat += spaced;
        map.push([node, offset]);
      }
    }

    const at = flat.indexOf(wanted);
    if (at < 0) return null;
    const range = document.createRange();
    range.setStart(map[at][0], map[at][1]);
    const end = map[at + wanted.length - 1];
    range.setEnd(end[0], end[1] + 1);
    return range;
  }

  function clearDecorations() {
    for (const badge of document.querySelectorAll('.kph-draft-badge')) badge.remove();
    for (const block of document.querySelectorAll('.kph-draft-target')) {
      block.classList.remove('kph-draft-target', 'kph-draft-target--current');
    }

    globalThis.CSS?.highlights?.delete(HIGHLIGHT_NAME);
  }

  let decorated = '';

  function decorate() {
    decorateTimer = null;
    const draft = currentDraft();
    if (!draft || !progress || progress.stale || progress.finished) {
      if (decorated) clearDecorations();
      decorated = '';
      return;
    }

    const done = new Set(progress.done);
    const plan = draft.parts
      .filter((part) => !done.has(part.n) && ['reply', 'quote'].includes(part.mode))
      .map((part) => ({ part, block: findBlock(part) }))
      .filter((item) => item.block);
    const planKey = JSON.stringify(plan.map(({ part, block }) => [part.n, block.dataset.kphKey || '', progress.current?.n === part.n]));
    const intact = plan.every(({ block }) => block.isConnected && block.querySelector(':scope > .kph-draft-badge'));
    if (planKey === decorated && intact) return;
    clearDecorations();
    decorated = planKey;
    const ranges = [];
    for (const { part, block } of plan) {
      const current = progress.current?.n === part.n;
      block.classList.add('kph-draft-target');
      if (current) block.classList.add('kph-draft-target--current');
      const badge = document.createElement('span');
      badge.className = `kph-draft-badge${current ? ' kph-draft-badge--current' : ''}`;
      badge.textContent = String(part.n);
      badge.title = `Часть ${part.n} черновика агента: ${reply.MODE_LABELS[part.mode]}`;
      block.append(badge);
      if (part.mode === 'quote') {
        const container = block.querySelector('.js-can-highlighted');
        const range = container ? fragmentRange(container, part.target) : null;
        if (range) ranges.push(range);
      }
    }

    if (ranges.length > 0 && globalThis.Highlight && globalThis.CSS?.highlights) {
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
    }
  }

  // Свои узлы (панель, номера) не повод перерисовываться: иначе цикл.
  function isOwnNode(node) {
    return node.nodeType === 1 && (node.classList.contains('kph-draft-badge') || node.classList.contains('kph-draft'));
  }

  function isOwnMutation(mutation) {
    if (panel?.contains(mutation.target)) return true;
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return nodes.length > 0 && nodes.every(isOwnNode);
  }

  function scheduleDecorate() {
    if (!decorateTimer) decorateTimer = setTimeout(decorate, 300);
  }

  // ---------- панель ----------

  function anchor() {
    if (isTrack) {
      const field = document.querySelector('#message_body1');
      return field?.closest('.js-mf-general-part') || field?.closest('form') || null;
    }

    return document.querySelector('#message_form_wrapper');
  }

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

  function scrollToPart(part) {
    const block = findBlock(part);
    if (block) {
      block.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } else {
      setStatus('Это сообщение клиента не загружено на странице — прокрутите переписку выше', 'warn');
    }
  }

  function render() {
    const draft = currentDraft();
    const target = anchor();
    if (!draft || !progress || progress.stale || progress.finished || !target) {
      panel?.remove();
      panel = null;
      clearDecorations();
      return;
    }

    const view = reply.panelView(draft, progress);
    const nextSignature = JSON.stringify([view, collapsed, status, pending ? pending.n : null]);
    if (panel?.isConnected && panel.parentElement === target.parentElement && signature === nextSignature) {
      return;
    }

    signature = nextSignature;
    const root = element('section', `kph-draft${collapsed ? ' kph-draft--collapsed' : ''}`);
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
      stopTyping();
      skips[draft.id] = draft.parts.map((part) => part.n);
      storageSet({ [SKIPS_KEY]: trimSkips(skips) });
      update();
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
        if (row.target) {
          const part = draft.parts.find((item) => item.n === row.n);
          if (['reply', 'quote'].includes(row.mode)) {
            const jump = button('kph-draft__target', row.target, () => scrollToPart(part));
            jump.title = 'Показать сообщение клиента';
            line.append(jump);
          } else {
            line.append(element('span', 'kph-draft__target kph-draft__target--static', row.target));
          }
        }

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
      const prepare = button('kph-draft__prepare', pending ? 'Готовлю…' : typingFor?.n === progress?.current?.n ? 'Вставить сразу' : view.button, () => prepareCurrent());
      prepare.disabled = Boolean(pending);
      const skip = button('kph-draft__skip', 'Пропустить', () => skipCurrent());
      skip.disabled = Boolean(pending);
      actions.append(prepare, skip);
    }

    const live = element('span', `kph-draft__status${status.tone ? ` kph-draft__status--${status.tone}` : ''}`, status.text);
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    actions.append(live);
    root.append(actions);

    const focused = panel?.contains(document.activeElement) ? document.activeElement.className : null;
    if (panel?.isConnected) {
      panel.replaceWith(root);
    } else {
      target.parentElement.insertBefore(root, target);
    }

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

  // Пропущенную или скрытую часть панель не допечатывает.
  function stopTyping() {
    if (!typingFor) return;
    typingFor = null;
    window.postMessage({ source: COMMAND_SOURCE, kind: 'stop-typing' }, window.location.origin);
  }

  function skipCurrent() {
    const draft = currentDraft();
    if (!draft || !progress?.current) return;
    stopTyping();
    skips[draft.id] = [...new Set([...(skips[draft.id] || []), progress.current.n])];
    storageSet({ [SKIPS_KEY]: trimSkips(skips) });
    status = { text: '', tone: '' };
    force = null;
    update();
  }

  function prepareCurrent({ onlyIf = null } = {}) {
    const draft = currentDraft();
    const part = progress?.current;
    if (!draft || !part || pending) return;
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const forced = Boolean(force && force.draftId === draft.id && force.n === part.n && Date.now() < force.until);
    const last = lastInserted();
    pending = { requestId, n: part.n, auto: Boolean(onlyIf) };
    status = { text: '', tone: '' };
    render();
    window.postMessage({
      source: COMMAND_SOURCE,
      kind: 'prepare',
      requestId,
      mode: part.mode,
      key: messageKey(targetMessage(part)),
      target: part.target,
      text: part.text,
      fields: part.fields || null,
      // По кнопке текст набирается по знаку: клиент видит «печатает».
      steps: onlyIf ? null : reply.typingSteps(part.text),
      force: forced,
      // Свой текст прошлого черновика в поле — тоже не пользовательский: заменяется сразу.
      known: [...draft.parts.filter((item) => ['reply', 'quote', 'plain'].includes(item.mode)).map((item) => item.text), ...(last ? [last.text] : [])],
      onlyIf,
    }, window.location.origin);
    // Ответа нет — страница сменилась или Kwork завис: кнопка не залипает.
    setTimeout(() => {
      if (pending?.requestId === requestId) {
        pending = null;
        setStatus('Kwork не ответил. Обновите страницу и попробуйте ещё раз', 'warn');
      }
    }, 8000);
  }

  // Агент прислал новый черновик. В поле ещё текст, который панель вставила из
  // прошлого, и пользователь его не правил: подготовить новую часть так же, как
  // по кнопке (отправляет по-прежнему пользователь). Свой текст пользователя,
  // пустое поле, предложение и опция — только подсказка, поле не трогается.
  function refreshField(changed) {
    const draft = currentDraft();
    const part = progress?.current;
    const last = lastInserted();
    if (!draft || refreshedFor === draft.id || pending) return;
    refreshedFor = draft.id;
    if (!part || progress.stale || progress.finished) return;
    if (changed) setStatus('Агент обновил черновик', 'ok');
    if (!last || last.draftId === draft.id || !['reply', 'quote', 'plain'].includes(part.mode)) return;
    const flat = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    // Поправлен хоть один знак — поле обновляется.
    if (flat(last.text) === flat(part.text) && last.mode === part.mode && (last.target || null) === (part.target || null)) {
      remember(draft, part, last.mode);
      return;
    }

    prepareCurrent({ onlyIf: last.text });
  }

  const DONE_TEXT = {
    reply: 'Готово: «Ответить» и текст в поле. Проверьте и нажмите «Отправить»',
    quote: 'Готово: цитата и текст в поле. Проверьте и нажмите «Отправить»',
    plain: 'Готово: текст в поле. Проверьте и нажмите «Отправить»',
    offer: 'Форма предложения заполнена. Проверьте и нажмите «Предложить»',
    option: 'Опция заполнена. Проверьте и нажмите «Предложить услуги»',
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== RESULT_SOURCE || event.data.kind !== 'prepared') return;
    if (event.data.requestId !== pending?.requestId) return;
    const draft = currentDraft();
    const part = draft?.parts.find((item) => item.n === pending.n);
    const auto = pending.auto;
    pending = null;
    // В поле уже не тот текст, что вставляла панель: его не трогаем.
    if (event.data.quiet) {
      if (auto) setStatus('Агент обновил черновик', 'ok');
      return;
    }

    if (event.data.busy) {
      force = part ? { draftId: draft.id, n: part.n, until: Date.now() + FORCE_WINDOW_MS } : null;
      setStatus(event.data.error, 'warn');
      return;
    }

    force = null;
    if (!event.data.ok) {
      setStatus(event.data.error || 'Не получилось подготовить часть', 'warn');
      return;
    }

    if (draft && part) remember(draft, part, event.data.applied);
    // Цитату поставить не вышло — подсказка про «Ответить» была бы неправдой.
    const base = auto
      ? 'Агент поправил черновик: в поле уже новый текст. Проверьте и нажмите «Отправить»'
      : DONE_TEXT[event.data.applied || part?.mode] || DONE_TEXT.plain;
    const note = event.data.note ? `${event.data.note[0].toUpperCase()}${event.data.note.slice(1)}` : '';
    const done = { text: note ? `${base}. ${note}` : base, tone: event.data.warn ? 'warn' : 'ok' };
    typingFor = event.data.typing ? { requestId: event.data.requestId, n: part?.n, done } : null;
    if (typingFor) {
      setStatus(note ? `Печатаю в поле… ${note}` : 'Печатаю в поле…', done.tone);
    } else {
      setStatus(done.text, done.tone);
    }
  });

  // Печать в поле закончилась: вся часть набрана или пользователь начал править поле.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== RESULT_SOURCE || event.data.kind !== 'typed') return;
    if (event.data.requestId !== typingFor?.requestId) return;
    const { done } = typingFor;
    typingFor = null;
    if (event.data.done) {
      setStatus(done.text, done.tone);
    } else if (event.data.empty) {
      // Поле опустело раньше конца: могла уйти только часть текста. Подсказка не гаснет со сменой части.
      status = { text: 'Поле очистилось до конца печати. Проверьте, что ушло клиенту', tone: 'warn', sticky: true };
      render();
    } else {
      setStatus('Печать остановлена: поле изменилось', 'warn');
    }
  });

  // ---------- цикл ----------

  function update() {
    const draft = currentDraft();
    const previous = progress?.current?.n ?? null;
    const messages = draft ? reply.withPageMessages(snapshot.messages, pageOwnMessages()) : [];
    progress = draft ? reply.draftProgress(draft, messages, { clientId: snapshot.clientId, dialogKey: snapshot.dialogKey, events: snapshot.events }) : null;
    // Часть ушла — подсказка о ней больше не нужна.
    if ((progress?.current?.n ?? null) !== previous && !pending && !status.sticky) status = { text: '', tone: '' };
    render();
    scheduleDecorate();
  }

  function poll() {
    if (document.visibilityState === 'visible') loadDraft();
  }

  // Kwork дорисовал своё сообщение (или ticks-main подписал блок) — пересчитать,
  // что уже ушло; пачка изменений — один пересчёт.
  function scheduleUpdate() {
    if (!updateTimer) {
      updateTimer = setTimeout(() => {
        updateTimer = null;
        if (snapshot?.draft) update();
      }, 250);
    }
  }

  function stop() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async function start() {
    const stored = await storageGet([SKIPS_KEY, COLLAPSED_KEY, INSERTED_KEY]);
    skips = stored[SKIPS_KEY] && typeof stored[SKIPS_KEY] === 'object' ? stored[SKIPS_KEY] : {};
    inserted = stored[INSERTED_KEY] && typeof stored[INSERTED_KEY] === 'object' ? stored[INSERTED_KEY] : {};
    collapsed = stored[COLLAPSED_KEY] === true;
    loadDraft();
    pollTimer = setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', poll);
    // Kwork перерисовывает ленту и форму: панель и номера возвращаются на место.
    new MutationObserver((mutations) => {
      if (mutations.every(isOwnMutation)) return;
      render();
      scheduleDecorate();
      scheduleUpdate();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-kph-key'] });
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
