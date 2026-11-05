(function initYougileCore(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.KphYougileCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createYougileCore() {
  // Чаты мессенджера YouGile → переписки на диске в том же виде, что у Kwork:
  // ключ диалога и сообщения { id, time, authorId, authorName, text, replyTo }.
  // Только чистая логика: страница (yougile-main.js) даёт сырые сообщения из памяти приложения.

  const KEY_PREFIX = 'yougile';
  const MESSAGE_LIMIT = 50;
  const KEY_PATTERN = /^yougile-[a-z0-9а-яё-]+-[0-9a-f]{12}$/;
  // Сообщение без текста — файл или картинка: без заглушки оно не легло бы на диск и не разбудило агента.
  const FILE_ONLY_TEXT = '(файл без подписи, смотрите в YouGile)';

  // Ключ, который пришёл со страницы YouGile, — только ключ чата YouGile, а не ник Kwork.
  function isDialogKey(key) {
    return KEY_PATTERN.test(String(key || ''));
  }

  function slugPart(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '');
  }

  // Ключ чата: компания и 12 последних знаков номера чата — те же, что в адресе чата
  // YouGile («#chat:0f1e2d3c4b5a»). Список заказов подключает компанию шаблоном «yougile-<компания>-*».
  function dialogKey(companyTitle, companyId, chatId) {
    const company = slugPart(companyTitle) || slugPart(companyId).replace(/-/g, '').slice(0, 8);
    const chat = String(chatId || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(-12);
    return company && chat.length === 12 ? `${KEY_PREFIX}-${company}-${chat}` : null;
  }

  function chatShortId(chatId) {
    return String(chatId || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(-12);
  }

  function htmlToText(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function messageText(message) {
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    return text || htmlToText(message?.properties?.textHtml);
  }

  // raw — сообщения чата из памяти приложения: { timestamp, from, text, deleted, properties }.
  // Номер сообщения YouGile — время его создания, поэтому id — это timestamp.
  // Системные («добавлен в чат», «задача перемещена») и удалённые не нужны.
  function normalizeMessages(raw, userName = () => null, limit = MESSAGE_LIMIT) {
    const list = (Array.isArray(raw) ? raw : [])
      .filter((message) => message && Number.isFinite(Number(message.timestamp)) && !message.deleted && !message.properties?.fromSystem)
      .sort((left, right) => Number(left.timestamp) - Number(right.timestamp));
    const byId = new Map(list.map((message) => [Number(message.timestamp), message]));
    return list
      .map((message) => {
        const replyId = Number(message.properties?.replyTo) || null;
        const target = replyId ? byId.get(replyId) : null;
        const snippet = htmlToText(message.properties?.replySnippetHtml);
        return {
          id: String(Number(message.timestamp)),
          time: new Date(Number(message.timestamp)).toISOString(),
          authorId: message.from ? String(message.from) : null,
          authorName: userName(message.from) || null,
          text: messageText(message) || FILE_ONLY_TEXT,
          replyTo: replyId ? { kind: snippet ? 'quote' : 'reply', id: String(replyId), text: snippet || messageText(target) } : null,
        };
      })
      .slice(-limit);
  }

  function textToHtml(text) {
    const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  return { MESSAGE_LIMIT, chatShortId, dialogKey, htmlToText, isDialogKey, normalizeMessages, textToHtml };
});
