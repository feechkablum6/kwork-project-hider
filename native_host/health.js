// Живая проверка цепочки побудки: мост пишет свой пульс и отчёт расширения в data/health,
// а команда проверки и сторож (scripts/kwork-health.mjs) по ним и по состоянию Desktop
// решают, какое звено живо. evaluate — чистая: факты на входе, звенья на выходе.

const fs = require('node:fs');
const path = require('node:path');

const HEALTH_DIR = 'health';
const BRIDGE_FILE = 'bridge.json';
const EXTENSION_FILE = 'extension.json';
const REQUEST_FILE = 'request';
const BEAT_MS = 10 * 1000;
// Пульс моста — раз в 10 с, отчёт расширения — по заявке и раз в минуту с будильником.
const BRIDGE_STALE_MS = 45 * 1000;
const EXTENSION_STALE_MS = 3 * 60 * 1000;
// Проход автосохранения — раз в минуту, после отказа Kwork пауза до 10 минут.
const SYNC_STALE_MS = 15 * 60 * 1000;
// Опрос FL.ru идёт раз в 2 минуты; один сорвавшийся запрос — не сбой.
// Больше паузы после отказа сайта (10 мин) плюс период опроса: один отказ — не «мертво».
const FL_STALE_MS = 15 * 60 * 1000;
// Побудка обычно доходит за секунды; дольше — её никто не получил.
const PENDING_STALE_MS = 10 * 60 * 1000;
// Такт будильщика — раз в 2 с; длинный такт (отправка, ожидание сокета) — десятки секунд.
const WAKER_STALE_MS = 2 * 60 * 1000;

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, filePath);
}

// Сторона моста: пульс, заявка «отчитайся сейчас» → push расширению, отчёт расширения → файл.
function createHealthBeat({ serviceDir, send, now = Date.now }) {
  const dir = path.join(serviceDir, HEALTH_DIR);
  let beatAt = 0;
  let pushedFor = 0;
  let wakerAt = null;

  function tick() {
    if (now() - beatAt >= BEAT_MS) {
      beatAt = now();
      writeAtomic(path.join(dir, BRIDGE_FILE), { pid: process.pid, node: process.version, execPath: process.execPath, wakerAt, at: new Date(now()).toISOString() });
    }

    let requestedAt = 0;
    try {
      requestedAt = fs.statSync(path.join(dir, REQUEST_FILE)).mtimeMs;
    } catch {
      // Заявки нет.
    }

    if (requestedAt > pushedFor) {
      pushedFor = requestedAt;
      send({ push: 'health' });
    }
  }

  function save(health) {
    writeAtomic(path.join(dir, EXTENSION_FILE), { ...health, at: new Date(now()).toISOString() });
  }

  // Будильщик закончил такт владельцем замка: чужой замок или падающий такт сюда не доходят.
  function wakerDone() {
    wakerAt = new Date(now()).toISOString();
  }

  return { tick, save, wakerDone };
}

const age = (iso, now) => now - (Date.parse(iso) || 0);
const minutes = (ms) => `${Math.max(1, Math.round(ms / 60000))} мин`;

// facts: { now, manifestVersion, bridge, bridgeAlive, launcherNode: { path, exists } | null, extension, sync,
//   yougileRouted, desktopRunning, dispatcher: { configured, inDesktop, pid }, inboundAccept, pending: [{ slug, since, error }] }
// → [{ id, name, ok, detail }]. Звено «мертво» — побудка клиента сейчас не дойдёт до агента.
function evaluate(facts) {
  const { now } = facts;
  const links = [];
  const add = (id, name, ok, detail) => links.push({ id, name, ok, detail });

  const bridgeFresh = Boolean(facts.bridge) && age(facts.bridge.at, now) < BRIDGE_STALE_MS && facts.bridgeAlive;
  add('bridge', 'Мост', bridgeFresh, bridgeFresh
    ? `работает, Node ${facts.bridge.node}`
    : facts.bridge ? `не отвечает ${minutes(age(facts.bridge.at, now))} — Chrome закрыт или расширение выключено` : 'ни разу не отчитался — расширение не перезагружено после обновления');
  if (facts.launcherNode) {
    add('node', 'Node для моста', facts.launcherNode.exists, facts.launcherNode.exists ? facts.launcherNode.path : `нет файла ${facts.launcherNode.path} — мост не запустится, переустановите мост`);
  }

  if (bridgeFresh) {
    const wakerOk = Boolean(facts.bridge.wakerAt) && age(facts.bridge.wakerAt, now) < WAKER_STALE_MS;
    add('waker', 'Будильщик', wakerOk, wakerOk ? 'такты идут'
      : facts.bridge.wakerAt ? `стоит ${minutes(age(facts.bridge.wakerAt, now))} — перезагрузите расширение` : 'не сделал ни одного такта — замок держит другой процесс или такт падает (bridge.log)');
  }

  const ext = facts.extension;
  const extFresh = bridgeFresh && Boolean(ext) && age(ext.at, now) < EXTENSION_STALE_MS;
  const versionOk = extFresh && ext.version === facts.manifestVersion;
  add('extension', 'Расширение', versionOk, !extFresh ? 'фоновый скрипт не отчитался'
    : versionOk ? `версия ${ext.version}` : `работает версия ${ext.version}, на диске ${facts.manifestVersion} — расширение не перезагружено`);

  if (extFresh) {
    const tabs = Array.isArray(ext.tabs) ? ext.tabs : [];
    for (const [site, title] of [['kwork', 'Вкладки Kwork'], ['yougile', 'Вкладки YouGile']]) {
      const mine = tabs.filter((tab) => tab.site === site);
      const silent = mine.filter((tab) => tab.state === 'silent');
      const live = mine.filter((tab) => tab.state === 'ok');
      if (silent.length > 0) {
        add(`tabs-${site}`, title, false, `без скрипта расширения: ${silent.map((tab) => tab.path).join(', ')} — обновите вкладку`);
      } else if (site === 'yougile' && facts.yougileRouted && live.length === 0) {
        add(`tabs-${site}`, title, false, 'нет открытой вкладки YouGile — сообщения из YouGile не сохраняются');
      } else if (mine.length > 0) {
        add(`tabs-${site}`, title, true, `${live.length} со скриптом${mine.length > live.length ? `, ${mine.length - live.length} спят` : ''}`);
      }
    }

    // Канал уведомлений Kwork молчит с 24.10.2026 — новое приносит минутный проход; мертво, когда стоит он.
    const blocked = Number(ext.blockedUntil) > now;
    const syncAge = facts.sync ? age(facts.sync.at, now) : Infinity;
    const pullAge = ext.pullAt ? age(ext.pullAt, now) : Infinity;
    // Проход отчитывается раз в минуту при любом исходе: свежий, но неудачный — сообщения не приходят.
    const signedOut = Boolean(facts.sync?.signedOut);
    const failed = facts.sync?.ok === false;
    const arriving = !blocked && !signedOut && !failed && Math.min(syncAge, pullAge) < SYNC_STALE_MS;
    const channel = pullAge === Infinity ? 'канал уведомлений молчит' : `событие канала ${minutes(pullAge)} назад`;
    add('incoming', 'Новые сообщения Kwork', arriving, blocked ? 'Kwork закрыл доступ за частые запросы — откройте kwork.ru и пройдите проверку'
      : signedOut ? 'вы вышли из Kwork — войдите на kwork.ru'
        : failed ? `проход падает: ${facts.sync.error || 'ошибка без текста'}`
          : arriving ? `проход ${minutes(syncAge)} назад, ${channel}`
            : `проход не шёл ${syncAge === Infinity ? 'ни разу' : minutes(syncAge)}, ${channel}`);

    // FL.ru читает опрос фонового скрипта раз в 2 минуты; звено есть, только если он хоть раз прошёл.
    const fl = ext.fl;
    if (fl?.okAt) {
      const flAge = now - fl.okAt;
      const flOk = !fl.signedOut && !fl.warn && flAge < FL_STALE_MS;
      add('incoming-fl', 'Новые сообщения FL.ru', flOk, fl.signedOut ? 'вы вышли из FL.ru — войдите на fl.ru'
        : fl.warn ? fl.warn
          : flOk ? `опрос ${minutes(flAge)} назад` : `опрос не проходит ${minutes(flAge)}${fl.error ? `: ${fl.error}` : ''}`);
    }
  }

  if (facts.wakeTo === 't3') {
    // Побудку доставляет CLI T3 Code ("wakeTo": "t3"): без его сервера побудки ждут в пути и повторяются.
    const t3 = facts.t3 || {};
    add('t3', 'T3 Code', Boolean(t3.alive), t3.alive ? `сервер ${t3.pid}` : 'T3 Code закрыт — побудки ждут, пока вы его откроете');
  } else {
    const d = facts.dispatcher || {};
    add('dispatcher', 'Диспетчер', Boolean(d.pid), !facts.desktopRunning ? 'Claude Desktop закрыт'
      : !d.configured ? 'не задан (data/dispatcher.json)'
        : !d.inDesktop ? 'чата «Kwork-диспетчер» нет в Claude Desktop'
          : d.pid ? `процесс ${d.pid}` : 'спит: чат есть, процесса нет — откройте чат «Kwork-диспетчер»');
    add('inbound', 'Приём сообщений чатами', Boolean(facts.inboundAccept), facts.inboundAccept ? 'включён' : 'в ~/.claude/settings.json нет crossSessionInbound: accept');
  }

  const stuck = (facts.pending || []).filter((item) => now - item.since > PENDING_STALE_MS);
  add('pending', 'Побудки в пути', stuck.length === 0, stuck.length === 0
    ? `застрявших нет${(facts.pending || []).length > 0 ? `, в пути ${facts.pending.length}` : ''}`
    : stuck.map((item) => `${item.slug} ждёт ${minutes(now - item.since)}${item.error ? ` (${item.error})` : ''}`).join('; '));

  return links;
}

module.exports = {
  BRIDGE_FILE,
  EXTENSION_FILE,
  HEALTH_DIR,
  REQUEST_FILE,
  createHealthBeat,
  evaluate,
};
