const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function readManifest() {
  const content = fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8');
  return JSON.parse(content.replace(/^\uFEFF/, ''));
}

test('manifest использует MV3, storage и не содержит попапа', () => {
  const manifest = readManifest();

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.action, undefined);
  assert.equal(manifest.background, undefined);
});

test('content scripts запускаются только на странице проектов Kwork', () => {
  const manifest = readManifest();
  const [mainWorldScript, contentScript] = manifest.content_scripts;

  assert.deepEqual(mainWorldScript.matches, ['https://kwork.ru/*']);
  assert.equal(mainWorldScript.exclude_matches, undefined);
  assert.deepEqual(mainWorldScript.js, ['src/core.js', 'src/feed-main.js']);
  assert.equal(mainWorldScript.world, 'MAIN');
  assert.equal(mainWorldScript.run_at, 'document_start');
  assert.deepEqual(contentScript.matches, ['https://kwork.ru/*']);
  assert.equal(contentScript.exclude_matches, undefined);
  assert.deepEqual(contentScript.js, ['src/core.js', 'src/content.js', 'src/feed-content.js']);
  assert.deepEqual(contentScript.css, ['src/content.css']);
});

test('manifest ссылается на все необходимые размеры иконки', () => {
  const manifest = readManifest();

  assert.deepEqual(Object.keys(manifest.icons), ['16', '32', '48', '128']);
  for (const iconPath of Object.values(manifest.icons)) {
    assert.equal(fs.existsSync(path.join(projectRoot, iconPath)), true, `${iconPath} должен существовать`);
  }
});
