// Побудка пришла не в тот заказ клиента: node kwork-reroute.mjs <диалог> <номер побудки> <папка заказа> —
// готовая команда есть в тексте побудки. Заявку подхватит будильщик (native_host/reroute.js) и разбудит
// чат того заказа теми же сообщениями.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveChatsDir } from './kwork-shared.mjs';

const require = createRequire(import.meta.url);
const reroute = require('../native_host/reroute.js');
const { ACTIVE_DIR, DONE_DIR } = require('../native_host/wake-core.js');

export function runReroute(args, { home = homedir(), now = Date.now() } = {}) {
  const [slug, wakeId, order] = args;
  if (args.length !== 3 || !reroute.NAME.test(slug) || !reroute.WAKE_ID.test(wakeId) || !reroute.NAME.test(order)) {
    return { code: 2, text: 'Нужно: node kwork-reroute.mjs <диалог> <номер побудки> <имя заказа> — команда есть в тексте побудки, имя заказа — как там.' };
  }

  const kworkRoot = join(home, 'Projects', 'Kwork');
  if (![ACTIVE_DIR, DONE_DIR].some((folder) => existsSync(join(kworkRoot, folder, order)))) {
    return { code: 2, text: `Заказа «${order}» нет в ${join(kworkRoot, ACTIVE_DIR)} и ${DONE_DIR}: имя заказа — как в тексте побудки. Ничего не переслано.` };
  }

  reroute.writeRequest(join(resolveChatsDir(kworkRoot), 'data'), { slug, wakeId, order, at: now });
  return { code: 0, text: `Побудка уйдёт в чат заказа ${order} за несколько секунд. Здесь по этому сообщению больше ничего не делай.` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, text } = runReroute(process.argv.slice(2));
  console.log(text);
  process.exit(code);
}
