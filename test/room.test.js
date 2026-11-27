// 3단계 시험: 그룹별 독립 세션(시작·일시정지·끝 시각이 달라도 각각 기록) · 선수 먼저 끝내기·다시 넣기·빼기·합류.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/core/room.js';
import { checkPlan } from '../src/core/session.js';
import { Settings } from '../src/core/settings.js';

const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const plan = (name, min) => checkPlan({ name, steps: [{ label: 'A', sec: min * 60, lo: 50, hi: 60 }] });
function setup() {
  const s = new Settings(memory()); s.setAthletes(6);
  ['고E', '고E', '고S', '고S', '중E', '중S'].forEach((g, i) => { const c = `P0${i + 1}`; s.setGroup(c, g); s.setFtp(c, 200); });
  return { s, room: new Room(s) };
}
const tiles = (s, w = 110) => s.codes().map(code => ({ code, power: w, hr: 140, cadence: 90 }));
const run = (room, s, from, to) => { const out = []; for (let t = from; t < to; t += 1000) out.push(...room.tick(t + 1, tiles(s))); return out; };

test('그룹별 세션 3개가 다른 시각에 시작·끝나고 기록이 따로 남는다', () => {
  const { s, room } = setup();
  const hE = room.start(plan('고E SST', 2), '고E', 0);
  run(room, s, 0, 30_000);
  const hS = room.start(plan('고S 스프린트', 1), '고S', 30_000);
  const mid = room.start(plan('중등 CAD', 3), '중E,중S', 45_000);
  assert.equal(room.entries.length, 3);
  assert.throws(() => room.start(plan('x', 1), '고E', 46_000), /고E 그룹은/);
  assert.throws(() => room.start(plan('x', 1), null, 46_000), /전체 세션은/);
  assert.equal(room.active('P01'), hE); assert.equal(room.active('P03'), hS); assert.equal(room.active('P06'), mid);
  const done = run(room, s, 30_000, 240_000);
  assert.deepEqual(done.map(d => d.plan.name), ['고S 스프린트', '고E SST', '중등 CAD']);   // 끝나는 순서 = 시작+길이 순(90s, 120s, 225s)
  const [sS, sE, sM] = done;
  assert.deepEqual(sS.athletes.map(a => a.code), ['P03', 'P04']); assert.equal(sS.seconds, 60); assert.equal(sS.group, '고S');
  assert.deepEqual(sE.athletes.map(a => a.code), ['P01', 'P02']); assert.equal(sE.athletes[0].fromSec, 0); assert.equal(sE.athletes[0].toSec, 120);
  assert.deepEqual(sM.athletes.map(a => a.code), ['P05', 'P06']); assert.equal(sM.group, '중E·중S');
  assert.ok(done.every(d => d.complete)); assert.equal(room.entries.length, 0);
});

test('일시정지는 그 그룹만 멈춘다', () => {
  const { s, room } = setup();
  const a = room.start(plan('A', 2), '고E', 0), b = room.start(plan('B', 2), '고S', 0);
  run(room, s, 0, 10_000); a.run.pause(10_000); run(room, s, 10_000, 40_000); a.run.resume(40_000); run(room, s, 40_000, 50_000);
  assert.equal(Math.round(a.run.elapsed(50_000)), 20); assert.equal(Math.round(b.run.elapsed(50_000)), 50);
  assert.equal(a.recorder.rows.get('P01').length, 20); assert.equal(b.recorder.rows.get('P03').length, 50);
});

test('선수 먼저 끝내기 → 기록 멈춤·「먼저 끝냄」, 다시 넣기 → 이어서, 빼기 → 그 세션 기록 지움', () => {
  const { s, room } = setup();
  const e = room.start(plan('고E', 2), '고E', 0);
  run(room, s, 0, 30_000);
  room.endAthlete('P01', 30_000);
  assert.equal(room.active('P01'), null); assert.equal(room.place('P01').state, 'ended');
  run(room, s, 30_000, 60_000);
  room.resumeAthlete('P01'); run(room, s, 60_000, 70_000);
  room.endAthlete('P01', 70_000);
  room.removeAthlete('P02'); assert.equal(room.place('P02').entry, null);
  const [sum] = run(room, s, 70_000, 130_000);
  assert.deepEqual(sum.athletes.map(a => [a.code, a.status]), [['P01', '먼저 끝냄']]);
  assert.equal(e.recorder.rows.get('P01').length, 40);   // 0~30 + 60~70
  assert.throws(() => room.endAthlete('P01', 1), /진행 중인 세션이 없습니다/);
});

test('다른 세션 합류: 원래 세션은 「먼저 끝냄」으로 남고 새 세션은 「중간 합류」로 적힌다. 그룹 없는 선수도 합류 가능', () => {
  const { s, room } = setup(); s.setGroup('P06', '');
  const hE = room.start(plan('고E', 2), '고E', 0), hS = room.start(plan('고S', 2), '고S', 0);
  assert.equal(room.place('P06').entry, null);
  run(room, s, 0, 20_000);
  room.join('P02', hS.id, 20_000); room.join('P06', hE.id, 20_000);
  assert.equal(room.active('P02'), hS); assert.equal(room.active('P06'), hE);
  const done = run(room, s, 20_000, 130_000);
  const byName = Object.fromEntries(done.map(d => [d.plan.name, Object.fromEntries(d.athletes.map(a => [a.code, a]))]));
  assert.equal(byName['고E'].P02.status, '먼저 끝냄'); assert.equal(byName['고E'].P02.toSec, 20);
  assert.equal(byName['고S'].P02.status, '중간 합류'); assert.equal(byName['고S'].P02.fromSec, 20);
  assert.equal(byName['고E'].P06.status, '중간 합류'); assert.equal(byName['고E'].P01.status, '함께');
});

test('세션 하나만 먼저 끝내기(끝내기 버튼): 다른 세션은 그대로', () => {
  const { s, room } = setup();
  const a = room.start(plan('A', 2), '고E', 0); room.start(plan('B', 2), '고S', 0);
  run(room, s, 0, 10_000);
  const sum = room.finish(a.id, 10_000);
  assert.equal(sum.complete, false); assert.equal(sum.seconds, 10); assert.equal(room.entries.length, 1); assert.equal(room.active('P01'), null);
  assert.equal(room.active('P03').run.plan.name, 'B');
});
