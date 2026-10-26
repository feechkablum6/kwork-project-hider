// Живой канал Kwork (notice.kwork.ru) с 24.10.2026 молчит: подключение принимается, но событий нет ни
// странице, ни расширению (проверено 26.10 звёздочкой диалога и новыми сообщениями), и переписка с
// заказом показывали новое только после обновления. Пока вкладка видна, скрипт сам подтягивает новое
// тем же путём, что сайт по событию канала. Пока канал присылает события, опрос молчит.
(function initKworkLiveMain() {
  'use strict';

  if (!/^\/(?:(?:new_)?inbox|track)(?:\/|$)/.test(window.location.pathname)) {
    return;
  }

  const POLL_MS = 20 * 1000;
  const MIN_GAP_MS = 5 * 1000;
  // Список диалогов успевает обновиться (getdialogs — около полусекунды).
  const LIST_WAIT_MS = 4 * 1000;
  // Событие канала недавно было — сайт показывает новое сам; замолчал — опрос возвращается.
  const LIVE_QUIET_MS = 2 * 60 * 1000;
  const handled = new Set();
  let liveAt = 0;
  let busy = false;
  let lastAt = 0;

  // Сайт вызывает onmessage только для настоящих событий, не для пингов.
  function watchChannel() {
    const stream = window.PushStreamManager?.[0];
    if (!stream || stream.kphLiveWatch || typeof stream.onmessage !== 'function') {
      return;
    }

    const original = stream.onmessage;
    stream.onmessage = function onmessage(...args) {
      liveAt = Date.now();
      return original.apply(this, args);
    };
    stream.kphLiveWatch = true;
  }

  // Сообщение заказа в открытой переписке: getnewmessages его не отдаёт. Список диалогов знает
  // последнее сообщение собеседника — нет его на странице, сайт дорисует своим разбором new_order_track.
  function checkDialogOrder() {
    // За время ожидания списка вкладку могли скрыть: дорисовка отметила бы сообщения прочитанными.
    if (document.visibilityState !== 'visible') {
      return;
    }

    const conversation = document.querySelector('.conversation-messages-list')?.__vue__;
    const chats = window.appChatList?.$refs?.chatList?.chatList;
    if (typeof conversation?.onNewOrderTrack !== 'function' || !Array.isArray(chats)) {
      return;
    }

    const chat = chats.find((item) => String(item?.USERID) === String(conversation.conversationUserId));
    const trackId = Number(chat?.MID) || 0;
    if (chat?.type !== 'track' || !trackId || !chat.MSGFROM || !chat.MSGTO || handled.has(trackId)) {
      return;
    }

    handled.add(trackId);
    if (!(conversation.messages || []).some((message) => Number(message?.MID) === trackId)) {
      conversation.onNewOrderTrack({
        track_id: trackId,
        from_user_id: chat.MSGFROM,
        to_user_id: chat.MSGTO,
        newTrackType: chat.lastMessage?.type_id,
      });
    }
  }

  // Самый новый показываемый сайтом трек ответа; скрытые сайт не рисует (как в _getNewTracks).
  // С withData треки — массив объектов, без него — словарь «номер → пусто».
  function newestTrackId(response) {
    const tracks = response?.success ? response.tracksToAdd : null;
    if (!tracks || typeof tracks !== 'object') {
      return 0;
    }

    return (Array.isArray(tracks) ? tracks : Object.keys(tracks).map((id) => ({ id })))
      .filter((track) => track && !track.isHiddenConversation)
      .reduce((max, track) => Math.max(max, Number(track.id) || 0), 0);
  }

  // Заказ: появилось новое — сайт перерисовывает его своим разбором refresh_track (без всплывашки
  // «заказ обновлён», ввод в поле сохраняет). На каждый трек — одна перерисовка.
  function refreshTrack() {
    const $ = window.jQuery;
    const orderId = window.Track?.orderId;
    const list = window.appTracks?.$refs?.trackList;
    if (!$ || !orderId || typeof list?.getMaxTrackId !== 'function') {
      return;
    }

    const lastTrackId = Number(list.getMaxTrackId()) || 0;
    busy = true;
    $.post('api/track/getnewtracks', { orderId, lastTrackId, withData: true })
      .done((response) => {
        const newest = newestTrackId(response);
        if (newest > lastTrackId && !handled.has(newest)) {
          handled.add(newest);
          $(document).trigger('refresh_track.pull', [{ order_id: orderId }]);
        }
      })
      .always(() => {
        busy = false;
      });
  }

  function tick() {
    watchChannel();
    const now = Date.now();
    if (busy || document.visibilityState !== 'visible' || now - lastAt < MIN_GAP_MS || now - liveAt < LIVE_QUIET_MS) {
      return;
    }

    lastAt = now;
    // Так сайт сам догоняет пропущенное после обрыва канала: личные сообщения открытой переписки,
    // список диалогов, счётчики в шапке.
    window.bus?.$emit?.('pushsteam-connection-restore');
    const path = window.location.pathname;
    if (/^\/(?:new_)?inbox\/[^/]+/.test(path)) {
      setTimeout(checkDialogOrder, LIST_WAIT_MS);
    } else if (path === '/track') {
      refreshTrack();
    }
  }

  setInterval(tick, POLL_MS);
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('focus', tick);
})();
