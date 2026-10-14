const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function readManifest() {
  const content = fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8');
  return JSON.parse(content.replace(/^\uFEFF/, ''));
}

test('manifest использует MV3, хранилище, мост на диск и попап', () => {
  const manifest = readManifest();

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage', 'nativeMessaging', 'tabs', 'cookies', 'alarms']);
  assert.deepEqual(manifest.host_permissions, ['https://kwork.ru/*', 'https://cdn-edge.kwork.ru/*', 'https://kwork-conversation.storage.yandexcloud.net/*', 'https://kwork-track.storage.yandexcloud.net/*']);
  assert.equal(manifest.action.default_popup, 'src/popup.html');
  assert.equal(manifest.background.service_worker, 'src/background.js');
  assert.equal(fs.existsSync(path.join(projectRoot, 'src/background.js')), true);
});

test('content scripts запускаются только на страницах Kwork', () => {
  const manifest = readManifest();
  const [mainWorldScript, contentScript] = manifest.content_scripts;

  assert.equal(manifest.content_scripts.length, 2);
  assert.deepEqual(mainWorldScript.matches, ['https://kwork.ru/*']);
  assert.equal(mainWorldScript.exclude_matches, undefined);
  assert.deepEqual(
    mainWorldScript.js,
    ['src/core.js', 'src/feed-main.js', 'src/inbox-core.js', 'src/inbox-main.js', 'src/inbox-crawler.js', 'src/ticks-main.js'],
  );
  assert.equal(mainWorldScript.world, 'MAIN');
  assert.equal(mainWorldScript.run_at, 'document_start');
  assert.deepEqual(contentScript.matches, ['https://kwork.ru/*']);
  assert.equal(contentScript.exclude_matches, undefined);
  assert.deepEqual(
    contentScript.js,
    [
      'src/core-isolated.js',
      'src/inbox-core-isolated.js',
      'src/project-core.js',
      'src/payout-core.js',
      'src/payout-source.js',
      'src/content.js',
      'src/feed-content.js',
      'src/inbox-content.js',
      'src/project-content.js',
      'src/payout-content.js',
      'src/report-toggle.js',
      'src/ticks-content.js',
    ],
  );
  assert.deepEqual(contentScript.css, ['src/content.css']);
});

test('изолированный мир получает оба ядра отдельными файлами, идентичными исходным', () => {
  for (const [sourceName, copyName] of [
    ['src/core.js', 'src/core-isolated.js'],
    ['src/inbox-core.js', 'src/inbox-core-isolated.js'],
  ]) {
    const source = fs.readFileSync(path.join(projectRoot, sourceName), 'utf8')
      .replace(/^﻿/, '')
      .replace(/\r\n/g, '\n');
    const copy = fs.readFileSync(path.join(projectRoot, copyName), 'utf8')
      .replace(/^﻿/, '')
      .replace(/\r\n/g, '\n');

    assert.match(copy, /npm run sync-core/);
    assert.equal(
      copy.replace(/^(\/\/[^\n]*\n)+/, ''),
      source,
      `${copyName} устарел, выполните npm run sync-core`,
    );
  }
});

test('ядро заказов подключено раньше сценариев, которые им пользуются', () => {
  const manifest = readManifest();
  const [, contentScript] = manifest.content_scripts;

  assert.ok(
    contentScript.js.indexOf('src/inbox-core-isolated.js') < contentScript.js.indexOf('src/project-core.js'),
    'ядро заказов берёт разбор имён файлов из ядра переписок',
  );
  assert.ok(contentScript.js.indexOf('src/project-core.js') < contentScript.js.indexOf('src/project-content.js'));
});

test('версия расширения и пакета совпадают', () => {
  const manifest = readManifest();
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

  assert.equal(manifest.version, pkg.version);
});

test('скрытые карточки не успевают показаться до скрытия', () => {
  const manifest = readManifest();
  const [, contentScript] = manifest.content_scripts;

  assert.equal(contentScript.run_at, 'document_start');
});

test('единая лента ждёт готовности перехватчика, а не порядка запуска скриптов', () => {
  const feedContentScript = fs.readFileSync(path.join(projectRoot, 'src/feed-content.js'), 'utf8');

  assert.match(feedContentScript, /addEventListener\('kph-feed-ready'[\s\S]{0,80}once: true/);
  assert.match(feedContentScript, /getAttribute\('data-kph-feed-ready'\) === 'true'/);
});

test('manifest ссылается на все необходимые размеры иконки', () => {
  const manifest = readManifest();

  assert.deepEqual(Object.keys(manifest.icons), ['16', '32', '48', '128']);
  for (const iconPath of Object.values(manifest.icons)) {
    assert.equal(fs.existsSync(path.join(projectRoot, iconPath)), true, `${iconPath} должен существовать`);
  }
});
