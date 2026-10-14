// Подписывает блоки сообщений на /inbox/<ник> и /track ключом «автор:время».
// Данные сообщения лежат только в компоненте Vue, а он виден лишь MAIN world;
// галочку по ключам ставит изолированный ticks-content.js.
(function initKworkTicksMain() {
  'use strict';

  if (!/^\/(?:(?:new_)?inbox\/[^/]+|track)/.test(window.location.pathname)) {
    return;
  }

  const MAX_DEPTH = 12;
  let timer = null;

  function readProps(block) {
    for (let node = block, depth = 0; node && depth < MAX_DEPTH; node = node.parentElement, depth += 1) {
      const props = node.__vue__?.$props;
      if (props?.message?.MSGFROM !== undefined) {
        return { authorId: props.message.MSGFROM, time: Number(props.message.time), peer: null };
      }

      if (props?.track?.author?.id !== undefined) {
        const author = props.track.author;
        const mine = String(author.id) === String(window.actorId);
        return { authorId: author.id, time: Number(props.track.time), peer: mine ? null : author.username || null };
      }
    }

    return null;
  }

  // Собеседник в чате заказа — второй участник из списка аватаров страницы:
  // так он известен и до первого ответа клиента.
  function labelPeer() {
    if (window.location.pathname !== '/track' || document.documentElement.dataset.kphPeer) {
      return;
    }

    const me = String(window.actorLogin || '').toLowerCase();
    const others = Object.keys(window.userAvatarColors || {}).filter((login) => login.toLowerCase() !== me);
    if (me && others.length === 1) {
      document.documentElement.dataset.kphPeer = others[0];
    }
  }

  function label() {
    timer = null;
    labelPeer();
    for (const block of document.querySelectorAll('.js-message-block:not([data-kph-key])')) {
      const props = readProps(block);
      if (!props || !Number.isFinite(props.time)) {
        continue;
      }

      block.dataset.kphKey = `${props.authorId}:${props.time}`;
      if (props.peer) {
        block.dataset.kphPeer = props.peer;
      }
    }
  }

  function schedule() {
    if (!timer) {
      timer = setTimeout(label, 300);
    }
  }

  function start() {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
