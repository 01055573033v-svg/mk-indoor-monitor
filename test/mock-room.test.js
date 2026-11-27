// 동글 없이 16명 방 전체를 돌려 보는 시험: 모의 센서가 만든 실제 ANT 바이트 → 덩어리로 자름 → Parser → parseBroadcast → Hub → 화면 값.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Parser } from '../src/ant/message.js';
import { parseBroadcast, sensorKey } from '../src/ant/scan.js';
import { Hub, LEVELS } from '../src/core/hub.js';
import { Settings } from '../src/core/settings.js';
import { zoneOf } from '../src/core/zones.js';
import { MockField, MockDongle } from '../src/transport/mock.js';

const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

function room({ athletes = 16, dongles = [{ name: 'A' }, { name: 'B' }, { name: 'C' }] } = {}) {
  const field = MockField.room(athletes), settings = new Settings(memory()), hub = new Hub(settings);
  settings.setAthletes(athletes);
  field.sensors.forEach((s, i) => { const code = 'P' + String(Math.floor(i / 2) + 1).padStart(2, '0'); settings.assign(sensorKey(s), code, s.deviceType === 120 ? 'hr' : 'power'); });
  const ds = dongles.map((d, i) => ({ dongle: new MockDongle(d.name, { seed: 11 + i, ...d }), parser: new Parser() }));
  let now = 0;
  const run = ms => { const end = now + ms; for (; now < end; now += 50) { const tx = field.step(now); for (const { dongle, parser } of ds) for (const c of dongle.chunks(tx)) for (const msg of parser.push(c)) hub.receive(dongle.name, now, parseBroadcast(msg)); } return hub.snapshot(now); };
  return { field, settings, hub, run, ds, sensor: (code, role) => field.sensors[(Number(code.slice(1)) - 1) * 2 + (role === 'hr' ? 1 : 0)] };
}

test('16명·32센서·동글 3개: 모든 타일이 정상, 파워는 누적값 평균으로 설정값과 같고 겹쳐 받아도 부풀지 않는다', () => {
  const r = room(), view = r.run(5000);
  assert.equal(view.tiles.length, 16);
  assert.ok(view.tiles.every(t => t.level === LEVELS.OK), view.tiles.map(t => t.level).join(','));
  for (const t of view.tiles) {
    const p = r.sensor(t.code, 'power'), h = r.sensor(t.code, 'hr');
    assert.equal(t.power, p.watts, `${t.code} 파워`); assert.equal(t.hr, h.hr, `${t.code} 심박`); assert.equal(t.cadence, p.cadence);
  }
  assert.equal(view.unpaired.length, 0);
  assert.equal(view.dongles.length, 3);
  for (const d of view.dongles) { assert.equal(d.sensors, 32); assert.ok(d.perSecond >= 120 && d.perSecond <= 135, `${d.name} 초당 ${d.perSecond}건(설계안 약 129건)`); assert.ok(d.missing < 0.05); }
});

test('FTP를 넣으면 %FTP와 존(V2 경계)이 나온다; FTP가 없으면 비워 둔다', () => {
  const r = room({ athletes: 2 });
  r.sensor('P01', 'power').watts = 250; r.settings.setFtp('P01', 250);
  const v = r.run(3000), [p1, p2] = v.tiles;
  assert.equal(p1.ftpPercent, 100); assert.equal(p1.zone.key, 'Z4');
  assert.equal(p2.ftpPercent, null); assert.equal(p2.zone, null);
  assert.deepEqual([137, 138, 187, 188, 225, 226, 262, 263, 300, 301].map(w => zoneOf(w, 250).key), ['Z1', 'Z2', 'Z2', 'Z3', 'Z3', 'Z4', 'Z4', 'Z5', 'Z5', 'Z6']);
  assert.throws(() => r.settings.setFtp('홍길동', 250), /P01/); assert.throws(() => r.settings.setFtp('P01', 5000), /50~600/);
});

test('센서가 끊기면 주의(1초)→끊김(3초)→오프라인(10초), 경보는 끊김 순간 1번, 5초 안 재알림 없음, 돌아오면 정상', () => {
  const r = room({ athletes: 2 });
  r.run(3000);
  const s = r.sensor('P02', 'power'); s.silent = true;
  const seen = [];
  let alerts = 0;
  for (let i = 0; i < 24; i++) { const v = r.run(500); const t = v.tiles[1]; seen.push(t.level); alerts += v.alerts.filter(a => a.code === 'P02').length; }
  assert.ok(seen.includes(LEVELS.LATE) && seen.includes(LEVELS.LOST) && seen.at(-1) === LEVELS.OFFLINE, seen.join(','));
  assert.equal(alerts, 1, '끊김→오프라인은 다시 울리지 않음');
  s.silent = false; const back = r.run(1000);
  assert.equal(back.tiles[1].level, LEVELS.OK); assert.equal(back.tiles[0].level, LEVELS.OK, '다른 선수는 영향 없음');
  // 5초 안에 다시 끊겨도 경보는 조용하다.
  s.silent = true; let again = 0; for (let i = 0; i < 8; i++) again += r.run(500).alerts.length;
  assert.equal(again, 1, '앞 경보에서 5초가 지났으면 1번');
});

test('주 동글이 못 들으면 다른 동글 값을 이어받고 「경유」를 표시한다; 세 동글 다 못 들으면 끊김', () => {
  const r = room({ athletes: 2, dongles: [{ name: 'A' }, { name: 'B' }] });
  r.run(2000);
  r.ds[0].dongle.hears = () => false;   // P01·P02 의 주 동글 A 가 아무것도 못 들음
  const v = r.run(4000);
  assert.equal(v.tiles[0].level, LEVELS.OK); assert.equal(v.tiles[0].via, 'B');
  assert.equal(v.tiles[0].power, r.sensor('P01', 'power').watts);
  r.ds[1].dongle.hears = () => false;
  assert.equal(r.run(4000).tiles[0].level, LEVELS.LOST);
});

test('빠짐 10%인 동글은 빠진 비율을 보여 주고, 다른 동글이 채워 화면 값은 그대로다', () => {
  const r = room({ athletes: 4, dongles: [{ name: 'A', drop: 0.1 }, { name: 'B' }] }), v = r.run(10000);
  const a = v.dongles.find(d => d.name === 'A');
  assert.ok(a.missing > 0.05 && a.missing < 0.15, `빠짐 ${a.missing}`);
  assert.ok(v.tiles.every(t => t.level === LEVELS.OK && t.power === r.sensor(t.code, 'power').watts));
});

test('페달을 멈추면 3초 뒤 0W; 짝 없는 센서는 따로 모아 보여 준다(기기 번호는 뒤 2자리만)', () => {
  const r = room({ athletes: 2 });
  r.run(2000); r.sensor('P01', 'power').cadence = 0;
  assert.equal(r.run(4000).tiles[0].power, 0);
  r.settings.unassign(sensorKey(r.sensor('P02', 'hr')));
  const v = r.run(1000);
  assert.equal(v.unpaired.length, 1); assert.equal(v.unpaired[0].type, '심박'); assert.match(v.unpaired[0].tail, /^\d{2}$/);
  assert.equal(v.tiles[1].hr, null);
});

test('설정 저장: 코드·FTP·센서 짝만 남고, 형식이 틀린 값(실명 등)은 읽을 때 버린다', () => {
  const store = memory();
  store.setItem('mk-indoor-monitor.settings.v1', JSON.stringify({ version: 1, athletes: 16, ftp: { P01: 250, 홍길동: 200 }, sensors: { '11:10000': { code: 'P01', role: 'power' }, '11:1': { code: '김선수', role: 'power' } } }));
  const s = new Settings(store);
  assert.deepEqual(s.data.ftp, { P01: 250 }); assert.deepEqual(Object.keys(s.data.sensors), ['11:10000']);
  s.assign('11:20000', 'P01', 'power');
  assert.deepEqual(s.sensorsOf('P01'), [{ key: '11:20000', role: 'power' }], '같은 종류 새 센서를 지정하면 앞의 것은 뗀다');
  assert.equal(new Settings(store).sensorsOf('P01')[0].key, '11:20000');
  assert.deepEqual([s.primaryDongle('P01'), s.primaryDongle('P07'), s.primaryDongle('P16')], ['A', 'B', 'C']);
});
