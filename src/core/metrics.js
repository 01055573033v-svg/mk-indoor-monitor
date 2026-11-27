// 센서 1개의 화면 값. 파워·케이던스는 순간값 대신 누적값 차이로 약 1초 평균을 낸다(설계안 §4-4):
// 같은 송신을 두 동글이 받아 두 번 들어와도 누적값 차이는 0이라 값이 부풀지 않는다.
const WINDOW_MS = 1000, KEEP_MS = 3000, STOP_MS = 3000;
const wrap = (a, b, mod) => (a - b + mod) % mod;

export class SensorMetrics {
  constructor() { this.samples = []; this.hr = null; this.battery = null; this.cadenceHint = null; this.lastChange = null; }

  add(t, v) {
    if (!v) return;
    if (v.battery !== undefined && v.battery !== null) this.battery = v.battery;
    if (v.kind === 'battery') return;
    if (v.kind === 'hr') { if (v.hr) this.hr = { value: v.hr, t }; return; }
    const last = this.samples.at(-1);
    const counter = v.kind === 'power' ? v.events : v.time;
    if (!last || last.counter !== counter) this.lastChange = t;
    this.samples.push({ t, ...v, counter });
    while (this.samples.length > 2 && this.samples[0].t < t - KEEP_MS) this.samples.shift();
    if (v.kind === 'power') this.cadenceHint = v.cadence;
  }

  /** 마지막 샘플과, 그보다 약 1초 앞선 샘플의 차이. */
  pair() {
    const last = this.samples.at(-1); if (!last) return null;
    let base = null;
    for (let i = this.samples.length - 2; i >= 0; i--) { base = this.samples[i]; if (last.t - base.t >= WINDOW_MS) break; }
    return base ? { base, last } : { base: null, last };
  }

  power(now) {
    const p = this.pair(); if (!p || p.last.kind !== 'power') return null;
    if (this.lastChange !== null && now - this.lastChange >= STOP_MS) return 0;   // 이벤트 수가 멈춤 = 페달 멈춤
    if (!p.base) return p.last.power;
    const events = wrap(p.last.events, p.base.events, 256);
    if (!events) return p.last.t - p.base.t >= WINDOW_MS ? 0 : p.last.power;
    return Math.round(wrap(p.last.accPower, p.base.accPower, 65536) / events);
  }

  cadence(now) {
    const p = this.pair(); if (!p) return null;
    if (p.last.kind === 'power') return this.cadenceHint;
    if (this.lastChange !== null && now - this.lastChange >= STOP_MS) return 0;
    if (!p.base) return null;
    const dt = wrap(p.last.time, p.base.time, 65536), revs = wrap(p.last.revs, p.base.revs, 65536);
    if (!dt) return null;
    return Math.round(revs * 60 * 1024 / dt);
  }
}
