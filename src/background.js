importScripts('inbox-core.js', 'session-sync.js');

const core = globalThis.KworkInboxCore;

const HOST_NAME = 'ru.kwork.hider.host';
const STATUS_KEY = 'inboxBridgeStatus';
const CRAWL_KEY = 'inboxCrawlState';
const BRIDGE_TIMEOUT_MS = 20000;

let port = null;
let requestCounter = 0;
const pendingRequests = new Map();

function setStatus(status) {
  chrome.storage.local.set({
    [STATUS_KEY]: { ...status, at: new Date().toISOString() },
  });
}

function setCrawlState(patch) {
  chrome.storage.local.get([CRAWL_KEY], (result) => {
    const next = { ...(result?.[CRAWL_KEY] || {}), ...patch, at: new Date().toISOString() };
    chrome.storage.local.set({ [CRAWL_KEY]: next });
    chrome.runtime.sendMessage({ type: 'kph-crawl-state', state: next }, () => {
      void chrome.runtime.lastError;
    });
  });
}

function getPort() {
  if (port) {
    return port;
  }

  port = chrome.runtime.connectNative(HOST_NAME);
  // Мост постоянного порта слушает заявки агентов «выгрузи сейчас» и будит
  // агентов; одноразовые мосты (передача входа) этого не делают.
  port.postMessage({ command: 'subscribe' });
  port.onMessage.addListener((response) => {
    if (response?.push === 'sync') {
      requestSyncNow(response);
      return;
    }

    const pending = response?.id ? pendingRequests.get(response.id) : null;
    if (pending) {
      pendingRequests.delete(response.id);
      clearTimeout(pending.timer);
      pending.resolve(response);
    }

    // Файлы идут кусками, и каждый кусок отвечает отдельно: статус моста
    // обновляют только законченные записи, иначе он мигает на каждом куске.
    if (response?.ok && response.saved === false) {
      return;
    }

    // Статус в попапе относится к выгрузке переписок, поэтому удачно сохранённый
    // заказ его не подменяет: о своём результате вкладка сообщает сама.
    if (response?.ok && String(response.command || '').startsWith('save-project')) {
      return;
    }

    if (response?.command === 'sync-done') {
      return;
    }

    setStatus(response?.ok
      ? { ok: true, path: response.path }
      : { ok: false, error: response?.error || 'мост вернул ошибку' });
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message;
    port = null;
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: error || 'мост отключился' });
    }

    pendingRequests.clear();

    if (error) {
      setStatus({ ok: false, error });
    }
  });

  return port;
}

function request(payload) {
  requestCounter += 1;
  const id = `r${requestCounter}`;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      resolve({ ok: false, error: 'мост не ответил' });
    }, BRIDGE_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, timer });

    if (!post({ ...payload, id })) {
      pendingRequests.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, error: 'мост недоступен' });
    }
  });
}

function post(payload) {
  try {
    getPort().postMessage(payload);
    return true;
  } catch (error) {
    port = null;
    setStatus({ ok: false, error: error?.message || 'мост недоступен' });
    return false;
  }
}

function findInboxTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://kwork.ru/*' }, (tabs) => {
      void chrome.runtime.lastError;
      const inboxTab = (tabs || []).find((tab) => /\/(inbox|new_inbox)/.test(tab.url || ''));
      resolve(inboxTab || (tabs || [])[0] || null);
    });
  });
}

function openInboxTab() {
  return new Promise((resolve) => {
    chrome.tabs.create({ url: 'https://kwork.ru/inbox', active: false }, (tab) => {
      void chrome.runtime.lastError;
      if (!tab) {
        resolve(null);
        return;
      }

      const onUpdated = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve(tab);
        }
      };

      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

async function ensureInboxTab() {
  const existing = await findInboxTab();
  if (existing && /\/(inbox|new_inbox)/.test(existing.url || '')) {
    return existing;
  }

  return openInboxTab();
}

function sendToTab(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      void chrome.runtime.lastError;
      resolve(response || null);
    });
  });
}

const crawlQueue = { keys: [], done: 0, total: 0, messages: 0, skipped: [], error: null, tabId: null, active: false };

function navigateTab(tabId, url) {
  return new Promise((resolve) => {
    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(true);
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(false);
      }
    });
  });
}

// Диалоги без известного клиента дочитываются по одному: страница переписки
// сама раскрывает идентификатор, поэтому расширение открывает её в своей вкладке.
async function processQueue() {
  if (!crawlQueue.active) {
    return;
  }

  const nextKey = crawlQueue.keys.shift();
  if (!nextKey) {
    await waitForAttachments();
    crawlQueue.active = false;
    setCrawlState({
      running: false,
      finished: true,
      total: crawlQueue.total,
      done: crawlQueue.done,
      messages: crawlQueue.messages,
      skipped: crawlQueue.skipped.slice(-50),
      error: crawlQueue.error || null,
    });
    return;
  }

  setCrawlState({
    running: true,
    stage: 'dialog',
    done: crawlQueue.done,
    total: crawlQueue.total,
    messages: crawlQueue.messages,
    dialogKey: nextKey,
  });

  // Файлы предыдущего диалога качает та же вкладка, поэтому уходить с неё
  // можно только после того, как загрузки закончились.
  await waitForAttachments();

  const navigated = await navigateTab(crawlQueue.tabId, `https://kwork.ru/inbox/${encodeURIComponent(nextKey)}`);
  if (!navigated) {
    crawlQueue.skipped.push(nextKey);
    crawlQueue.done += 1;
    processQueue();
    return;
  }

  const response = await sendToTab(crawlQueue.tabId, { type: 'kph-crawl-one' });
  if (!response?.started) {
    crawlQueue.skipped.push(nextKey);
    crawlQueue.done += 1;
    processQueue();
  }
}

async function finishOrContinue(message) {
  const pending = Array.isArray(message.pending) ? message.pending : [];
  const tab = await findInboxTab();

  if (pending.length === 0 || !tab?.id) {
    // Файлы качаются следом за перепиской, поэтому выгрузка считается законченной
    // только когда всё скачанное дошло до диска.
    await waitForAttachments();
    crawlQueue.active = false;
    setCrawlState({
      running: false,
      finished: true,
      total: message.total,
      messages: message.messages,
      error: message.reason || null,
    });
    return;
  }

  crawlQueue.keys = pending;
  crawlQueue.done = Math.max(0, Number(message.total) - pending.length);
  crawlQueue.total = Number(message.total) || pending.length;
  crawlQueue.messages = Number(message.messages) || 0;
  crawlQueue.skipped = [];
  crawlQueue.error = null;
  crawlQueue.tabId = tab.id;
  crawlQueue.active = true;
  processQueue();
}

function getTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      void chrome.runtime.lastError;
      resolve(tab || null);
    });
  });
}

// Вход проверяется по тому, куда Kwork привёл вкладку: гостя биржа уводит
// со страницы переписок на вход или на главную.
async function checkAuth() {
  const tab = await ensureInboxTab();
  if (!tab?.id) {
    return { ok: false, reason: 'no-tab', tab: null };
  }

  const actual = await getTab(tab.id);
  const url = actual?.url || '';

  if (/kwork\.ru\/(inbox|new_inbox)/.test(url)) {
    return { ok: true, tab: actual };
  }

  return { ok: false, reason: 'signed-out', tab: actual };
}

async function focusKworkTab() {
  const tab = await findInboxTab();
  if (tab?.id) {
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows?.update?.(tab.windowId, { focused: true });
    return;
  }

  chrome.tabs.create({ url: 'https://kwork.ru/inbox', active: true });
}

async function startCrawl() {
  attachmentProgress.done = 0;
  attachmentProgress.total = 0;
  setCrawlState({
    running: true,
    stage: 'auth',
    done: 0,
    total: 0,
    messages: 0,
    files: { done: 0, total: 0 },
    error: null,
    authRequired: false,
    skipped: [],
  });

  const auth = await checkAuth();

  if (!auth.ok) {
    setCrawlState({
      running: false,
      finished: false,
      authRequired: auth.reason === 'signed-out',
      error: auth.reason === 'signed-out'
        ? 'Kwork не пускает к перепискам: вход не выполнен'
        : 'Не удалось открыть страницу переписок Kwork',
    });
    return;
  }

  setCrawlState({ running: true, stage: 'dialogs' });
  // Новые автопроходы ждут ручную выгрузку, а уже идущий она дожидается сама:
  // два потока запросов к бирже — прямой путь к 429.
  manualCrawlAt = Date.now();
  const generation = crawlGeneration;
  const idle = await waitForSyncIdle();
  // Пока ждали, выгрузку могли отменить.
  if (generation !== crawlGeneration) {
    return;
  }

  if (!idle) {
    manualCrawlAt = 0;
    setCrawlState({ running: false, error: 'Идёт автосохранение переписок, повторите через минуту' });
    return;
  }

  manualCrawlAt = Date.now();
  const response = await sendToTab(auth.tab.id, { type: 'kph-crawl-all' });
  if (!response?.started) {
    setCrawlState({
      running: false,
      error: 'Страница переписок не отвечает: перезагрузите вкладку Kwork',
    });
  }
}

async function cancelCrawl() {
  crawlGeneration += 1;
  manualCrawlAt = 0;
  crawlQueue.active = false;
  crawlQueue.keys = [];
  const tab = await findInboxTab();
  if (tab?.id) {
    await sendToTab(tab.id, { type: 'kph-crawl-cancel' });
  }

  setCrawlState({ running: false, cancelled: true });
}

const attachmentProgress = { done: 0, total: 0 };
const activeDownloads = new Set();

function trackDownload(task) {
  activeDownloads.add(task);
  task.finally(() => activeDownloads.delete(task));
  return task;
}

async function waitForAttachments() {
  while (activeDownloads.size > 0) {
    await Promise.allSettled([...activeDownloads]);
  }
}

function reportAttachmentProgress() {
  setCrawlState({ files: { done: attachmentProgress.done, total: attachmentProgress.total } });
}

// Файлы качает сама вкладка Kwork: там запрос уходит как обычный запрос страницы,
// с её адресом и куками, поэтому биржа отдаёт вложение, а не страницу ошибки.
// Уже скачанное не перекачивается: мост отдаёт список лежащих файлов с размерами.
async function downloadAttachments(dialog, tabId) {
  const files = core.resolveAttachmentFiles(dialog?.messages).filter((item) => item.url);
  if (files.length === 0 || !tabId) {
    return;
  }

  const known = await request({ command: 'list-attachments', dialogKey: dialog.key });
  const saved = new Map((known?.files || []).map((item) => [item.file, item.size]));
  const missing = files.filter((item) => {
    const size = saved.get(item.file);
    return size === undefined || (item.size && size !== item.size);
  });

  if (missing.length === 0) {
    return;
  }

  attachmentProgress.total += missing.length;
  reportAttachmentProgress();

  await sendToTab(tabId, {
    type: 'kph-download-attachments',
    dialogKey: dialog.key,
    files: missing.map((item) => ({ url: item.url, file: item.file })),
  });
}

const PROJECT_FILE_CHUNK_BYTES = 3 * 1024 * 1024;
const MAX_PROJECT_FILE_BYTES = 300 * 1024 * 1024;

function toBase64(bytes) {
  const step = 0x8000;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }

  return btoa(binary);
}

// Файлы заказа уходят на диск кусками: native messaging принимает только текст.
async function sendProjectFile(projectId, file, bytes) {
  const parts = Math.max(1, Math.ceil(bytes.length / PROJECT_FILE_CHUNK_BYTES));

  for (let part = 0; part < parts; part += 1) {
    const slice = bytes.subarray(part * PROJECT_FILE_CHUNK_BYTES, (part + 1) * PROJECT_FILE_CHUNK_BYTES);
    const response = await request({
      command: 'save-project-file',
      projectId,
      file,
      part,
      final: part === parts - 1,
      chunk: toBase64(slice),
    });

    if (!response?.ok) {
      return false;
    }
  }

  return true;
}

// Адрес файла приходит со страницы, а качает его фоновый скрипт с куками
// пользователя: чужой адрес увёл бы их на сторону, поэтому качаются только файлы
// самой биржи.
const FILE_HOSTS = new Set(['kwork.ru', 'www.kwork.ru', 'cdn-edge.kwork.ru']);

function isKworkFileUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && FILE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

// Ссылка на файл заказа ведёт на kwork.ru и оттуда переадресуется на CDN,
// который не разрешает межсайтовые запросы. Со страницы такой запрос обрывается,
// поэтому файлы качает фоновый скрипт: у него есть доступ к обоим адресам.
async function downloadProjectFile(projectId, item) {
  if (!isKworkFileUrl(item.url)) {
    return false;
  }

  const response = await fetch(item.url, { credentials: 'include' });
  if (!response.ok) {
    return false;
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_PROJECT_FILE_BYTES) {
    return false;
  }

  return sendProjectFile(projectId, item.file, new Uint8Array(buffer));
}

async function saveProject(project) {
  const saved = await request({ command: 'save-project', project });
  if (!saved?.ok) {
    return { ok: false, error: saved?.error || 'мост не сохранил заказ' };
  }

  const files = Array.isArray(project.files) ? project.files : [];
  const results = await Promise.all(files.map((item) => (
    downloadProjectFile(project.id, item).catch(() => false)
  )));

  return {
    ok: true,
    path: saved.path,
    dir: saved.dir,
    files: files.length,
    savedFiles: results.filter(Boolean).length,
  };
}

// Автовыгрузка: по событию живого канала Kwork и раз в минуту будильником
// фоновый скрипт сам смотрит список диалогов
// Kwork и дописывает на диск новые сообщения. Вкладка Kwork для этого не нужна:
// запросы уходят с куками пользователя, как со страницы биржи.
const SYNC_ALARM = 'kph-inbox-sync';
const SYNC_PERIOD_MINUTES = 1;
const SYNC_SEEN_KEY = 'inboxSyncSeen';
const SYNC_STATE_KEY = 'inboxSyncState';
const SYNC_CONCURRENCY = 3;
const KWORK_ORIGIN = 'https://kwork.ru';
const ATTACHMENT_CHUNK_BYTES = 3 * 1024 * 1024;
// Файлы «Сообщений» и чата заказа Kwork хранит в разных корзинах.
const ATTACHMENT_FINAL_HOSTS = new Set([...FILE_HOSTS, 'kwork-conversation.storage.yandexcloud.net', 'kwork-track.storage.yandexcloud.net']);
const SYNC_RETRY_KEY = 'inboxSyncRetries';
// Последний MID, прочитанный тихо (getnewmessages): следующий тихий запрос берёт только новее.
const SYNC_QUIET_MID_KEY = 'inboxSyncQuietMids';
const SYNC_FILE_RETRY_KEY = 'inboxFileRetries';
const SYNC_MAX_FILE_RETRIES = 5;
const SYNC_MAX_BACKOFF_MINUTES = 60;
const SYNC_TIMES_KEY = 'inboxSyncTimes';
const USER_IDS_KEY = 'inboxUserIds';
// Номера собеседников из списка диалогов пишет только фоновый скрипт — отдельным
// ключом, чтобы не затирать то, что параллельно запомнила вкладка (USER_IDS_KEY).
const SYNC_USER_IDS_KEY = 'inboxSyncUserIds';
const OFFERS_EVERY_MS = 6 * 60 * 1000;
const FILES_SWEEP_EVERY_MS = 60 * 60 * 1000;
const SYNC_THROTTLE_PAUSE_MS = 10 * 60 * 1000;

let syncRunning = false;
// Заявки агентов, которые ждут прохода: ники и номера заявок для ответа мосту.
const forcedNext = { ids: new Set(), keys: new Set() };
// Ручная выгрузка идёт в странице Kwork и шлёт прогресс; пока он свежий,
// автовыгрузка не запускает второй поток запросов к бирже.
const MANUAL_CRAWL_QUIET_MS = 2 * 60 * 1000;
let manualCrawlAt = 0;
let lastPassEndedAt = 0;
const ALARM_MIN_GAP_MS = 20 * 1000;
// Живой канал Kwork: событие о новом сообщении запускает проход сразу. Канал
// один, простаивает без трафика; минутный будильник — запасной путь, когда
// канал оборвался или фоновый скрипт усыпили.
const PULL_DEBOUNCE_MS = 300;
const PULL_RETRY_MIN_MS = 5 * 1000;
const PULL_RETRY_MAX_MS = 60 * 1000;
let pullUrl = null;
let pullSocket = null;
let pullRetryMs = PULL_RETRY_MIN_MS;
let pullRetryTimer = null;
let pullSyncTimer = null;
let pullRerun = false;

// Номер ручной выгрузки: отмена его меняет, и ждущий запуск не стартует.
let crawlGeneration = 0;

async function waitForSyncIdle(limitMs = 2 * 60 * 1000) {
  const deadline = Date.now() + limitMs;
  while (syncRunning && Date.now() < deadline) {
    await pause(500);
  }

  return !syncRunning;
}

function manualCrawlBusy() {
  return crawlQueue.active || Date.now() - manualCrawlAt < MANUAL_CRAWL_QUIET_MS;
}

function requestSyncNow(push) {
  for (const id of push?.requestIds || []) forcedNext.ids.add(String(id));
  for (const nick of push?.nicks || []) forcedNext.keys.add(String(nick).toLowerCase());
  if (!syncRunning) {
    syncInbox();
  }
}

function takeForced() {
  const forced = { ids: [...forcedNext.ids], keys: new Set(forcedNext.keys) };
  forcedNext.ids.clear();
  forcedNext.keys.clear();
  return forced;
}

async function answerForced(forced, ok, error = null) {
  if (forced.ids.length > 0) {
    await request({ command: 'sync-done', requestIds: forced.ids, ok, error });
  }
}
// Общий стоп прохода: после отказа биржи (429, 5xx) его видят и уже
// запущенные диалоги — листание истории и загрузка файлов прекращаются.
let syncStopped = false;

function storageGet(area, key) {
  return new Promise((resolve) => {
    chrome.storage[area].get([key], (result) => {
      void chrome.runtime.lastError;
      resolve(result?.[key]);
    });
  });
}

function storageSet(area, values) {
  return new Promise((resolve) => {
    chrome.storage[area].set(values, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postKworkForm(url, params) {
  const response = await fetch(new URL(url, KWORK_ORIGIN).toString(), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
    body: new URLSearchParams(params).toString(),
  });

  if (!response.ok) {
    const error = new Error(`${url} вернул ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

async function runWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  });

  await Promise.all(workers);
}

// Ссылка на вложение ведёт на kwork.ru и переадресуется в хранилище файлов
// биржи; переадресацию фоновый скрипт проходит сам благодаря разрешению на
// этот адрес. Вместо файла может прийти страница ошибки — такое не сохраняется.
async function fetchAttachment(item) {
  const url = new URL(item.url, KWORK_ORIGIN).toString();
  if (!isKworkFileUrl(url)) {
    return null;
  }

  const response = await fetch(url, { credentials: 'include' });
  // Временный отказ — не беда файла: попытку не тратим, проход отдыхает.
  if (response.status === 429 || response.status >= 500) {
    const error = new Error(`Kwork ответил ${response.status}`);
    error.status = response.status;
    throw error;
  }

  if (!response.ok || !ATTACHMENT_FINAL_HOSTS.has(new URL(response.url).hostname)) {
    return null;
  }

  const type = response.headers.get('content-type') || '';
  if (/text\/html/i.test(type) && !/\.html?$/i.test(item.file)) {
    return null;
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_PROJECT_FILE_BYTES) {
    return null;
  }

  // Размер известен из сообщения: несовпадение значит, что пришёл не тот файл.
  if (Number(item.size) > 0 && buffer.byteLength !== Number(item.size)) {
    return null;
  }

  return new Uint8Array(buffer);
}

async function saveAttachmentBytes(dialogKey, file, bytes) {
  const parts = Math.max(1, Math.ceil(bytes.length / ATTACHMENT_CHUNK_BYTES));
  const transferId = `bg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  for (let part = 0; part < parts; part += 1) {
    const slice = bytes.subarray(part * ATTACHMENT_CHUNK_BYTES, (part + 1) * ATTACHMENT_CHUNK_BYTES);
    const response = await request({
      command: 'save-attachment',
      dialogKey,
      file,
      transferId,
      part,
      final: part === parts - 1,
      chunk: toBase64(slice),
    });

    if (!response?.ok) {
      return false;
    }
  }

  return true;
}

// Недокачанное мост считает по всей сохранённой переписке. Каждый файл
// пробуется не больше пяти раз: удалённое с биржи не должно дёргать её вечно.
async function syncAttachments(dialogKey, fileRetries) {
  const listed = await request({ command: 'missing-attachments', dialogKey });
  if (!listed?.ok) {
    return { saved: 0, failed: 0 };
  }

  let savedCount = 0;
  let failed = 0;

  for (const item of listed.files || []) {
    if (syncStopped) {
      break;
    }

    const retryKey = `${dialogKey.toLowerCase()}/${item.file}`;
    if ((fileRetries[retryKey] || 0) >= SYNC_MAX_FILE_RETRIES) {
      continue;
    }

    let ok = false;
    try {
      const bytes = await fetchAttachment(item);
      ok = Boolean(bytes) && await saveAttachmentBytes(dialogKey, item.file, bytes);
    } catch (error) {
      if (error?.status === 429 || error?.status >= 500) {
        syncStopped = true;
        break;
      }

      ok = false;
    }

    if (ok) {
      savedCount += 1;
      delete fileRetries[retryKey];
    } else {
      failed += 1;
      fileRetries[retryKey] = (fileRetries[retryKey] || 0) + 1;
    }
  }

  return { saved: savedCount, failed };
}

async function syncDialog(item, saved, fileRetries, { files: withFiles = true } = {}) {
  const firstPayload = await postKworkForm('/inbox_more_messages', {
    userId: item.userId,
    allUnread: 'false',
    limit: '50',
  });
  let clientId = core.findParticipantId(firstPayload, item.key) || item.userId;
  let messages = core.filterDialogMessages(core.collectMessages(firstPayload), { dialogKey: item.key, clientId });
  let complete;
  let strategy = null;
  let throttled = false;

  if (core.needsFullHistory(saved, messages)) {
    const result = await core.loadDialogHistory({
      postForm: postKworkForm,
      pause,
      dialogKey: item.key,
      userId: item.userId,
      isCancelled: () => syncStopped,
    });
    messages = core.mergeMessages(messages, result.messages);
    clientId = result.clientId || clientId;
    complete = result.complete;
    strategy = result.strategy || null;
    throttled = result.throttled;
    syncStopped = syncStopped || throttled;
  }

  // Пустой ответ ничего не говорит о переписке: на диске остаётся сохранённое,
  // а диалог проверяется снова на следующем проходе.
  if (messages.length === 0) {
    return { ok: false, throttled, files: { saved: 0, failed: 0 } };
  }

  const dialog = {
    key: item.key,
    title: item.key,
    url: `${KWORK_ORIGIN}/inbox/${item.key}`,
    clientId,
    strategy,
    complete,
    updatedAt: new Date().toISOString(),
    messages,
  };

  const response = await request({ command: 'save-dialog', dialog });
  if (!response?.ok) {
    throw new Error(response?.error || 'мост не сохранил переписку');
  }

  // После отказа биржи файлы не качаются: это те же запросы к kwork.ru.
  const files = syncStopped || !withFiles ? { saved: 0, failed: 0 } : await syncAttachments(dialog.key, fileRetries);
  return { ok: true, complete, throttled, files };
}

// Диалог с непрочитанным: новые личные сообщения без отметки «прочитано» (см. isQuietRead).
// Сообщений внутри заказа getnewmessages не отдаёт — их берёт обычный путь (processDialog).
async function syncDialogQuiet(item, quietMids, fileRetries, { files: withFiles = true } = {}) {
  const key = item.key.toLowerCase();
  const payload = await postKworkForm('/api/inbox/getnewmessages', {
    interlocutorId: item.userId,
    lastMessageId: quietMids[key] || '0',
  });
  const parsed = core.parseNewMessages(payload, { dialogKey: item.key, clientId: item.userId });
  if (!parsed) {
    return { ok: false, throttled: false, files: { saved: 0, failed: 0 } };
  }

  if (parsed.messages.length > 0) {
    const response = await request({
      command: 'save-dialog',
      dialog: {
        key: item.key,
        title: item.key,
        url: `${KWORK_ORIGIN}/inbox/${item.key}`,
        clientId: item.userId,
        // Последнее время диалога сдвинулось, а сообщения заказа между ними не читались:
        // полнота истории больше не подтверждена, обычный путь дочитает её целиком.
        complete: false,
        updatedAt: new Date().toISOString(),
        messages: parsed.messages,
      },
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'мост не сохранил переписку');
    }
  }

  if (parsed.maxMid && Number(parsed.maxMid) > Number(quietMids[key] || 0)) {
    quietMids[key] = parsed.maxMid;
  }

  const files = syncStopped || !withFiles || parsed.messages.length === 0
    ? { saved: 0, failed: 0 }
    : await syncAttachments(item.key, fileRetries);
  return { ok: true, quiet: true, saved: parsed.messages.length > 0, clientUnread: parsed.clientUnread, files };
}

// Отправленные отклики видны только на бирже: страница «Мои предложения»
// несёт их готовым списком. По нему агент сверяет, ушёл ли отклик и по какой цене.
async function syncOffers() {
  const response = await fetch(`${KWORK_ORIGIN}/offers`, { credentials: 'include' });
  if (!response.ok) {
    const error = new Error(`/offers вернул ${response.status}`);
    error.status = response.status;
    throw error;
  }

  if (!/kwork\.ru\/offers/.test(response.url)) {
    return;
  }

  const offers = core.parseOffers(await response.text());
  if (offers.length > 0) {
    await request({ command: 'save-offers', offers });
  }
}

async function reportSync(status) {
  const state = { ...status, at: new Date().toISOString() };
  await storageSet('local', { [SYNC_STATE_KEY]: state });
  await request({ command: 'sync-status', status });
}

// Отказ биржи или обрыв сети — повод остановить проход; ошибка моста — нет.
const { isKworkRefusal } = core;

async function pauseSync() {
  const times = { ...(await storageGet('local', SYNC_TIMES_KEY) || {}) };
  times.pausedUntil = Date.now() + SYNC_THROTTLE_PAUSE_MS;
  await storageSet('local', { [SYNC_TIMES_KEY]: times });
}

async function syncInbox() {
  if (syncRunning) {
    return;
  }

  // Фоновый скрипт один, поэтому замка в памяти достаточно: убитый посреди
  // прохода скрипт уносит его с собой, и следующий будильник начнёт заново.
  syncRunning = true;
  syncStopped = false;
  const forced = takeForced();
  let forcedAnswered = false;
  const answer = async (ok, error = null) => {
    if (!forcedAnswered) {
      forcedAnswered = true;
      await answerForced(forced, ok, error);
    }
  };

  try {
    // Ручная выгрузка сама пишет всё подряд; второй поток запросов ей не нужен.
    if (manualCrawlBusy()) {
      await answer(false, 'идёт ручная выгрузка переписок');
      return;
    }

    // Биржа отказала (429, сбой) — весь проход отдыхает, а не только диалог.
    const pausedUntil = (await storageGet('local', SYNC_TIMES_KEY))?.pausedUntil || 0;
    if (Date.now() < pausedUntil) {
      await answer(false, 'Kwork попросил подождать, повтор через несколько минут');
      return;
    }

    const response = await fetch(`${KWORK_ORIGIN}/inbox`, { credentials: 'include' });
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        await pauseSync();
      }

      throw new Error(`Kwork ответил ${response.status}`);
    }

    const inboxHtml = await response.text();
    const chatList = core.parseChatList(inboxHtml);
    if (!/kwork\.ru\/(inbox|new_inbox)/.test(response.url) || chatList.length === 0) {
      // Вышли из Kwork — канал старого входа больше не слушается.
      closePull();
      pullRetryMs = PULL_RETRY_MIN_MS;
      await reportSync({ ok: false, signedOut: true, error: 'вход в Kwork не выполнен' });
      await answer(false, 'вход в Kwork не выполнен');
      return;
    }

    connectPull(core.parsePullSettings(inboxHtml)?.url);

    // Номера собеседников запоминаются с каждого прохода: по ним запрошенный
    // агентом диалог выгружается, даже когда выпал из 50 свежих.
    const syncUserIds = { ...(await storageGet('local', SYNC_USER_IDS_KEY) || {}) };
    let userIdsChanged = false;
    for (const item of chatList) {
      if (item.userId && syncUserIds[item.key] !== String(item.userId)) {
        syncUserIds[item.key] = String(item.userId);
        userIdsChanged = true;
      }
    }

    if (userIdsChanged) {
      await storageSet('local', { [SYNC_USER_IDS_KEY]: syncUserIds });
    }

    const userIds = { ...(await storageGet('local', USER_IDS_KEY) || {}), ...syncUserIds };

    const seen = { ...(await storageGet('local', SYNC_SEEN_KEY) || {}) };
    const quietMids = { ...(await storageGet('local', SYNC_QUIET_MID_KEY) || {}) };
    const retries = { ...(await storageGet('local', SYNC_RETRY_KEY) || {}) };
    const times = { ...(await storageGet('local', SYNC_TIMES_KEY) || {}) };
    const now = Date.now();

    // Сорвавшийся диалог (429, обрыв, мост) повторяется с растущей паузой:
    // 2, 4, 8… минут, не реже раза в час, и считается незавершённым, пока
    // история не дочитана — на это смотрит и сверка черновиков.
    // Диалог, который запросил агент, пауз повтора не ждёт.
    const changed = core.selectChangedDialogs(chatList, seen).filter((item) => {
      const key = item.key.toLowerCase();
      const retry = retries[key];
      return forced.keys.has(key) || !retry || now - retry.at >= Math.min(2 ** retry.n, SYNC_MAX_BACKOFF_MINUTES) * 60 * 1000;
    });
    // Запрошенный диалог не в списке свежих (пока Chrome был закрыт, обновились
    // другие) — выгружается напрямую по номеру собеседника.
    const listed = new Set(chatList.map((item) => item.key.toLowerCase()));
    const unknownForced = [];
    for (const key of forced.keys) {
      if (listed.has(key)) {
        continue;
      }

      const known = Object.entries(userIds).find(([nick]) => nick.toLowerCase() === key);
      if (known) {
        changed.push({ key: known[0], userId: known[1], lastId: null });
      } else {
        unknownForced.push(key);
      }
    }

    // Сообщения читаются сразу: о новом сообщении клиента сообщает будильщик
    // агентов (мост → Telegram). Непрочитанное читается тихо, без отметки на Kwork.
    const held = [];
    const savedKeys = [];
    const failedKeys = [];
    const files = { saved: 0, failed: 0 };
    // Счётчики неудач по файлам общие на проход: параллельные диалоги
    // иначе перезаписывали бы друг другу весь объект в storage.
    const fileRetries = { ...(await storageGet('local', SYNC_FILE_RETRY_KEY) || {}) };
    const skippedKeys = [];

    if (changed.length > 0) {
      const index = await request({ command: 'dialog-index', dialogKeys: changed.map((item) => item.key) });
      if (!index?.ok) {
        throw new Error(index?.error || 'мост на диск не отвечает');
      }

      const processDialog = async (item, withFiles) => {
        // После отказа биржи оставшиеся диалоги ждут следующего прохода без
        // штрафа: они не виноваты, что очередь до них не дошла.
        if (syncStopped) {
          skippedKeys.push(item.key);
          return;
        }

        const key = item.key.toLowerCase();
        // Канал сообщил о новом сообщении этого клиента уже после снимка списка: его unread
        // устарел, и обычная выгрузка отметила бы новое прочитанным. Диалог ждёт следующего
        // прохода, а он начнётся сразу после этого (forcedNext).
        const freshEvent = () => forcedNext.keys.has(key);
        let done = false;
        let quiet = false;
        try {
          let result;
          if (!core.isQuietRead(item)) {
            if (freshEvent()) {
              skippedKeys.push(item.key);
              return;
            }

            result = await syncDialog(item, index.dialogs?.[key] || null, fileRetries, { files: withFiles });
          } else {
            result = await syncDialogQuiet(item, quietMids, fileRetries, { files: withFiles });
            quiet = result.ok;
            // Непрочитанное может быть в заказе: обычная выгрузка его прочитанным не отмечает
            // (лог робота 16.10.2026: unread заказа держался после выгрузки), но отметила бы
            // личное. Есть личное непрочитанное — заказ ждёт, пока вы прочитаете диалог.
            if (result.ok && item.order) {
              if (result.clientUnread || freshEvent()) {
                // Личное, прочитанное тихо, уже на диске — агенту оно нужно сейчас.
                if (result.saved) savedKeys.push(item.key);
                files.saved += result.files.saved;
                files.failed += result.files.failed;
                held.push(item);
                return;
              }

              const full = await syncDialog(item, index.dialogs?.[key] || null, fileRetries, { files: withFiles });
              result = {
                ...full,
                saved: full.ok || result.saved,
                files: { saved: full.files.saved + result.files.saved, failed: full.files.failed + result.files.failed },
              };
              quiet = false;
            }
          }

          files.saved += result.files.saved;
          files.failed += result.files.failed;
          if (result.ok && result.saved !== false) {
            savedKeys.push(item.key);
          }

          done = result.ok && result.complete !== false;
        } catch (error) {
          syncStopped = syncStopped || isKworkRefusal(error);
          done = false;
        }

        // Диалог, прерванный общим стопом, не виноват: ждёт без штрафа.
        if (!done && syncStopped) {
          skippedKeys.push(item.key);
          return;
        }

        if (done) {
          // Диалог вне списка свежих не знает своего последнего сообщения:
          // отметку «просмотрено» ему ставит следующий проход по списку.
          if (item.lastId) seen[key] = quiet ? core.quietSeenMark(item.lastId) : item.lastId;
          delete retries[key];
        } else {
          retries[key] = { n: (retries[key]?.n || 0) + 1, at: now };
          failedKeys.push(item.key);
        }
      };

      // Запрошенные агентом диалоги — первыми и без файлов: хук агента ждёт
      // текст переписки, а файлы докачаются следом в этом же проходе.
      const { forced: first, rest } = core.splitForced(changed, forced.keys);
      await runWithConcurrency(first, SYNC_CONCURRENCY, (item) => processDialog(item, false));
      await storageSet('local', { [SYNC_SEEN_KEY]: seen, [SYNC_RETRY_KEY]: retries, [SYNC_QUIET_MID_KEY]: quietMids });
      const forcedFailed = [
        ...first.filter((item) => failedKeys.includes(item.key) || skippedKeys.includes(item.key)).map((item) => item.key),
        ...unknownForced,
      ];
      await answer(forcedFailed.length === 0, forcedFailed.length > 0 ? `не дочитаны: ${forcedFailed.join(', ')}` : null);

      for (const item of first) {
        if (!syncStopped && savedKeys.includes(item.key)) {
          const result = await syncAttachments(item.key, fileRetries);
          files.saved += result.saved;
          files.failed += result.failed;
        }
      }

      await runWithConcurrency(rest, SYNC_CONCURRENCY, (item) => processDialog(item, true));
      await storageSet('local', { [SYNC_SEEN_KEY]: seen, [SYNC_RETRY_KEY]: retries, [SYNC_QUIET_MID_KEY]: quietMids });
    }

    // Запрошенного агентом в списке изменений не было: на диске уже свежее.
    await answer(unknownForced.length === 0, unknownForced.length > 0 ? `диалог не найден на Kwork: ${unknownForced.join(', ')}` : null);


    // Отметки времени живут в storage: фоновый скрипт засыпает между
    // будильниками, и счётчик в памяти обнулялся бы на каждом проходе.
    if (!syncStopped && now - (times.offers || 0) >= OFFERS_EVERY_MS) {
      // Отказ биржи на /offers останавливает проход, как и на переписке; страницу
      // перечитаем после паузы. Прочие сбои ждут обычного интервала.
      try {
        await syncOffers();
        times.offers = now;
      } catch (error) {
        if (isKworkRefusal(error)) syncStopped = true;
        else times.offers = now;
      }
    }

    if (!syncStopped && now - (times.filesSweep || 0) >= FILES_SWEEP_EVERY_MS) {
      const pendingFiles = await request({ command: 'dialogs-missing-files' });
      for (const dialogKey of Object.keys(pendingFiles?.dialogs || {})) {
        const result = await syncAttachments(dialogKey, fileRetries);
        files.saved += result.saved;
        files.failed += result.failed;
      }

      times.filesSweep = now;
    }

    // Пауза ставится после всех этапов: отказ может прийти и на обходе файлов.
    if (syncStopped) {
      times.pausedUntil = now + SYNC_THROTTLE_PAUSE_MS;
    }

    await storageSet('local', { [SYNC_TIMES_KEY]: times, [SYNC_FILE_RETRY_KEY]: fileRetries });

    // Пропущенные из-за паузы тоже недочитаны: сверка черновиков по ним
    // не должна решать «не отправлял».
    const pendingKeys = [...new Set([...Object.keys(retries), ...skippedKeys.map((key) => key.toLowerCase())])];
    // Отложенные непрочитанные — не сбой, но и не дочитаны: сверка
    // черновиков по ним «не отправлял» не решает.
    const heldKeys = held.map((item) => item.key.toLowerCase());
    await reportSync({
      ok: pendingKeys.length === 0 && !syncStopped,
      error: syncStopped ? 'Kwork попросил подождать, пауза 10 минут' : pendingKeys.length > 0 ? `не дочитаны: ${pendingKeys.join(', ')}` : null,
      held: heldKeys,
      dialogs: chatList.length,
      changed: savedKeys,
      failed: failedKeys,
      pending: [...new Set([...pendingKeys, ...heldKeys])],
      files,
      unread: Object.fromEntries(chatList.filter((item) => item.unread > 0).map((item) => [item.key, item.unread])),
    });
  } catch (error) {
    await answer(false, error?.message || 'ошибка автовыгрузки').catch(() => undefined);
    await reportSync({ ok: false, error: error?.message || 'ошибка автовыгрузки' }).catch(() => undefined);
  } finally {
    syncRunning = false;
    lastPassEndedAt = Date.now();
    // Пока шёл проход, агенты могли попросить ещё: следующий проход сразу.
    if (forcedNext.ids.size > 0 || forcedNext.keys.size > 0 || pullRerun) {
      pullRerun = false;
      setTimeout(syncInbox, 0);
    }
  }
}

// Событие пришло во время прохода — после него будет ещё один: проход мог
// уже прочитать список диалогов без этого сообщения.
function syncFromPull(data) {
  const from = data?.from ? String(data.from) : '';
  clearTimeout(pullSyncTimer);
  pullSyncTimer = setTimeout(async () => {
    if (from) {
      const userIds = (await storageGet('local', SYNC_USER_IDS_KEY)) || {};
      const nick = Object.keys(userIds).find((key) => userIds[key] === from);
      if (nick) forcedNext.keys.add(nick.toLowerCase());
    }

    if (syncRunning) {
      pullRerun = true;
    } else {
      syncInbox();
    }
  }, PULL_DEBOUNCE_MS);
}

function connectPull(url) {
  if (!url || (url === pullUrl && pullSocket)) {
    return;
  }

  // Канал сменился (новый вход) — старый закрывается.
  closePull();
  pullUrl = url;
  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    schedulePullRetry();
    return;
  }

  pullSocket = socket;
  socket.onopen = () => {
    pullRetryMs = PULL_RETRY_MIN_MS;
    // Пока канал молчал, сообщения могли прийти: один проход сверяет.
    syncFromPull(null);
  };
  socket.onmessage = (event) => {
    const frame = core.parsePullFrame(event.data);
    if (frame && core.isInboxPullEvent(frame.event)) {
      syncFromPull(frame.data);
    }
  };
  socket.onclose = () => {
    if (pullSocket === socket) {
      pullSocket = null;
      schedulePullRetry();
    }
  };
}

function closePull() {
  clearTimeout(pullRetryTimer);
  clearTimeout(pullSyncTimer);
  pullUrl = null;
  if (pullSocket) {
    pullSocket.onclose = null;
    pullSocket.close();
    pullSocket = null;
  }
}

// Обрыв — повтор с растущей паузой. Канал перестал приниматься (вышли из
// Kwork) — следующий проход будильника возьмёт новый адрес со страницы.
function schedulePullRetry() {
  clearTimeout(pullRetryTimer);
  const delay = pullRetryMs;
  pullRetryMs = Math.min(pullRetryMs * 2, PULL_RETRY_MAX_MS);
  pullRetryTimer = setTimeout(() => {
    const url = pullUrl;
    pullUrl = null;
    connectPull(url);
  }, delay);
}

function ensureSyncAlarm() {
  chrome.alarms.get(SYNC_ALARM, (alarm) => {
    void chrome.runtime.lastError;
    // Период мог смениться с новой версией: будильник пересоздаётся.
    if (!alarm || alarm.periodInMinutes !== SYNC_PERIOD_MINUTES) {
      chrome.alarms.create(SYNC_ALARM, { delayInMinutes: 0.1, periodInMinutes: SYNC_PERIOD_MINUTES });
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    // Мост держится открытым портом: через него приходят заявки агентов.
    getPort();
    // Проход по заявке агента только что был — будильник его не повторяет.
    if (Date.now() - lastPassEndedAt >= ALARM_MIN_GAP_MS) {
      syncInbox();
    }
  }
});
chrome.runtime.onInstalled.addListener(ensureSyncAlarm);
chrome.runtime.onStartup.addListener(ensureSyncAlarm);
ensureSyncAlarm();
// Мост поднимается сразу со стартом фонового скрипта: будильщик агентов и
// заявки «выгрузи сейчас» живут в нём, пока открыт порт.
getPort();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'kph-save-dialog' && message.dialog?.key) {
    sendResponse({ accepted: post({ command: 'save-dialog', dialog: message.dialog, sample: message.sample }) });
    trackDownload(downloadAttachments(message.dialog, sender?.tab?.id).catch(() => undefined));
    return false;
  }

  // Заказ сохраняется с ответом моста: по нему вкладка показывает путь к папке,
  // куда лёг заказ, и предлагает его скопировать.
  if (message?.type === 'kph-save-project' && message.project?.id) {
    saveProject(message.project).then(sendResponse);
    return true;
  }

  if (message?.type === 'kph-attachment-chunk' && message.file) {
    sendResponse({
      accepted: post({
        command: 'save-attachment',
        dialogKey: message.dialogKey,
        file: message.file,
        transferId: message.transferId,
        part: message.part,
        final: message.final,
        chunk: message.chunk,
      }),
    });
    return false;
  }

  if (message?.type === 'kph-attachment-done') {
    attachmentProgress.done += 1;
    reportAttachmentProgress();
    return false;
  }

  if (message?.type === 'kph-known-dialogs' && Array.isArray(message.dialogKeys)) {
    sendResponse({ accepted: post({ command: 'known-dialogs', dialogKeys: message.dialogKeys }) });
    return false;
  }

  if (message?.type === 'kph-crawl-diagnostics') {
    post({ command: 'save-diagnostics', diagnostics: message.diagnostics });
    return false;
  }

  if (message?.type === 'kph-crawl-progress') {
    manualCrawlAt = Date.now();
    setCrawlState({ running: true, ...message.progress });
    return false;
  }

  if (message?.type === 'kph-crawl-skipped') {
    chrome.storage.local.get([CRAWL_KEY], (result) => {
      const skipped = [...((result?.[CRAWL_KEY] || {}).skipped || []), message.dialogKey].slice(-50);
      setCrawlState({ skipped });
    });
    return false;
  }

  if (message?.type === 'kph-crawl-done') {
    manualCrawlAt = 0;
    if (message.diagnostics) {
      post({ command: 'save-diagnostics', diagnostics: message.diagnostics });
    }

    finishOrContinue(message);
    return false;
  }

  if (message?.type === 'kph-crawl-one-done') {
    crawlQueue.messages += Number(message.messages) || 0;
    crawlQueue.done += 1;
    if (message.reason) {
      crawlQueue.skipped.push(message.dialogKey);
    }

    // Отказ биржи останавливает очередь: остальные диалоги ждут следующей выгрузки.
    if (message.throttled) {
      crawlQueue.keys = [];
      crawlQueue.error = message.reason || 'Kwork попросил подождать, продолжите выгрузку позже';
    }

    processQueue();
    return false;
  }

  if (message?.type === 'kph-open-kwork') {
    focusKworkTab();
    sendResponse({ opened: true });
    return false;
  }

  if (message?.type === 'kph-start-crawl') {
    startCrawl();
    sendResponse({ started: true });
    return false;
  }

  if (message?.type === 'kph-saved-keys' && message.dialogKey) {
    request({ command: 'message-keys', dialogKey: message.dialogKey })
      .then((result) => sendResponse({ keys: result?.ok ? result.keys || [] : [] }))
      .catch(() => sendResponse({ keys: [] }));
    return true;
  }

  if (message?.type === 'kph-sync-now') {
    syncInbox();
    sendResponse({ started: true });
    return false;
  }

  if (message?.type === 'kph-cancel-crawl') {
    cancelCrawl();
    sendResponse({ cancelled: true });
    return false;
  }

  return false;
});
