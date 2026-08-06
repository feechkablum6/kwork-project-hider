// Копия ядра для изолированного мира.
// Chrome не подключает один и тот же файл к двум наборам content scripts с одинаковым
// run_at, поэтому MAIN world и isolated world получают ядро разными файлами.
// Файл создаётся командой `npm run sync-core`, править вручную не нужно.
(function initKworkInboxCore(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.KworkInboxCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createInboxCore() {
  const TEXT_KEYS = ['message', 'text', 'body', 'content', 'msg', 'comment'];
  const TIME_KEYS = ['time', 'created_at', 'createdAt', 'date', 'timestamp', 'date_create', 'dateCreate', 'time_created'];
  const ID_KEYS = ['message_id', 'messageId', 'id', 'inbox_id', 'inboxId'];
  const AUTHOR_ID_KEYS = ['MSGFROM', 'from_id', 'fromId', 'user_id', 'userId', 'author_id', 'authorId', 'from', 'sender_id'];
  const AUTHOR_NAME_KEYS = ['mfrom', 'from_username', 'fromUsername', 'username', 'user_name', 'userName', 'login', 'name', 'author'];
  const CLIENT_ID_KEYS = ['conversationUserId', 'conversation_user_id', 'interlocutor_id'];
  // Файлы сообщения Kwork отдаёт дважды: списком `filesArray` и словарём `files`
  // по идентификатору файла, поэтому разбор понимает обе формы и схлопывает повторы.
  const ATTACHMENT_KEYS = ['attachments', 'filesArray', 'files', 'attach', 'attaches', 'documents'];
  const ATTACHMENT_URL_KEYS = ['url', 'path', 'link', 'href', 'file', 'download_url'];
  const ATTACHMENT_NAME_KEYS = ['name', 'fname', 'filename', 'file_name', 'title', 'original_name'];
  const ATTACHMENT_ID_KEYS = ['id', 'FID', 'file_id', 'fileId'];
  const ATTACHMENT_SIZE_KEYS = ['size', 'filesize', 'file_size'];
  const DIALOG_KEYS = ['username', 'user_name', 'userName', 'login', 'to_username', 'toUsername'];
  const RECIPIENT_ID_KEYS = ['MSGTO', 'to_id', 'toId', 'recipient_id', 'recipientId'];
  const RECIPIENT_NAME_KEYS = ['mto', 'to_username', 'toUsername', 'recipient_username'];
  const MAX_SCAN_DEPTH = 8;
  // Раскладка папки переписок: диалог = папка с текстом, данными и вложениями.
  const ATTACHMENT_DIR_NAME = 'файлы';
  const DIALOG_MARKDOWN_NAME = 'переписка.md';
  const DIALOG_DATA_NAME = 'данные.json';

  const HTML_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    laquo: '«',
    raquo: '»',
    mdash: '—',
    ndash: '–',
    hellip: '…',
    rsquo: '’',
    lsquo: '‘',
  };

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function firstFilledKey(source, keys) {
    for (const key of keys) {
      const value = source?.[key];
      const isPrimitive = typeof value === 'string' || typeof value === 'number';
      if (isPrimitive && String(value).trim() !== '') {
        return value;
      }
    }

    return null;
  }

  function decodeEntities(text) {
    return text
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/&([a-z]+);/gi, (match, name) => HTML_ENTITIES[name.toLowerCase()] ?? match);
  }

  function htmlToText(value) {
    if (value === undefined || value === null) {
      return '';
    }

    return decodeEntities(
      String(value)
        .replace(/<\s*(br|BR)\s*\/?\s*>/g, '\n')
        .replace(/<\s*\/\s*(p|div)\s*>/gi, '\n\n')
        .replace(/<\s*\/\s*(li|tr)\s*>/gi, '\n')
        .replace(/<[^>]*>/g, ''),
    )
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizeTime(value) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
      const numeric = Number(value);
      const milliseconds = numeric > 1e11 ? numeric : numeric * 1000;
      const date = new Date(milliseconds);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    const isoLike = String(value).trim().replace(' ', 'T');
    const parsed = new Date(isoLike);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }

    const withZone = new Date(`${isoLike}+03:00`);
    return Number.isNaN(withZone.getTime()) ? null : withZone.toISOString();
  }

  // Имя файла приходит и в адресе, где кириллица закодирована процентами,
  // и отдельным полем; в обоих случаях нужен читаемый вариант без параметров.
  function decodeFileName(value) {
    const raw = String(value ?? '').split('?')[0].split('#')[0].trim();
    if (!raw) {
      return '';
    }

    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  function looksLikeAttachment(value) {
    return isPlainObject(value)
      && [...ATTACHMENT_URL_KEYS, ...ATTACHMENT_NAME_KEYS].some((key) => typeof value[key] === 'string' && value[key].trim() !== '');
  }

  function normalizeAttachment(value) {
    if (typeof value === 'string') {
      const url = value.trim();
      return url ? { id: null, name: decodeFileName(url.split('/').pop()) || url, url, size: null } : null;
    }

    if (!isPlainObject(value)) {
      return null;
    }

    const url = firstFilledKey(value, ATTACHMENT_URL_KEYS);
    const name = firstFilledKey(value, ATTACHMENT_NAME_KEYS);
    if (!url && !name) {
      return null;
    }

    const size = firstFilledKey(value, ATTACHMENT_SIZE_KEYS);
    const id = firstFilledKey(value, ATTACHMENT_ID_KEYS);
    return {
      id: id === null ? null : String(id),
      name: String(name || decodeFileName(String(url).split('/').pop()) || 'файл').trim(),
      url: url ? String(url) : null,
      size: size === null ? null : Number(size) || null,
    };
  }

  function collectAttachments(source) {
    const attachments = [];
    const seen = new Set();

    for (const key of ATTACHMENT_KEYS) {
      const value = source?.[key];
      if (!value) {
        continue;
      }

      let list = [value];
      if (Array.isArray(value)) {
        list = value;
      } else if (isPlainObject(value) && !looksLikeAttachment(value)) {
        list = Object.values(value);
      }

      for (const item of list) {
        const attachment = normalizeAttachment(item);
        if (!attachment) {
          continue;
        }

        const identity = attachment.id || attachment.url || attachment.name;
        if (seen.has(identity)) {
          continue;
        }

        seen.add(identity);
        attachments.push(attachment);
      }
    }

    return attachments;
  }

  function sanitizeFileName(value) {
    const cleaned = decodeFileName(value)
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .trim();

    return cleaned.slice(0, 120).trim() || null;
  }

  function splitFileName(fileName) {
    const match = String(fileName).match(/^(.*?)(\.[A-Za-z0-9]{1,10})$/);
    return match ? { base: match[1] || match[2], ext: match[1] ? match[2] : '' } : { base: fileName, ext: '' };
  }

  // Дата и время сообщения в имени файла: по московскому времени, как подписи
  // в самой переписке, и в порядке, который сортируется по возрастанию.
  function formatFileStamp(isoTime) {
    const date = isoTime ? new Date(isoTime) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return null;
    }

    const parts = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(date).reduce((found, part) => ({ ...found, [part.type]: part.value }), {});

    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}-${parts.minute}-${parts.second}`;
  }

  // Имена вложений на бирже повторяются: каждый скриншот приходит как image.png,
  // а голосовые называются числом. Имя файла начинается с даты и времени сообщения,
  // поэтому оно осмысленно, сортируется и не зависит от того, какие сообщения
  // пришли в этот раз.
  function resolveAttachmentFiles(messages) {
    const byUrl = new Map();
    const used = new Set();
    const files = [];

    for (const message of Array.isArray(messages) ? messages : []) {
      for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
        const url = attachment?.url ? String(attachment.url).trim() : '';
        if (!url || byUrl.has(url)) {
          continue;
        }

        const preferred = sanitizeFileName(attachment.name) || sanitizeFileName(url.split('/').pop()) || 'файл';
        const { base, ext } = splitFileName(preferred);
        const stamp = formatFileStamp(message?.time);
        const named = stamp ? `${stamp} ${base}` : base;
        let file = `${named}${ext}`;
        let counter = 2;

        while (used.has(file.toLowerCase())) {
          file = `${named} (${counter})${ext}`;
          counter += 1;
        }

        used.add(file.toLowerCase());
        byUrl.set(url, file);
        files.push({
          id: attachment.id || null,
          name: attachment.name || file,
          url,
          file,
          size: attachment.size ?? null,
          messageId: message?.id || null,
          time: message?.time || null,
        });
      }
    }

    return files;
  }

  function looksLikeMessage(value) {
    if (!isPlainObject(value)) {
      return false;
    }

    const hasText = TEXT_KEYS.some((key) => typeof value[key] === 'string');
    const hasAttachments = ATTACHMENT_KEYS.some((key) => Array.isArray(value[key]) && value[key].length > 0);
    if (!hasText && !hasAttachments) {
      return false;
    }

    const hasTime = TIME_KEYS.some((key) => value[key] !== undefined && value[key] !== null);
    const hasAuthor = AUTHOR_ID_KEYS.some((key) => value[key] !== undefined && value[key] !== null);
    return hasTime && (hasAuthor || hasText);
  }

  function normalizeMessage(raw) {
    if (!isPlainObject(raw)) {
      return null;
    }

    const text = htmlToText(firstFilledKey(raw, TEXT_KEYS));
    const attachments = collectAttachments(raw);
    if (!text && attachments.length === 0) {
      return null;
    }

    const authorId = firstFilledKey(raw, AUTHOR_ID_KEYS);
    const authorName = firstFilledKey(raw, AUTHOR_NAME_KEYS);
    const recipientId = firstFilledKey(raw, RECIPIENT_ID_KEYS);
    const recipientName = firstFilledKey(raw, RECIPIENT_NAME_KEYS);
    const id = firstFilledKey(raw, ID_KEYS);
    const time = normalizeTime(firstFilledKey(raw, TIME_KEYS));

    return {
      id: id === null ? null : String(id),
      time,
      authorId: authorId === null ? null : String(authorId),
      authorName: authorName === null ? null : String(authorName).trim(),
      recipientId: recipientId === null ? null : String(recipientId),
      recipientName: recipientName === null ? null : String(recipientName).trim(),
      text,
      attachments,
    };
  }

  function collectMessages(payload) {
    const found = [];
    const seen = new Set();

    function walk(value, depth) {
      if (depth > MAX_SCAN_DEPTH || !value || typeof value !== 'object' || seen.has(value)) {
        return;
      }

      seen.add(value);

      if (Array.isArray(value)) {
        for (const item of value) {
          if (looksLikeMessage(item)) {
            const message = normalizeMessage(item);
            if (message) {
              found.push(message);
            }
          }

          walk(item, depth + 1);
        }
        return;
      }

      for (const item of Object.values(value)) {
        walk(item, depth + 1);
      }
    }

    walk(payload, 0);
    return found;
  }

  function getMessageKey(message) {
    if (message.id) {
      return `id:${message.id}`;
    }

    return `text:${message.time || ''}|${message.authorId || ''}|${message.text}`;
  }

  // Часть ответов биржи приходит без идентификатора сообщения, поэтому одна
  // и та же реплика может лечь дважды: с идентификатором и без. Второй ключ
  // строится по содержанию и схлопывает такие пары.
  function getNaturalKey(message) {
    const author = String(message?.authorName || message?.authorId || '').trim().toLowerCase();
    return `${message?.time || ''}|${author}|${(message?.text || '').trim()}`;
  }

  function collapseByContent(messages) {
    const byNaturalKey = new Map();

    for (const message of messages) {
      const key = getNaturalKey(message);
      const previous = byNaturalKey.get(key);

      if (!previous) {
        byNaturalKey.set(key, message);
        continue;
      }

      byNaturalKey.set(key, {
        ...previous,
        ...message,
        id: previous.id || message.id,
        recipientId: previous.recipientId || message.recipientId,
        recipientName: previous.recipientName || message.recipientName,
        attachments: previous.attachments?.length ? previous.attachments : message.attachments,
      });
    }

    return [...byNaturalKey.values()];
  }

  function mergeMessages(...batches) {
    const known = new Map();

    for (const batch of batches) {
      if (!Array.isArray(batch)) {
        continue;
      }

      for (const message of batch) {
        if (!message || typeof message.text !== 'string') {
          continue;
        }

        const key = getMessageKey(message);
        const previous = known.get(key);
        if (!previous) {
          known.set(key, message);
          continue;
        }

        known.set(key, {
          ...previous,
          ...message,
          attachments: previous.attachments?.length ? previous.attachments : message.attachments,
        });
      }
    }

    return collapseByContent([...known.values()]).sort((left, right) => {
      const leftTime = left.time ? Date.parse(left.time) : 0;
      const rightTime = right.time ? Date.parse(right.time) : 0;
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }

      return Number(left.id || 0) - Number(right.id || 0);
    });
  }

  function isInboxPage(href) {
    if (typeof href !== 'string' || !href.trim()) {
      return false;
    }

    try {
      const url = new URL(href, 'https://kwork.ru');
      const isKwork = url.hostname === 'kwork.ru' || url.hostname === 'www.kwork.ru';
      return isKwork && /^\/(inbox|new_inbox)(\/|$)/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function extractDialogKey(href) {
    if (typeof href !== 'string' || !href.trim()) {
      return null;
    }

    try {
      const url = new URL(href, 'https://kwork.ru');
      if (url.hostname !== 'kwork.ru' && url.hostname !== 'www.kwork.ru') {
        return null;
      }

      const match = url.pathname.match(/^\/(?:inbox|new_inbox)\/([^/?#]+)/);
      if (match) {
        return decodeURIComponent(match[1]).trim() || null;
      }

      const queryKey = url.searchParams.get('user')
        || url.searchParams.get('username')
        || url.searchParams.get('dialog');
      return queryKey ? queryKey.trim() : null;
    } catch {
      return null;
    }
  }

  function buildDialogSlug(dialogKey) {
    const normalized = String(dialogKey ?? '').trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    const slug = normalized
      .replace(/[^a-z0-9а-яё_-]+/gi, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');

    return slug || null;
  }

  // Диалоги самой биржи (поддержка, служебные уведомления) перепиской с клиентом
  // не являются: их не выгружают и на диск не пишут.
  const SERVICE_DIALOG_KEYS = new Set(['support', 'kwork', 'kwork_support', 'kworksupport', 'admin']);

  function isServiceDialogKey(dialogKey) {
    const normalized = String(dialogKey ?? '').trim().toLowerCase();
    return normalized !== '' && SERVICE_DIALOG_KEYS.has(normalized);
  }

  function findDialogKeys(payload) {
    const keys = new Set();
    const seen = new Set();

    function walk(value, depth) {
      if (depth > MAX_SCAN_DEPTH || !value || typeof value !== 'object' || seen.has(value)) {
        return;
      }

      seen.add(value);

      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item, depth + 1);
        }
        return;
      }

      const key = firstFilledKey(value, DIALOG_KEYS);
      const hasDialogShape = key
        && (TIME_KEYS.some((timeKey) => value[timeKey] !== undefined)
          || TEXT_KEYS.some((textKey) => value[textKey] !== undefined)
          || value.unread !== undefined
          || value.last_message !== undefined);
      if (hasDialogShape) {
        keys.add(String(key).trim());
      }

      for (const item of Object.values(value)) {
        walk(item, depth + 1);
      }
    }

    walk(payload, 0);
    return [...keys].filter(Boolean);
  }

  function findParticipantId(payload, dialogKey) {
    const wanted = String(dialogKey ?? '').trim().toLowerCase();
    const seen = new Set();
    let participantId = null;

    function walk(value, depth) {
      if (participantId || depth > MAX_SCAN_DEPTH || !value || typeof value !== 'object' || seen.has(value)) {
        return;
      }

      seen.add(value);

      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item, depth + 1);
        }
        return;
      }

      const declaredId = firstFilledKey(value, CLIENT_ID_KEYS);
      if (declaredId) {
        participantId = String(declaredId);
        return;
      }

      const name = firstFilledKey(value, DIALOG_KEYS);
      const id = firstFilledKey(value, ['id', 'user_id', 'userId', 'USERID']);
      if (wanted && id && name && String(name).trim().toLowerCase() === wanted) {
        participantId = String(id);
        return;
      }

      for (const item of Object.values(value)) {
        walk(item, depth + 1);
      }
    }

    walk(payload, 0);
    return participantId;
  }

  const HISTORY_CURSOR_KEYS = [
    'lastMessageId',
    'last_message_id',
    'lastId',
    'last_id',
    'beforeId',
    'before_id',
    'fromId',
    'from_id',
    'maxId',
    'firstMessageId',
  ];
  const HISTORY_OFFSET_KEYS = ['offset', 'skip', 'page', 'p'];
  const MAX_HISTORY_LIMIT = 300;

  function toParamsObject(entries) {
    if (Array.isArray(entries)) {
      return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
    }

    return { ...(entries || {}) };
  }

  // Kwork не документирует, чем листается история переписки, поэтому расширение
  // пробует известные варианты на живом запросе и запоминает сработавший.
  function buildHistoryProbes(baseParams, state) {
    const base = toParamsObject(baseParams);
    const loaded = Number(state?.loaded) || 0;
    const limit = Number(base.limit) || 50;
    const oldestId = state?.oldestId ? String(state.oldestId) : null;
    const probes = [
      { strategy: 'limit', key: 'limit', params: { ...base, limit: String(Math.min(limit + loaded + limit, MAX_HISTORY_LIMIT)) } },
    ];

    for (const key of HISTORY_OFFSET_KEYS) {
      const value = key === 'page' || key === 'p'
        ? String(Math.floor(loaded / limit) + 1)
        : String(loaded);
      probes.push({ strategy: key, key, params: { ...base, [key]: value } });
    }

    if (oldestId) {
      for (const key of HISTORY_CURSOR_KEYS) {
        probes.push({ strategy: key, key, params: { ...base, [key]: oldestId } });
      }
    }

    return probes;
  }

  function buildHistoryRequest(baseParams, strategy, state) {
    return buildHistoryProbes(baseParams, state).find((probe) => probe.strategy === strategy) || null;
  }

  // Страница профиля отдаёт идентификатор клиента, поэтому диалог не нужно
  // открывать ради него: достаточно одного запроса, и он выполняется параллельно.
  function extractProfileUserId(markup, dialogKey) {
    if (typeof markup !== 'string' || !markup) {
      return null;
    }

    const wanted = String(dialogKey ?? '').trim().toLowerCase();
    const pairPattern = /"userProfileId"\s*:\s*(\d+)\s*,\s*"userProfileName"\s*:\s*"([^"]*)"/g;
    let match = pairPattern.exec(markup);

    while (match) {
      if (!wanted || match[2].trim().toLowerCase() === wanted) {
        return match[1];
      }

      match = pairPattern.exec(markup);
    }

    const single = markup.match(/"userProfileId"\s*:\s*(\d+)/);
    return single ? single[1] : null;
  }

  // Kwork на большие запросы отдаёт сводную ленту по всем перепискам, поэтому
  // в диалог принимаются только сообщения между его участниками.
  function belongsToDialog(message, context) {
    const dialogKey = String(context?.dialogKey ?? '').trim().toLowerCase();
    const clientId = context?.clientId ? String(context.clientId) : null;
    const names = [message?.authorName, message?.recipientName]
      .filter(Boolean)
      .map((name) => String(name).trim().toLowerCase());
    const ids = [message?.authorId, message?.recipientId].filter(Boolean).map(String);

    // Имя участника надёжнее идентификатора: страница переписки видит и запросы
    // соседних диалогов, а идентификатор собеседника берётся из того же ответа
    // и подтвердил бы чужую переписку сам себе.
    if (dialogKey && names.length > 0) {
      return names.includes(dialogKey);
    }

    return Boolean(clientId) && ids.includes(clientId);
  }

  function filterDialogMessages(messages, context) {
    if (!Array.isArray(messages)) {
      return [];
    }

    return messages.filter((message) => belongsToDialog(message, context));
  }

  // В переписке ровно два участника, поэтому собственный ник — тот, что не совпадает
  // с ником диалога. Он нужен, чтобы не выгружать собственный профиль как переписку.
  function findOwnerName(messages, dialogKey) {
    const wanted = String(dialogKey ?? '').trim().toLowerCase();
    for (const message of messages || []) {
      for (const name of [message?.authorName, message?.recipientName]) {
        const normalized = String(name ?? '').trim();
        if (normalized && normalized.toLowerCase() !== wanted) {
          return normalized;
        }
      }
    }

    return null;
  }

  function isParallelStrategy(strategy) {
    return ['offset', 'skip', 'page', 'p'].includes(String(strategy || ''));
  }

  function getOldestMessage(messages) {
    return mergeMessages(messages)[0] || null;
  }

  function countNewMessages(knownMessages, incomingMessages) {
    const known = new Set(mergeMessages(knownMessages).map(getMessageKey));
    return mergeMessages(incomingMessages).filter((message) => !known.has(getMessageKey(message))).length;
  }

  function formatMessageTime(isoTime) {
    if (!isoTime) {
      return 'без даты';
    }

    const date = new Date(isoTime);
    if (Number.isNaN(date.getTime())) {
      return 'без даты';
    }

    const parts = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);

    return `${parts} МСК`;
  }

  function resolveAuthorLabel(message, dialog) {
    const clientId = dialog?.clientId ? String(dialog.clientId) : null;
    if (clientId && message.authorId) {
      return message.authorId === clientId
        ? (dialog?.title || message.authorName || 'Клиент')
        : 'Я';
    }

    const ownerId = dialog?.ownerId ? String(dialog.ownerId) : null;
    if (ownerId && message.authorId) {
      return message.authorId === ownerId ? 'Я' : (dialog?.title || message.authorName || 'Клиент');
    }

    const dialogKey = dialog?.key ? String(dialog.key).trim().toLowerCase() : null;
    const authorLogin = message.authorName && !/\s/.test(message.authorName)
      ? message.authorName.trim().toLowerCase()
      : null;
    if (dialogKey && authorLogin) {
      return authorLogin === dialogKey ? (dialog?.title || message.authorName) : 'Я';
    }

    if (message.authorName) {
      return message.authorName;
    }

    return message.authorId ? `Участник ${message.authorId}` : 'Участник';
  }

  function renderDialogMarkdown(dialog) {
    const messages = Array.isArray(dialog?.messages) ? dialog.messages : [];
    const title = dialog?.title || dialog?.key || 'Переписка';
    const attachmentFiles = resolveAttachmentFiles(messages);
    const localFiles = new Map(attachmentFiles.map((item) => [item.url, item.file]));
    const lines = [
      `# Переписка с ${title}`,
      '',
      `- Диалог: ${dialog?.key || 'неизвестен'}`,
      `- Ссылка: ${dialog?.url || `https://kwork.ru/inbox/${dialog?.key || ''}`}`,
      `- Сообщений: ${messages.length}`,
    ];

    if (attachmentFiles.length > 0) {
      lines.push(`- Файлов: ${attachmentFiles.length} (папка «${ATTACHMENT_DIR_NAME}»)`);
    }

    lines.push(
      `- Обновлено: ${formatMessageTime(dialog?.updatedAt || new Date().toISOString())}`,
      '',
      '---',
      '',
    );

    for (const message of messages) {
      lines.push(`## ${resolveAuthorLabel(message, dialog)} — ${formatMessageTime(message.time)}`);
      lines.push('');
      if (message.text) {
        // Решётка в начале строки сообщения превратилась бы в заголовок и сбила
        // границы реплик, поэтому она экранируется.
        lines.push(message.text.replace(/^(\s*)(#+)/gm, '$1\\$2'));
        lines.push('');
      }

      if (message.attachments?.length) {
        lines.push('Вложения:');
        for (const attachment of message.attachments) {
          const localFile = attachment.url ? localFiles.get(attachment.url) : null;
          const target = localFile ? `${ATTACHMENT_DIR_NAME}/${encodeURI(localFile)}` : attachment.url;
          lines.push(target ? `- [${attachment.name}](${target})` : `- ${attachment.name}`);
        }
        lines.push('');
      }
    }

    return `${lines.join('\n').trim()}\n`;
  }

  return {
    ATTACHMENT_DIR_NAME,
    DIALOG_DATA_NAME,
    DIALOG_MARKDOWN_NAME,
    buildDialogSlug,
    belongsToDialog,
    buildHistoryProbes,
    buildHistoryRequest,
    collectMessages,
    countNewMessages,
    getOldestMessage,
    extractDialogKey,
    extractProfileUserId,
    filterDialogMessages,
    findDialogKeys,
    findOwnerName,
    findParticipantId,
    formatMessageTime,
    htmlToText,
    isInboxPage,
    isParallelStrategy,
    isServiceDialogKey,
    looksLikeMessage,
    mergeMessages,
    normalizeMessage,
    normalizeTime,
    renderDialogMarkdown,
    resolveAttachmentFiles,
    sanitizeFileName,
  };
});
