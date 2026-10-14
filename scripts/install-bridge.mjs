// Регистрирует мост переписок как native messaging host для Chrome, Chromium и Edge.
// Запуск: install.bat (Windows) или install.command (macOS) [папка переписок] [папка заказов]

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'ru.kwork.hider.host';
const RETIRED_HOST_NAMES = ['ru.kwork.hider.bridge'];
// Манифест хоста читает только браузер, и в нём нет ни одного символа вне латиницы:
// так исключены расхождения кодировок при чтении файла.
const HOST_DESCRIPTION = 'Kwork extension bridge: saves dialogs and projects to disk';
const HOST_DIR_NAME = 'KworkProjectHider';
const DEFAULT_PROJECTS_DIR_NAME = 'заказы';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridgePath = join(projectRoot, 'native_host', 'kwork-bridge.js');

// Chrome запускает мост только настоящей программой: командный файл (.bat) он
// с версии 151 отклоняет, отвечая расширению «мост не найден». Поэтому при
// установке собирается крошечный запускающий exe — он поднимает Node с мостом
// и просто перекладывает данные между Chrome и мостом.
function buildWindowsLauncher(hostDir) {
  const launcherPath = join(hostDir, 'kwork-bridge.exe');
  const sourcePath = join(hostDir, 'kwork-bridge.cs');
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

const windows = {
  defaultTargetDir: 'F:\\Projects\\Kwork\\переписки',

  userDataDirs() {
    const localAppData = process.env.LOCALAPPDATA || '';
    return [
      join(localAppData, 'Google', 'Chrome', 'User Data'),
      join(localAppData, 'Google', 'Chrome Beta', 'User Data'),
      join(localAppData, 'Chromium', 'User Data'),
      join(localAppData, 'Microsoft', 'Edge', 'User Data'),
    ];
  },

  buildLauncher() {
    const hostDir = join(process.env.LOCALAPPDATA || projectRoot, HOST_DIR_NAME);
    mkdirSync(hostDir, { recursive: true });
    return buildWindowsLauncher(hostDir);
  },

  // Windows держит адрес манифеста в реестре, поэтому сам файл лежит в одном месте
  // и на все браузеры выдаётся одной записью.
  registerHost(manifest) {
    const hostDir = join(process.env.LOCALAPPDATA || projectRoot, HOST_DIR_NAME);
    const manifestPath = join(hostDir, `${HOST_NAME}.json`);
    writeFileSync(manifestPath, manifest, 'utf8');

    const registryRoots = [
      'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
      'HKCU\\Software\\Chromium\\NativeMessagingHosts',
      'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
    ];

    for (const registryRoot of registryRoots) {
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

    return [manifestPath];
  },
};

function quoteForShell(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function macBrowserDirs() {
  const support = join(homedir(), 'Library', 'Application Support');
  return [
    join(support, 'Google', 'Chrome'),
    join(support, 'Google', 'Chrome Beta'),
    join(support, 'Chromium'),
    join(support, 'Microsoft Edge'),
  ];
}

const macos = {
  defaultTargetDir: join(homedir(), 'Projects', 'Kwork', 'переписки'),

  // На macOS папка браузера — она же папка профилей: рядом с ней лежат Default,
  // Profile 1 и подобные, и там же браузер ищет манифесты хостов.
  userDataDirs: macBrowserDirs,

  buildLauncher() {
    const hostDir = join(homedir(), 'Library', 'Application Support', HOST_DIR_NAME);
    mkdirSync(hostDir, { recursive: true });
    const launcherPath = join(hostDir, 'kwork-bridge.sh');

    // Chrome запускает мост без пользовательского окружения: в PATH у него только
    // системные папки, поэтому путь к Node записан целиком. Поиск в PATH остаётся
    // на случай, когда Node переехал после обновления.
    writeFileSync(launcherPath, `#!/bin/sh
NODE=${quoteForShell(process.execPath)}

if [ ! -x "$NODE" ]; then
  PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  NODE=$(command -v node)
fi

exec "$NODE" ${quoteForShell(bridgePath)}
`, 'utf8');
    chmodSync(launcherPath, 0o755);

    return launcherPath;
  },

  // Реестра здесь нет: каждый браузер читает манифест из своей папки, поэтому файл
  // кладётся во все установленные браузеры.
  registerHost(manifest) {
    const browserDirs = macBrowserDirs().filter((dir) => existsSync(dir));
    const targets = browserDirs.length > 0 ? browserDirs : [macBrowserDirs()[0]];
    const manifestPaths = [];

    for (const browserDir of targets) {
      const hostsDir = join(browserDir, 'NativeMessagingHosts');
      mkdirSync(hostsDir, { recursive: true });
      const manifestPath = join(hostsDir, `${HOST_NAME}.json`);
      writeFileSync(manifestPath, manifest, 'utf8');
      manifestPaths.push(manifestPath);

      for (const retiredName of RETIRED_HOST_NAMES) {
        rmSync(join(hostsDir, `${retiredName}.json`), { force: true });
      }
    }

    return manifestPaths;
  },
};

const platform = { win32: windows, darwin: macos }[process.platform];

if (!platform) {
  process.stderr.write(`Мост ставится только на Windows и macOS, а здесь ${process.platform}.\n`);
  process.exit(1);
}

function computeUnpackedId(extensionPath, encoding) {
  const digest = createHash('sha256').update(Buffer.from(extensionPath, encoding)).digest();
  return [...digest.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('');
}

// Путь к расширению приходит из настроек браузера, а macOS хранит кириллицу в файловых
// именах в разложенном виде: без приведения к одной форме путь не узнаётся.
function isProjectPath(value) {
  return resolve(value).normalize('NFC').toLowerCase() === projectRoot.normalize('NFC').toLowerCase();
}

function findInstalledIds() {
  const found = new Set();

  for (const userDataDir of platform.userDataDirs()) {
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
          if (installedPath && isProjectPath(installedPath)) {
            found.add(id);
          }
        }
      }
    }
  }

  return [...found];
}

function writeBridgeConfig(targetDir, projectsDir) {
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  const configPath = join(projectRoot, 'native_host', 'bridge-config.json');
  writeFileSync(configPath, `${JSON.stringify({ targetDir, projectsDir }, null, 2)}\n`, 'utf8');
  return configPath;
}

const targetDir = resolve(process.argv[2] || platform.defaultTargetDir);
const projectsDir = resolve(process.argv[3] || join(dirname(targetDir), DEFAULT_PROJECTS_DIR_NAME));
const installedIds = findInstalledIds();
const extensionIds = installedIds.length > 0
  ? installedIds
  : [...new Set([computeUnpackedId(projectRoot, 'utf16le'), computeUnpackedId(projectRoot, 'utf8')])];

const launcherPath = platform.buildLauncher();
const manifestPaths = platform.registerHost(`${JSON.stringify({
  name: HOST_NAME,
  description: HOST_DESCRIPTION,
  path: launcherPath,
  type: 'stdio',
  allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
}, null, 2)}\n`);
const configPath = writeBridgeConfig(targetDir, projectsDir);

process.stdout.write([
  'Мост переписок установлен.',
  `  Папка переписок: ${targetDir}`,
  `  Папка заказов:   ${projectsDir}`,
  ...manifestPaths.map((path, index) => `  ${index === 0 ? 'Манифест хоста: ' : '                '} ${path}`),
  `  Настройка моста: ${configPath}`,
  installedIds.length > 0
    ? `  Расширение найдено в браузере: ${installedIds.join(', ')}`
    : '  Расширение в браузере не найдено, разрешены вычисленные идентификаторы.',
  '',
  'Перезапустите браузер, чтобы мост подключился.',
  '',
].join('\n'));
