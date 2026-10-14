const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectPendingWithdrawals,
  sumWithdrawals,
  formatMoney,
  parsePayoutDate,
  describeDelay,
  buildPayoutState,
} = require('../src/payout-core.js');

const NBSP = '\u00A0';

function moscowDate(isoLocal) {
  return new Date(`${isoLocal}+03:00`);
}

test('пустой список операций не даёт заявок и состояние', () => {
  assert.deepEqual(collectPendingWithdrawals([]), []);
  assert.deepEqual(collectPendingWithdrawals(null), []);
  assert.equal(buildPayoutState([]), null);
});

test('закрытые выводы со статусом done не попадают в список', () => {
  const operations = [
    { type: 'withdraw', operation_status: 'done', operationAmount: -1000, time: '1 сентября, 10:00' },
    { type: 'order_in', operation_status: 'done', operationAmount: 500 },
  ];
  assert.deepEqual(collectPendingWithdrawals(operations), []);
  assert.equal(buildPayoutState(operations), null);
});

test('смесь статусов оставляет только новые выводы', () => {
  const operations = [
    { type: 'withdraw', operation_status: 'new', operationAmount: -1000, time: '1 сентября, 10:00', getDateWithdrawByDate: 'четверг 3 сентября до 23:00 по МСК' },
    { type: 'withdraw', wd_status: 'new', price: -500, time: '1 сентября, 11:00', getDateWithdrawByDate: 'четверг 3 сентября до 23:00 по МСК' },
    { type: 'withdraw', operation_status: 'done', operationAmount: -2000, time: 'старый' },
    { type: 'withdraw', operation_status: 'cancel', operationAmount: -300, time: 'отмена' },
    { type: 'withdraw', operation_status: 'inprogress', operationAmount: -400, time: 'в работе' },
    { type: 'order_in', operation_status: 'new', operationAmount: 900 },
  ];

  const pending = collectPendingWithdrawals(operations);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].amount, 1000);
  assert.equal(pending[1].amount, 500);
  assert.equal(sumWithdrawals(pending), 1500);
});

test('сумма устойчиво разбирает строки с пробелами, минусом и валютой', () => {
  const operations = [
    { type: 'withdraw', operation_status: 'new', operationAmount: '- 2 800 ₽', time: '2 сентября, 16:50', getDateWithdrawByDate: 'четверг 3 сентября до 23:00 по МСК' },
    { type: 'withdraw', wd_status: 'new', price: '-2800', time: '2 сентября, 16:51', getDateWithdrawByDate: 'четверг 3 сентября до 23:00 по МСК' },
    { type: 'withdraw', operation_status: 'new', operationAmount: '2800.50', time: '2 сентября, 16:52', getDateWithdrawByDate: 'четверг 3 сентября до 23:00 по МСК' },
    { type: 'withdraw', operation_status: 'new', operationAmount: -800, time: '2 сентября, 16:53', getDateWithdrawByDate: 'четверг 3 сентября до 23:00 по МСК' },
    { type: 'withdraw', operation_status: 'new', operationAmount: 'не сумма', time: 'мусор' },
  ];

  const pending = collectPendingWithdrawals(operations);
  assert.equal(pending.length, 4);
  assert.equal(sumWithdrawals(pending), 2800 + 2800 + 2800.5 + 800);
});

test('нулевая сумма заявок даёт null', () => {
  const operations = [
    { type: 'withdraw', operation_status: 'new', operationAmount: 0, time: '1 сентября, 10:00' },
  ];
  assert.equal(buildPayoutState(operations), null);
});

test('formatMoney отбрасывает копейки вниз и ставит неразрывный пробел', () => {
  assert.equal(formatMoney(6400), `6${NBSP}400 ₽`);
  assert.equal(formatMoney(2800.99), `2${NBSP}800 ₽`);
  assert.equal(formatMoney(0), '0 ₽');
});

test('describeDelay считает календарные дни по Москве: сегодня, завтра, склонения', () => {
  const now = moscowDate('2026-09-03T08:00:00');

  assert.equal(describeDelay(moscowDate('2026-09-03T23:00:00'), now), 'сегодня');
  assert.equal(describeDelay(moscowDate('2026-09-04T23:00:00'), now), 'завтра');
  assert.equal(describeDelay(moscowDate('2026-09-05T23:00:00'), now), 'через 2 дня');
  assert.equal(describeDelay(moscowDate('2026-09-08T23:00:00'), now), 'через 5 дней');
  assert.equal(describeDelay(moscowDate('2026-09-24T23:00:00'), now), 'через 21 день');
  assert.equal(describeDelay(moscowDate('2026-09-14T23:00:00'), now), 'через 11 дней');
});

test('parsePayoutDate через Новый год берёт следующий год', () => {
  const now = moscowDate('2026-12-30T12:00:00');
  const parsed = parsePayoutDate('понедельник 2 января', now);
  assert.ok(parsed instanceof Date);
  assert.equal(parsed.getUTCFullYear(), 2027);
  assert.equal(parsed.getUTCMonth(), 0);
  assert.equal(parsed.getUTCDate(), 2);
});

test('пятница после четверга выплаты остаётся в текущем году и без срока', () => {
  const now = moscowDate('2026-09-04T08:00:00');
  const payoutText = 'четверг 3 сентября до 23:00 по МСК';
  const parsed = parsePayoutDate(payoutText, now);

  assert.ok(parsed instanceof Date);
  assert.equal(parsed.getUTCFullYear(), 2026);
  assert.equal(parsed.getUTCMonth(), 8);
  assert.equal(parsed.getUTCDate(), 3);
  assert.equal(describeDelay(parsed, now), null);

  const state = buildPayoutState([
    { type: 'withdraw', operation_status: 'new', operationAmount: -2800, time: '3 сентября, 10:00', getDateWithdrawByDate: payoutText },
  ], now);

  assert.equal(state.delayText, null);
  assert.equal(state.label, `2${NBSP}800 ₽`);
});

test('30 декабря и строка 2 января берут следующий год', () => {
  const now = moscowDate('2026-12-30T12:00:00');
  const parsed = parsePayoutDate('пятница 2 января до 23:00 по МСК', now);

  assert.ok(parsed instanceof Date);
  assert.equal(parsed.getUTCFullYear(), 2027);
  assert.equal(parsed.getUTCMonth(), 0);
  assert.equal(parsed.getUTCDate(), 2);
  assert.equal(describeDelay(parsed, now), 'через 3 дня');
});

test('1 января и строка 31 декабря берут прошедший год без срока', () => {
  const now = moscowDate('2027-01-01T08:00:00');
  const parsed = parsePayoutDate('четверг 31 декабря до 23:00 по МСК', now);

  assert.ok(parsed instanceof Date);
  assert.equal(parsed.getUTCFullYear(), 2026);
  assert.equal(parsed.getUTCMonth(), 11);
  assert.equal(parsed.getUTCDate(), 31);
  assert.equal(describeDelay(parsed, now), null);
});

test('неразбираемая дата даёт подпись только с суммой', () => {
  const now = moscowDate('2026-09-03T08:00:00');
  const state = buildPayoutState([
    { type: 'withdraw', operation_status: 'new', operationAmount: -6400, time: '2 сентября, 16:50', getDateWithdrawByDate: 'когда-нибудь потом' },
  ], now);

  assert.equal(state.label, `6${NBSP}400 ₽`);
  assert.equal(state.delayText, null);
});

test('дата выплаты в прошлом даёт подпись только с суммой', () => {
  const now = moscowDate('2026-09-03T23:30:00');
  const state = buildPayoutState([
    { type: 'withdraw', operation_status: 'new', operationAmount: -6400, time: '2 сентября, 16:50', getDateWithdrawByDate: 'четверг 3 сентября до 23:00 по МСК' },
  ], now);

  assert.equal(state.label, `6${NBSP}400 ₽`);
  assert.equal(state.delayText, null);
});

test('собирает подпись, срок «сегодня» и полный текст тултипа', () => {
  const now = moscowDate('2026-09-03T08:00:00');
  const payoutText = 'четверг 3 сентября до 23:00 по МСК';
  const state = buildPayoutState([
    { type: 'withdraw', operation_status: 'new', operationAmount: '- 2 800 ₽', time: '2 сентября, 16:50', getDateWithdrawByDate: payoutText },
    { type: 'withdraw', wd_status: 'new', price: -2800, time: '2 сентября, 17:10', getDateWithdrawByDate: payoutText },
    { type: 'withdraw', operation_status: 'new', operationAmount: -800, time: '3 сентября, 09:00', getDateWithdrawByDate: payoutText },
  ], now);

  assert.equal(state.total, 6400);
  assert.equal(state.amountText, `6${NBSP}400 ₽`);
  assert.equal(state.delayText, 'сегодня');
  assert.equal(state.payoutDateText, payoutText);
  assert.equal(state.count, 3);
  assert.equal(state.label, `6${NBSP}400 ₽ · сегодня`);
  assert.equal(
    state.tooltip,
    [
      'Заявок на вывод: 3',
      'Четверг 3 сентября до 23:00 по МСК',
      `2 сентября, 16:50 — 2${NBSP}800 ₽`,
      `2 сентября, 17:10 — 2${NBSP}800 ₽`,
      `3 сентября, 09:00 — 800 ₽`,
    ].join('\n'),
  );
});
