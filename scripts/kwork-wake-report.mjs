// Итог разбуженного агента — в Telegram. Stop-хук Claude Code: если в ходе была
// побудка «[Kwork-побудка #…]» (в начале или подмешанная в уже идущий ход),
// строка «Итог для Telegram: …» из последнего ответа ложится в очередь
// уведомлений; мост расширения отправит её роботу kwork-hunter.
// Любой сбой — тихий выход: агент не должен застрять из-за уведомления.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJson, resolveChatsDir } from './kwork-shared.mjs';

const require = createRequire(import.meta.url);
const outbox = require('../native_host/outbox.js');

const WAKE_LINE = /\[Kwork-побудка #([0-9a-f]{6,20})\] Клиент (\S+) написал/;
const ORDER_LINE = /^Заказ ([^:\n]+): папка/m;
const REPORT_LINE = /Итог для Telegram:\s*([\s\S]+)$/i;
const REPORT_CHARS = 1500;

function textOf(content) {
  if (typeof content === 'string') {
    return content;
  }

  return (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

// Побудки и последний ответ агента — из журнала сессии. Побудка без ответа
// после неё ещё не разобрана: её итог придёт со следующим Stop.
export function collectTurn(lines) {
  const wakes = new Map();
  let lastAnswer = '';
  let lastAnswerAt = -1;
  for (const [index, line] of lines.entries()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const text = textOf(entry?.message?.content);
    if (entry?.type === 'user') {
      const match = WAKE_LINE.exec(text);
      if (match && !wakes.has(match[1])) {
        wakes.set(match[1], { wakeId: match[1], nick: match[2], order: ORDER_LINE.exec(text)?.[1]?.trim() || null, index });
      }
    } else if (entry?.type === 'assistant' && text.trim()) {
      lastAnswer = text;
      lastAnswerAt = index;
    }
  }

  return { wakes: [...wakes.values()].filter((wake) => wake.index < lastAnswerAt), lastAnswer };
}

export function extractReport(answer) {
  const match = REPORT_LINE.exec(String(answer || ''));
  const text = (match ? match[1] : String(answer || '')).trim();
  return text.length > REPORT_CHARS ? `${text.slice(0, REPORT_CHARS).trimEnd()}…` : text;
}

export function runReport(input, options = {}) {
  const home = options.home || homedir();
  const transcript = input?.transcript_path;
  if (!transcript || !existsSync(transcript)) {
    return 0;
  }

  const { wakes, lastAnswer } = collectTurn(readFileSync(transcript, 'utf8').split('\n'));
  if (wakes.length === 0) {
    return 0;
  }

  const stateDir = options.stateDir || join(home, '.claude', 'state', 'kwork-wake-report');
  const sessionId = String(input?.session_id || 'no-session').replace(/[^A-Za-z0-9_-]/g, '');
  const statePath = join(stateDir, `${sessionId}.json`);
  // Курсор по журналу: побудки до него уже отправлены, сколько бы их ни было.
  const after = Number(readJson(statePath)?.after ?? -1);
  const fresh = wakes.filter((wake) => wake.index > after);
  if (fresh.length === 0) {
    return 0;
  }

  const targetDir = options.targetDir || resolveChatsDir(join(home, 'Projects', 'Kwork'));
  const serviceDir = join(targetDir, 'data');
  const text = extractReport(lastAnswer);
  // Несколько побудок в одном ходе — один итог: агент отвечал на все сразу.
  const last = fresh[fresh.length - 1];
  outbox.enqueue(serviceDir, {
    id: `report:${fresh.map((wake) => wake.wakeId).join(',')}`,
    kind: 'report',
    nick: [...new Set(fresh.map((wake) => wake.nick))].join(', '),
    order: last.order,
    text,
  });

  mkdirSync(stateDir, { recursive: true });
  const temp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ after: Math.max(...fresh.map((wake) => wake.index)) }));
  renameSync(temp, statePath);
  return fresh.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    runReport(input);
  } catch {
    // Уведомление — не условие работы агента.
  }

  process.exit(0);
}

