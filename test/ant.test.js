import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, Parser, checksum, MSG, SYNC } from '../src/ant/message.js';
import { scanSetup, parseBroadcast, parseNetworkKey, channelResponse, DEVICE } from '../src/ant/scan.js';
import { decode } from '../src/ant/profiles.js';
import { MockSensor, broadcastFrame } from '../src/transport/mock.js';

test('메시지: 동기·길이·ID·체크섬(XOR) 꼴로 만들고 그대로 읽는다', () => {
  const m = encode(MSG.RESET, [0]);
  assert.deepEqual([...m], [SYNC, 1, 0x4a, 0, SYNC ^ 1 ^ 0x4a ^ 0]);
  assert.equal(checksum(m), 0, '체크섬까지 XOR하면 0');
  assert.deepEqual(new Parser().push(m).map(x => [x.id, [...x.data]]), [[0x4a, [0]]]);
});

test('메시지: USB 덩어리가 메시지 중간에서 잘려도 이어 붙이고, 깨진 바이트는 건너뛴다', () => {
  const a = encode(MSG.BROADCAST, [0, 1, 2, 3, 4, 5, 6, 7, 8]), b = encode(MSG.CHANNEL_EVENT, [0, 0x5b, 0]);
  const bad = Uint8Array.from([SYNC, 3, 0x40, 0, 0, 0, 0x99]);   // 체크섬 틀림
  const all = Uint8Array.from([0x00, 0x11, ...a, ...bad, ...b]), p = new Parser(), got = [];
  for (let i = 0; i < all.length; i += 5) got.push(...p.push(all.subarray(i, i + 5)));
  assert.deepEqual(got.map(x => x.id), [MSG.BROADCAST, MSG.CHANNEL_EVENT]);
  assert.ok(p.bad >= 1);
});

test('스캔 준비: 리셋→네트워크 키→채널 배정→와일드카드 ID→2457MHz→확장 정보→Open Rx Scan(0x5B)', () => {
  const key = parseNetworkKey('01 02 03 04 05 06 07 08');
  assert.deepEqual(key, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(parseNetworkKey('짧음'), null);
  const steps = scanSetup(key);
  assert.deepEqual(steps.map(s => s.name), ['reset', 'networkKey', 'assign', 'channelId', 'rfFreq', 'libConfig', 'openScan']);
  assert.deepEqual([...steps.at(-1).bytes.subarray(2, 4)], [0x5b, 0]);
  assert.deepEqual([...steps[3].bytes.subarray(3, 8)], [0, 0, 0, 0, 0], '기기 번호·종류·전송 형식 전부 와일드카드');
  assert.equal(steps[4].bytes[4], 57);
  assert.throws(() => scanSetup(null), /네트워크 키/);
  assert.deepEqual(channelResponse({ id: 0x40, data: Uint8Array.from([0, 0x5b, 0]) }), { channel: 0, to: 0x5b, code: 0 });
});

test('확장 방송: 기기 번호(20비트)·종류(짝짓기 비트 뗌)·RSSI를 읽고, 확장이 없으면 누군지 모름으로 표시', () => {
  const s = new MockSensor({ deviceType: DEVICE.POWER, deviceNumber: 0x1abcd });
  const [msg] = new Parser().push(broadcastFrame(s, [0x10, 1, 0xff, 90, 200, 0, 200, 0], -55));
  const b = parseBroadcast(msg);
  assert.equal(b.deviceNumber, 0x1abcd); assert.equal(b.deviceType, 11); assert.equal(b.rssi, -55); assert.equal(b.extended, true);
  const [plain] = new Parser().push(encode(MSG.BROADCAST, [0, 1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(parseBroadcast(plain).extended, false);
  const paired = Uint8Array.from(msg.data); paired[12] |= 0x80;
  assert.equal(parseBroadcast({ id: msg.id, data: paired }).deviceType, 11);
});

test('프로파일: 파워 0x10 · FE-C 0x19(12비트 파워) · 심박 · 케이던스 · 배터리 0x52', () => {
  assert.deepEqual(decode(DEVICE.POWER, [0x10, 7, 0xff, 92, 0x10, 0x27, 0x2c, 0x01]), { kind: 'power', events: 7, accPower: 10000, power: 300, cadence: 92 });
  assert.equal(decode(DEVICE.POWER, [0x10, 7, 0xff, 0xff, 0, 0, 0, 0]).cadence, null);
  assert.deepEqual(decode(DEVICE.FEC, [0x19, 3, 88, 0x10, 0x27, 0x2c, 0x31, 0]), { kind: 'power', events: 3, accPower: 10000, power: 300, cadence: 88 });
  assert.equal(decode(DEVICE.FEC, [0x19, 3, 88, 0, 0, 0xff, 0x0f, 0]).power, null, '0xFFF = 값 없음');
  assert.equal(decode(DEVICE.FEC, [0x10, 0, 0, 0, 0, 0, 0, 0]), null, '다른 FE-C 페이지는 1단계에서 무시');
  assert.equal(decode(DEVICE.HR, [0x84, 1, 0, 0, 0, 4, 9, 152]).hr, 152);
  assert.equal(decode(DEVICE.HR, [0x07, 80, 0, 0, 0, 4, 9, 152]).battery, '80%');
  assert.deepEqual(decode(DEVICE.CADENCE, [0, 0, 0, 0, 0x00, 0x04, 5, 0]), { kind: 'cadence', time: 1024, revs: 5 });
  assert.deepEqual(decode(DEVICE.POWER, [0x52, 0, 0, 0, 0, 0, 0, 0x30]), { kind: 'battery', battery: '보통' });
});
