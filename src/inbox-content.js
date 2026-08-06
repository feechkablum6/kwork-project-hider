(function initKworkInboxBridge() {
  'use strict';

  const core = globalThis.KworkInboxCore;
  if (!core?.isInboxPage?.(window.location.href) || !globalThis.chrome?.runtime?.sendMessage) {
    return;
  }

  const MESSAGE_SOURCE = 'kph-inbox';
  const COMMAND_SOURCE = 'kph-inbox-command';
  const USER_IDS_KEY = 'inboxUserIds';
  const SAVE_IDLE_DELAY_MS = 700;
  const ATTACHMENT_CHUNK_BYTES = 3 * 1024 * 1024;
  const ATTACHMENT_CONCURRENCY = 2;
  const MAX_ATTACHMENT_BYTES = 300 * 1024 * 1024;
  const TITLE_SELECTORS = [
    '.chat-header__title',
    '.dialog-header__title',
    '.inbox-header__name',
    '[data-qa="dialog-title"]',
    'h1',
  ];

  const dialogs = new Map();
  const sampledDialogs = new Set();
  const knownDialogKeys = new Set();
  let saveTimer = null;

  function readDialogTitle() {
    for (const selector of TITLE_SELECTORS) {
      const text = document.querySelector(selector)?.textContent?.trim();
      if (text) {
        return text;
      }
    }

    return null;
  }

  function getDialogState(dialogKey) {
    const key = dialogKey || core.extractDialogKey(window.location.href);
    if (!key) {
      return null;
    }

    if (!dialogs.has(key)) {
      dialogs.set(key, { key, messages: [], sample: null });
    }

    return dialogs.get(key);
  }

  function sendToBackground(payload) {
    try {
      chrome.runtime.sendMessage(payload, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // Расширение перезагружено — данные догрузятся при следующем открытии переписки.
    }
  }

  function flush() {
    saveTimer = null;

    for (const dialog of dialogs.values()) {
      if (dialog.messages.length === 0 || dialog.saved === dialog.messages.length) {
        continue;
      }

      dialog.saved = dialog.messages.length;
      sendToBackground({
        type: 'kph-save-dialog',
        dialog: {
          key: dialog.key,
          title: dialog.title || readDialogTitle() || dialog.key,
          url: `https://kwork.ru/inbox/${dialog.key}`,
          clientId: dialog.clientId || null,
          updatedAt: new Date().toISOString(),
          messages: dialog.messages,
        },
        sample: dialog.sample,
      });
      dialog.sample = null;
    }

    if (knownDialogKeys.size > 0) {
      sendToBackground({ type: 'kph-known-dialogs', dialogKeys: [...knownDialogKeys] });
    }
  }

  function scheduleFlush() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, SAVE_IDLE_DELAY_MS);
  }

  function handleMessages(data) {
    const dialog = getDialogState(data.dialogKey);
    if (!dialog) {
      return;
    }

    dialog.title = dialog.title || readDialogTitle();
    dialog.clientId = dialog.clientId || data.clientId || null;
    dialog.messages = core.mergeMessages(dialog.messages, data.messages);
    scheduleFlush();
  }

  function handleSample(data) {
    const dialog = getDialogState(data.dialogKey);
    if (!dialog || sampledDialogs.has(dialog.key)) {
      return;
    }

    sampledDialogs.add(dialog.key);
    rememberUserId(dialog.key, core.findParticipantId(data.payload, dialog.key));
    dialog.sample = {
      requestUrl: data.requestUrl,
      requestBody: data.requestBody || null,
      payload: data.payload,
    };
  }

  function rememberUserId(dialogKey, userId) {
    if (!dialogKey || !userId) {
      return;
    }

    chrome.storage.local.get([USER_IDS_KEY], (result) => {
      void chrome.runtime.lastError;
      const known = { ...(result?.[USER_IDS_KEY] || {}) };
      if (known[dialogKey] === String(userId)) {
        return;
      }

      known[dialogKey] = String(userId);
      chrome.storage.local.set({ [USER_IDS_KEY]: known });
    });
  }

  function askBackground(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          void chrome.runtime.lastError;
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function toBase64(bytes) {
    const step = 0x8000;
    let binary = '';

    for (let offset = 0; offset < bytes.length; offset += step) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
    }

    return btoa(binary);
  }

  // Вложение уходит на диск кусками: native messaging принимает только текст,
  // а держать многомегабайтный файл одним сообщением незачем.
  async function sendAttachment(dialogKey, file, bytes) {
    const parts = Math.max(1, Math.ceil(bytes.length / ATTACHMENT_CHUNK_BYTES));

    for (let part = 0; part < parts; part += 1) {
      const slice = bytes.subarray(part * ATTACHMENT_CHUNK_BYTES, (part + 1) * ATTACHMENT_CHUNK_BYTES);
      const response = await askBackground({
        type: 'kph-attachment-chunk',
        dialogKey,
        file,
        part,
        final: part === parts - 1,
        chunk: toBase64(slice),
      });

      if (!response?.accepted) {
        return false;
      }
    }

    return true;
  }

  async function downloadAttachment(dialogKey, item) {
    const response = await fetch(new URL(item.url, window.location.origin).toString(), { credentials: 'include' });
    if (!response.ok) {
      return false;
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      return false;
    }

    return sendAttachment(dialogKey, item.file, new Uint8Array(buffer));
  }

  async function downloadAttachments(dialogKey, files) {
    const queue = Array.isArray(files) ? [...files] : [];
    const workers = Array.from({ length: Math.min(ATTACHMENT_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        try {
          await downloadAttachment(dialogKey, item);
        } catch {
          // Недоступный файл не должен останавливать выгрузку переписки.
        }

        sendToBackground({ type: 'kph-attachment-done', dialogKey, file: item.file });
      }
    });

    await Promise.all(workers);
  }

  function sendToMainWorld(kind, detail) {
    window.postMessage({ source: COMMAND_SOURCE, kind, ...detail }, window.location.origin);
  }

  function saveCrawledDialog(data) {
    rememberUserId(data.dialogKey, data.clientId);
    sendToBackground({
      type: 'kph-save-dialog',
      dialog: {
        key: data.dialogKey,
        title: data.dialogKey,
        url: `https://kwork.ru/inbox/${data.dialogKey}`,
        clientId: data.clientId || null,
        strategy: data.strategy || null,
        complete: data.complete !== false,
        updatedAt: new Date().toISOString(),
        messages: data.messages,
      },
      sample: null,
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'kph-crawl-all') {
      chrome.storage.local.get([USER_IDS_KEY], (result) => {
        void chrome.runtime.lastError;
        sendToMainWorld('crawl-all', { knownUserIds: result?.[USER_IDS_KEY] || {} });
      });
      sendResponse({ started: true });
      return false;
    }

    if (message?.type === 'kph-crawl-one') {
      sendToMainWorld('crawl-one', {});
      sendResponse({ started: true });
      return false;
    }

    if (message?.type === 'kph-crawl-cancel') {
      sendToMainWorld('crawl-cancel', {});
      sendResponse({ cancelled: true });
      return false;
    }

    if (message?.type === 'kph-download-attachments' && Array.isArray(message.files)) {
      downloadAttachments(message.dialogKey, message.files).then(() => sendResponse({ done: true }));
      return true;
    }

    return false;
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== MESSAGE_SOURCE) {
      return;
    }

    const data = event.data;
    if (data.kind === 'crawl-progress') {
      sendToBackground({ type: 'kph-crawl-progress', progress: data.progress });
      return;
    }

    if (data.kind === 'crawl-dialog' && Array.isArray(data.messages)) {
      saveCrawledDialog(data);
      return;
    }

    if (data.kind === 'crawl-skipped') {
      sendToBackground({ type: 'kph-crawl-skipped', dialogKey: data.dialogKey, reason: data.reason || null });
      return;
    }

    if (data.kind === 'crawl-done') {
      sendToBackground({
        type: 'kph-crawl-done',
        total: data.total,
        messages: data.messages,
        pending: data.pending || [],
        diagnostics: data.diagnostics || null,
        reason: data.reason || null,
      });
      return;
    }

    if (data.kind === 'crawl-diagnostics' && data.diagnostics) {
      sendToBackground({ type: 'kph-crawl-diagnostics', diagnostics: data.diagnostics });
      return;
    }

    if (data.kind === 'crawl-dialog-keys' && Array.isArray(data.dialogKeys)) {
      for (const dialogKey of data.dialogKeys) {
        knownDialogKeys.add(dialogKey);
      }

      sendToBackground({ type: 'kph-known-dialogs', dialogKeys: [...knownDialogKeys] });
      return;
    }

    if (data.kind === 'crawl-one-done') {
      sendToBackground({
        type: 'kph-crawl-one-done',
        dialogKey: data.dialogKey,
        messages: data.messages || 0,
        reason: data.reason || null,
      });
      return;
    }

    if (data.kind === 'messages' && Array.isArray(data.messages)) {
      handleMessages(data);
      return;
    }

    if (data.kind === 'sample' && data.payload) {
      handleSample(data);
      return;
    }

    if (data.kind === 'dialogs' && Array.isArray(data.dialogKeys)) {
      for (const dialogKey of data.dialogKeys) {
        knownDialogKeys.add(dialogKey);
      }
      scheduleFlush();
    }
  });

  window.addEventListener('beforeunload', flush);
})();
