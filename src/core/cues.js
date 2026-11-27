// 3단계(11-27): 구간 전환 안내와 목표 이탈 알림의 골격. 화면은 1초마다 step 을 부르고, 돌아온 알림을 띠·소리로 보여 준다.
// 세션·선수 상태만 읽는다(저장·전송 없음). 소리 종류와 문구는 화면 쪽에서 정한다 — 여기서는 「언제·무엇을」만 정한다.
//   soon   : 다음 구간 SOON_SEC초 전 1번(세션마다 구간마다)
//   change : 구간이 바뀐 순간 1번
//   off    : 선수가 같은 쪽(낮음·높음)으로 OFF_SEC초 넘게 목표 밖이면 1번, 계속 밖이면 OFF_REPEAT_SEC초마다 다시
// 일시정지 중인 세션은 알리지 않고, 이탈 시간도 새로 센다. 자유 구간(목표 없음)·FTP 없는 선수는 이탈을 보지 않는다.
export const CUE = Object.freeze({ soonSec: 10, offSec: 15, offRepeatSec: 60 });

const range = s => s.lo === null || s.lo === undefined ? '자유' : `${s.lo}~${s.hi}%FTP`;

export class Cues {
  constructor(limits = CUE) { this.limits = limits; this.sessions = new Map(); this.off = new Map(); }

  /**
   * sessions: [{ id, group, pos }] — pos = SessionRun.at(now)(index·step·next·stepRemaining(초)·paused·done)
   * athletes: [{ code, sessionId, cmp }] — cmp = compare(파워, 목표) 결과(null 이면 판정 안 함)
   * 돌려줌: [{ kind, sessionId, code?, state?, text }]
   */
  step(now, sessions, athletes) {
    const out = [], L = this.limits, live = new Set();
    for (const { id, group, pos } of sessions) {
      live.add(id);
      const who = group ?? '전체';
      let seen = this.sessions.get(id);
      if (!seen) { seen = { index: pos.index, soonFor: -1 }; this.sessions.set(id, seen); }
      if (pos.done || pos.paused) continue;
      if (pos.index !== seen.index) {
        seen.index = pos.index;
        out.push({ kind: 'change', sessionId: id, text: `${who} · 지금 ${pos.index + 1}구간 ${pos.step.label} ${range(pos.step)}` });
      }
      if (pos.next && pos.stepRemaining <= L.soonSec && pos.stepRemaining > 0 && seen.soonFor !== pos.index) {
        seen.soonFor = pos.index;
        out.push({ kind: 'soon', sessionId: id, text: `${who} · ${Math.ceil(pos.stepRemaining)}초 뒤 ${pos.next.label} ${range(pos.next)}` });
      }
    }
    for (const id of [...this.sessions.keys()]) if (!live.has(id)) this.sessions.delete(id);

    const paused = new Set(sessions.filter(s => s.pos.paused || s.pos.done).map(s => s.id));
    const indexOf = new Map(sessions.map(s => [s.id, s.pos.index]));
    for (const a of athletes) {
      const state = a.cmp?.state;
      const prev = this.off.get(a.code), index = indexOf.get(a.sessionId);
      if (!a.sessionId || paused.has(a.sessionId) || (state !== 'low' && state !== 'high')) { this.off.delete(a.code); continue; }
      // 쪽이 바뀌거나 구간·세션이 바뀌면 처음부터 센다.
      if (!prev || prev.state !== state || prev.sessionId !== a.sessionId || prev.index !== index) { this.off.set(a.code, { state, sessionId: a.sessionId, index, since: now, alertedAt: null }); continue; }
      const offFor = (now - prev.since) / 1000, sinceAlert = prev.alertedAt === null ? Infinity : (now - prev.alertedAt) / 1000;
      if (offFor >= L.offSec && sinceAlert >= L.offRepeatSec) {
        prev.alertedAt = now;
        out.push({ kind: 'off', sessionId: a.sessionId, code: a.code, state, text: `${a.code} 목표보다 ${state === 'low' ? '낮음' : '높음'} ${Math.floor(offFor)}초` });
      }
    }
    for (const code of [...this.off.keys()]) if (!athletes.some(a => a.code === code)) this.off.delete(code);
    return out;
  }

  /** 지금 이탈 알림이 걸려 있는 선수(타일 표시용): 알림이 한 번이라도 나갔고 아직 밖. */
  alerting() { return new Set([...this.off].filter(([, v]) => v.alertedAt !== null).map(([code]) => code)); }
}
