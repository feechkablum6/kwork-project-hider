import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COPIES = [
  ['src/core.js', 'src/core-isolated.js'],
  ['src/inbox-core.js', 'src/inbox-core-isolated.js'],
];

const COPY_HEADER = [
  '// Копия ядра для изолированного мира.',
  '// Chrome не подключает один и тот же файл к двум наборам content scripts с одинаковым',
  '// run_at, поэтому MAIN world и isolated world получают ядро разными файлами.',
  '// Файл создаётся командой `npm run sync-core`, править вручную не нужно.',
  '',
].join('\n');

for (const [sourceName, copyName] of COPIES) {
  const source = readFileSync(resolve(projectRoot, sourceName), 'utf8').replace(/^﻿/, '');
  writeFileSync(resolve(projectRoot, copyName), `${COPY_HEADER}${source}`);
  process.stdout.write(`${copyName} обновлён из ${sourceName}\n`);
}
