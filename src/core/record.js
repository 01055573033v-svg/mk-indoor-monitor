// 2단계: 세션 동안 선수별 1초 값을 모으고, 끝나면 요약을 만든다. 요약만 이 크롬(localStorage)에 남긴다(1초 원본은 저장 안 함).
// 기록에 들어가는 것: P코드 · 그룹 · FTP · 숫자뿐. 실명·센서 번호·네트워크 키는 넣지 않는다.
import { targetWatts, compare } from './session.js';
import { CODE } from './settings.js';

export const HISTORY_KEY = 'mk-indoor-monitor.history.v1';
export const HISTORY_MAX = 30;

const avg = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
const max = xs => xs.length ? Math.max(...xs) : null;

export class Recorder {
  constructor(run, settings, { mock = false, wallStart = Date.now() } = {}) {
    Object.assign(this, { run, settings, mock, wallStart }); this.rows = new Map(); this.lastSec = -1;
    this.ended = new Map();   // 선수별 먼저 끝낸 초(3단계: 개별 선수 먼저 끝내기)
  }
  /** 개별 선수 먼저 끝내기: 기록은 남기고 그 뒤로 적지 않는다(member 가 거짓을 돌려줌). */
  endAthlete(code, now) { this.ended.set(code, Math.floor(this.run.elapsed(now))); }
  /** 다시 넣기: 끝낸 표시를 지우고 이어서 적는다. */
  resumeAthlete(code) { this.ended.delete(code); }
  /** 세션에서 빼기: 이 세션 기록을 지운다(다른 세션에 합류하면 거기서 새로 적힌다). */
  dropAthlete(code) { this.rows.delete(code); this.ended.delete(code); }
  /** 화면 갱신마다 부른다. 같은 초에는 한 번만 적는다. tiles = hub.snapshot().tiles,
   *  member(code) = 지금 이 세션에서 적을 선수인가(기본: 대상 그룹). */
  tick(now, tiles, member = code => this.run.includes(this.settings.group(code))) {
    if (this.run.startedAt === null || this.run.paused) return false;
    const pos = this.run.at(now), sec = Math.floor(pos.elapsed);
    if (sec === this.lastSec || pos.elapsed >= this.run.total) return false;
    this.lastSec = sec;
    for (const t of tiles) {
      if (!member(t.code)) continue;
      const target = targetWatts(pos.step, this.settings.ftp(t.code));
      if (!this.rows.has(t.code)) this.rows.set(t.code, []);
      this.rows.get(t.code).push({ sec, step: pos.index, p: t.power, hr: t.hr, cad: t.cadence, cmp: compare(t.power, target)?.state ?? null });
    }
    return true;
  }
  summary(now) {
    const plan = this.run.plan, seconds = Math.floor(this.run.elapsed(now));
    const athletes = [...this.rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, rows]) => {
      const p = rows.filter(r => r.p !== null).map(r => r.p), judged = rows.filter(r => r.cmp !== null);
      return {
        code, group: this.settings.group(code), ftp: this.settings.ftp(code),
        fromSec: rows[0]?.sec ?? null, toSec: rows.length ? rows.at(-1).sec + 1 : null,   // 이 선수가 실제로 기록된 구간(늦게 합류·먼저 끝냄)
        status: this.ended.has(code) ? '먼저 끝냄' : rows.length && rows[0].sec > 0 ? '중간 합류' : '함께',
        recorded: rows.length ? Math.round(p.length / rows.length * 100) : 0,   // 파워가 들어온 초 비율(끊김 확인용)
        avgPower: avg(p), maxPower: max(p), kj: p.length ? Math.round(p.reduce((a, b) => a + b, 0) / 1000) : null,
        avgHr: avg(rows.filter(r => r.hr !== null).map(r => r.hr)), maxHr: max(rows.filter(r => r.hr !== null).map(r => r.hr)),
        avgCadence: avg(rows.filter(r => r.cad !== null && r.cad > 0).map(r => r.cad)),
        inTarget: judged.length ? Math.round(judged.filter(r => r.cmp === 'in').length / judged.length * 100) : null,
        steps: plan.steps.map((s, i) => {
          const rs = rows.filter(r => r.step === i), sp = rs.filter(r => r.p !== null).map(r => r.p), sj = rs.filter(r => r.cmp !== null);
          return { avgPower: avg(sp), inTarget: sj.length ? Math.round(sj.filter(r => r.cmp === 'in').length / sj.length * 100) : null };
        }),
      };
    });
    return {
      version: 1, mock: this.mock, startedAt: new Date(this.wallStart).toISOString(), seconds,
      complete: seconds >= this.run.total, group: this.run.group,
      plan: { id: plan.id, name: plan.name, steps: plan.steps.map(s => ({ label: s.label, sec: s.sec, lo: s.lo, hi: s.hi })) },
      athletes,
    };
  }
}

// ── 이 크롬에 남기는 요약 목록(최근 30개) ──
const cleanSummary = s => s && s.version === 1 && Array.isArray(s.athletes) && s.athletes.every(a => CODE.test(a?.code)) ? s : null;
export function loadHistory(storage) {
  try { const list = JSON.parse(storage.getItem(HISTORY_KEY) ?? '[]'); return Array.isArray(list) ? list.map(cleanSummary).filter(Boolean) : []; } catch { return []; }
}
export function saveToHistory(storage, summary) {
  if (!cleanSummary(summary)) throw new Error('기록 형식이 아닙니다');
  const list = [summary, ...loadHistory(storage).filter(s => s.startedAt !== summary.startedAt)].slice(0, HISTORY_MAX);
  storage.setItem(HISTORY_KEY, JSON.stringify(list)); return list;
}
export function removeFromHistory(storage, startedAt) {
  const list = loadHistory(storage).filter(s => s.startedAt !== startedAt); storage.setItem(HISTORY_KEY, JSON.stringify(list)); return list;
}

/** 내려받기용 CSV(선수 1줄). 엑셀이 한글을 읽게 BOM 을 붙이는 건 화면 쪽에서. */
export function toCsv(s) {
  const head = ['세션', '시작', '모의', '선수', '그룹', '참여', '기록 시작(초)', '기록 끝(초)', 'FTP', '평균W', '최대W', 'kJ', '목표안%', '평균심박', '최대심박', '평균rpm', '기록률%', ...s.plan.steps.map((st, i) => `${i + 1}.${st.label} 평균W`)];
  const q = v => v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const rows = s.athletes.map(a => [s.plan.name, s.startedAt, s.mock ? '예' : '', a.code, a.group ?? '', a.status ?? '', a.fromSec, a.toSec, a.ftp ?? '', a.avgPower, a.maxPower, a.kj, a.inTarget, a.avgHr, a.maxHr, a.avgCadence, a.recorded, ...a.steps.map(x => x.avgPower)]);
  return [head, ...rows].map(r => r.map(q).join(',')).join('\n');
}
