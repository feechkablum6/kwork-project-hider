// Запись переписок и заказов на диск: папка на диалог и папка на заказ,
// в каждой — текст, полные данные и вложения.

const fs = require('node:fs');
const path = require('node:path');

const core = require('../src/inbox-core.js');
const projectCore = require('../src/project-core.js');

const DATA_DIR_NAME = 'data';
const DIALOG_LIST_FILE = '_dialogs.json';
const PART_SUFFIX = '.part';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getServiceDir(targetDir) {
  return ensureDir(path.join(targetDir, DATA_DIR_NAME));
}

function getDialogDir(targetDir, slug) {
  return path.join(targetDir, slug);
}

function getAttachmentDir(targetDir, slug) {
  return path.join(getDialogDir(targetDir, slug), core.ATTACHMENT_DIR_NAME);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
  return filePath;
}

function moveFile(fromPath, toPath) {
  if (!fs.existsSync(fromPath) || fs.existsSync(toPath)) {
    return false;
  }

  ensureDir(path.dirname(toPath));
  fs.renameSync(fromPath, toPath);
  return true;
}

// Первые версии складывали переписки плоско: `<ник>.md` в корне и `data/<ник>.json`.
// Файлы переносятся в папку диалога при первом же обращении, чтобы раскладка
// не оставалась смешанной.
function migrateDialogLayout(targetDir, slug) {
  const dialogDir = getDialogDir(targetDir, slug);
  const movedMarkdown = moveFile(
    path.join(targetDir, `${slug}.md`),
    path.join(dialogDir, core.DIALOG_MARKDOWN_NAME),
  );
  const movedData = moveFile(
    path.join(targetDir, DATA_DIR_NAME, `${slug}.json`),
    path.join(dialogDir, core.DIALOG_DATA_NAME),
  );

  return movedMarkdown || movedData;
}

function migrateLayout(targetDir) {
  if (!fs.existsSync(targetDir)) {
    return { migrated: 0 };
  }

  const slugs = new Set();

  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      slugs.add(entry.name.replace(/\.md$/, ''));
    }
  }

  const dataDir = path.join(targetDir, DATA_DIR_NAME);
  if (fs.existsSync(dataDir)) {
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('_')) {
        slugs.add(entry.name.replace(/\.json$/, ''));
      }
    }
  }

  let migrated = 0;
  for (const slug of slugs) {
    if (migrateDialogLayout(targetDir, slug)) {
      migrated += 1;
    }
  }

  return { migrated };
}

const WAKE_DIRTY_DIR = 'wake-dirty';

function markDialogDirty(targetDir, slug) {
  const dirtyDir = ensureDir(path.join(getServiceDir(targetDir), WAKE_DIRTY_DIR));
  fs.writeFileSync(path.join(dirtyDir, slug), '');
}

function saveDialog(targetDir, { dialog, sample }) {
  const slug = core.buildDialogSlug(dialog?.key);
  if (!slug) {
    throw new Error('переписка без имени диалога');
  }

  if (core.isServiceDialogKey(dialog?.key) || !Array.isArray(dialog?.messages) || dialog.messages.length === 0) {
    return { path: null, messages: 0, skipped: true };
  }

  ensureDir(targetDir);
  migrateDialogLayout(targetDir, slug);

  // Отметка для будильщика агентов ставится до записи переписки: упади мост
  // между ними — будильщик просто проверит диалог, где ничего не изменилось.
  markDialogDirty(targetDir, slug);

  const dialogDir = ensureDir(getDialogDir(targetDir, slug));
  const jsonPath = path.join(dialogDir, core.DIALOG_DATA_NAME);
  const markdownPath = path.join(dialogDir, core.DIALOG_MARKDOWN_NAME);

  const previous = readJson(jsonPath);
  const dialogContext = { dialogKey: dialog.key, clientId: dialog.clientId || previous?.clientId || null };
  const messages = core.filterDialogMessages(
    core.mergeMessages(previous?.messages, dialog?.messages),
    dialogContext,
  );
  // Точка сверки — последнее сообщение, до которого история на диске сплошная. Двигает
  // её только выгрузка, подтвердившая сплошность (verified или полная история), и только
  // до конца своей пачки. Тихая запись (getnewmessages не видит сообщений заказа) и
  // вкладка Kwork оставляют её на месте: пропуск дочитает обычная выгрузка.
  const previousLast = Array.isArray(previous?.messages) ? previous.messages[previous.messages.length - 1] : null;
  const previousVerified = previous?.verifiedTime ?? previousLast?.time ?? null;
  const confirmed = dialog.verified === true || dialog.complete === true;
  const verifiedTime = (confirmed ? [previousVerified, ...(dialog.messages || []).map((item) => item?.time)] : [previousVerified])
    .filter((time) => Number.isFinite(Date.parse(time)))
    .reduce((latest, time) => (latest && Date.parse(latest) >= Date.parse(time) ? latest : time), null);
  const record = {
    key: dialog.key,
    title: dialog.title || previous?.title || dialog.key,
    url: dialog.url || previous?.url || `https://kwork.ru/inbox/${dialog.key}`,
    clientId: dialog.clientId || previous?.clientId || null,
    historyStrategy: dialog.strategy || previous?.historyStrategy || null,
    historyComplete: dialog.complete === undefined ? previous?.historyComplete ?? null : dialog.complete,
    verifiedTime,
    ownerId: dialog.ownerId || previous?.ownerId || null,
    updatedAt: dialog.updatedAt || new Date().toISOString(),
    messages,
    // События заказов (опции, оплата, сдача) пишет отдельная команда; переписка их не трогает.
    events: Array.isArray(previous?.events) ? previous.events : [],
    samples: sample ? [...(previous?.samples || []), sample].slice(-3) : (previous?.samples || []),
  };

  writeFileAtomic(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  writeFileAtomic(markdownPath, core.renderDialogMarkdown(record));
  // Вторая отметка — после записи: будильщик, захвативший первую и прочитавший
  // переписку до записи, увидит новое сообщение по второй на следующем такте.
  markDialogDirty(targetDir, slug);
  updateOrderIndex(targetDir, slug, record);
  updateOpenOffers(targetDir, slug, record);

  return {
    path: markdownPath,
    messages: messages.length,
    attachments: core.resolveAttachmentFiles(messages).length,
  };
}

function resolveAttachmentPath(targetDir, dialogKey, fileName) {
  const slug = core.buildDialogSlug(dialogKey);
  if (!slug) {
    throw new Error('вложение без имени диалога');
  }

  const safeName = core.sanitizeFileName(fileName);
  if (!safeName) {
    throw new Error('вложение без имени файла');
  }

  const dir = getAttachmentDir(targetDir, slug);
  const filePath = path.join(dir, safeName);
  if (path.dirname(filePath) !== dir) {
    throw new Error('имя вложения уводит запись за пределы папки');
  }

  return { dir, filePath };
}

// Файлы приходят кусками: пока идёт передача, данные копятся во временном файле,
// и только последний кусок делает вложение видимым под настоящим именем.
const STALE_PART_MS = 10 * 60 * 1000;

// Оборванная передача (закрыли Chrome, перезагрузили расширение) оставляет
// свой кусок; после удачной записи того же файла старые куски не нужны.
// Свежие не трогаются: их может дописывать параллельная передача.
function removeStaleParts(dir, fileName) {
  const prefix = `${fileName}.`;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(PART_SUFFIX)) {
      continue;
    }

    const partPath = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(partPath).mtimeMs > STALE_PART_MS) {
        fs.rmSync(partPath, { force: true });
      }
    } catch {
      // Кусок уже убрала другая передача.
    }
  }
}

// Один и тот же файл могут одновременно передавать фоновая автовыгрузка и
// открытая вкладка Kwork. У каждой передачи свой временный файл, а куски
// принимаются строго по порядку: иначе две передачи перемешали бы байты.
const nextParts = new Map();

function saveAttachment(targetDir, message) {
  const { dir, filePath } = resolveAttachmentPath(targetDir, message?.dialogKey, message?.file);
  ensureDir(dir);

  const transferId = String(message?.transferId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const partPath = transferId ? `${filePath}.${transferId}${PART_SUFFIX}` : `${filePath}${PART_SUFFIX}`;
  const chunk = Buffer.from(String(message?.chunk || ''), 'base64');
  const part = Number(message?.part) || 0;

  if (part === 0) {
    fs.writeFileSync(partPath, chunk);
  } else if (nextParts.get(partPath) !== part) {
    nextParts.delete(partPath);
    fs.rmSync(partPath, { force: true });
    throw new Error('кусок вложения пришёл не по порядку, передача отменена');
  } else {
    fs.appendFileSync(partPath, chunk);
  }

  if (message?.final === false) {
    nextParts.set(partPath, part + 1);
    return { path: partPath, part, saved: false };
  }

  nextParts.delete(partPath);
  fs.renameSync(partPath, filePath);
  removeStaleParts(dir, path.basename(filePath));

  return { path: filePath, size: fs.statSync(filePath).size, saved: true };
}

function listAttachments(targetDir, dialogKey) {
  const slug = core.buildDialogSlug(dialogKey);
  if (!slug) {
    throw new Error('запрос вложений без имени диалога');
  }

  const dir = getAttachmentDir(targetDir, slug);
  if (!fs.existsSync(dir)) {
    return { files: [] };
  }

  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(PART_SUFFIX))
    .map((entry) => ({ file: entry.name, size: fs.statSync(path.join(dir, entry.name)).size }));

  return { files };
}

// Недокачанные вложения считаются по всей сохранённой переписке, а не по
// последней странице: старый файл, сорвавшийся однажды, иначе не повторился бы.
function missingAttachments(targetDir, dialogKey) {
  const slug = core.buildDialogSlug(dialogKey);
  if (!slug) {
    throw new Error('запрос вложений без имени диалога');
  }

  const record = readJson(path.join(getDialogDir(targetDir, slug), core.DIALOG_DATA_NAME));
  const saved = new Map(listAttachments(targetDir, dialogKey).files.map((item) => [item.file, item.size]));
  const files = core.resolveAttachmentFiles(record?.messages)
    .filter((item) => item.url)
    .filter((item) => {
      const size = saved.get(item.file);
      return size === undefined || (item.size && size !== Number(item.size));
    })
    .map((item) => ({ url: item.url, file: item.file, size: item.size ?? null }));

  return { files };
}

function dialogsMissingFiles(targetDir) {
  const dialogs = {};
  if (!fs.existsSync(targetDir)) {
    return { dialogs };
  }

  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !fs.existsSync(path.join(targetDir, entry.name, core.DIALOG_DATA_NAME))) {
      continue;
    }

    const count = missingAttachments(targetDir, entry.name).files.length;
    if (count > 0) {
      dialogs[entry.name] = count;
    }
  }

  return { dialogs };
}

function saveKnownDialogs(targetDir, dialogKeys) {
  const keys = [...new Set((dialogKeys || [])
    .map((key) => String(key).trim())
    .filter((key) => key && !core.isServiceDialogKey(key)))].sort();
  const listPath = path.join(getServiceDir(targetDir), DIALOG_LIST_FILE);
  const previous = readJson(listPath)?.dialogKeys || [];
  const merged = [...new Set([...previous, ...keys])].filter((key) => !core.isServiceDialogKey(key)).sort();

  writeFileAtomic(listPath, `${JSON.stringify({ updatedAt: new Date().toISOString(), dialogKeys: merged }, null, 2)}\n`);

  return { path: listPath, dialogs: merged.length };
}

// Когда список переписок собрать не удалось, на диск ложится срез страницы:
// по нему видно, что именно вернула биржа, без доступа к браузеру пользователя.
function saveDiagnostics(targetDir, diagnostics) {
  const filePath = path.join(getServiceDir(targetDir), '_diagnostics.json');
  writeFileAtomic(filePath, `${JSON.stringify({ at: new Date().toISOString(), ...diagnostics }, null, 2)}\n`);
  return { path: filePath };
}

// Фоновая автовыгрузка спрашивает, чем кончается сохранённое, чтобы решить,
// хватит ли последней страницы истории или диалог нужно дочитать целиком.
// Ключи сохранённых сообщений: по ним страница Kwork ставит галочку
// «есть у Claude».
function messageKeys(targetDir, dialogKey) {
  const slug = core.buildDialogSlug(dialogKey);
  if (!slug) {
    return { keys: [] };
  }

  const record = readJson(path.join(getDialogDir(targetDir, slug), core.DIALOG_DATA_NAME));
  return { keys: core.savedMessageKeys(record?.messages) };
}

function indexDialogs(targetDir, dialogKeys) {
  const dialogs = {};

  for (const key of dialogKeys || []) {
    const slug = core.buildDialogSlug(key);
    if (!slug || core.isServiceDialogKey(key)) {
      continue;
    }

    const record = readJson(path.join(getDialogDir(targetDir, slug), core.DIALOG_DATA_NAME));
    const messages = Array.isArray(record?.messages) ? record.messages : [];
    const last = messages[messages.length - 1];
    if (!last) {
      continue;
    }

    dialogs[String(key).trim().toLowerCase()] = {
      // Первая страница сверяется с точкой сверки, а не с последним тихим сообщением.
      lastTime: record.verifiedTime || last.time || null,
      lastId: last.id ? String(last.id) : null,
      count: messages.length,
      complete: record.historyComplete ?? null,
    };
  }

  return { dialogs };
}

// Отклики копятся: биржа показывает только последние, а сверке агента нужны
// и те, что ушли со страницы.
function saveOffers(targetDir, offers) {
  const filePath = path.join(getServiceDir(targetDir), '_offers.json');
  const known = new Map((readJson(filePath)?.offers || []).map((item) => [String(item.offerId), item]));

  for (const item of Array.isArray(offers) ? offers : []) {
    if (item?.offerId && item?.projectId) {
      known.set(String(item.offerId), { ...known.get(String(item.offerId)), ...item, seenAt: new Date().toISOString() });
    }
  }

  const list = [...known.values()].sort((left, right) => Number(right.offerId) - Number(left.offerId));
  writeFileAtomic(filePath, `${JSON.stringify({ updatedAt: new Date().toISOString(), offers: list }, null, 2)}\n`);
  return { path: filePath, offers: list.length };
}

// Заказы клиентов: номер заказа → диалог. По нему расширение знает, чьи события
// заказов читать и куда их писать. Закрытый заказ (принят, отменён) читается ещё сутки.
const ORDER_INDEX_FILE = 'orders.json';
const ORDER_CLOSED_TYPES = new Set([5, 7, 9, 10, 11, 12, 16, 18, 19, 27, 28, 34, 35, 47, 58, 60, 61, 64]);

function readOrderIndex(targetDir) {
  const index = readJson(path.join(getServiceDir(targetDir), ORDER_INDEX_FILE));
  return index && typeof index === 'object' && !Array.isArray(index) ? index : null;
}

function collectOrders(slug, record) {
  const orders = {};
  const touch = (orderId, time, closed = false) => {
    const id = String(orderId || '').trim();
    if (!/^\d+$/.test(id)) return;
    const entry = orders[id] || { dialogKey: record.key || slug, slug, clientId: record.clientId || null, lastTime: null, closed: false };
    if (time && (!entry.lastTime || Date.parse(time) > Date.parse(entry.lastTime))) entry.lastTime = time;
    entry.closed = entry.closed || closed;
    orders[id] = entry;
  };

  for (const message of Array.isArray(record.messages) ? record.messages : []) {
    touch(message.orderId, message.time);
    touch(message.event?.orderId, message.time);
  }

  for (const event of Array.isArray(record.events) ? record.events : []) {
    touch(event.orderId, event.time, ORDER_CLOSED_TYPES.has(Number(event.type)));
  }

  return orders;
}

function updateOrderIndex(targetDir, slug, record) {
  const indexPath = path.join(getServiceDir(targetDir), ORDER_INDEX_FILE);
  const index = readOrderIndex(targetDir) || buildOrderIndex(targetDir);
  let changed = false;
  for (const [orderId, entry] of Object.entries(collectOrders(slug, record))) {
    if (JSON.stringify(index[orderId]) !== JSON.stringify(entry)) {
      index[orderId] = entry;
      changed = true;
    }
  }

  if (changed || !fs.existsSync(indexPath)) {
    writeFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }
}

function buildOrderIndex(targetDir) {
  const index = {};
  for (const entry of fs.existsSync(targetDir) ? fs.readdirSync(targetDir, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || entry.name === DATA_DIR_NAME || entry.name.startsWith('.')) continue;
    const record = readJson(path.join(targetDir, entry.name, core.DIALOG_DATA_NAME));
    if (record) Object.assign(index, collectOrders(entry.name, record));
  }

  return index;
}

// Индивидуальные предложения, которые клиент ещё не оплатил: отказ Kwork не
// присылает новым сообщением, а меняет статус у старого — расширение перечитывает
// такие диалоги. Предложение старше двух недель уже не ждём.
const OPEN_OFFERS_FILE = 'open-offers.json';
const OPEN_OFFER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Записи до 1.24.0 хранили предложение без события, одним заголовком Kwork: их статус
// неизвестен, и первая перепроверка его узнаёт.
const LEGACY_OFFER_TITLE = 'Предложение индивидуального кворка';

function collectOpenOffers(slug, record) {
  const clientId = record.clientId ? String(record.clientId) : null;
  const offers = (Array.isArray(record.messages) ? record.messages : [])
    .filter((message) => (message.event?.type === 'offer_kwork_new' && message.event.status === 'new')
      || (!message.event && message.text === LEGACY_OFFER_TITLE && (!clientId || String(message.authorId) !== clientId)))
    .map((message) => ({ id: message.id ? String(message.id) : null, time: message.time || null }));
  return offers.length > 0 ? { dialogKey: record.key || slug, clientId: record.clientId || null, offers } : null;
}

function readOpenOffers(targetDir) {
  const index = readJson(path.join(getServiceDir(targetDir), OPEN_OFFERS_FILE));
  if (index && typeof index === 'object' && !Array.isArray(index)) return index;
  const built = {};
  for (const entry of fs.existsSync(targetDir) ? fs.readdirSync(targetDir, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || entry.name === DATA_DIR_NAME || entry.name.startsWith('.')) continue;
    const record = readJson(path.join(targetDir, entry.name, core.DIALOG_DATA_NAME));
    const open = record && collectOpenOffers(entry.name, record);
    if (open) built[entry.name] = open;
  }

  return built;
}

function updateOpenOffers(targetDir, slug, record) {
  const filePath = path.join(getServiceDir(targetDir), OPEN_OFFERS_FILE);
  const existed = fs.existsSync(filePath);
  const index = readOpenOffers(targetDir);
  const open = collectOpenOffers(slug, record);
  if (!existed || JSON.stringify(index[slug] || null) !== JSON.stringify(open)) {
    if (open) index[slug] = open;
    else delete index[slug];
    writeFileAtomic(filePath, `${JSON.stringify(index, null, 2)}\n`);
  }
}

function listOpenOffers(targetDir, now = Date.now()) {
  const fresh = (offer) => now - (Date.parse(offer?.time) || 0) < OPEN_OFFER_MAX_AGE_MS;
  return {
    dialogs: Object.entries(readOpenOffers(targetDir))
      .map(([slug, entry]) => ({ slug, dialogKey: entry.dialogKey, clientId: entry.clientId, ids: (entry.offers || []).filter(fresh).map((offer) => offer.id || offer.time) }))
      .filter((entry) => entry.ids.length > 0),
  };
}

// Заказы, события которых стоит читать: живые за 45 дней и закрытые за последние сутки.
function listActiveOrders(targetDir, now = Date.now()) {
  const index = readOrderIndex(targetDir) || buildOrderIndex(targetDir);
  const orders = Object.entries(index)
    .map(([orderId, entry]) => ({ orderId, ...entry }))
    .filter((entry) => {
      const age = now - (Date.parse(entry.lastTime) || 0);
      return entry.closed ? age < 24 * 60 * 60 * 1000 : age < 45 * 24 * 60 * 60 * 1000;
    })
    .sort((left, right) => (Date.parse(right.lastTime) || 0) - (Date.parse(left.lastTime) || 0));
  return { orders };
}

// События заказа ложатся в данные диалога клиента. Запись и отметка будильщику —
// только когда что-то изменилось: опрос заказов идёт каждые пару минут.
function saveOrderEvents(targetDir, { dialogKey, clientId, orderId, events }) {
  const slug = core.buildDialogSlug(dialogKey);
  if (!slug || core.isServiceDialogKey(dialogKey) || !/^\d+$/.test(String(orderId || ''))) {
    throw new Error('события заказа без диалога или номера заказа');
  }

  const fresh = (Array.isArray(events) ? events : []).filter((event) => event && String(event.orderId) === String(orderId));
  ensureDir(targetDir);
  migrateDialogLayout(targetDir, slug);
  const dialogDir = ensureDir(getDialogDir(targetDir, slug));
  const jsonPath = path.join(dialogDir, core.DIALOG_DATA_NAME);
  const previous = readJson(jsonPath);
  const merged = core.mergeEvents(previous?.events, fresh);
  if (previous && JSON.stringify(merged) === JSON.stringify(previous.events || [])) {
    return { saved: false, events: merged.length };
  }

  markDialogDirty(targetDir, slug);
  const record = {
    key: previous?.key || dialogKey,
    title: previous?.title || dialogKey,
    url: previous?.url || `https://kwork.ru/inbox/${dialogKey}`,
    clientId: previous?.clientId || clientId || null,
    historyStrategy: previous?.historyStrategy ?? null,
    historyComplete: previous?.historyComplete ?? null,
    verifiedTime: previous?.verifiedTime ?? null,
    ownerId: previous?.ownerId ?? null,
    updatedAt: new Date().toISOString(),
    messages: Array.isArray(previous?.messages) ? previous.messages : [],
    events: merged,
    samples: previous?.samples || [],
  };
  writeFileAtomic(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  writeFileAtomic(path.join(dialogDir, core.DIALOG_MARKDOWN_NAME), core.renderDialogMarkdown(record));
  markDialogDirty(targetDir, slug);
  updateOrderIndex(targetDir, slug, record);
  return { saved: true, events: merged.length };
}

// Черновик агента для панели на странице Kwork: части ответа, а рядом — хвост
// переписки и события заказа, по которым панель видит, что уже отправлено и не
// устарел ли черновик. Только в память страницы: на диск расширение это не пишет.
const DRAFTS_DIR = 'drafts';
const DRAFT_MESSAGE_FIELDS = ['id', 'time', 'authorId', 'authorName', 'text', 'orderId', 'event', 'replyTo'];

function getDraft(targetDir, { dialogKey, orderId } = {}) {
  let slug = dialogKey ? core.buildDialogSlug(dialogKey) : null;
  if (!slug && /^\d+$/.test(String(orderId || ''))) {
    slug = (readOrderIndex(targetDir) || buildOrderIndex(targetDir))[String(orderId)]?.slug || null;
  }

  if (!slug) {
    return { draft: null };
  }

  const draft = readJson(path.join(getServiceDir(targetDir), DRAFTS_DIR, `${slug}.json`));
  if (!draft || !Array.isArray(draft.parts) || draft.parts.length === 0) {
    return { slug, draft: null };
  }

  const record = readJson(path.join(targetDir, slug, core.DIALOG_DATA_NAME));
  const messages = (Array.isArray(record?.messages) ? record.messages : []).slice(-80).map((message) => {
    const item = {};
    for (const field of DRAFT_MESSAGE_FIELDS) {
      if (message[field] !== undefined) item[field] = message[field];
    }
    return item;
  });
  return {
    slug,
    dialogKey: record?.key || draft.nick || slug,
    clientId: record?.clientId || draft.clientId || null,
    draft,
    messages,
    events: (Array.isArray(record?.events) ? record.events : []).slice(-40),
  };
}

// По этому файлу агент понимает, насколько свежи переписки на диске.
function saveSyncStatus(targetDir, status) {
  const filePath = path.join(getServiceDir(targetDir), '_sync.json');
  writeFileAtomic(filePath, `${JSON.stringify({ ...(status || {}), at: new Date().toISOString() }, null, 2)}\n`);
  return { path: filePath };
}

// Папка заказов лежит рядом с папкой переписок, если мост не настроен на другую:
// у обеих один корень, и агенту не нужно знать про две разные настройки.
function resolveDirs(value) {
  const dirs = typeof value === 'string' ? { targetDir: value } : { ...(value || {}) };
  const targetDir = String(dirs.targetDir || '').trim();

  return {
    targetDir,
    projectsDir: String(dirs.projectsDir || '').trim()
      || path.join(path.dirname(targetDir), projectCore.PROJECTS_DIR_NAME),
  };
}

// Номер заказа известен и при записи файлов, а имя папки содержит ещё и заголовок,
// поэтому папка ищется по номеру, а не собирается заново.
function findProjectDir(projectsDir, projectId) {
  const id = String(projectId ?? '').trim();
  if (!/^\d+$/.test(id)) {
    throw new Error('заказ без номера');
  }

  if (fs.existsSync(projectsDir)) {
    const existing = fs.readdirSync(projectsDir, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && (entry.name === id || entry.name.startsWith(`${id}-`)));

    if (existing) {
      return path.join(projectsDir, existing.name);
    }
  }

  return path.join(projectsDir, id);
}

function saveProject(projectsDir, { project }) {
  const slug = projectCore.buildProjectSlug(project);
  if (!slug) {
    throw new Error('заказ без номера');
  }

  const previousDir = findProjectDir(projectsDir, project.id);
  const projectDir = path.join(projectsDir, slug);

  if (previousDir !== projectDir && fs.existsSync(previousDir)) {
    fs.renameSync(previousDir, projectDir);
  }

  ensureDir(projectDir);

  const markdownPath = path.join(projectDir, projectCore.PROJECT_MARKDOWN_NAME);
  writeFileAtomic(
    path.join(projectDir, projectCore.PROJECT_DATA_NAME),
    `${JSON.stringify(project, null, 2)}\n`,
  );
  writeFileAtomic(markdownPath, projectCore.renderProjectMarkdown(project));

  return {
    path: markdownPath,
    dir: projectDir,
    files: Array.isArray(project.files) ? project.files.length : 0,
  };
}

function saveProjectFile(projectsDir, message) {
  const dir = path.join(findProjectDir(projectsDir, message?.projectId), projectCore.PROJECT_FILES_DIR_NAME);
  const safeName = core.sanitizeFileName(message?.file);
  if (!safeName) {
    throw new Error('файл заказа без имени');
  }

  const filePath = path.join(dir, safeName);
  if (path.dirname(filePath) !== dir) {
    throw new Error('имя файла уводит запись за пределы папки заказа');
  }

  ensureDir(dir);

  const partPath = `${filePath}${PART_SUFFIX}`;
  const chunk = Buffer.from(String(message?.chunk || ''), 'base64');
  const part = Number(message?.part) || 0;

  if (part === 0) {
    fs.writeFileSync(partPath, chunk);
  } else {
    fs.appendFileSync(partPath, chunk);
  }

  if (message?.final === false) {
    return { path: partPath, part, saved: false };
  }

  fs.rmSync(filePath, { force: true });
  fs.renameSync(partPath, filePath);

  return { path: filePath, size: fs.statSync(filePath).size, saved: true };
}

function handleCommand(dirs, message) {
  const { targetDir, projectsDir } = resolveDirs(dirs);

  if (message?.command === 'save-project') {
    return saveProject(projectsDir, message);
  }

  if (message?.command === 'save-project-file') {
    return saveProjectFile(projectsDir, message);
  }

  if (message?.command === 'save-diagnostics') {
    return saveDiagnostics(targetDir, message.diagnostics || {});
  }

  if (message?.command === 'save-dialog') {
    return saveDialog(targetDir, message);
  }

  if (message?.command === 'save-attachment') {
    return saveAttachment(targetDir, message);
  }

  if (message?.command === 'missing-attachments') {
    return missingAttachments(targetDir, message.dialogKey);
  }

  if (message?.command === 'dialogs-missing-files') {
    return dialogsMissingFiles(targetDir);
  }

  if (message?.command === 'list-attachments') {
    return listAttachments(targetDir, message.dialogKey);
  }

  if (message?.command === 'migrate-layout') {
    return migrateLayout(targetDir);
  }

  if (message?.command === 'message-keys') {
    return messageKeys(targetDir, message.dialogKey);
  }

  if (message?.command === 'dialog-index') {
    return indexDialogs(targetDir, message.dialogKeys);
  }

  if (message?.command === 'save-offers') {
    return saveOffers(targetDir, message.offers);
  }

  if (message?.command === 'sync-status') {
    return saveSyncStatus(targetDir, message.status);
  }

  if (message?.command === 'known-dialogs') {
    return saveKnownDialogs(targetDir, message.dialogKeys);
  }

  if (message?.command === 'save-order-events') {
    return saveOrderEvents(targetDir, message);
  }

  if (message?.command === 'active-orders') {
    return listActiveOrders(targetDir);
  }

  if (message?.command === 'open-offers') {
    return listOpenOffers(targetDir, Number(message.now) || Date.now());
  }

  if (message?.command === 'get-draft') {
    return getDraft(targetDir, message);
  }

  throw new Error(`неизвестная команда: ${message?.command}`);
}

module.exports = {
  WAKE_DIRTY_DIR,
  handleCommand,
  listAttachments,
  migrateLayout,
  resolveDirs,
  saveAttachment,
  saveDialog,
  saveDiagnostics,
  saveKnownDialogs,
  saveOrderEvents,
  listActiveOrders,
  getDraft,
  saveProject,
  saveProjectFile,
};
