// Запускается npm после `npm version …`: номер версии один на проект, поэтому
// manifest.json получает тот же номер, что и package.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
const manifestPath = resolve(projectRoot, 'manifest.json');
const manifest = readFileSync(manifestPath, 'utf8');

writeFileSync(manifestPath, manifest.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`));
process.stdout.write(`manifest.json: ${version}\n`);
