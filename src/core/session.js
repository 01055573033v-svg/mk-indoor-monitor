// 2단계: 훈련 세션 = 구간 목록(시간 · %FTP 범위)과 진행 시계. 시각은 밖에서 넣는다(화면은 performance.now, 시험은 가상 시계).
// 목표 와트는 선수 FTP × 구간 %FTP(내림). 범위 판정은 존 계산(zones.js)과 별개로 「이 구간 목표 안인가」만 본다.
import { TEAM_SESSIONS } from './team-sessions.js';
// 용어: 화면·기록에 상표 용어(NP·TSS·IF 등)는 쓰지 않는다 — 평균·최대 파워, 목표 안 비율, kJ 만.

/** 구간: label(화면 이름) · sec(초) · lo/hi(%FTP 정수, 둘 다 null 이면 목표 없음 = 자유). */
const step = (label, min, lo, hi) => ({ label, sec: Math.round(min * 60), lo, hi });

// 기본 목록 = 시연 5분(모의 확인용) + 우리 팀 실내 세션(team-sessions.js, 11-27 코치 지시: 세션 처방 시트 반영).
export const DEMO = { id: 'demo-5m', name: '시연 5분(모의 확인용)', groups: [], section: '시연', source: '모의 확인용', steps: [step('W-up', 1, 50, 60), step('템포', 1, 76, 90), step('휴식', 0.5, 45, 55), step('VO2', 1, 106, 120), step('휴식', 0.5, 45, 55), step('쿨다운', 1, 40, 55)] };
export const PRESETS = Object.freeze([...TEAM_SESSIONS, DEMO]);

/** 사용자 세션(JSON) 검사: 구간 1~60개, 구간 5초~3시간(스핀업 8초가 있어 11-27 10초 → 5초), %FTP 30~200(lo ≤ hi) 또는 둘 다 비움. */
export function checkPlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('세션 형식이 아닙니다');
  const name = String(plan.name ?? '').trim().slice(0, 40), steps = plan.steps;
  if (!name) throw new Error('세션 이름이 필요합니다');
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 60) throw new Error('구간은 1~60개');
  const out = steps.map((s, i) => {
    const sec = Number(s?.sec), lo = s?.lo ?? null, hi = s?.hi ?? null;
    if (!Number.isInteger(sec) || sec < 5 || sec > 10800) throw new Error(`${i + 1}번 구간 시간은 5초~3시간`);
    if ((lo === null) !== (hi === null)) throw new Error(`${i + 1}번 구간 %FTP는 둘 다 넣거나 둘 다 비웁니다`);
    if (lo !== null && !(Number.isInteger(lo) && Number.isInteger(hi) && lo >= 30 && hi <= 200 && lo <= hi)) throw new Error(`${i + 1}번 구간 %FTP는 30~200 정수, 아래 ≤ 위`);
    return { label: String(s?.label ?? `구간 ${i + 1}`).slice(0, 20), sec, lo, hi };
  });
  return { id: String(plan.id ?? 'custom').slice(0, 30), name, steps: out };
}

export const totalSec = plan => plan.steps.reduce((a, s) => a + s.sec, 0);

/** 목표 와트 범위. FTP 없거나 자유 구간이면 null. */
export function targetWatts(st, ftp) {
  if (!st || st.lo === null || st.lo === undefined || !(ftp > 0)) return null;
  return { low: Math.floor(ftp * st.lo / 100), high: Math.floor(ftp * st.hi / 100) };
}

/** 지금 파워 vs 목표: state 'low'|'in'|'high', diff = 가까운 경계까지 W(범위 안이면 0). */
export function compare(power, target) {
  if (power === null || power === undefined || !target) return null;
  if (power < target.low) return { state: 'low', diff: power - target.low };
  if (power > target.high) return { state: 'high', diff: power - target.high };
  return { state: 'in', diff: 0 };
}

/** 진행 시계: start → (pause/resume) → stop. at(now)는 지금 구간·남은 시간. */
export class SessionRun {
  /** group: null(전체) · '고E' · ['중E', '중S'](여러 그룹). */
  constructor(plan, { group = null } = {}) {
    this.groups = (Array.isArray(group) ? group : group ? String(group).split(',') : []).filter(Boolean);
    this.group = this.groups.length ? this.groups.join('·') : null;
    this.plan = plan; this.total = totalSec(plan);
    this.startedAt = null; this.stoppedAt = null; this.pausedAt = null; this.pausedMs = 0;
    this.bounds = []; let acc = 0; for (const s of plan.steps) { this.bounds.push([acc, acc + s.sec]); acc += s.sec; }
  }
  start(now) { this.startedAt = now; return this; }
  pause(now) { if (this.running(now) && this.pausedAt === null) this.pausedAt = now; }
  resume(now) { if (this.pausedAt !== null) { this.pausedMs += now - this.pausedAt; this.pausedAt = null; } }
  stop(now) { if (this.stoppedAt === null) { this.resume(now); this.stoppedAt = now; } }
  get paused() { return this.pausedAt !== null; }
  running(now) { return this.startedAt !== null && this.stoppedAt === null && this.elapsed(now) < this.total; }
  /** 흐른 초(일시정지 뺌, 세션 길이에서 멈춤). */
  elapsed(now) {
    if (this.startedAt === null) return 0;
    const end = this.stoppedAt ?? this.pausedAt ?? now;
    return Math.min(this.total, Math.max(0, (end - this.startedAt - this.pausedMs) / 1000));
  }
  at(now) {
    const e = this.elapsed(now), done = this.stoppedAt !== null || e >= this.total;
    let i = this.bounds.findIndex(([a, b]) => e >= a && e < b); if (i === -1) i = this.plan.steps.length - 1;
    const [a, b] = this.bounds[i];
    return { index: i, step: this.plan.steps[i], next: this.plan.steps[i + 1] ?? null, elapsed: e, total: this.total,
      stepElapsed: e - a, stepRemaining: Math.max(0, b - e), done, paused: this.paused };
  }
  /** 이 선수에게 목표를 보여 줄지(대상 그룹이 정해졌으면 그 그룹만). */
  includes(group) { return !this.groups.length || this.groups.includes(group); }
}

export const mmss = sec => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
