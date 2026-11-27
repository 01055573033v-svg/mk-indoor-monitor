// 3단계(11-27 코치): 한 방에서 그룹별 세션을 따로 돌린다. 그룹마다 시작·일시정지·끝 시각이 다르고 기록도 따로 남는다.
// 선수 한 명은 한 순간에 세션 하나에만 속한다:
//   1) 다른 세션에 「합류」했으면 그 세션
//   2) 아니면 자기 그룹을 대상으로 하는 세션(빼기 하지 않았을 때)
// 「먼저 끝내기」는 그 세션에 남아 있되 기록·목표를 멈춘다(요약에 「먼저 끝냄」). 「빼기」는 그 세션 기록을 지운다.
import { SessionRun } from './session.js';
import { Recorder } from './record.js';

export class Room {
  constructor(settings) { this.settings = settings; this.entries = []; this.seq = 0; }

  /** 새 세션. group: null(전체) · '고E' · '중E,중S' · 배열. 진행 중인 세션과 대상 그룹이 겹치면 거절. */
  start(plan, group, now, { mock = false, wallStart = Date.now() } = {}) {
    const run = new SessionRun(plan, { group });
    for (const e of this.entries) {
      if (!e.run.groups.length || !run.groups.length) throw new Error(`「${e.run.plan.name}」가 ${e.run.group ?? '전체'} 대상으로 진행 중입니다. 전체 세션은 다른 세션과 함께 돌릴 수 없습니다`);
      const both = run.groups.filter(g => e.run.groups.includes(g));
      if (both.length) throw new Error(`${both.join('·')} 그룹은 「${e.run.plan.name}」가 진행 중입니다`);
    }
    run.start(now);
    const entry = { id: ++this.seq, run, recorder: new Recorder(run, this.settings, { mock, wallStart }), joined: new Set(), out: new Set() };
    this.entries.push(entry); return entry;
  }
  get(id) { return this.entries.find(e => e.id === id) ?? null; }
  busyGroups() { return this.entries.flatMap(e => e.run.groups.length ? e.run.groups : ['전체']); }

  /** 선수가 지금 속한 세션(먼저 끝낸 경우도 그 세션)과 상태. */
  place(code) {
    const joined = this.entries.find(e => e.joined.has(code));
    const entry = joined ?? this.entries.find(e => !e.out.has(code) && e.run.includes(this.settings.group(code)) && !this.entries.some(o => o.joined.has(code)));
    if (!entry) return { entry: null, state: null };
    return { entry, state: entry.recorder.ended.has(code) ? 'ended' : 'active' };
  }
  /** 목표·기록 대상인가(진행 중이고 먼저 끝내지 않음). */
  active(code) { const p = this.place(code); return p.state === 'active' ? p.entry : null; }

  endAthlete(code, now) { const p = this.place(code); if (p.state !== 'active') throw new Error(`${code}는 진행 중인 세션이 없습니다`); p.entry.recorder.endAthlete(code, now); return p.entry; }
  resumeAthlete(code) { const p = this.place(code); if (p.state !== 'ended') throw new Error(`${code}는 먼저 끝낸 상태가 아닙니다`); p.entry.recorder.resumeAthlete(code); return p.entry; }
  /** 세션에서 빼기: 기록 지움 + 그 세션 목표 끝. 자기 그룹 세션이면 out, 합류였으면 합류 취소. */
  removeAthlete(code) {
    const p = this.place(code); if (!p.entry) throw new Error(`${code}는 속한 세션이 없습니다`);
    p.entry.recorder.dropAthlete(code);
    if (p.entry.joined.has(code)) p.entry.joined.delete(code); else p.entry.out.add(code);
    return p.entry;
  }
  /** 다른 세션에 합류(그룹과 상관없이). 지금 세션에서 기록이 있으면 「먼저 끝냄」으로 남기고 옮긴다. */
  join(code, id, now) {
    const target = this.get(id); if (!target) throw new Error('그 세션이 없습니다');
    const p = this.place(code);
    if (p.entry === target) { if (p.state === 'ended') target.recorder.resumeAthlete(code); return target; }
    if (p.entry) {
      if (p.entry.recorder.rows.has(code)) { if (p.state === 'active') p.entry.recorder.endAthlete(code, now); } else p.entry.recorder.dropAthlete(code);
      if (p.entry.joined.has(code)) p.entry.joined.delete(code); else p.entry.out.add(code);
    }
    for (const e of this.entries) e.joined.delete(code);
    target.joined.add(code); target.out.delete(code); target.recorder.resumeAthlete(code);
    return target;
  }

  /** 화면 1초마다: 각 세션 기록 + 끝난 세션 요약 목록을 돌려준다(세션은 목록에서 빠진다). */
  tick(now, tiles) {
    const done = [];
    for (const e of [...this.entries]) {
      e.recorder.tick(now, tiles, code => this.active(code) === e);
      if (e.run.at(now).done) done.push(this.finish(e.id, now));
    }
    return done;
  }
  finish(id, now) {
    const e = this.get(id); if (!e) return null;
    e.run.stop(now); this.entries = this.entries.filter(x => x !== e);
    return e.recorder.summary(now);
  }
}
