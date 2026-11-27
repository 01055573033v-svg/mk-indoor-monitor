// 3단계: 자동 재연결 — 실물 동글 없이 가짜 전송·가짜 시계로 끊김 → 1·2·4초 재시도 → 다시 연결, 다시 꽂기, 포기, 멈춤을 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DongleLink, matchReplug, BACKOFF_MS, MAX_TRIES } from '../src/transport/reconnect.js';
import { WebUsbTransport } from '../src/transport/webusb.js';

/** 가짜 시계 + 예약: run(ms) 로 시간을 흘리면 때가 된 예약을 부른다. */
function clock() {
  let t = 0, jobs = [];
  return { now: () => t, schedule: (fn, ms) => { const j = { at: t + ms, fn }; jobs.push(j); return j; }, cancel: j => { jobs = jobs.filter(x => x !== j); },
    async run(ms) { const end = t + ms; for (;;) { const due = jobs.filter(j => j.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; jobs = jobs.filter(j => j !== due); t = due.at; due.fn(); await flush(); } t = end; },
    pending: () => jobs.length };
}
const flush = () => new Promise(r => setImmediate(r));
/** 가짜 전송: plan 배열 순서대로 열기 성공(true)/실패(문자열). 열린 전송은 drop() 으로 끊을 수 있다. */
function transports(plan) {
  const made = [];
  const make = device => { const i = made.length, outcome = plan[i] ?? true;
    const t = { device, stopped: false, diag: { devices: new Set() }, async start({ onClose }) { t.onClose = onClose; if (outcome !== true) throw new Error(outcome); }, async stop() { t.stopped = true; }, drop(reason = '읽기 실패') { t.onClose(reason); } };
    made.push(t); return t; };
  return { make, made };
}
const link = (plan, extra = {}) => { const c = clock(), tr = transports(plan), changes = [];
  const l = new DongleLink({ name: 'A', device: { serialNumber: 'S1', vendorId: 0x0fcf, productId: 0x1008 }, makeTransport: tr.make, onPacket: () => {}, onChange: x => changes.push(x.state), schedule: c.schedule, cancel: c.cancel, now: c.now, ...extra });
  return { l, c, tr, changes }; };

test('처음 열기 실패는 재시도하지 않고 오류를 던진다(키·다른 프로그램은 연결 진단에서)', async () => {
  const { l, c } = link(['동글을 다른 프로그램이 쓰고 있을 수 있습니다']);
  await assert.rejects(l.connect(), /다른 프로그램/);
  assert.equal(l.state, 'failed'); assert.equal(c.pending(), 0);
});

test('끊기면 1·2·4초 간격으로 다시 열고, 성공하면 「스캔 중」·다시 연결 1회·끊긴 시간', async () => {
  const { l, c, tr } = link([true, '열기 실패', '열기 실패', true]);
  await l.connect(); assert.equal(l.state, 'up');
  tr.made[0].drop();
  assert.equal(l.state, 'retrying'); assert.equal(l.view().label, '다시 연결 중 (1번째 · 1초 뒤)');
  await c.run(BACKOFF_MS[0]); assert.equal(tr.made.length, 2); assert.equal(l.view().label, '다시 연결 중 (2번째 · 2초 뒤)');
  await c.run(BACKOFF_MS[1]); assert.equal(tr.made.length, 3); assert.equal(l.tries, 3);
  await c.run(BACKOFF_MS[2]); assert.equal(tr.made.length, 4);
  assert.equal(l.state, 'up'); assert.equal(l.view().label, '스캔 중'); assert.equal(l.reconnects, 1); assert.equal(l.tries, 0);
  assert.equal(l.downMs, 7000); assert.equal(l.view().downFor, null);
  assert.ok(tr.made[1].stopped && tr.made[2].stopped, '실패한 시도의 전송은 닫는다');
});

test('끊김 알림이 두 번 와도(읽기 실패 + USB 빠짐) 재시도 예약은 하나, 옛 전송의 늦은 알림은 무시', async () => {
  const { l, c, tr } = link([true, true]);
  await l.connect(); tr.made[0].drop(); l.unplugged();
  assert.equal(c.pending(), 1);
  await c.run(1000); assert.equal(l.state, 'up');
  tr.made[0].drop('늦은 알림'); assert.equal(l.state, 'up', '옛 전송 알림은 무시');
});

test('다시 꽂기(크롬이 새 장치로 알림): 기다리지 않고 바로 새 장치로 연다', async () => {
  const { l, c, tr } = link([true, true]);
  await l.connect(); tr.made[0].drop(); assert.equal(l.state, 'retrying');
  const fresh = { serialNumber: 'S1', vendorId: 0x0fcf, productId: 0x1008 };
  assert.equal(matchReplug([l], fresh), l);
  assert.equal(l.replug(fresh), true); await flush();
  assert.equal(l.state, 'up'); assert.equal(tr.made[1].device, fresh); assert.equal(c.pending(), 0, '예약된 재시도는 취소');
  assert.equal(l.replug(fresh), false, '연결돼 있으면 무시');
});

test('다시 꽂기 짝 찾기: 일련번호가 같으면 그것, 없으면 같은 기종의 끊긴 링크가 하나뿐일 때만', () => {
  const mk = (sn, pid, state) => ({ state, device: { serialNumber: sn, vendorId: 0x0fcf, productId: pid } });
  const a = mk('S1', 0x1008, 'retrying'), b = mk('S2', 0x1008, 'retrying'), c = mk(null, 0x1009, 'failed'), up = mk('S3', 0x1008, 'up');
  assert.equal(matchReplug([a, b, c, up], { serialNumber: 'S2', vendorId: 0x0fcf, productId: 0x1008 }), b);
  assert.equal(matchReplug([a, b, up], { serialNumber: '', vendorId: 0x0fcf, productId: 0x1008 }), null, '같은 기종이 둘이면 고르지 않는다');
  assert.equal(matchReplug([a, c, up], { serialNumber: '', vendorId: 0x0fcf, productId: 0x1009 }), c);
  assert.equal(matchReplug([up], { serialNumber: 'S3', vendorId: 0x0fcf, productId: 0x1008 }), null, '연결된 동글은 대상이 아니다');
});

test(`${MAX_TRIES}번 연속 실패하면 「다시 연결 못 함」으로 멈추고, 다시 꽂으면 다시 시작`, async () => {
  const { l, c, tr } = link([true, ...Array(MAX_TRIES).fill('없음'), true]);
  await l.connect(); tr.made[0].drop();
  await c.run(10 * 60 * 1000);
  assert.equal(l.state, 'failed'); assert.equal(tr.made.length, 1 + MAX_TRIES); assert.equal(c.pending(), 0);
  l.replug({ serialNumber: 'S1', vendorId: 0x0fcf, productId: 0x1008 }); await flush();
  assert.equal(l.state, 'up'); assert.equal(l.reconnects, 1);
});

test('멈춤(stop)은 예약을 지우고 다시 열지 않는다', async () => {
  const { l, c, tr } = link([true, true]);
  await l.connect(); tr.made[0].drop(); await l.stop();
  await c.run(30000); assert.equal(tr.made.length, 1); assert.equal(l.state, 'stopped');
});

test('WebUSB 전송: 읽기 실패 시 onClose 를 한 번 부르고, 우리가 stop 한 경우는 부르지 않는다', async () => {
  const mkDevice = () => { let fail = false; const d = { opened: false, configuration: null, fail: () => { fail = true; },
    async open() { d.opened = true; }, async selectConfiguration() { d.configuration = { interfaces: [{ interfaceNumber: 0, alternate: { endpoints: [{ direction: 'in', type: 'bulk', endpointNumber: 1, packetSize: 64 }, { direction: 'out', type: 'bulk', endpointNumber: 1, packetSize: 64 }] } }] }; },
    async claimInterface() {}, async close() {}, async transferOut() {},
    async transferIn() { await new Promise(r => setTimeout(r, 2)); if (fail) throw new Error('The device was disconnected.'); return { status: 'ok', data: null }; } }; return d; };
  // 스캔 준비 응답이 없어 start 는 reset 뒤 단계에서 실패하므로, 읽기 고리만 따로 돌린다.
  const d = mkDevice(), t = new WebUsbTransport(d, { name: 'A', networkKey: [1, 2, 3, 4, 5, 6, 7, 8] }), closes = [];
  t.onStatus = () => {}; t.onClose = r => closes.push(r); t.ep = { input: 1, output: 1, packetSize: 64 }; t.running = true;
  t.readLoop(); d.fail(); await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(closes, ['The device was disconnected.']);
  t.lost('또'); assert.equal(closes.length, 1, '한 번만');
  const d2 = mkDevice(), t2 = new WebUsbTransport(d2, { name: 'B', networkKey: [1, 2, 3, 4, 5, 6, 7, 8] }), closes2 = [];
  t2.onStatus = () => {}; t2.onClose = r => closes2.push(r); t2.ep = { input: 1, output: 1, packetSize: 64 }; t2.running = true;
  t2.readLoop(); await t2.stop(); d2.fail(); await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(closes2, [], '우리가 멈춘 것은 끊김이 아니다');
});
