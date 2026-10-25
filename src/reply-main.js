// Руки панели черновика на странице Kwork: «Ответить», «Цитировать», текст в поле,
// заполнение индивидуального предложения и опций. Всё это живёт в Vue и jQuery
// страницы, поэтому здесь MAIN world; команды присылает изолированный reply-content.js.
//
// Ничего не отправляет. Кнопки «Отправить», «Предложить», «Предложить услуги»,
// «Сдать работу», клавиши и submit формы здесь не трогаются никогда: нажимает их
// только пользователь. Нажатия — только через safeClick по списку SAFE_CLICKS,
// контракт держит test/reply-panel.test.js.
(function initKworkReplyMain() {
  'use strict';

  if (!/^\/(?:(?:new_)?inbox\/[^/]+|track)/.test(window.location.pathname) || window.__kphReplyMainInstalled) {
    return;
  }

  window.__kphReplyMainInstalled = true;

  const COMMAND_SOURCE = 'kph-reply-panel';
  const RESULT_SOURCE = 'kph-reply-main';
  const MAX_DEPTH = 12;
  // Только открывающие и служебные кнопки: шапка «Заказ» (открывает форму
  // предложения), «Предложить опции» (раскрывает блок), «Добавить ещё опцию»,
  // крестик цитаты в поле ввода и кнопка, раскрывающая скрытое поле в заказе.
  const SAFE_CLICKS = {
    offerOpen: '.kwork-conversation__header-button.kw-button--green',
    optionsToggle: '[data-suggestion="options"]',
    optionAdd: '.js-add-custom-option',
    quoteRemove: '.js-message-quote-wrap .js-message-quote-remove',
    openForm: '.open-hidden-form-button',
  };
  const FORBIDDEN_TARGET = '.js-box-submit, .message-submit-button, .js-suggest-offer-submit, .offer-individual__submit, .js-track-pass-work-button, button[type="submit"], input[type="submit"]';
  const FORBIDDEN_TEXT = /^(?:отправить|предложить|предложить услуги.*|сдать выполненную работу|отменить.*)$/i;

  const isTrack = window.location.pathname === '/track';
  const $ = () => window.jQuery;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function safeClick(name) {
    const selector = SAFE_CLICKS[name];
    const element = selector ? document.querySelector(selector) : null;
    if (!element) {
      return false;
    }

    // Второй замок: даже если Kwork переименует классы, кнопка отправки не нажмётся.
    const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
    if (element.matches(FORBIDDEN_TARGET) || element.closest(FORBIDDEN_TARGET) || FORBIDDEN_TEXT.test(text)) {
      return false;
    }

    element.click();
    return true;
  }

  // У окон Kwork (position: fixed) offsetParent всегда null — видимость по прямоугольникам.
  function visible(element) {
    return Boolean(element) && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  }

  function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Строки — отдельными <div>, пустая строка — <div><br></div>: так Kwork сам
  // превращает набранный текст в переносы при отправке (preSubmitMessage).
  function textToEditorHtml(text) {
    return String(text || '').replace(/\r\n/g, '\n').split('\n')
      .map((line) => (line.trim() ? `<div>${escapeHtml(line)}</div>` : '<div><br></div>'))
      .join('');
  }

  function plain(value) {
    return String(value || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div)>/gi, '\n')
      // Эмодзи редактор Kwork превращает в <img alt="🙂">: без alt текст поля «потерял» бы знак.
      .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }

  // Тот же текст с точностью до пробелов и переносов: правку пользователя (даже одну
  // запятую или знак вопроса) панель не принимает за свой текст. Оба аргумента —
  // уже текст (поле — через fieldText): второй plain() съел бы «<div>» из самого текста.
  function sameText(left, right) {
    const flat = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    return flat(left) === flat(right);
  }

  function normalize(value) {
    return plain(value).toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”„'`.,!?;:()[\]{}—–-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function vmName(vm) {
    return vm?.$options?.name || vm?.$options?._componentTag || '';
  }

  function vmUp(element, name) {
    for (let node = element; node; node = node.parentElement) {
      if (node.__vue__ && vmName(node.__vue__) === name) return node.__vue__;
    }

    return null;
  }

  // ---------- сообщения ----------

  function inboxList() {
    return window.conversationApp?.$refs?.conversationMessagesList || null;
  }

  function trackList() {
    return window.appTracks?.$refs?.trackList || null;
  }

  function blockProps(block) {
    for (let node = block, depth = 0; node && depth < MAX_DEPTH; node = node.parentElement, depth += 1) {
      const props = node.__vue__?.$props;
      if (props?.message?.MSGFROM !== undefined) return { message: props.message };
      if (props?.track?.id !== undefined) return { track: props.track };
    }

    return null;
  }

  // Сообщение клиента: сначала по ключу «автор:время», потом по тексту среди
  // загруженных на странице — самое свежее, где есть искомый текст.
  function findMessage({ key, target }) {
    const blocks = [...document.querySelectorAll('.js-message-block')];
    let block = key ? blocks.find((item) => item.dataset.kphKey === key) : null;
    const me = String(window.actorId || '');
    if (!block && target) {
      const needle = normalize(target);
      block = blocks.reverse().find((item) => {
        const props = blockProps(item);
        const author = String(props?.message?.MSGFROM ?? props?.track?.author?.id ?? '');
        const text = item.querySelector('.js-can-highlighted')?.textContent || '';
        return author && author !== me && needle && normalize(text).includes(needle);
      }) || null;
    }

    const props = block ? blockProps(block) : null;
    return props ? { block, ...props } : null;
  }

  function quoteSet() {
    return Boolean(window.QuoteMessage?.quoteId);
  }

  function clearQuote() {
    if (quoteSet() || document.querySelector(SAFE_CLICKS.quoteRemove)) {
      safeClick('quoteRemove');
    }
  }

  function reply(found) {
    clearQuote();
    if (found.message) {
      inboxList().messageQuote(found.message);
    } else {
      trackList().quoteTrackAction(found.track.id);
    }

    return quoteSet();
  }

  // Выделение куска как мышью: Kwork сам считает границы цитаты по выделению
  // внутри сообщения (highlightMessage на mouseup) — те же, что уйдут на сервер.
  function selectFragment(container, fragment) {
    const wanted = normalize(fragment);
    if (!wanted) return false;
    const nodes = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let flat = '';
    const map = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push(node);
      for (let offset = 0; offset < node.data.length; offset += 1) {
        const char = node.data[offset];
        const lower = char.toLowerCase().replace('ё', 'е');
        const spaced = /[\s«»"“”„'`.,!?;:()[\]{}—–-]/.test(lower) ? ' ' : lower;
        if (spaced === ' ' && (flat.endsWith(' ') || flat === '')) continue;
        flat += spaced;
        map.push([node, offset]);
      }
    }

    const at = flat.indexOf(wanted);
    if (at < 0) return false;
    const [startNode, startOffset] = map[at];
    const [endNode, endOffset] = map[at + wanted.length - 1];
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset + 1);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    container.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    return true;
  }

  async function quote(found, fragment) {
    clearQuote();
    const container = found.block.querySelector('.js-can-highlighted');
    if (!container || !selectFragment(container, fragment)) {
      return { ok: reply(found), fallback: 'кусок для цитаты не найден в сообщении, поставил «Ответить»' };
    }

    await wait(60);
    const list = found.message ? inboxList() : trackList();
    if (!list || list.highlightedLastIndex < 1) {
      window.getSelection().removeAllRanges();
      return { ok: reply(found), fallback: 'Kwork не принял выделение, поставил «Ответить»' };
    }

    if (found.message) {
      list.messageHighlightedQuote(found.message);
    } else {
      list.quoteHighlightedTrackAction(found.track.id);
    }

    window.getSelection().removeAllRanges();
    return { ok: quoteSet() };
  }

  // ---------- поле ввода ----------

  function messageField() {
    return document.querySelector(isTrack ? '#message_body1' : '#message_body');
  }

  function fieldText() {
    const field = messageField();
    return field ? plain(field.value).trim() : '';
  }

  function setFieldText(text, { focus = true } = {}) {
    const field = messageField();
    const jq = $();
    if (!field || !jq?.fn?.trumbowyg) return false;
    const $field = jq(field);
    $field.trumbowyg('html', textToEditorHtml(text));
    const editor = field.parentElement?.querySelector('.trumbowyg-editor');
    // Те же события, что от набора: Kwork обновляет кнопку и свой черновик поля.
    editor?.dispatchEvent(new Event('input', { bubbles: true }));
    $field.trigger('tbwchange');
    if (editor && focus) {
      editor.focus({ preventScroll: true });
      const selection = window.getSelection();
      selection.selectAllChildren(editor);
      selection.collapseToEnd();
    }

    return true;
  }

  function ensureTrackForm() {
    if (isTrack && !visible(messageField()?.parentElement) && document.querySelector(SAFE_CLICKS.openForm)) {
      window.MessageFormModule?.openMessageForm?.(document.querySelector(SAFE_CLICKS.openForm));
    }
  }

  // Последний текст, который панель печатала в поле: written — уже набранное,
  // active — печать идёт. Остановленная печать остаётся «своим» текстом поля.
  let typing = null;
  const SEND_BUTTON = '.js-box-submit, .message-submit-button';

  function fieldEditor() {
    return messageField()?.parentElement?.querySelector('.trumbowyg-editor') || null;
  }

  // Textarea Kwork догоняет редактор только на keyup: правку пользователя видно в самом редакторе.
  function editorText() {
    const editor = fieldEditor();
    return editor ? plain(editor.innerHTML).trim() : fieldText();
  }

  // Дописать сразу: «Вставить сразу», скрытая вкладка, нажатие «Отправить».
  function finishTyping({ focus = false } = {}) {
    if (!typing?.active) return;
    typing.active = false;
    // Пользователь успел поправить поле между шагами — его правку не затираем.
    if (!sameText(editorText(), typing.written)) return;
    typing.written = typing.text;
    setFieldText(typing.text, { focus });
  }

  // Набор по знаку: пока текст в поле меняется, Kwork показывает клиенту «печатает».
  // Пользователь правит или отправляет поле, ушёл в другой диалог, пропустил часть — печать стоп.
  async function typeFieldText(run, steps) {
    // shortcut: внутренности Kwork (pull-is-type-message.js) — свой сигнал он шлёт не раньше 4 с набора; сброс начала даёт «печатает» с первого знака, сменят класс — сигнал придёт по-обычному позже.
    const kwork = window.pullIsTypeMessage;
    if (kwork?.intervalType) kwork.intervalType.begin = new Date(0);
    try {
      for (const [length, delay] of steps) {
        // В скрытой вкладке Chrome будит таймеры раз в секунду и реже: печать растянулась бы на минуты.
        if (document.hidden) finishTyping();
        else await wait(delay);
        if (!run.active) break;
        if (window.location.href !== run.href || !sameText(editorText(), run.written)) {
          run.active = false;
          break;
        }

        run.written = run.text.slice(0, length);
        const editor = fieldEditor();
        setFieldText(run.written, { focus: Boolean(editor) && document.activeElement === editor });
        try {
          kwork?._typeText?.();
        } catch {
          // Сигнал «печатает» не повод бросать текст недописанным.
        }
      }
    } finally {
      run.active = false;
    }

    const done = run.written === run.text;
    return { done, empty: !done && !editorText() };
  }

  // «Отправить» во время печати: сначала весь текст в поле, потом его заберёт Kwork.
  for (const type of ['pointerdown', 'click']) {
    window.addEventListener(type, (event) => {
      if (event.isTrusted && event.target?.closest?.(SEND_BUTTON)) finishTyping();
    }, true);
  }

  async function prepareMessage({ mode, key, target, text, force, known, onlyIf, steps }) {
    // В поле всё ещё текст, который набирала панель: печать идёт или остановлена.
    const typed = typing && sameText(editorText(), typing.written) ? typing : null;
    // Повторное нажатие во время печати — дописать сразу.
    if (typed?.active && !onlyIf && sameText(typed.text, text)) {
      finishTyping({ focus: true });
      return typed.result;
    }

    // Подмена по новому черновику — только поверх текста, который вставила сама
    // панель: пользователь его правил, стёр или отправил — поле не трогаем.
    if (onlyIf && !sameText(editorText(), onlyIf) && !(typed && sameText(typed.text, onlyIf))) {
      return { ok: false, quiet: true };
    }

    if (typing) typing.active = false;

    ensureTrackForm();
    if (!messageField()) {
      return { ok: false, error: 'Поле сообщения не найдено на странице' };
    }

    // В поле уже свой текст, не из черновика: без второго нажатия не затираем.
    const current = editorText();
    if (current && !force && !typed && !(known || []).some((item) => sameText(item, current))) {
      return { ok: false, busy: true, error: 'В поле уже есть ваш текст. Нажмите ещё раз, чтобы заменить его частью черновика' };
    }

    let note = null;
    let applied = mode;
    if (mode === 'reply' || mode === 'quote') {
      const found = findMessage({ key, target });
      if (!found) {
        clearQuote();
        applied = 'plain';
        note = 'сообщение клиента не загружено на странице, поэтому без «Ответить». Прокрутите переписку выше и нажмите ещё раз';
      } else if (mode === 'quote') {
        const result = await quote(found, target);
        if (result.fallback) {
          applied = result.ok ? 'reply' : 'plain';
          note = result.fallback;
        } else if (!result.ok) {
          applied = 'plain';
          note = 'цитата не поставилась';
        }
      } else if (!reply(found)) {
        applied = 'plain';
        note = '«Ответить» не поставилось';
      }
    } else {
      clearQuote();
    }

    const result = { ok: true, applied, note, warn: Boolean(note) };
    // Подмена без нажатия не уводит фокус и прокрутку у пользователя и вставляется сразу.
    if (onlyIf || !steps?.length) {
      setFieldText(text, { focus: !onlyIf });
      if (!onlyIf) messageField()?.closest('.js-message-field-wrapper, .mf-message-row, form')?.scrollIntoView({ block: 'nearest' });
      return result;
    }

    setFieldText('');
    messageField()?.closest('.js-message-field-wrapper, .mf-message-row, form')?.scrollIntoView({ block: 'nearest' });
    typing = { text, written: '', result, active: true, href: window.location.href };
    return { ...result, typing: typeFieldText(typing, steps) };
  }

  // ---------- индивидуальное предложение ----------

  function setTrumbowyg(textarea, text) {
    const jq = $();
    if (!textarea || !jq?.fn?.trumbowyg) return false;
    jq(textarea).trumbowyg('html', textToEditorHtml(text));
    textarea.parentElement?.querySelector('.trumbowyg-editor')?.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  async function waitFor(find, timeout = 3000) {
    const started = Date.now();
    for (;;) {
      const found = find();
      if (found || Date.now() - started > timeout) return found || null;
      await wait(100);
    }
  }

  async function prepareOffer(fields) {
    if (isTrack) {
      return { ok: false, error: 'Индивидуальное предложение выставляется в переписке с клиентом' };
    }

    let modal = document.querySelector('.modal-individual-offer');
    if (!visible(modal)) {
      if (!safeClick('offerOpen')) {
        return { ok: false, error: 'Кнопка «Заказ» в шапке переписки не найдена' };
      }

      modal = await waitFor(() => {
        const found = document.querySelector('.modal-individual-offer');
        return visible(found) && found.querySelector('#offer-custom-price') ? found : null;
      });
    }

    if (!modal) {
      return { ok: false, error: 'Форма предложения не открылась' };
    }

    const notes = [];
    if (fields.description) {
      setTrumbowyg(modal.querySelector('textarea[name="description"]'), fields.description);
    }

    const priceInput = modal.querySelector('#offer-custom-price');
    const price = Math.min(2000000, Math.max(500, Math.round(Number(fields.price) || 0)));
    if (price !== Math.round(Number(fields.price) || 0)) notes.push(`цена приведена к пределам Kwork: ${money(price)}`);
    priceInput.value = String(price);
    priceInput.dispatchEvent(new Event('input', { bubbles: true }));
    priceInput.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(150);

    // Название появляется у крупных сумм; пустое Kwork не примет.
    const nameArea = modal.querySelector('textarea[name="name"]');
    if (visible(nameArea?.parentElement)) {
      const name = fields.name || String(fields.description || '').split('\n')[0].slice(0, 70);
      if (name) setTrumbowyg(nameArea, name.slice(0, 70));
    }

    if (Number.isFinite(Number(fields.days)) && Number(fields.days) > 0) {
      const durationSelect = [...modal.querySelectorAll('.v-select')]
        .map((element) => element.__vue__)
        .find((vm) => (vm?.options || []).some((option) => /дн/.test(option?.formattedValue || '')));
      const options = durationSelect?.options || [];
      const wanted = Number(fields.days);
      const option = options.find((item) => Number(item.value) === wanted)
        || options.filter((item) => Number(item.value) >= wanted).sort((a, b) => a.value - b.value)[0]
        || options[options.length - 1];
      if (option) {
        durationSelect.select(option);
        // Иначе список сроков остаётся раскрытым поверх кнопок формы.
        if (typeof durationSelect.closeSearchOptions === 'function') durationSelect.closeSearchOptions();
        else durationSelect.open = false;
        if (Number(option.value) !== wanted) notes.push(`срок в Kwork: ${option.formattedValue}`);
      } else {
        notes.push('срок не выбрался — выберите его в форме');
      }
    }

    const warn = notes.length > 0;
    notes.push('рубрику выберите сами');
    return { ok: true, note: notes.join('; '), warn };
  }

  // ---------- опции заказа ----------

  function recalcOptions() {
    window.SuggestOptions?.updateExtraPrices?.();
    window.SuggestOptions?.calculateSuggestExtrasTotal?.();
  }

  function money(value) {
    return `${String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}\u00a0₽`;
  }

  function nearestValue(select, wanted) {
    const values = [...select.options].map((option) => Number(option.value)).filter((value) => Number.isFinite(value));
    if (values.length === 0) return null;
    return values.reduce((best, value) => {
      const gap = Math.abs(value - wanted);
      const bestGap = Math.abs(best - wanted);
      return gap < bestGap || (gap === bestGap && value > best) ? value : best;
    });
  }

  async function prepareOption(fields) {
    if (!isTrack) {
      return { ok: false, error: 'Опции выставляются на странице заказа' };
    }

    if (!document.querySelector(SAFE_CLICKS.optionsToggle)) {
      return { ok: false, error: 'В этом заказе Kwork не даёт предложить опции' };
    }

    if (!window.openedSuggestions?.options) {
      safeClick('optionsToggle');
      await wait(300);
    }

    const box = document.querySelector('#suggestExtras');
    const rows = () => [...(box?.querySelectorAll('.order-extras__item.custom, li') || [])]
      .filter((row) => row.querySelector('input[name="customExtraName[]"]') && visible(row));
    const name = String(fields.name || '').trim();
    // Повторное нажатие правит ту же строку, а не добавляет вторую такую же опцию.
    let row = rows().find((item) => item.querySelector('input[name="customExtraName[]"]').value.trim() === name.slice(0, 50))
      || rows().find((item) => !item.querySelector('input[name="customExtraName[]"]').value.trim());
    if (!row) {
      safeClick('optionAdd');
      await wait(300);
      row = rows().find((item) => !item.querySelector('input[name="customExtraName[]"]').value.trim());
    }

    if (!row) {
      return { ok: false, error: 'Свободная строка опции не нашлась' };
    }

    const jq = $();
    const notes = [];
    const nameInput = row.querySelector('input[name="customExtraName[]"]');
    const limit = nameInput.maxLength > 0 ? nameInput.maxLength : 50;
    if (name.length > limit) notes.push(`название обрезано до ${limit} знаков`);
    nameInput.value = name.slice(0, limit);
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));

    const priceSelect = row.querySelector('select[name="customExtraPrice[]"]');
    const price = nearestValue(priceSelect, Number(fields.price) || 0);
    if (price !== Number(fields.price)) notes.push(`в черновике ${money(fields.price)}, в списке Kwork ближайшая — ${money(price)}`);
    jq(priceSelect).val(String(price)).trigger('chosen:updated');

    const daysSelect = row.querySelector('select[name="customExtraTime[]"]');
    const days = Math.min(10, Math.max(0, Math.round(Number(fields.days) || 0)));
    if (days !== Math.round(Number(fields.days) || 0)) notes.push(`срок опции в Kwork — до 10 дней, поставил ${days}`);
    jq(daysSelect).val(String(days)).trigger('chosen:updated');
    recalcOptions();
    box.scrollIntoView({ block: 'nearest' });

    const income = priceSelect.selectedOptions[0]?.textContent.replace(/\s+/g, ' ').replace(/\s*Р$/, ' ₽').trim();
    return { ok: true, note: [`клиент заплатит ${money(price)}, вам ${income || '—'}`, ...notes].join('; '), warn: notes.length > 0 };
  }

  // ---------- связь с изолированным миром ----------

  async function handle(command) {
    try {
      if (command.mode === 'offer') return await prepareOffer(command.fields || {});
      if (command.mode === 'option') return await prepareOption(command.fields || {});
      return await prepareMessage(command);
    } catch (error) {
      return { ok: false, error: `Kwork не дал подготовить часть: ${error?.message || error}` };
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== COMMAND_SOURCE) return;
    if (event.data.kind === 'stop-typing') {
      if (typing) typing.active = false;
      return;
    }

    if (event.data.kind !== 'prepare') return;

    const { requestId } = event.data;
    handle(event.data).then(({ typing: typed, ...result }) => {
      window.postMessage({ source: RESULT_SOURCE, kind: 'prepared', requestId, ...result, typing: Boolean(typed) }, window.location.origin);
      const post = (end) => window.postMessage({ source: RESULT_SOURCE, kind: 'typed', requestId, ...end }, window.location.origin);
      typed?.then(post, () => post({ done: false, empty: false }));
    });
  });
})();
