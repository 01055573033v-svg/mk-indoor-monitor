// 3단계 준비: 실물 동글 없이, ANT 명령에 답하는 가짜 USB 동글로 연결 진단(선테스트 1~4)을 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebUsbTransport } from '../src/transport/webusb.js';
import { encode, MSG } from '../src/ant/message.js';
import { MockField, broadcastFrame } from '../src/transport/mock.js';
import { preChecks, dongleRows, verdict, EXT_FAIL_AFTER } from '../src/core/diagnose.js';

const KEY = [1, 2, 3, 4, 5, 6, 7, 8];   // 시험용 가짜 키(실제 ANT+ 키 아님)
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 가짜 동글: 명령마다 채널 응답(코드 0)을, 리셋엔 시작 메시지를 돌려주고, 스캔이 열리면 센서 방송을 흘린다. */
class FakeDongle {
  constructor({ claimError = null, rejectFirst = [], extended = true, athletes = 2 } = {}) {
    Object.assign(this, { claimError, rejectFirst: new Set(rejectFirst), extended });
    this.opened = false; this.configuration = null; this.queue = []; this.scanning = false; this.field = MockField.room(athletes); this.t = 0;
  }
  async open() { this.opened = true; }
  async selectConfiguration() {
    this.configuration = { interfaces: [{ interfaceNumber: 0, alternate: { endpoints: [
      { direction: 'in', type: 'bulk', endpointNumber: 1, packetSize: 64 }, { direction: 'out', type: 'bulk', endpointNumber: 1, packetSize: 64 }] } }] };
  }
  async claimInterface() { if (this.claimError) throw new Error(this.claimError); }
  async close() { this.opened = false; }
  async transferOut(_ep, bytes) {
    const id = bytes[2];
    if (id === MSG.RESET) { this.queue.push(encode(MSG.STARTUP, [0])); return; }
    const reject = this.rejectFirst.has(id); this.rejectFirst.delete(id);
    this.queue.push(encode(MSG.CHANNEL_EVENT, [0, id, reject ? 0x28 : 0]));
    if (id === MSG.OPEN_RX_SCAN && !reject) this.scanning = true;
  }
  async transferIn() {
    await sleep(1);
    let chunk = this.queue.shift();
    if (!chunk && this.scanning) {
      this.t += 250;
      const frames = this.field.step(this.t).map(tx => this.extended ? broadcastFrame(tx.sensor, tx.payload) : encode(MSG.BROADCAST, [0, ...tx.payload]));
      chunk = Uint8Array.from(frames.flatMap(f => [...f]));
    }
    if (!chunk || !chunk.length) return { status: 'ok', data: null };
    return { status: 'ok', data: new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength) };
  }
}
const run = async (opts, wait = 60) => {
  const t = new WebUsbTransport(new FakeDongle(opts), { name: 'A', networkKey: KEY });
  let error = null; const packets = [];
  try { await t.start({ onPacket: (_at, b) => packets.push(b) }); await sleep(wait); } catch (e) { error = e; }
  await t.stop();
  return { t, error, packets, rows: dongleRows(t.diag) };
};

test('꽂기 전 점검: 크롬·보안 주소·키(값은 안 보임)·허용된 동글', () => {
  const ok = preChecks({ usb: true, secure: true, key: true, known: 2 });
  assert.deepEqual(ok.map(r => r.state), ['ok', 'ok', 'ok', 'ok']);
  assert.equal(ok[2].detail, '입력됨(값은 표시 안 함)');
  const bad = preChecks({ usb: false, secure: true, key: false, known: 0 });
  assert.deepEqual(bad.map(r => r.state), ['fail', 'ok', 'fail', 'wait']);
  assert.match(bad[2].hint, /코치가 직접/);
  assert.equal(verdict(ok, []).state, 'wait');
});

test('선테스트 1~4 모두 통과: 단계별 ✓, 첫 방송·확장 메시지·센서 종류별 수, 판정 통과', async () => {
  const { error, rows, t, packets } = await run({ athletes: 2 });
  assert.equal(error, null);
  assert.ok(packets.length > 0);
  assert.deepEqual(t.diag.steps.map(s => s.name), ['open', 'endpoints', 'claim', 'reset', 'networkKey', 'assign', 'channelId', 'rfFreq', 'libConfig', 'openScan']);
  assert.ok(rows.every(r => r.state === 'ok'), JSON.stringify(rows.filter(r => r.state !== 'ok')));
  const sensors = rows.find(r => r.label === '들리는 센서');
  assert.match(sensors.detail, /^4개 \(/); assert.match(sensors.detail, /파워 \d/); assert.match(sensors.detail, /심박 2/);
  assert.equal(verdict(preChecks({ usb: true, secure: true, key: true, known: 1 }), [{ name: 'A', rows, sensors: t.diag.devices.size }]).text, '통과 — 동글 1개 · 센서 4개');
  assert.ok(!JSON.stringify(rows).includes('1,2,3,4'), '키 값이 진단에 나오지 않는다');
});

test('확장 정보를 거절하면 줄인 설정(기기 번호만)으로 다시 시도하고, 그 사실을 적는다', async () => {
  const { error, t } = await run({ rejectFirst: [MSG.LIB_CONFIG] });
  assert.equal(error, null);
  const lib = t.diag.steps.find(s => s.name === 'libConfig');
  assert.equal(lib.ok, true); assert.match(lib.note, /줄인 설정/);
});

test('다른 프로그램이 동글을 잡고 있으면: 막힌 단계와 할 일(ANT 프로그램 끄기)을 보인다', async () => {
  const { error, rows } = await run({ claimError: 'Unable to claim interface.' });
  assert.match(error.message, /다른 프로그램/);
  assert.equal(rows.find(r => r.label.startsWith('동글 잡기')).state, 'fail');
  assert.match(rows.at(-1).detail, /Zwift·Garmin Express/);
  assert.equal(verdict([], [{ name: 'A', rows, sensors: 0 }]).text, '막힘: 동글 잡기(다른 프로그램이 안 씀)');
});

test(`확장 메시지가 없으면(누가 보냈는지 모름) ${EXT_FAIL_AFTER}건 뒤 선테스트 4 실패로 판정`, async () => {
  const { rows, t } = await run({ extended: false, athletes: 4 }, 120);
  assert.ok(t.diag.packets >= EXT_FAIL_AFTER, `${t.diag.packets}건`);
  const ext = rows.find(r => r.label.startsWith('선테스트 4 · 누가'));
  assert.equal(ext.state, 'fail'); assert.match(ext.hint, /브리지/);
});
