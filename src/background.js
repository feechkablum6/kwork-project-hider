importScripts('inbox-core.js');

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
  port.onMessage.addListener((response) => {
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

const crawlQueue = { keys: [], done: 0, total: 0, messages: 0, skipped: [], tabId: null, active: false };

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
      error: null,
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
  const response = await sendToTab(auth.tab.id, { type: 'kph-crawl-all' });
  if (!response?.started) {
    setCrawlState({
      running: false,
      error: 'Страница переписок не отвечает: перезагрузите вкладку Kwork',
    });
  }
}

async function cancelCrawl() {
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

// Ссылка на файл заказа ведёт на kwork.ru и оттуда переадресуется на CDN,
// который не разрешает межсайтовые запросы. Со страницы такой запрос обрывается,
// поэтому файлы качает фоновый скрипт: у него есть доступ к обоим адресам.
async function downloadProjectFile(projectId, item) {
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

  if (message?.type === 'kph-cancel-crawl') {
    cancelCrawl();
    sendResponse({ cancelled: true });
    return false;
  }

  return false;
});
