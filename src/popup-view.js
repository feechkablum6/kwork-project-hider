(function initKworkPopupView(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.KworkPopupView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPopupView() {
  function pluralize(count, one, few, many) {
    const abs = Math.abs(count) % 100;
    const tail = abs % 10;

    if (abs > 10 && abs < 20) {
      return many;
    }

    if (tail > 1 && tail < 5) {
      return few;
    }

    return tail === 1 ? one : many;
  }

  function describeTotals(dialogs, messages) {
    return `${dialogs} ${pluralize(dialogs, 'переписка', 'переписки', 'переписок')}`
      + `, ${messages} ${pluralize(messages, 'сообщение', 'сообщения', 'сообщений')}`;
  }

  function describeCrawlState(state) {
    const total = Number(state?.total) || 0;
    const done = Number(state?.done) || 0;
    const messages = Number(state?.messages) || 0;

    if (state?.authRequired) {
      return {
        status: 'Вход в Kwork не выполнен',
        hint: 'Переписки доступны только авторизованному аккаунту.',
        showProgress: false,
        pending: false,
        ratio: 0,
        counter: '',
        actionLabel: 'Открыть Kwork для входа',
        actionMode: 'open',
        error: null,
      };
    }

    if (state?.running) {
      const checkingAuth = state.stage === 'auth';
      const collectingList = !checkingAuth && (state.stage === 'dialogs' || total === 0);
      const indeterminate = checkingAuth || collectingList;
      const filesTotal = Number(state.files?.total) || 0;
      const filesDone = Number(state.files?.done) || 0;
      const filesPart = filesTotal > 0 ? ` · файлы ${Math.min(filesDone, filesTotal)} из ${filesTotal}` : '';

      return {
        status: 'Выгружаю переписки',
        hint: 'Вкладка Kwork нужна открытой до конца выгрузки.',
        showProgress: true,
        pending: indeterminate,
        ratio: indeterminate ? 0 : Math.min(1, done / total),
        counter: checkingAuth
          ? 'Проверяю доступ к переписке'
          : collectingList
            ? 'Собираю список переписок'
            : `Диалог ${Math.min(done + 1, total)} из ${total} · ${messages} ${pluralize(messages, 'сообщение', 'сообщения', 'сообщений')}${filesPart}`,
        actionLabel: 'Остановить выгрузку',
        actionMode: 'stop',
        error: state.error || null,
      };
    }

    if (state?.cancelled) {
      return {
        status: 'Выгрузка остановлена',
        hint: `Обработано ${done} ${pluralize(done, 'переписка', 'переписки', 'переписок')}, добавлено ${messages} ${pluralize(messages, 'сообщение', 'сообщения', 'сообщений')}.`,
        showProgress: false,
        pending: false,
        ratio: 0,
        counter: '',
        actionLabel: 'Продолжить выгрузку',
        actionMode: 'start',
        error: state.error || null,
      };
    }

    if (state?.finished) {
      const savedFiles = Number(state.files?.done) || 0;
      const filesPart = savedFiles > 0
        ? `, сохранено ${savedFiles} ${pluralize(savedFiles, 'файл', 'файла', 'файлов')}`
        : '';

      return {
        status: state.error ? 'Выгрузка прервалась' : 'Переписки выгружены',
        hint: `Обработано ${total} ${pluralize(total, 'переписка', 'переписки', 'переписок')}, добавлено ${messages} ${pluralize(messages, 'сообщение', 'сообщения', 'сообщений')}${filesPart}.`,
        showProgress: false,
        pending: false,
        ratio: 1,
        counter: '',
        actionLabel: 'Выгрузить заново',
        actionMode: 'start',
        error: state.error || null,
      };
    }

    return {
      status: 'Переписки Kwork на диске',
      hint: 'Кнопка ниже дописывает все диалоги целиком, включая старые.',
      showProgress: false,
      pending: false,
      ratio: 0,
      counter: '',
      actionLabel: 'Извлечь все переписки',
      actionMode: 'start',
      error: state?.error || null,
    };
  }

  const AUTO_SYNC_STALE_MS = 10 * 60 * 1000;

  function formatClock(isoTime) {
    const date = new Date(isoTime);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  // Строка про автосохранение: пользователь видит, что новые сообщения ложатся
  // на диск сами и когда это было в последний раз.
  function describeAutoSync(state, now = Date.now()) {
    const at = state?.at ? Date.parse(state.at) : NaN;
    if (Number.isNaN(at)) {
      return { text: 'Новые сообщения сохраняются сами каждые 2 минуты.', problem: false };
    }

    if (state.signedOut) {
      return { text: 'Автосохранение ждёт входа в Kwork.', problem: true };
    }

    if (state.ok === false) {
      return { text: `Автосохранение в ${formatClock(state.at)} не удалось: ${state.error || 'ошибка'}.`, problem: true };
    }

    if (now - at > AUTO_SYNC_STALE_MS) {
      return { text: `Автосохранение не шло с ${formatClock(state.at)}.`, problem: true };
    }

    return { text: `Новые сообщения сохраняются сами, последний раз в ${formatClock(state.at)}.`, problem: false };
  }

  return {
    describeAutoSync,
    describeCrawlState,
    describeTotals,
    pluralize,
  };
});
