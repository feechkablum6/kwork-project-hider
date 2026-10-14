// Передача входа в Kwork (куки браузера) роботу kwork-hunter на сервере.
// Робот по ним читает переписку, пока мак спит, и пересылает сообщения заказчиков в Telegram.
// Куки уходят только по ssh на свой сервер; в лог и на диск мака значения не пишутся —
// локально хранится лишь отпечаток, чтобы не отправлять одно и то же.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_TARGET = Object.freeze({
  sshHost: 'firstbyte',
  path: '/srv/apps/kwork-hunter/data/kwork-session.json',
});
const STATE_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'KworkProjectHider', 'session-sync.json');
// Без изменений всё равно освежаем раз в 6 часов: сервер видит, что вход живой.
const REFRESH_MS = 6 * 60 * 60 * 1000;
const SSH_TIMEOUT_MS = 30_000;
// Счётчики аналитики меняются на каждой странице и ко входу отношения не имеют.
const NOISE = /^(_ym|_ga|_gid|_gcl|_fbp|tmr_|__ddg|cto_)/i;

const isKworkDomain = (domain) => {
  const d = String(domain || '').replace(/^\./, '');
  return d === 'kwork.ru' || d.endsWith('.kwork.ru');
};

function cleanCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  return cookies.filter(
    (c) =>
      c &&
      isKworkDomain(c.domain) &&
      /^[^\s;=,]+$/.test(String(c.name || '')) &&
      !/[;\r\n]/.test(String(c.value ?? '')),
  );
}

function fingerprint(cookies) {
  const meaningful = cookies
    .filter((c) => !NOISE.test(c.name))
    .map((c) => `${c.name}=${c.value}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(meaningful).digest('hex');
}

function buildSession(cookies, userAgent, now) {
  // Одинаковое имя на kwork.ru и поддомене: браузер шлёт более точный путь первым, нам хватит одного.
  const seen = new Set();
  const pairs = [];
  for (const c of cookies) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    pairs.push(`${c.name}=${c.value}`);
  }
  return {
    cookie: pairs.join('; '),
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 400) : '',
    updatedAt: new Date(now).toISOString(),
  };
}

function resolveTarget(config) {
  const t = { ...DEFAULT_TARGET, ...(config?.sessionTarget || {}) };
  if (!/^[A-Za-z0-9._@-]+$/.test(t.sshHost)) throw new Error('недопустимое имя сервера в sessionTarget');
  if (!/^\/[A-Za-z0-9._/-]+\.json$/.test(t.path)) throw new Error('недопустимый путь в sessionTarget');
  return t;
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
}

/** Атомарная запись на сервере: временный файл с правами 600, затем переименование. */
function pushOverSsh(target, body, spawnFn = spawn) {
  const tmp = `${target.path}.tmp`;
  const remote = `umask 077 && cat > '${tmp}' && mv '${tmp}' '${target.path}'`;
  return new Promise((resolve, reject) => {
    const child = spawnFn('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target.sshHost, remote], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('сервер не ответил за 30 секунд'));
    }, SSH_TIMEOUT_MS);
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-400);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ssh завершился с кодом ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(body);
  });
}

/**
 * @param {{ cookies: object[], userAgent?: string }} message
 * @param {{ config?: object, now?: number, statePath?: string, push?: Function }} [deps]
 */
async function handleSessionSync(message, deps = {}) {
  const now = deps.now ?? Date.now();
  const statePath = deps.statePath ?? STATE_PATH;
  const push = deps.push ?? pushOverSsh;
  const cookies = cleanCookies(message?.cookies);
  if (!cookies.some((c) => !NOISE.test(c.name))) return { skipped: 'нет кук входа' };

  const target = resolveTarget(deps.config);
  const print = fingerprint(cookies);
  const state = readState(statePath);
  if (state?.fingerprint === print && now - Number(state.pushedAt) < REFRESH_MS) {
    return { skipped: 'без изменений' };
  }

  await push(target, JSON.stringify(buildSession(cookies, message.userAgent, now)));
  writeState(statePath, { fingerprint: print, pushedAt: now });
  return { pushed: true };
}

module.exports = {
  DEFAULT_TARGET,
  REFRESH_MS,
  buildSession,
  cleanCookies,
  fingerprint,
  handleSessionSync,
  pushOverSsh,
  resolveTarget,
};
