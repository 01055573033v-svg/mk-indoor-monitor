// 2단계 시험: 세션 시계 · 목표 비교 · 기록 요약·저장 · 명단 파일 · 모의 방에서 목표 따라가기(실제 ANT 바이트 길 전체).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TEAM_SESSIONS } from '../src/core/team-sessions.js';
import { PRESETS, checkPlan, totalSec, targetWatts, compare, SessionRun, mmss } from '../src/core/session.js';
import { Recorder, loadHistory, saveToHistory, removeFromHistory, toCsv, HISTORY_MAX } from '../src/core/record.js';
import { parseRoster, applyRoster, exportRoster } from '../src/core/roster.js';
import { Settings } from '../src/core/settings.js';
import { Hub, LEVELS } from '../src/core/hub.js';
import { Parser } from '../src/ant/message.js';
import { parseBroadcast, sensorKey } from '../src/ant/scan.js';
import { MockField, MockDongle, MockRider } from '../src/transport/mock.js';

const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };
const plan = checkPlan({ name: '시험', steps: [{ label: 'W-up', sec: 60, lo: 50, hi: 60 }, { label: '자유', sec: 30 }, { label: 'VO2', sec: 60, lo: 106, hi: 120 }] });

test('세션 시계: 구간 이동 · 남은 시간 · 일시정지 · 끝', () => {
  const run = new SessionRun(plan).start(1000);
  assert.equal(run.total, 150);
  let p = run.at(1000 + 30_000); assert.equal(p.index, 0); assert.equal(p.stepRemaining, 30); assert.equal(p.next.label, '자유');
  p = run.at(1000 + 75_000); assert.equal(p.index, 1); assert.equal(p.step.lo, null);
  run.pause(1000 + 75_000); p = run.at(1000 + 200_000); assert.equal(p.elapsed, 75); assert.ok(p.paused);
  run.resume(1000 + 200_000); p = run.at(1000 + 210_000); assert.equal(p.elapsed, 85);
  p = run.at(1000 + 500_000); assert.ok(p.done); assert.equal(p.index, 2); assert.equal(p.elapsed, 150);
  assert.equal(mmss(75), '1:15'); assert.equal(mmss(3600), '60:00');
});

test('목표 와트·비교: FTP×%(내림), 경계 포함, 자유 구간·FTP 없음은 목표 없음', () => {
  assert.deepEqual(targetWatts(plan.steps[0], 250), { low: 125, high: 150 });
  assert.deepEqual(targetWatts(plan.steps[2], 233), { low: 246, high: 279 });
  assert.equal(targetWatts(plan.steps[1], 250), null); assert.equal(targetWatts(plan.steps[0], null), null);
  const t = { low: 125, high: 150 };
  assert.deepEqual(compare(125, t), { state: 'in', diff: 0 }); assert.deepEqual(compare(150, t), { state: 'in', diff: 0 });
  assert.deepEqual(compare(110, t), { state: 'low', diff: -15 }); assert.deepEqual(compare(162, t), { state: 'high', diff: 12 });
  assert.equal(compare(null, t), null); assert.equal(compare(140, null), null);
});

test('세션 파일 검사와 기본 세션', () => {
  assert.throws(() => checkPlan({ name: 'x', steps: [{ sec: 5, lo: 50, hi: 60 }] }), /10초/);
  assert.throws(() => checkPlan({ name: 'x', steps: [{ sec: 60, lo: 70, hi: 60 }] }), /아래 ≤ 위/);
  assert.throws(() => checkPlan({ name: 'x', steps: [{ sec: 60, lo: 70 }] }), /둘 다/);
  assert.throws(() => checkPlan({ steps: [{ sec: 60 }] }), /이름/);
  for (const p of PRESETS) assert.equal(checkPlan(p).steps.length, p.steps.length, p.id);
  assert.ok(PRESETS.some(p => p.id === 'demo-5m'));
});

test('기록 요약: 초마다 1번, 그룹 밖 선수 제외, 평균·최대·목표 안·구간별', () => {
  const s = new Settings(memory()); s.setAthletes(3);
  s.setFtp('P01', 200); s.setGroup('P01', '고E'); s.setFtp('P02', 300); s.setGroup('P02', '고E'); s.setGroup('P03', '중S');
  const run = new SessionRun(plan, { group: '고E' }).start(0), rec = new Recorder(run, s, { wallStart: Date.UTC(2026, 10, 27, 1) });
  const tile = (code, power, hr = 150) => ({ code, power, hr, cadence: 90 });
  for (let sec = 0; sec < 150; sec++) {
    // P01: 늘 범위 안(구간 가운데), P02: 늘 100W(W-up 150~180 아래, VO2 아래), P03: 그룹 밖
    const p1 = sec < 60 ? 110 : sec < 90 ? 150 : 225;
    assert.equal(rec.tick(sec * 1000 + 10, [tile('P01', p1), tile('P02', sec === 5 ? null : 100), tile('P03', 999)]), true);
    assert.equal(rec.tick(sec * 1000 + 500, [tile('P01', 1), tile('P02', 1), tile('P03', 1)]), false);   // 같은 초 두 번째는 안 적음
  }
  const sum = rec.summary(150_000);
  assert.equal(sum.seconds, 150); assert.ok(sum.complete); assert.equal(sum.group, '고E');
  assert.deepEqual(sum.athletes.map(a => a.code), ['P01', 'P02']);
  const [a, b] = sum.athletes;
  assert.equal(a.inTarget, 100); assert.equal(a.maxPower, 225); assert.equal(a.avgPower, Math.round((110 * 60 + 150 * 30 + 225 * 60) / 150));
  assert.deepEqual(a.steps.map(x => x.inTarget), [100, null, 100]); assert.deepEqual(a.steps.map(x => x.avgPower), [110, 150, 225]);
  assert.equal(b.inTarget, 0); assert.equal(b.recorded, 99); assert.equal(b.kj, Math.round(100 * 149 / 1000));
  assert.equal(a.avgHr, 150); assert.equal(a.avgCadence, 90);
  const csv = toCsv(sum).split('\n'); assert.equal(csv.length, 3); assert.match(csv[0], /^세션,시작,모의,선수,그룹,참여,기록 시작\(초\),기록 끝\(초\),FTP,평균W/); assert.match(csv[1], /^시험,2026-11-27T01:00:00.000Z,,P01,고E,함께,0,150,200,/);
});

test('기록 저장: 최근 30개, 같은 시작 시각은 덮음, 지우기, 형식 틀린 것·P코드 아닌 것은 버림', () => {
  const st = memory(), base = { version: 1, mock: true, seconds: 1, plan: { name: 'x', steps: [] }, athletes: [{ code: 'P01', steps: [] }] };
  for (let i = 0; i < 35; i++) saveToHistory(st, { ...base, startedAt: `2026-11-27T00:00:${String(i).padStart(2, '0')}Z` });
  assert.equal(loadHistory(st).length, HISTORY_MAX); assert.equal(loadHistory(st)[0].startedAt, '2026-11-27T00:00:34Z');
  saveToHistory(st, { ...base, seconds: 9, startedAt: '2026-11-27T00:00:34Z' }); assert.equal(loadHistory(st).length, HISTORY_MAX); assert.equal(loadHistory(st)[0].seconds, 9);
  removeFromHistory(st, '2026-11-27T00:00:34Z'); assert.equal(loadHistory(st).length, HISTORY_MAX - 1);
  assert.throws(() => saveToHistory(st, { ...base, athletes: [{ code: '홍길동' }] }), /형식/);
  st.setItem('mk-indoor-monitor.history.v1', JSON.stringify([{ ...base, athletes: [{ code: 'kim' }] }, { ...base, startedAt: 'ok' }]));
  assert.deepEqual(loadHistory(st).map(s => s.startedAt), ['ok']);
});

test('명단 파일: P코드만, 실명 같은 칸은 버리고 칸 이름도 옮기지 않음, FTP·그룹 검사, 설정 반영', () => {
  const text = JSON.stringify({ format: 'mk-indoor-roster', version: 1, source: 'V2', exportedAt: '2026-11-27T10:00:00+09:00', athletes: [
    { code: 'P01', group: '고E', ftp: 262, name: '실명예시', phone: 'x' }, { code: 'P02', group: '고X', ftp: 900 }, { code: '김', ftp: 200 }, { code: 'P01', ftp: 1 }, { code: 'P18', group: '중S', ftp: 205, ftpDate: '2026-11-05' }] });
  const r = parseRoster(text);
  assert.deepEqual(r.athletes, [{ code: 'P01', ftp: 262, group: '고E', ftpDate: null }, { code: 'P02', ftp: null, group: null, ftpDate: null }, { code: 'P18', ftp: 205, group: '중S', ftpDate: '2026-11-05' }]);
  assert.equal(r.warnings.length, 5); assert.ok(r.warnings.every(w => !/name|phone|실명예시/.test(w)));
  assert.throws(() => parseRoster('{}'), /형식/); assert.throws(() => parseRoster('nope'), /JSON/);
  const s = new Settings(memory()); assert.deepEqual(applyRoster(s, r), { ftp: 2, group: 2 });
  assert.equal(s.data.athletes, 18); assert.equal(s.ftp('P01'), 262); assert.equal(s.group('P18'), '중S');
  assert.deepEqual(applyRoster(s, r), { ftp: 0, group: 0 });
  const back = parseRoster(JSON.stringify(exportRoster(s, new Date(0))));
  assert.equal(back.athletes.length, 18); assert.equal(back.athletes.find(a => a.code === 'P01').ftp, 262);
  const again = new Settings(s.storage); assert.equal(again.group('P01'), '고E');   // 저장 후 다시 읽어도 남음
  assert.throws(() => s.setGroup('P01', '대학'), /그룹/);
});

test('모의 방 + 세션: 모의 선수가 목표를 따라 밟고, 화면 값(실제 ANT 길)으로 기록하면 목표 안 비율이 높다', () => {
  const n = 8, field = MockField.room(n), settings = new Settings(memory()), hub = new Hub(settings);
  settings.setAthletes(n);
  field.sensors.forEach((s, i) => settings.assign(sensorKey(s), 'P' + String(Math.floor(i / 2) + 1).padStart(2, '0'), s.deviceType === 120 ? 'hr' : 'power'));
  settings.codes().forEach((c, i) => { settings.setFtp(c, 200 + i * 10); settings.setGroup(c, i < 4 ? '고E' : '고S'); });
  const riders = settings.codes().map((c, i) => ({ c, r: new MockRider(field.sensors[i * 2], field.sensors[i * 2 + 1], 101 + i) }));
  riders.forEach(x => { x.r.skill = 1; });   // 시험은 실력 배율 1(목표 가운데)
  const short = checkPlan({ name: '짧은', steps: [{ label: 'A', sec: 20, lo: 56, hi: 75 }, { label: 'B', sec: 20, lo: 88, hi: 94 }] });
  const run = new SessionRun(short, { group: '고E' }).start(0), rec = new Recorder(run, settings, { mock: true });
  const dongles = ['A', 'B'].map((name, i) => ({ d: new MockDongle(name, { seed: 3 + i, drop: 0.03 }), p: new Parser() }));
  let view;
  for (let now = 0; now < 40_000; now += 50) {
    if (now % 1000 === 0) { const pos = run.at(now); for (const { c, r } of riders) if (run.includes(settings.group(c))) r.step(targetWatts(pos.step, settings.ftp(c)), settings.ftp(c)); }
    const tx = field.step(now);
    for (const { d, p } of dongles) for (const ch of d.chunks(tx)) for (const m of p.push(ch)) hub.receive(d.name, now, parseBroadcast(m));
    if (now % 1000 === 950) { view = hub.snapshot(now); rec.tick(now, view.tiles); }
  }
  assert.ok(view.tiles.every(t => t.level === LEVELS.OK));
  const sum = rec.summary(40_000);
  assert.deepEqual(sum.athletes.map(a => a.code), ['P01', 'P02', 'P03', 'P04']);
  for (const a of sum.athletes) {
    assert.ok(a.inTarget >= 80, `${a.code} 목표 안 ${a.inTarget}%`);   // 구간 바뀐 직후 1~2초(1초 평균이 따라오는 동안)만 밖
    assert.equal(a.recorded, 100);
    const t = targetWatts(short.steps[1], a.ftp); assert.ok(a.steps[1].avgPower >= t.low - 5 && a.steps[1].avgPower <= t.high + 5, `${a.code} B 평균 ${a.steps[1].avgPower}`);
  }
});

test('우리 팀 실내 세션: 11월 세부표 시간표와 총 시간·구간 시작 분이 같고, 강도는 세션 처방 시트 범위', () => {
  const by = id => TEAM_SESSIONS.find(p => p.id === id), min = p => totalSec(p) / 60;
  const starts = (p, prefix) => { let t = 0; const out = []; for (const st of p.steps) { if (st.label.startsWith(prefix)) out.push(t / 60); t += st.sec; } return out; };
  assert.equal(min(by('hE-sst2x20-lc4x5')), 105); assert.deepEqual(starts(by('hE-sst2x20-lc4x5'), 'LC'), [65, 73, 81, 89]); assert.deepEqual(starts(by('hE-sst2x20-lc4x5'), 'SST'), [15, 40]);
  assert.equal(min(by('hE-sst2x15-lc3x5')), 85); assert.deepEqual(starts(by('hE-sst2x15-lc3x5'), 'LC'), [55, 63, 71]);
  assert.equal(min(by('hE-vo2-6x3')), 81); assert.deepEqual(starts(by('hE-vo2-6x3'), 'VO2'), [15, 21, 27, 33, 39, 45]);
  assert.equal(min(by('m-cad6x2')), 54); assert.deepEqual(starts(by('m-cad6x2'), 'CAD'), [10, 14, 18, 22, 26, 30]);
  assert.equal(min(by('m-cad7x2')), 58); assert.deepEqual(starts(by('m-cad7x2'), 'CAD'), [10, 14, 18, 22, 26, 30, 34]);
  assert.equal(min(by('all-cad4x2')), 45);
  const RX = { SST: [88, 93], VO2: [106, 120], CAD: [76, 85], LC: [80, 90] };
  for (const p of TEAM_SESSIONS) {
    checkPlan(p);
    for (const st of p.steps) { const k = Object.keys(RX).find(k => st.label.startsWith(k)); if (k) assert.deepEqual([st.lo, st.hi], RX[k], `${p.id} ${st.label}`); }
  }
  assert.deepEqual(by('m-sst3x10').groups, ['중E', '중S']); assert.deepEqual(by('hE-vo2-6x3').groups, ['고E']); assert.deepEqual(by('z2-1h').groups, []);
});

test('여러 그룹 대상: 중E·중S 만 목표·기록', () => {
  const run = new SessionRun(plan, { group: '중E,중S' });
  assert.equal(run.group, '중E·중S'); assert.ok(run.includes('중E')); assert.ok(run.includes('중S')); assert.ok(!run.includes('고E')); assert.ok(!run.includes(null));
  assert.ok(new SessionRun(plan, { group: ['고E'] }).includes('고E')); assert.ok(new SessionRun(plan).includes(null));
});
