// Живая проверка цепочки побудки: мост → расширение → вкладки → новые сообщения → диспетчер → чат заказа.
//   node scripts/kwork-health.mjs          — звенья «живо / мертво» и общий итог (код выхода 1, если что-то мертво)
//   node scripts/kwork-health.mjs --wake   — ещё и пробная побудка: проверочное сообщение (не от клиента и не
//                                            клиенту) доходит до чата проверочного заказа, затем пересылается
//                                            во второй заказ того же «клиента»; после себя убирает всё
//                                            (папки, строки списка заказов, переписку; чаты — в архив Desktop)
//   node scripts/kwork-health.mjs --watch  — сторож (LaunchAgent, раз в 5 минут): мёртвое звено — одно
//                                            уведомление macOS, пока не оживёт
// Правка цепочки побудки сдаётся только после зелёного `--wake` (docs/do-not.md).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectRoot, readJson, resolveChatsDir } from './kwork-shared.mjs';

const require = createRequire(import.meta.url);
const health = require('../native_host/health.js');
const reroute = require('../native_host/reroute.js');
const wakeCore = require('../native_host/wake-core.js');
const { WAKE_DIRTY_DIR } = require('../native_host/store.js');
const core = require('../src/inbox-core.js');
const { createClaudeRunner, projectSlug } = require('../native_host/claude-runner.js');

const HOST_MANIFEST = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'ru.kwork.hider.host.json');
const REPORT_WAIT_MS = 12 * 1000;
const TRIAL_NICK = 'kph-selftest';
// Имена заказов — свои на каждый запуск: чат прошлой пробы лежит в архиве Desktop, и новая в него не попадает.
const TRIAL_PREFIX = 'kph-proverka-';
const TRIAL_ORDER = /^kph-proverka-[ab](?:-[a-z0-9]+)?$/;
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const TRIAL_LEG_MS = 4 * 60 * 1000;
const CHAT_REMOVE_MS = 90 * 1000;
// Команда диспетчеру (dispatcher/CLAUDE.md): убрать чаты проверочных заказов в архив Claude Desktop
// (удаление чата Desktop всегда спрашивает пользователя, архив — нет).
const DISPATCHER_REMOVE = '[Kwork-диспетчер] убрать проверочные чаты';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function paths() {
  const config = readJson(join(projectRoot, 'native_host', 'bridge-config.json')) || {};
  const targetDir = resolveChatsDir(join(homedir(), 'Projects', 'Kwork'));
  const kworkRoot = String(config.kworkRoot || '').trim() || dirname(targetDir);
  return { targetDir, kworkRoot, serviceDir: join(targetDir, 'data'), healthDir: join(targetDir, 'data', health.HEALTH_DIR) };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// Node, записанный в запускателе моста: Homebrew при обновлении убирает старый файл, и мост молча не стартует.
function launcherNode() {
  try {
    const launcher = readJson(HOST_MANIFEST)?.path;
    const match = /^NODE='?([^'\n]+)'?$/m.exec(readFileSync(launcher, 'utf8'));
    return match ? { path: match[1], exists: existsSync(match[1]) } : null;
  } catch {
    return null;
  }
}

// Просим расширение отчитаться сейчас и ждём его отчёт: без моста или фонового скрипта он не придёт.
async function freshExtensionReport(healthDir, startedAt) {
  const request = join(healthDir, health.REQUEST_FILE);
  mkdirSync(healthDir, { recursive: true });
  writeFileSync(request, '');
  utimesSync(request, new Date(), new Date());
  const file = join(healthDir, health.EXTENSION_FILE);
  for (let waited = 0; waited < REPORT_WAIT_MS; waited += 500) {
    const report = readJson(file);
    if (report && Date.parse(report.at) >= startedAt) return report;
    await sleep(500);
  }

  return null;
}

async function gather() {
  const { targetDir, kworkRoot, serviceDir, healthDir } = paths();
  const startedAt = Date.now();
  const fresh = await freshExtensionReport(healthDir, startedAt);
  const bridge = readJson(join(healthDir, health.BRIDGE_FILE));
  const runner = createClaudeRunner();
  const desktop = runner.desktopChats();
  const localId = readJson(join(serviceDir, 'dispatcher.json'))?.localId || null;
  const found = localId ? [...desktop].find(([, chat]) => chat.localId === localId) : null;
  const open = found?.[1].cwd ? runner.openChat(found[1].cwd, found[0], false) : null;
  const state = readJson(join(serviceDir, 'wake-state.json')) || {};
  let map = '';
  try {
    map = readFileSync(join(kworkRoot, 'docs', 'заказы-клиенты.md'), 'utf8');
  } catch {
    // Списка заказов нет — YouGile не подключён.
  }

  return {
    now: Date.now(),
    manifestVersion: readJson(join(projectRoot, 'manifest.json'))?.version,
    bridge,
    bridgeAlive: Boolean(bridge?.pid) && pidAlive(bridge.pid),
    launcherNode: launcherNode(),
    // Отчёт не обновился за время ожидания — старый не в счёт: расширение сейчас не отвечает.
    extension: fresh,
    sync: readJson(join(serviceDir, '_sync.json')),
    yougileRouted: Object.values(wakeCore.parseOrderMap(map)).some((order) => order.nicks.some((nick) => nick.startsWith('yougile-'))),
    desktopRunning: runner.desktopAgeMs() !== null,
    dispatcher: { configured: Boolean(localId), inDesktop: Boolean(found), pid: open?.pid || null },
    inboundAccept: readJson(join(homedir(), '.claude', 'settings.json'))?.crossSessionInbound === 'accept',
    pending: Object.entries(state.pending || {}).map(([slug, item]) => ({ slug, since: item.since || Date.now(), error: item.error || null })),
    targetDir,
  };
}

function print(links) {
  for (const link of links) console.log(`${link.ok ? 'живо  ' : 'МЕРТВО'}  ${link.name}: ${link.detail}`);
}

function notify(title, message, id) {
  const env = { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` };
  const done = spawnSync('terminal-notifier', ['-title', title, '-message', message, '-group', `kph-watch-${id}`, '-sound', 'default'], { env, stdio: 'ignore' });
  if (done.error || done.status) {
    execFileSync('/usr/bin/osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]);
  }
}

// Сторож: о мёртвом звене — одно уведомление, пока оно не оживёт; ожило — одно «снова работает».
// Уведомляет на втором запуске подряд (5 минут): перезагрузка расширения, разовый отказ Kwork и
// перезапуск Desktop проходят сами.
async function watch() {
  const links = health.evaluate(await gather());
  const stateFile = join(paths().healthDir, 'watch.json');
  // Звено, которое в этом запуске не оценивалось (мост лежит — вкладки не судятся), своё состояние не теряет.
  const dead = { ...readJson(stateFile)?.dead };
  for (const link of links) {
    const known = typeof dead[link.id] === 'string' ? { since: dead[link.id], notified: true } : dead[link.id];
    if (link.ok) {
      if (known?.notified) notify('Kwork: снова работает', `${link.name}: ${link.detail}`, link.id);
      delete dead[link.id];
      continue;
    }

    dead[link.id] = { since: known?.since || new Date().toISOString(), notified: Boolean(known) };
    if (known && !known.notified) notify('Kwork: автоответчик не работает', `${link.name}: ${link.detail}`, link.id);
  }

  writeFileSync(stateFile, JSON.stringify({ dead, at: new Date().toISOString() }, null, 2));
  print(links);
}

// Пробная побудка. «Клиент» kph-selftest с двумя проверочными заказами: сообщение ложится в переписку так же,
// как его кладёт мост, будильщик ведёт его обычным путём (выбор заказа, сокет или диспетчер, метка в журнале
// чата), затем агентская пересылка уводит его во второй заказ. На Kwork ничего не уходит: такого клиента нет.
function prepareTrial({ targetDir, kworkRoot }, projectsDir = PROJECTS_DIR) {
  // Прерванная проба (Ctrl-C, таймаут) уборку не прошла: её папки увели бы новую побудку в старый заказ.
  sweepTrial({ targetDir, kworkRoot }, projectsDir);
  const stamp = Date.now().toString(36);
  const orders = ['a', 'b'].map((letter) => `${TRIAL_PREFIX}${letter}-${stamp}`);
  const dirs = orders.map((name) => join(kworkRoot, wakeCore.ACTIVE_DIR, name));
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), `# Проверка побудки\n\nСлужебная папка живой проверки цепочки побудки (kwork-project-hider, \`npm run health -- --wake\`). Клиента ${TRIAL_NICK} не существует.\n\nНа любое сообщение \`[Kwork-побудка …]\` ответь одной строкой «проверка получена». Ничего не читай, не запускай и не пиши: ни черновиков, ни файлов, ни команд, ни вопросов.\n`);
  }

  const mapPath = join(kworkRoot, 'docs', 'заказы-клиенты.md');
  const map = readFileSync(mapPath, 'utf8');
  writeFileSync(mapPath, `${map.replace(/\n*$/, '\n')}${orders.map((name) => `- ${name}: ${TRIAL_NICK} (выкладка: нет)\n`).join('')}`);

  const slug = core.buildDialogSlug(TRIAL_NICK);
  const file = join(targetDir, slug, core.DIALOG_DATA_NAME);
  const now = new Date();
  const message = { id: String(now.getTime()), authorName: TRIAL_NICK, time: now.toISOString(), text: 'ПРОВЕРКА ЦЕПОЧКИ ПОБУДКИ. Это не клиент: сообщение создала команда живой проверки. Ответь одной строкой «проверка получена» и ничего не делай.' };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ key: TRIAL_NICK, messages: [message] }, null, 2));
  markDirty(targetDir, slug);
  return { slug, dirs, file };
}

function markDirty(targetDir, slug) {
  const dirty = join(targetDir, 'data', WAKE_DIRTY_DIR);
  mkdirSync(dirty, { recursive: true });
  writeFileSync(join(dirty, slug), '');
}

async function waitDelivered({ serviceDir }, slug, since, wanted) {
  const logPath = join(projectRoot, 'native_host', 'bridge.log');
  const logFrom = statSync(logPath).size;
  let hinted = false;
  for (let waited = 0; waited < TRIAL_LEG_MS; waited += 1000) {
    const state = readJson(join(serviceDir, 'wake-state.json')) || {};
    const entry = (state.delivered?.[slug] || []).find((item) => item.at >= since && (!wanted || item.key === wanted));
    const log = readFileSync(logPath).subarray(logFrom).toString('utf8').split('\n').filter((line) => line.includes(`побудка ${slug}`));
    if (entry) return { entry, log, seconds: Math.round((entry.at - since) / 1000) };
    if (!hinted && log.some((line) => /уведомление/.test(line))) {
      hinted = true;
      console.log('        чата проверочного заказа ещё нет в Claude Desktop: откройте его из уведомления «Kwork: новый чат» — проверка ждёт');
    }

    await sleep(1000);
  }

  const state = readJson(join(serviceDir, 'wake-state.json')) || {};
  return { entry: null, error: state.pending?.[slug]?.error || (state.pending?.[slug]?.waitDispatcher ? 'ждёт диспетчера' : 'метки побудки нет в журнале чата') };
}

async function trial() {
  const where = paths();
  const startedAt = Date.now();
  const { slug, dirs, file } = prepareTrial(where);
  const clean = async () => {
    const left = await cleanupTrial(where, { slug, dirs, file });
    if (left.length > 0) console.log(`        в Claude Desktop остались проверочные чаты: ${left.join(', ')} — уберите их в архив или удалите, остальное убрано`);
  };
  // Прервали (Ctrl-C, таймаут запуска) — finally не выполнится: убираем по сигналу.
  const stop = () => clean().finally(() => process.exit(130));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await runTrial(where, slug, dirs, startedAt);
  } finally {
    await clean();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

// Файлы пробы: папки проверочных заказов (и прошлых прерванных проб), журналы их чатов, строки списка
// заказов, переписка проверочного клиента. Удаляется только своё — по точным именам.
function sweepTrial({ targetDir, kworkRoot }, projectsDir) {
  const mapPath = join(kworkRoot, 'docs', 'заказы-клиенты.md');
  const map = readFileSync(mapPath, 'utf8');
  const kept = map.split('\n').filter((line) => !wakeCore.parseOrderLine(line)?.order.startsWith(TRIAL_PREFIX)).join('\n');
  if (kept !== map) writeFileSync(mapPath, kept);
  const active = join(kworkRoot, wakeCore.ACTIVE_DIR);
  for (const name of existsSync(active) ? readdirSync(active) : []) {
    if (!TRIAL_ORDER.test(name)) continue;
    rmSync(join(active, name), { recursive: true, force: true });
  }

  // Журналы чатов: имя папки — путь заказа, где всё, кроме латиницы и цифр, заменено дефисом.
  const journals = new RegExp(`^${projectSlug(active)}-+kph-proverka-[ab](?:-[a-z0-9]+)?$`);
  for (const name of existsSync(projectsDir) ? readdirSync(projectsDir) : []) {
    if (journals.test(name)) rmSync(join(projectsDir, name), { recursive: true, force: true });
  }

  rmSync(join(targetDir, core.buildDialogSlug(TRIAL_NICK)), { recursive: true, force: true });
}

// Чаты проверочных заказов в списке Desktop — и этой пробы, и прошлых, которые тогда убрать не удалось.
const trialChats = (runner) => [...runner.desktopChats().values()].filter((chat) => !chat.archived && TRIAL_ORDER.test(basename(String(chat.cwd || ''))));

// Проба убирает за собой всё, что завела: побудку в пути, чаты в списке Claude Desktop (в архив), папки проверочных заказов,
// их строки в списке заказов, переписку и журналы чатов. → названия чатов, которые убрать не удалось.
async function cleanupTrial(where, { slug, file }, { runner = createClaudeRunner(), projectsDir = PROJECTS_DIR, pause = sleep } = {}) {
  const pendingGone = () => {
    const state = readJson(join(where.serviceDir, 'wake-state.json')) || {};
    return !state.pending?.[slug] && !state.reroute?.[slug] && !existsSync(join(where.serviceDir, WAKE_DIRTY_DIR, slug));
  };
  // Пустая переписка снимает недошедшую побудку: иначе будильщик слал бы ссылки и служебные просьбы в чаты заказов.
  writeFileSync(file, JSON.stringify({ key: TRIAL_NICK, messages: [] }, null, 2));
  markDirty(where.targetDir, slug);
  // Строки и папки убираются только после этого: такт будильщика, ещё держащий побудку, без заказов увёл бы её в корень Kwork.
  for (let waited = 0; waited < 60000 && !pendingGone(); waited += 500) await pause(500);

  // Чат из списка Desktop убирает только сам Desktop: просим диспетчера убрать его в архив.
  let chats = trialChats(runner);
  if (chats.length > 0) {
    try {
      const localId = readJson(join(where.serviceDir, 'dispatcher.json'))?.localId;
      const found = [...runner.desktopChats()].find(([, chat]) => chat.localId === localId);
      const open = found?.[1].cwd ? runner.openChat(found[1].cwd, found[0], false) : null;
      if (open) {
        // Агент проверочного чата ещё дописывает «проверка получена».
        await pause(5000);
        await runner.deliver(open, `${DISPATCHER_REMOVE}\n${chats.map((chat) => `убрать: ${chat.localId}`).join('\n')}`);
        for (let waited = 0; waited < CHAT_REMOVE_MS && chats.length > 0; waited += 1000) {
          await pause(1000);
          chats = trialChats(runner);
        }
      }
    } catch {
      // Диспетчер не ответил — чаты назовём в выводе.
    }
  }

  sweepTrial(where, projectsDir);
  return chats.map((chat) => chat.title || chat.localId);
}

async function runTrial(where, slug, dirs, startedAt) {
  const how = (log) => (log.some((line) => line.includes('через диспетчера')) ? 'чат спал, через диспетчера' : 'в открытый чат');
  const first = await waitDelivered(where, slug, startedAt, null);
  if (!first.entry || !dirs.includes(first.entry.key)) {
    return [{ id: 'trial', name: 'Пробная побудка', ok: false, detail: first.entry ? `ушла не в проверочный заказ: ${first.entry.key}` : `не дошла за ${TRIAL_LEG_MS / 60000} мин: ${first.error}` }];
  }

  const links = [{ id: 'trial', name: 'Пробная побудка', ok: true, detail: `дошла за ${first.seconds} с в ${first.entry.key.split('/').pop()} (${how(first.log)})` }];
  // Клиент с двумя заказами: агент первого пересылает побудку во второй — как 25.10.2026 «по парковке» в чат ломбарда.
  const other = dirs.find((dir) => dir !== first.entry.key);
  const reroutedAt = Date.now();
  reroute.writeRequest(where.serviceDir, { slug, wakeId: first.entry.wakeId, order: other.split('/').pop(), at: reroutedAt });
  const second = await waitDelivered(where, slug, reroutedAt, other);
  links.push({ id: 'trial-reroute', name: 'Пересылка во второй заказ клиента', ok: Boolean(second.entry), detail: second.entry ? `дошла за ${second.seconds} с в ${other.split('/').pop()} (${how(second.log)})` : `не дошла за ${TRIAL_LEG_MS / 60000} мин: ${second.error}` });
  return links;
}

// Сторож в launchd: раз в 5 минут и при входе; без KeepAlive — выключенный остаётся выключенным.
const WATCH_LABEL = 'com.local.kwork-watch';

function installWatch() {
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${WATCH_LABEL}.plist`);
  const log = join(homedir(), 'Library', 'Logs', 'kwork-watch.log');
  // Node из Homebrew — постоянной ссылкой opt/, а не папкой версии в Cellar: её уберёт обновление.
  const node = process.execPath.replace(/\/Cellar\/([^/]+)\/[^/]+\//, '/opt/$1/');
  const strings = [existsSync(node) ? node : process.execPath, fileURLToPath(import.meta.url), '--watch'].map((value) => `    <string>${value}</string>`).join('\n');
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${WATCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings}
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`);
  const domain = `gui/${process.getuid()}`;
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${WATCH_LABEL}`], { stdio: 'ignore' });
  const done = spawnSync('/bin/launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' });
  console.log(done.status === 0 ? `Сторож включён: ${plist}, журнал ${log}` : `Сторож не включён: ${done.stderr}`);
  process.exitCode = done.status;
}

async function main(args) {
  if (args.includes('--install-watch')) return installWatch();
  if (args.includes('--watch')) return watch();
  const links = health.evaluate(await gather());
  if (args.includes('--wake')) {
    // Без моста пробное сообщение просто пролежит: сначала звенья, потом побудка.
    if (links.find((link) => link.id === 'bridge')?.ok) links.push(...await trial());
    else links.push({ id: 'trial', name: 'Пробная побудка', ok: false, detail: 'не запускалась: мост не работает' });
  }

  print(links);
  const dead = links.filter((link) => !link.ok);
  console.log(dead.length === 0 ? '\nИтог: цепочка побудки жива.' : `\nИтог: мёртвых звеньев — ${dead.length}. Побудка клиента сейчас может не дойти.`);
  process.exitCode = dead.length === 0 ? 0 : 1;
}

export { cleanupTrial, prepareTrial };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
