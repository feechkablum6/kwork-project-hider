(function initKworkReplyCore(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.KworkReplyCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createReplyCore() {
  // Черновик агента по частям: на какое сообщение клиента «Ответить», какой кусок
  // «Цитировать», что отправить обычным сообщением, какое предложение или опцию
  // выставить. Здесь только чистая логика: разбор ответа агента, поиск сообщения
  // клиента, сверка отправленного. Её же используют мост, сводка и панель на Kwork.

  const PART_HEADER = /^\s*(?:[#>*\s]*)\**\s*(\d{1,2})[.)]\s*\**\s*(ответить(?:\s+на)?|цитировать|обычным\s+сообщением|предложение|опция)(?=[\s*:«]|$)\s*\**\s*:?\s*(?:«([\s\S]*?)»)?/i;
  const MESSAGE_MARKER = /^\s*(?:[#>*\s]*)\**\s*сообщение\s+клиенту\s*\**\s*:\s*(.*)$/i;
  const OFFER_MARKER = /^\s*(?:[#>*\s]*)\**\s*предложение\s+клиенту\s*\**\s*:\s*$/i;
  const OPTION_MARKER = /^\s*(?:[#>*\s]*)\**\s*опция\s+клиенту\s*\**\s*:\s*$/i;
  const FIELD_LINE = /^\s*\**\s*(описание|название|цена|стоимость|срок)\s*\**\s*:\s*(.*)$/i;
  const PART_MODES = { 'ответить': 'reply', 'ответить на': 'reply', 'цитировать': 'quote', 'обычным сообщением': 'plain', 'предложение': 'offer', 'опция': 'option' };
  const SENT_EXACT = 'exact';
  const SENT_EDITED = 'edited';

  function isFence(line) {
    return /^\s*(```|~~~)/.test(line);
  }

  function stripQuotes(value) {
    return String(value || '').trim().replace(/^[«"“]+|[»"”]+$/g, '').trim();
  }

  // Тело за маркером: блок кода целиком или абзацы до следующей части.
  function readBody(lines, start) {
    let index = start;
    while (index < lines.length && lines[index].trim() === '') index += 1;
    const body = [];
    if (index < lines.length && isFence(lines[index])) {
      for (index += 1; index < lines.length && !isFence(lines[index]); index += 1) body.push(lines[index]);
      return { text: body.join('\n').trim(), next: index + 1 };
    }

    for (; index < lines.length; index += 1) {
      const line = lines[index];
      if (PART_HEADER.test(line) || MESSAGE_MARKER.test(line) || OFFER_MARKER.test(line) || OPTION_MARKER.test(line) || /^\s*(---|\*\*\*|#)/.test(line)) break;
      if (line.trim() === '' && (index + 1 >= lines.length || lines[index + 1].trim() === '')) break;
      body.push(line);
    }

    return { text: body.join('\n').trim(), next: index };
  }

  function parseNumber(value) {
    const digits = String(value || '').replace(/[\s ]/g, '').match(/\d+(?:[.,]\d+)?/);
    return digits ? Math.round(Number(digits[0].replace(',', '.'))) : null;
  }

  // Поля предложения и опции: «Описание:» (может занимать несколько строк),
  // «Название:», «Цена:», «Срок:». Блок кода вокруг них не обязателен.
  function readFields(lines, start) {
    const { text, next } = (() => {
      let index = start;
      while (index < lines.length && lines[index].trim() === '') index += 1;
      if (index < lines.length && isFence(lines[index])) {
        const body = [];
        for (index += 1; index < lines.length && !isFence(lines[index]); index += 1) body.push(lines[index]);
        return { text: body.join('\n'), next: index + 1 };
      }

      const body = [];
      for (; index < lines.length; index += 1) {
        if (PART_HEADER.test(lines[index]) || MESSAGE_MARKER.test(lines[index]) || /^\s*(---|\*\*\*|#)/.test(lines[index])) break;
        if (lines[index].trim() === '' && !FIELD_LINE.test(lines[index + 1] || '') && !/^\s+\S/.test(lines[index + 1] || '')) break;
        body.push(lines[index]);
      }

      return { text: body.join('\n'), next: index };
    })();

    const fields = {};
    let current = null;
    for (const line of text.split('\n')) {
      const field = FIELD_LINE.exec(line);
      if (field) {
        current = field[1].toLowerCase() === 'стоимость' ? 'цена' : field[1].toLowerCase();
        fields[current] = field[2].trim();
      } else if (current === 'описание') {
        fields[current] = `${fields[current]}\n${line}`.trim();
      }
    }

    return {
      fields: {
        description: fields['описание'] ? fields['описание'].trim() : null,
        name: fields['название'] ? stripQuotes(fields['название']) : null,
        price: parseNumber(fields['цена']),
        days: fields['срок'] !== undefined ? parseNumber(fields['срок']) ?? 0 : null,
      },
      next,
    };
  }

  // Ответ агента → части. Без нумерованных заголовков одиночное «Сообщение клиенту:»
  // становится одной частью обычным сообщением.
  // markImplicit — пометить части без своего заголовка: при правке черновика они
  // наследуют «Ответить»/«Цитировать» прошлого (inheritTargets).
  function parseDraftParts(markdown, { markImplicit = false } = {}) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const parts = [];
    let header = null;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const head = PART_HEADER.exec(line);
      if (head) {
        header = { n: Number(head[1]), mode: PART_MODES[head[2].toLowerCase().replace(/\s+/g, ' ')], target: head[3] ? stripQuotes(head[3]) : null };
        continue;
      }

      const message = MESSAGE_MARKER.exec(line);
      if (message) {
        const inline = message[1].trim();
        const { text, next } = inline ? { text: inline, next: index + 1 } : readBody(lines, index + 1);
        if (text) {
          const mode = header && ['reply', 'quote', 'plain'].includes(header.mode) ? header.mode : 'plain';
          parts.push({ n: parts.length + 1, mode, target: mode === 'plain' ? null : header?.target || null, text, ...(markImplicit && !header ? { implicit: true } : {}) });
        }

        header = null;
        index = next - 1;
        continue;
      }

      if (OFFER_MARKER.test(line) || OPTION_MARKER.test(line)) {
        const kind = OFFER_MARKER.test(line) ? 'offer' : 'option';
        const { fields, next } = readFields(lines, index + 1);
        if (fields.price) {
          parts.push({ n: parts.length + 1, mode: kind, target: null, text: kind === 'offer' ? fields.description || '' : fields.name || '', fields });
        }

        header = null;
        index = next - 1;
      }
    }

    return parts;
  }

  // ---------- сравнение текстов ----------

  function normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[ \s]+/g, ' ')
      .replace(/[«»"“”„'`.,!?;:()[\]{}—–-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokens(value) {
    return normalizeText(value).split(' ').filter((token) => token.length > 1 || /\d/.test(token));
  }

  // Доля слов «a», которые есть в «b».
  function containment(a, b) {
    const left = tokens(a);
    if (left.length === 0) return 0;
    const right = new Set(tokens(b));
    return left.filter((token) => right.has(token)).length / left.length;
  }

  // Отправленное против части черновика: дословно, с правками или не оно.
  function compareSent(draftText, sentText) {
    const draft = normalizeText(draftText);
    const sent = normalizeText(sentText);
    if (!draft || !sent) return null;
    if (draft === sent) return SENT_EXACT;
    const forward = containment(draftText, sentText);
    const backward = containment(sentText, draftText);
    return forward >= 0.6 && backward >= 0.5 ? SENT_EDITED : null;
  }

  // ---------- сообщения клиента ----------

  function isClient(message, clientId, dialogKey) {
    if (clientId && message?.authorId) return String(message.authorId) === String(clientId);
    const key = String(dialogKey || '').trim().toLowerCase();
    return Boolean(key) && String(message?.authorName || '').trim().toLowerCase() === key;
  }

  // Сообщение клиента для «Ответить»/«Цитировать»: самое свежее, где есть этот текст.
  // Агент цитирует точно, но пробелы, переносы и регистр Kwork может поменять.
  function findTargetMessage(messages, target, { clientId = null, dialogKey = null } = {}) {
    const needle = normalizeText(target);
    if (!needle) return null;
    const list = Array.isArray(messages) ? messages : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index];
      if (isClient(message, clientId, dialogKey) && normalizeText(message.text).includes(needle)) {
        return message;
      }
    }

    return null;
  }

  // Точный кусок исходного текста под «Цитировать»: Kwork выделяет его в самом
  // сообщении, поэтому нужны границы в настоящем тексте, а не в нормализованном.
  function locateFragment(text, fragment) {
    const source = String(text || '');
    const wanted = String(fragment || '').trim();
    if (!wanted) return null;
    const direct = source.indexOf(wanted);
    if (direct >= 0) return { start: direct, end: direct + wanted.length };

    // Сравнение без регистра и с любыми пробелами: строится карта позиций.
    const map = [];
    let flat = '';
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (/\s/.test(char)) {
        if (flat.endsWith(' ') || flat === '') continue;
        flat += ' ';
      } else {
        flat += char.toLowerCase().replace('ё', 'е');
      }
      map.push(index);
    }

    const needle = wanted.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
    const found = flat.indexOf(needle);
    if (found < 0) return null;
    return { start: map[found], end: map[found + needle.length - 1] + 1 };
  }

  // ---------- цены и сроки форм Kwork ----------

  const SELLER_SHARES = [0.8, 0.88, 0.925, 0.95];
  const OFFER_MIN_PRICE = 500;
  const OFFER_MAX_PRICE = 2000000;
  const OPTION_MAX_DAYS = 10;
  const OPTION_NAME_LIMIT = 50;

  // Цены опций в Kwork — список, а не поле (снят со страницы заказа 22.10.2026).
  // Берётся ближайшая, при равенстве — бо́льшая.
  function snapPrice(values, price) {
    const list = (Array.isArray(values) ? values : []).map(Number).filter((value) => Number.isFinite(value) && value > 0);
    const wanted = Number(price);
    if (list.length === 0 || !Number.isFinite(wanted) || wanted <= 0) return null;
    return list.reduce((best, value) => {
      const gap = Math.abs(value - wanted);
      const bestGap = Math.abs(best - wanted);
      return gap < bestGap || (gap === bestGap && value > best) ? value : best;
    });
  }

  const OPTION_PRICES = [
    100, 200, 300, 400, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 6000, 7000, 8000, 9000,
    10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000, 18000, 19000, 20000, 21000, 22000, 23000, 24000,
    25000, 28000, 30000, 32000, 35000, 38000, 40000, 42000, 45000, 48000, 50000, 55000, 60000, 65000, 70000,
    75000, 80000, 85000, 90000, 95000, 100000,
  ];

  function snapOptionPrice(price) {
    return snapPrice(OPTION_PRICES, price);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // ---------- вид панели ----------

  const MODE_LABELS = { reply: 'Ответить на', quote: 'Цитировать', plain: 'Обычным сообщением', offer: 'Предложение', option: 'Опция' };

  function partsWord(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'часть';
    return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'части' : 'частей';
  }

  function shorten(text, limit) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
  }

  function formatMoney(value) {
    return `${String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}\u00a0₽`;
  }

  function daysWord(value) {
    const number = Number(value) || 0;
    const mod10 = number % 10;
    const mod100 = number % 100;
    const word = mod10 === 1 && mod100 !== 11 ? 'день' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'дня' : 'дней';
    return `${number}\u00a0${word}`;
  }

  // Набор «как человек» для поля Kwork: [длина набранного, пауза перед знаком в мс].
  // Около 1300 знаков в минуту, после пробела, знака препинания и переноса — дольше.
  function typingSteps(text, random = Math.random) {
    const steps = [];
    let length = 0;
    let previous = '';
    for (const char of Array.from(String(text || ''))) {
      let delay = 22 + random() * 33;
      if (previous === '\n') delay += 100 + random() * 100;
      else if (/[.,!?;:]/.test(previous)) delay += 50 + random() * 60;
      else if (previous === ' ') delay += random() * 30;
      length += char.length;
      steps.push([length, Math.round(delay)]);
      previous = char;
    }

    return steps;
  }

  // Строки панели: что за часть, к чему она и в каком она состоянии.
  function panelView(draft, progress) {
    const parts = Array.isArray(draft?.parts) ? draft.parts : [];
    const done = new Set(progress?.done || []);
    const skipped = new Set(progress?.skipped || []);
    const current = progress?.current?.n ?? null;
    const rows = parts.map((part) => {
      let target = part.target ? `«${shorten(part.target, 60)}»` : '';
      let text = shorten(part.text, 140);
      if (part.mode === 'offer' || part.mode === 'option') {
        const fields = part.fields || {};
        const terms = [
          fields.price ? formatMoney(part.mode === 'option' ? snapOptionPrice(fields.price) : fields.price) : null,
          fields.days !== null && fields.days !== undefined ? daysWord(fields.days) : null,
        ].filter(Boolean).join(' · ');
        target = part.mode === 'option' && fields.name ? `«${shorten(fields.name, 60)}»` : '';
        text = [terms, part.mode === 'offer' ? shorten(fields.description, 120) : ''].filter(Boolean).join(' — ');
      }

      return {
        n: part.n,
        mode: part.mode,
        label: MODE_LABELS[part.mode] || '',
        target,
        text,
        state: skipped.has(part.n) ? 'skipped' : done.has(part.n) ? 'done' : part.n === current ? 'current' : 'next',
      };
    });
    const sent = rows.filter((row) => row.state === 'done' || row.state === 'skipped').length;
    return {
      title: `Черновик агента · ${parts.length} ${partsWord(parts.length)}`,
      counter: sent > 0 ? `готово ${sent} из ${parts.length}` : '',
      rows,
      button: current ? `Подготовить часть ${current}` : '',
    };
  }

  // ---------- состояние черновика на странице ----------

  // Черновик устарел, когда клиент написал после того, как агент его составил.
  // Отправленные части — свои сообщения после черновика, похожие на текст части.
  function draftProgress(draft, messages, { clientId = null, dialogKey = null, events = [] } = {}) {
    const allParts = Array.isArray(draft?.parts) ? draft.parts : [];
    // Пропущенные части в сопоставлении не участвуют: иначе пропущенная часть с тем же
    // текстом забирает отправленное у следующей.
    const skippedSet = new Set((Array.isArray(draft?.skipped) ? draft.skipped : []).map(Number));
    const parts = allParts.filter((part) => !skippedSet.has(part.n));
    const since = Date.parse(draft?.basedOn || draft?.at) || 0;
    const after = (item) => (Date.parse(item?.time) || 0) > since;
    const list = (Array.isArray(messages) ? messages : []).filter(after);
    // Служебные сообщения клиента («Заказ создан») — не новый вопрос: черновик живёт.
    const stale = list.some((message) => isClient(message, clientId, dialogKey) && !message.event);
    const own = list.filter((message) => !isClient(message, clientId, dialogKey));
    const options = (Array.isArray(events) ? events : []).filter((event) => after(event) && event.type === 13);
    const done = new Set();
    // Каждое отправленное засчитывается одной части: два одинаковых ответа или две
    // опции по одной цене не закрываются одним сообщением или одной опцией.
    const used = new Set();
    const take = (candidates) => {
      const found = candidates.find((item) => !used.has(item.key));
      if (found) used.add(found.key);
      return Boolean(found);
    };
    const ownTexts = own.filter((message) => !message.event).map((message, index) => ({ key: `m:${message.id ?? index}`, message }));
    const ownOffers = own.filter((message) => message.event?.type === 'offer_kwork_new').map((message, index) => ({ key: `o:${message.id ?? index}`, message }));
    const optionRows = options.flatMap((event, eventIndex) => (event.options || []).map((option, index) => ({ key: `t:${event.id ?? eventIndex}:${index}`, option })));
    // Тексты — так же в два прохода: сначала дословные совпадения, потом с правками.
    const textParts = parts.filter((part) => ['reply', 'quote', 'plain'].includes(part.mode));
    for (const part of textParts) {
      if (take(ownTexts.filter((item) => compareSent(part.text, item.message.text) === SENT_EXACT))) done.add(part.n);
    }

    for (const part of textParts.filter((item) => !done.has(item.n))) {
      if (take(ownTexts.filter((item) => compareSent(part.text, item.message.text)))) done.add(part.n);
    }

    for (const part of parts) {
      if (part.mode === 'offer') {
        // Цена приводится к пределам формы Kwork так же, как её заполняет панель.
        const price = clamp(Math.round(Number(part.fields?.price) || 0), OFFER_MIN_PRICE, OFFER_MAX_PRICE);
        if (take(ownOffers.filter((item) => item.message.event.price === price))) done.add(part.n);
      }
    }

    // Опции: сначала совпадения по названию и цене, потом — только по цене.
    // В треке Kwork показывает продавцу доход: цену без комиссии, а комиссия зависит
    // от оборота с клиентом (20, 12, 7,5 или 5%); цену Kwork округляет по своему списку.
    const optionParts = parts.filter((part) => part.mode === 'option');
    const priceMatches = (part) => {
      const price = snapOptionPrice(Number(part.fields?.price) || 0) || Number(part.fields?.price) || 0;
      return optionRows.filter((item) => [1, ...SELLER_SHARES].some((share) => Math.abs((Number(item.option.price) || 0) - price * share) < 1));
    };
    for (const part of optionParts) {
      const name = normalizeText(String(part.fields?.name || '').slice(0, OPTION_NAME_LIMIT));
      if (name && take(priceMatches(part).filter((item) => normalizeText(item.option.name) === name))) done.add(part.n);
    }

    for (const part of optionParts.filter((item) => !done.has(item.n))) {
      if (take(priceMatches(part))) done.add(part.n);
    }

    const skipped = allParts.filter((part) => skippedSet.has(part.n)).map((part) => part.n);
    for (const n of skipped) done.add(n);

    const current = parts.find((part) => !done.has(part.n)) || null;
    return { stale, done: [...done].sort((a, b) => a - b), skipped: skipped.sort((a, b) => a - b), current, finished: allParts.length > 0 && !current };
  }

  // Агент поправил текст и не повторил «Ответить на …»: часть без заголовка берёт
  // способ и адрес у той же по счёту неотправленной текстовой части прошлого
  // черновика. Только при том же числе текстовых частей — иначе соответствие не угадать.
  function inheritTargets(parts, previous, doneNumbers = []) {
    const done = new Set((doneNumbers || []).map(Number));
    const strip = ({ implicit, ...part }) => part;
    const isText = (part) => ['reply', 'quote', 'plain'].includes(part.mode);
    const before = (Array.isArray(previous?.parts) ? previous.parts : []).filter((part) => isText(part) && !done.has(Number(part.n)));
    const after = (Array.isArray(parts) ? parts : []).filter(isText);
    if (before.length === 0 || before.length !== after.length) return (parts || []).map(strip);
    return parts.map((part) => {
      const source = before[after.indexOf(part)];
      if (!part.implicit || part.mode !== 'plain' || !source?.target || !['reply', 'quote'].includes(source.mode)) return strip(part);
      return { ...strip(part), mode: source.mode, target: source.target };
    });
  }

  // Своё отправленное Kwork показывает сразу, а на диск оно ложится через секунды:
  // панель досчитывает свои сообщения со страницы и закрывает часть без ожидания.
  // То же сообщение с диска (время может разойтись на секунду) второй раз не входит.
  function withPageMessages(messages, pageMessages) {
    const list = Array.isArray(messages) ? messages : [];
    const extra = [];
    for (const message of Array.isArray(pageMessages) ? pageMessages : []) {
      const time = Date.parse(message?.time) || 0;
      const text = normalizeText(message?.text);
      if (!time || !text || !message.authorId) continue;
      const known = [...list, ...extra].some((item) => String(item?.authorId) === String(message.authorId)
        && Math.abs((Date.parse(item?.time) || 0) - time) <= 5000
        && normalizeText(item?.text) === text);
      if (!known) extra.push(message);
    }

    return extra.length > 0 ? [...list, ...extra] : list;
  }

  return {
    MODE_LABELS,
    OFFER_MAX_PRICE,
    OFFER_MIN_PRICE,
    OPTION_MAX_DAYS,
    OPTION_NAME_LIMIT,
    OPTION_PRICES,
    SENT_EDITED,
    SENT_EXACT,
    clamp,
    compareSent,
    containment,
    draftProgress,
    findTargetMessage,
    inheritTargets,
    locateFragment,
    normalizeText,
    panelView,
    parseDraftParts,
    parseNumber,
    snapOptionPrice,
    snapPrice,
    typingSteps,
    withPageMessages,
  };
});
