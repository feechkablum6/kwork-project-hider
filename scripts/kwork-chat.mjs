// Печатает сохранённую переписку с клиентом Kwork.
// Запуск: node scripts/kwork-chat.mjs <ссылка на переписку | имя клиента> [--json] [--list]

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const core = require('../src/inbox-core.js');

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(projectRoot, 'native_host', 'bridge-config.json');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readTargetDir() {
  if (!existsSync(configPath)) {
    fail('Мост переписок не установлен: запустите install.bat в папке расширения.');
  }

  const targetDir = JSON.parse(readFileSync(configPath, 'utf8'))?.targetDir;
  if (!targetDir || !existsSync(targetDir)) {
    fail(`Папка переписок не найдена: ${targetDir || 'не указана'}`);
  }

  return targetDir;
}

function listDialogs(targetDir) {
  return readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(targetDir, entry.name, core.DIALOG_MARKDOWN_NAME)))
    .map((entry) => entry.name);
}

function findDialogSlug(targetDir, request) {
  const slugs = listDialogs(targetDir);
  const wanted = core.buildDialogSlug(core.extractDialogKey(request) || request);
  if (!wanted) {
    fail('Не удалось понять, какая переписка нужна. Передайте ссылку вида https://kwork.ru/inbox/<клиент>.');
  }

  if (slugs.includes(wanted)) {
    return wanted;
  }

  const partial = slugs.filter((slug) => slug.includes(wanted) || wanted.includes(slug));
  if (partial.length === 1) {
    return partial[0];
  }

  const hint = slugs.length > 0
    ? `Сохранённые переписки: ${slugs.join(', ')}`
    : 'Сохранённых переписок пока нет.';
  fail([
    `Переписка «${wanted}» не найдена.`,
    hint,
    'Откройте эту переписку на kwork.ru — расширение сохранит её автоматически.',
  ].join('\n'));

  return null;
}

const args = process.argv.slice(2);
const targetDir = readTargetDir();

if (args.includes('--list')) {
  const slugs = listDialogs(targetDir);
  process.stdout.write(slugs.length > 0 ? `${slugs.join('\n')}\n` : 'Сохранённых переписок пока нет.\n');
  process.exit(0);
}

const request = args.find((argument) => !argument.startsWith('--'));
if (!request) {
  fail('Укажите ссылку на переписку: node scripts/kwork-chat.mjs https://kwork.ru/inbox/<клиент>');
}

const slug = findDialogSlug(targetDir, request);
const wantsJson = args.includes('--json');
const filePath = join(targetDir, slug, wantsJson ? core.DIALOG_DATA_NAME : core.DIALOG_MARKDOWN_NAME);

if (!existsSync(filePath)) {
  fail(`Файл переписки не найден: ${filePath}`);
}

process.stdout.write(readFileSync(filePath, 'utf8'));
