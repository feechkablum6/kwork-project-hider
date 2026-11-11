(function initFlCore(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.KphFlCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createFlCore() {
  // Биржа FL.ru → переписки на диске в том же виде, что у Kwork: диалог на заказчика
  // («fl-<логин>»), сообщения { id, time, authorId, authorName, text, replyTo }.
  // Только чистая логика: ответы сайта приносит фоновый скрипт (background.js, syncFl).
  // Отклики и их чаты сверены с живыми ответами 11.11.2026; у сделок сверена только обёртка
  // ответа (items, messages) — поля сделки взяты из кода сайта, живой сделки ещё не было.

  const ORIGIN = 'https://www.fl.ru';
  const PAGE = 20;
  const offersPath = (offset) => `/projects/offers/?limit=${PAGE}&deleted=1&sort=lastMessage&offset=${offset}`;
  const OFFERS_PATH = offersPath(0);
  // Отметка «кандидат» или «выбран» без нового сообщения не поднимает отклик в списке: раз в
  // DEEP_EVERY_MS (и первым проходом) читаются и следующие страницы.
  // shortcut: до 100 откликов и 20 сделок; живых станет больше — поднять MAX_PAGES и листать сделки.
  const MAX_PAGES = 5;
  const DEEP_EVERY_MS = 10 * 60 * 1000;
  const DEALS_PATH = '/api/orders/?limit=20&offset=0';
  const MESSAGE_LIMIT = 40;
  // Сайт сам шлёт mark_read=1 из активного окна и 0 из фонового: опрос прочитанным ничего не отмечает
  // (отметка — отдельные POST …/read/, их здесь нет).
  const KEEP_UNREAD = '&mark_read=0';
  const KEY_PATTERN = /^fl-[a-z0-9_-]+$/;
  const FILE_ONLY_TEXT = '(файл без текста, смотрите на FL.ru)';

  // Ключ, который пришёл как диалог FL.ru, — только ключ FL.ru, а не ник Kwork.
  function isDialogKey(key) {
    return KEY_PATTERN.test(String(key || ''));
  }

  function dialogKey(username) {
    const login = String(username || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return login ? `fl-${login}` : null;
  }

  // Время у откликов — миллисекунды (сверено вживую); в коде сайта встречаются и секунды — понимаем оба.
  function millis(value) {
    const time = Number(value);
    return Number.isFinite(time) && time > 0 ? (time < 1e11 ? time * 1000 : time) : 0;
  }

  function iso(value) {
    return millis(value) ? new Date(millis(value)).toISOString() : null;
  }

  const flag = (value) => (value ? 1 : 0);

  function offerSignature(offer) {
    return [Number(offer?.messages_count) || 0, offer?.last_message_at ?? '', flag(offer?.is_candidate), flag(offer?.is_chosen)].join('|');
  }

  // Событие биржи без сообщения (кандидат, выбор исполнителя, сделка) ложится в переписку
  // сообщением заказчика: так его будит и показывает та же цепочка, что и обычный ответ.
  function eventMessage(id, clientId, time, text) {
    return { id, time, authorId: clientId, authorName: null, text: `Событие FL.ru: ${text}`, replyTo: null };
  }

  // seen — подписи прошлого прохода { 'offer:<id>': подпись }. Возвращает отклики, где что-то
  // изменилось: { items: [...], unparsed, selfId } — unparsed считает отклики без заказчика в ответе,
  // selfId — мой номер на бирже (автор любого отклика).
  function planOffers(response, seen = {}, now = Date.now()) {
    const projects = new Map((Array.isArray(response?.projects) ? response.projects : []).map((project) => [String(project?.id), project]));
    const items = [];
    const met = new Set();
    let unparsed = 0;
    let total = 0;
    let me = null;
    for (const offer of Array.isArray(response?.items) ? response.items : []) {
      if (!offer?.id || met.has(String(offer.id))) continue;
      met.add(String(offer.id));
      const project = projects.get(String(offer.project_id));
      const customer = project?.author;
      const key = dialogKey(customer?.username);
      const selfId = offer.author?.id ? String(offer.author.id) : null;
      me = me || selfId;
      if (!key || !customer?.id || !selfId) {
        unparsed += 1;
        continue;
      }

      total += 1;
      const sigKey = `offer:${offer.id}`;
      const signature = offerSignature(offer);
      if (seen[sigKey] === signature) continue;
      const [, , wasCandidate, wasChosen] = String(seen[sigKey] || '').split('|');
      const clientId = String(customer.id);
      const subject = String(project.name || offer.title || '').trim();
      const about = subject ? ` по заказу «${subject}»` : '';
      const events = [];
      if (offer.is_candidate && wasCandidate !== '1') {
        events.push(eventMessage(`fl-offer-${offer.id}-candidate`, clientId, iso(now), `заказчик добавил вас в кандидаты${about}.`));
      }

      if (offer.is_chosen && wasChosen !== '1') {
        events.push(eventMessage(`fl-offer-${offer.id}-chosen`, clientId, iso(now), `заказчик выбрал вас исполнителем${about}.`));
      }

      items.push({
        sigKey,
        signature,
        key,
        title: String(customer.username),
        clientId,
        selfId,
        url: project.url || `${ORIGIN}/projects/${offer.project_id}/`,
        idPrefix: `o${offer.id}-`,
        events,
        // Первое сообщение чата — сам отклик: пока заказчик молчит и событий нет, читать нечего.
        messagesPath: (Number(offer.messages_count) || 0) > 1 || events.length > 0
          ? `/projects/${offer.project_id}/offers/${offer.id}/messages/?limit=${MESSAGE_LIMIT}${KEEP_UNREAD}`
          : null,
      });
    }

    return { items, unparsed, total, selfId: me };
  }

  // Заказчик сделки: участник с логином, который не я. Поля сделки на живом ответе не сверены,
  // поэтому берётся первый подходящий из известных по коду сайта.
  function dealCustomer(deal, selfId) {
    return [deal?.customer, deal?.employer, deal?.author, deal?.emp]
      .find((user) => user?.id && user.username && String(user.id) !== String(selfId)) || null;
  }

  function planDeals(response, seen = {}, selfId = null, now = Date.now()) {
    const last = new Map();
    for (const message of Array.isArray(response?.messages) ? response.messages : []) {
      if (message?.order_id && message.id) last.set(String(message.order_id), message.id);
    }

    const items = [];
    let unparsed = 0;
    for (const deal of Array.isArray(response?.items) ? response.items : []) {
      if (!deal?.id) continue;
      const me = selfId || (deal.freelancer?.id ? String(deal.freelancer.id) : null);
      const customer = dealCustomer(deal, me);
      const key = dialogKey(customer?.username);
      if (!key || !me) {
        unparsed += 1;
        continue;
      }

      const sigKey = `deal:${deal.id}`;
      const status = String(deal.status ?? '');
      const signature = [status, Number(deal.messages_count) || 0, deal.last_message_at ?? '', last.get(String(deal.id)) ?? ''].join('|');
      if (seen[sigKey] === signature) continue;
      const clientId = String(customer.id);
      const subject = String(deal.title || deal.name || '').trim();
      const name = subject ? `«${subject}»` : `№ ${deal.id}`;
      const known = sigKey in seen;
      const wasStatus = known ? String(seen[sigKey]).split('|')[0] : null;
      const events = [];
      if (!known) {
        events.push(eventMessage(`fl-deal-${deal.id}-new`, clientId, iso(now), `заказчик открыл сделку ${name}${status ? `, статус «${status}»` : ''}.`));
      } else if (wasStatus !== status) {
        events.push(eventMessage(`fl-deal-${deal.id}-status-${status || 'none'}`, clientId, iso(now), `сделка ${name}: статус «${status}».`));
      }

      items.push({
        sigKey,
        signature,
        key,
        title: String(customer.username),
        clientId,
        selfId: me,
        url: deal.url || `${ORIGIN}/orders/${deal.id}/`,
        idPrefix: `d${deal.id}-`,
        events,
        messagesPath: `/api/orders/messages/?order_id=${deal.id}&limit=${MESSAGE_LIMIT}${KEEP_UNREAD}`,
      });
    }

    return { items, unparsed };
  }

  // raw — ответ чата отклика или сделки: { items: [{ id, from_id, time, text, files, reply_to }], replied_messages, users }.
  // В диалоге заказчика сходятся чаты всех его откликов и сделок: приставка с номером отклика или сделки
  // не даёт номерам сообщений совпасть.
  function normalizeMessages(raw, prefix = 'o') {
    const users = new Map((Array.isArray(raw?.users) ? raw.users : []).map((user) => [String(user?.id), user?.username || null]));
    const list = (Array.isArray(raw?.items) ? raw.items : []).filter((message) => message?.id && iso(message.time));
    const byId = new Map([...(Array.isArray(raw?.replied_messages) ? raw.replied_messages : []), ...list].map((message) => [String(message?.id), message]));
    return list
      .sort((left, right) => millis(left.time) - millis(right.time))
      .map((message) => {
        const target = message.reply_to && typeof message.reply_to === 'object' ? message.reply_to : byId.get(String(message.reply_to ?? ''));
        const files = Array.isArray(message.files) ? message.files.length : 0;
        const text = String(message.text || '').trim();
        return {
          id: `${prefix}${message.id}`,
          time: iso(message.time),
          authorId: message.from_id ? String(message.from_id) : null,
          authorName: users.get(String(message.from_id)) || null,
          text: files > 0 ? `${text || FILE_ONLY_TEXT}${text ? `\n(файлов: ${files}, смотрите на FL.ru)` : ''}` : text,
          replyTo: target?.id
            ? { kind: 'reply', id: `${prefix}${target.id}`, time: iso(target.time), authorId: target.from_id ? String(target.from_id) : null, text: String(target.text || '').trim() }
            : null,
        };
      })
      .filter((message) => message.text);
  }

  // Сообщения, которые разбор не понял: нет номера или времени, либо заказчик написал, а ни текста, ни файлов
  // в известных полях нет. Формат чата другой — молчать об этом нельзя. Пустое служебное и своё — не в счёт.
  function unreadable(raw, selfId = null) {
    return (Array.isArray(raw?.items) ? raw.items : []).filter((message) => {
      if (!message?.id || !iso(message.time)) return true;
      const empty = !(typeof message.text === 'string' && message.text.trim()) && !(Array.isArray(message.files) && message.files.length > 0);
      return empty && Boolean(message.from_id) && String(message.from_id) !== String(selfId);
    }).length;
  }

  // Диалог для моста или null: без слова или события заказчика на диск ничего не ложится —
  // свои отклики без ответа не копятся в переписках.
  function buildDialog(item, raw, now = Date.now()) {
    const messages = [...normalizeMessages(raw, item.idPrefix), ...item.events];
    if (!messages.some((message) => message.authorId && message.authorId !== item.selfId)) {
      return null;
    }

    return {
      source: 'fl',
      key: item.key,
      title: item.title,
      url: item.url,
      clientId: item.clientId,
      selfId: item.selfId,
      messages,
      updatedAt: iso(now),
    };
  }

  const PAUSE_MS = 10 * 60 * 1000;
  const STUCK_MS = 10 * 60 * 1000;
  const SEE_SITE = 'сообщения смотрите на fl.ru/messages';

  function list(response, what) {
    if (!Array.isArray(response?.items)) throw new Error(`FL.ru отдал ${what} в незнакомом виде`);
    return response;
  }

  async function readOffers(fetchJson, deep) {
    const all = { items: [], projects: [] };
    for (let page = 0; page < (deep ? MAX_PAGES : 1); page += 1) {
      const response = list(await fetchJson(offersPath(page * PAGE)), 'отклики');
      all.items.push(...response.items);
      all.projects.push(...(Array.isArray(response.projects) ? response.projects : []));
      if (!response.has_next_page || response.items.length === 0) break;
    }

    return all;
  }

  // Один проход опроса. fetchJson(path) → ответ сайта (бросает ошибку с signedOut или pause),
  // saveDialog(dialog) пишет через мост (бросает, если не записал). stored — подписи прошлых
  // проходов; их нет — первый удачный проход только запоминает, чтобы давно прочитанное не будило.
  // Возвращает { status, seen }: seen === null — подписи не трогать (первый проход не удался).
  // Сбой одного чата (сайт не отдал, мост отказал, формат другой) не останавливает остальные: его подпись
  // не запоминается, а в status.failing — с какого времени и почему он не читается (ближний проход дальние
  // страницы не читает и их записи не трогает; дальний собирает список заново). Весь проход обрывают только
  // выход из аккаунта, отказ сайта с паузой и молчащий мост (ошибка с signedOut, pause или abort).
  async function runPass({ fetchJson, saveDialog, stored = null, previous = {}, now = Date.now() }) {
    const seen = { ...(stored || {}) };
    try {
      const deep = !stored || now - (previous.deepAt || 0) >= DEEP_EVERY_MS;
      const offers = planOffers(await readOffers(fetchJson, deep), seen, now);
      const selfId = offers.selfId || previous.selfId || null;
      const deals = planDeals(list(await fetchJson(DEALS_PATH), 'сделки'), seen, selfId, now);
      const failing = deep ? {} : { ...(previous.failing || {}) };
      for (const item of [...offers.items, ...deals.items]) {
        try {
          if (stored) {
            const raw = item.messagesPath ? await fetchJson(item.messagesPath) : null;
            const dialog = buildDialog(item, raw, now);
            if (dialog) await saveDialog(dialog);
            const missed = unreadable(raw, item.selfId);
            if (missed > 0) throw Object.assign(new Error(`сообщений не разобрано: ${missed} — формат ответа сайта другой`), { format: true });
          }

          // Подпись запоминается только после записи: сбой моста или сайта — повтор следующим проходом.
          seen[item.sigKey] = item.signature;
          delete failing[item.sigKey];
        } catch (error) {
          if (error?.signedOut || error?.pause || error?.abort) throw error;
          // Чужой формат сам не пройдёт — предупреждение сразу; сбой сайта или моста — после STUCK_MS.
          failing[item.sigKey] = { since: error?.format ? 0 : previous.failing?.[item.sigKey]?.since || now, error: error?.message || String(error) };
        }
      }

      const stuck = Object.values(failing).filter((entry) => now - entry.since >= STUCK_MS);
      const warn = deals.unparsed > 0
        ? `сделок FL.ru не разобрано: ${deals.unparsed} — формат ответа сайта другой, ${SEE_SITE}`
        : offers.unparsed > 0 && offers.total === 0
          ? `откликов FL.ru не разобрано: ${offers.unparsed} — формат ответа сайта другой, ${SEE_SITE}`
          : stuck.length > 0
            ? `чатов FL.ru не читается: ${stuck.length} (${stuck[0].error}) — ${SEE_SITE}`
            : null;
      return { seen, status: { at: now, okAt: now, selfId, warn, deepAt: deep ? now : previous.deepAt || 0, failing } };
    } catch (error) {
      return {
        seen: stored ? seen : null,
        status: { ...previous, at: now, error: error?.message || String(error), signedOut: Boolean(error?.signedOut), pausedUntil: error?.pause ? now + PAUSE_MS : 0 },
      };
    }
  }

  return { DEALS_PATH, MESSAGE_LIMIT, OFFERS_PATH, ORIGIN, buildDialog, dialogKey, isDialogKey, normalizeMessages, offerSignature, offersPath, planDeals, planOffers, runPass, unreadable };
});
