// 3단계: 구간 전환 안내 · 목표 이탈 알림 골격 — 가상 시계로 세션을 흘리며 언제 무엇이 나오는지 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cues, CUE } from '../src/core/cues.js';
import { SessionRun, compare, targetWatts } from '../src/core/session.js';
import { Room } from '../src/core/room.js';
import { Settings } from '../src/core/settings.js';

const plan = { id: 't', name: '시험', steps: [{ label: 'W-up', sec: 30, lo: 50, hi: 60 }, { label: 'VO2', sec: 60, lo: 106, hi: 120 }, { label: '쿨다운', sec: 30, lo: null, hi: null }] };
const sess = (run, now) => [{ id: 1, group: '고E', pos: run.at(now) }];

test('다음 구간 10초 전 1번, 구간이 바뀐 순간 1번(세션 그룹·구간 번호·%FTP)', () => {
  const run = new SessionRun(plan, { group: '고E' }).start(0), cues = new Cues(), got = [];
  for (let s = 0; s <= 120; s++) got.push(...cues.step(s * 1000, sess(run, s * 1000), []).map(e => `${s}:${e.kind}:${e.text}`));
  assert.deepEqual(got, [
    '20:soon:고E · 10초 뒤 VO2 106~120%FTP',
    '30:change:고E · 지금 2구간 VO2 106~120%FTP',
    '80:soon:고E · 10초 뒤 쿨다운 자유',
    '90:change:고E · 지금 3구간 쿨다운 자유',
  ]);
});

test('일시정지 중에는 안내하지 않는다(풀면 그때 알림)', () => {
  const run = new SessionRun(plan, { group: '고E' }).start(0), cues = new Cues(), got = [];
  for (let s = 0; s <= 40; s++) { if (s === 15) run.pause(15000); if (s === 35) run.resume(35000); got.push(...cues.step(s * 1000, sess(run, s * 1000), []).map(e => `${s}:${e.kind}`)); }
  assert.deepEqual(got, ['40:soon']);   // 일시정지 20초 → 10초 전 안내가 40초로 밀림
});

test(`목표 밖 ${CUE.offSec}초째에 1번, 계속 밖이면 ${CUE.offRepeatSec}초마다, 안으로 들어오면 새로 센다`, () => {
  const cues = new Cues(), run = new SessionRun({ ...plan, steps: [{ label: '템포', sec: 600, lo: 76, hi: 90 }] }).start(0), target = targetWatts(run.plan.steps[0], 200);
  const at = (s, w) => cues.step(s * 1000, sess(run, s * 1000), [{ code: 'P03', sessionId: 1, cmp: compare(w, target) }]).filter(e => e.kind === 'off').map(e => `${s}:${e.text}`);
  const got = [];
  for (let s = 0; s <= 100; s++) got.push(...at(s, s < 90 ? 120 : 160));   // 0~89초 낮음(120W < 152W), 90초부터 범위 안
  assert.deepEqual(got, ['15:P03 목표보다 낮음 15초', '75:P03 목표보다 낮음 75초']);
  assert.equal(cues.alerting().size, 0, '안으로 들어오면 표시도 풀림');
  const got2 = []; for (let s = 101; s <= 130; s++) got2.push(...at(s, 200));   // 높음(200W > 180W)
  assert.deepEqual(got2, ['116:P03 목표보다 높음 15초']);
  assert.ok(cues.alerting().has('P03'));
});

test('이탈은 쪽이 바뀌거나 구간이 바뀌면 처음부터, 판정 없음(FTP 없음·자유 구간)은 세지 않는다', () => {
  const cues = new Cues(), run = new SessionRun(plan).start(0);
  const low = { state: 'low', diff: -30 }, high = { state: 'high', diff: 30 };
  const go = (s, cmp) => cues.step(s * 1000, sess(run, s * 1000), [{ code: 'P01', sessionId: 1, cmp }]).filter(e => e.kind === 'off');
  for (let s = 0; s < 10; s++) go(s, low);
  for (let s = 10; s < 24; s++) assert.equal(go(s, high).length, 0, '낮음 → 높음: 처음부터');
  for (let s = 24; s < 30; s++) go(s, high);
  assert.equal(go(30, high).length, 0, '30초 구간 전환: 처음부터');
  for (let s = 31; s < 60; s++) go(s, null);
  assert.equal(cues.alerting().size, 0);
});

test('Room 과 같이: 그룹별 세션 두 개는 따로 안내하고, 끝난 세션은 잊는다', () => {
  const st = new Settings((() => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; })());
  st.setAthletes(4); st.setGroup('P01', '고E'); st.setGroup('P02', '중E');
  const room = new Room(st), a = room.start(plan, '고E', 0, { wallStart: 0 }), b = room.start(plan, '중E', 10000, { wallStart: 0 }), cues = new Cues(), kinds = [];
  for (let s = 0; s <= 45; s++) kinds.push(...cues.step(s * 1000, room.entries.map(e => ({ id: e.id, group: e.run.group, pos: e.run.at(s * 1000) })), []).map(e => `${s}:${e.sessionId}:${e.kind}`));
  assert.deepEqual(kinds, [`20:${a.id}:soon`, `30:${a.id}:change`, `30:${b.id}:soon`, `40:${b.id}:change`]);
  room.finish(a.id, 46000); cues.step(46000, room.entries.map(e => ({ id: e.id, group: e.run.group, pos: e.run.at(46000) })), []);
  assert.equal(cues.sessions.has(a.id), false);
});
