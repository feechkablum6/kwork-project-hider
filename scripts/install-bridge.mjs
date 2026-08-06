// Регистрирует мост переписок как native messaging host для Chrome, Chromium и Edge.
// Запуск: install.bat [папка для переписок]

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'ru.kwork.hider.host';
const RETIRED_HOST_NAMES = ['ru.kwork.hider.bridge'];
const DEFAULT_TARGET_DIR = 'F:\\Projects\\Kwork\\переписки';
const DEFAULT_PROJECTS_DIR_NAME = 'заказы';
const BROWSER_ROOTS = [
  ['Chrome', join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')],
  ['Chrome Beta', join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome Beta', 'User Data')],
  ['Chromium', join(process.env.LOCALAPPDATA || '', 'Chromium', 'User Data')],
  ['Edge', join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data')],
];
const REGISTRY_ROOTS = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU\\Software\\Chromium\\NativeMessagingHosts',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
];

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function computeUnpackedId(extensionPath, encoding) {
  const digest = createHash('sha256').update(Buffer.from(extensionPath, encoding)).digest();
  return [...digest.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('');
}

function findInstalledIds() {
  const found = new Set();

  for (const [, userDataDir] of BROWSER_ROOTS) {
    if (!userDataDir || !existsSync(userDataDir)) {
      continue;
    }

    for (const entry of readdirSync(userDataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      for (const fileName of ['Secure Preferences', 'Preferences']) {
        const preferencesPath = join(userDataDir, entry.name, fileName);
        if (!existsSync(preferencesPath)) {
          continue;
        }

        let settings;
        try {
          settings = JSON.parse(readFileSync(preferencesPath, 'utf8'))?.extensions?.settings;
        } catch {
          continue;
        }

        for (const [id, value] of Object.entries(settings || {})) {
          const installedPath = String(value?.path || '');
          if (installedPath && resolve(installedPath).toLowerCase() === projectRoot.toLowerCase()) {
            found.add(id);
          }
        }
      }
    }
  }

  return [...found];
}

// Chrome запускает мост только настоящей программой: командный файл (.bat) он
// с версии 151 отклоняет, отвечая расширению «мост не найден». Поэтому при
// установке собирается крошечный запускающий exe — он поднимает Node с мостом
// и просто перекладывает данные между Chrome и мостом.
function buildHostLauncher(manifestDir) {
  const launcherPath = join(manifestDir, 'kwork-bridge.exe');
  const sourcePath = join(manifestDir, 'kwork-bridge.cs');
  const bridgePath = join(projectRoot, 'native_host', 'kwork-bridge.js');
  const source = `using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

class KworkBridgeLauncher {
  const string NodePath = ${JSON.stringify(process.execPath)};
  const string BridgePath = ${JSON.stringify(bridgePath)};

  static int Main(string[] args) {
    var start = new ProcessStartInfo(NodePath, "\\"" + BridgePath + "\\"");
    start.UseShellExecute = false;
    start.CreateNoWindow = true;
    start.RedirectStandardInput = true;
    start.RedirectStandardOutput = true;

    var bridge = Process.Start(start);

    var toBridge = new Thread(delegate() {
      Copy(Console.OpenStandardInput(), bridge.StandardInput.BaseStream);
      try { bridge.StandardInput.BaseStream.Close(); } catch (Exception) { }
    });
    toBridge.IsBackground = true;
    toBridge.Start();

    Copy(bridge.StandardOutput.BaseStream, Console.OpenStandardOutput());
    bridge.WaitForExit();

    return bridge.ExitCode;
  }

  static void Copy(Stream from, Stream to) {
    var buffer = new byte[8192];
    int read;

    while ((read = from.Read(buffer, 0, buffer.Length)) > 0) {
      to.Write(buffer, 0, read);
      to.Flush();
    }
  }
}
`;

  writeFileSync(sourcePath, source, 'utf8');

  const compiler = [
    join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find((path) => existsSync(path));

  if (!compiler) {
    throw new Error('не найден компилятор csc.exe из .NET Framework: без него Chrome не сможет запустить мост');
  }

  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:anycpu', `/out:${launcherPath}`, sourcePath], {
    stdio: 'ignore',
  });

  return launcherPath;
}

function writeHostManifest(extensionIds) {
  const manifestDir = join(process.env.LOCALAPPDATA || projectRoot, 'KworkProjectHider');
  mkdirSync(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, `${HOST_NAME}.json`);

  writeFileSync(manifestPath, `${JSON.stringify({
    name: HOST_NAME,
    // Манифест хоста читает только Chrome, и в нём нет ни одного символа вне латиницы:
    // так исключены расхождения кодировок при чтении файла браузером.
    description: 'Kwork extension bridge: saves dialogs and projects to disk',
    path: buildHostLauncher(manifestDir),
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  }, null, 2)}\n`, 'utf8');

  return manifestPath;
}

function registerHost(manifestPath) {
  for (const registryRoot of REGISTRY_ROOTS) {
    execFileSync('reg', ['add', `${registryRoot}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
      stdio: 'ignore',
    });

    // Мост до версии 1.12.0 звался иначе и запускался командным файлом. Chrome такую
    // запись отвергает и продолжает отвечать «мост не найден», поэтому она убирается.
    for (const retiredName of RETIRED_HOST_NAMES) {
      try {
        execFileSync('reg', ['delete', `${registryRoot}\\${retiredName}`, '/f'], { stdio: 'ignore' });
      } catch {
        // Записи может и не быть — это обычное дело при первой установке.
      }
    }
  }
}

function writeBridgeConfig(targetDir, projectsDir) {
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  const configPath = join(projectRoot, 'native_host', 'bridge-config.json');
  writeFileSync(configPath, `${JSON.stringify({ targetDir, projectsDir }, null, 2)}\n`, 'utf8');
  return configPath;
}

const targetDir = resolve(process.argv[2] || DEFAULT_TARGET_DIR);
const projectsDir = resolve(process.argv[3] || join(dirname(targetDir), DEFAULT_PROJECTS_DIR_NAME));
const installedIds = findInstalledIds();
const extensionIds = installedIds.length > 0
  ? installedIds
  : [...new Set([computeUnpackedId(projectRoot, 'utf16le'), computeUnpackedId(projectRoot, 'utf8')])];

const manifestPath = writeHostManifest(extensionIds);
registerHost(manifestPath);
const configPath = writeBridgeConfig(targetDir, projectsDir);

process.stdout.write([
  'Мост переписок установлен.',
  `  Папка переписок: ${targetDir}`,
  `  Папка заказов:   ${projectsDir}`,
  `  Манифест хоста:  ${manifestPath}`,
  `  Настройка моста: ${configPath}`,
  installedIds.length > 0
    ? `  Расширение найдено в браузере: ${installedIds.join(', ')}`
    : '  Расширение в браузере не найдено, разрешены вычисленные идентификаторы.',
  '',
  'Перезапустите Chrome, чтобы мост подключился.',
  '',
].join('\n'));
