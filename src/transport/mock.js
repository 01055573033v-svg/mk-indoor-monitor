// 모의 센서(동글 없이 검증용, 설계안 §7 「가짜 센서 발생기」). 실제 ANT 바이트(0xA4 … 체크섬)를 만들어
// 동글처럼 덩어리로 잘라 내보낸다 → 화면까지 실제와 같은 길(Parser → parseBroadcast → Hub)을 지난다.
// 시각은 밖에서 넣는다(시험은 가상 시계, 화면은 setInterval). 난수는 씨앗 고정이라 시험이 매번 같다.
import { MSG, encode } from '../ant/message.js';
import { DEVICE } from '../ant/scan.js';

export function rng(seed = 1) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const PERIOD = { [DEVICE.POWER]: 8182 / 32768 * 1000, [DEVICE.FEC]: 8192 / 32768 * 1000, [DEVICE.HR]: 8070 / 32768 * 1000 };

/** 센서 1개: 목표 파워·케이던스·심박을 바꿀 수 있고, silent 면 송신하지 않는다. */
export class MockSensor {
  constructor({ deviceType, deviceNumber, watts = 180, cadence = 90, hr = 140, phase = 0 }) {
    Object.assign(this, { deviceType, deviceNumber, watts, cadence, hr, silent: false });
    this.period = PERIOD[deviceType]; this.next = phase; this.events = 0; this.acc = 0; this.beats = 0; this.beatTime = 0; this.sent = 0;
  }
  payload() {
    this.sent++;
    if (this.deviceType === DEVICE.HR) {
      const beatsPerPeriod = this.hr / 60 * this.period / 1000;
      const before = Math.floor(this.beats); this.beats += beatsPerPeriod;
      if (Math.floor(this.beats) !== before) this.beatTime = (this.beatTime + Math.round(1024 * 60 / this.hr)) & 0xffff;
      const toggle = (Math.floor(this.sent / 4) % 2) << 7;
      return [toggle | 0x04, 0x01, 0, 0, this.beatTime & 0xff, this.beatTime >> 8, Math.floor(this.beats) & 0xff, this.hr];
    }
    const pedalling = this.cadence > 0;
    if (pedalling) { this.events = (this.events + 1) & 0xff; this.acc = (this.acc + this.watts) & 0xffff; }
    const w = pedalling ? this.watts : 0;
    if (this.deviceType === DEVICE.FEC) return [0x19, this.events, this.cadence, this.acc & 0xff, this.acc >> 8, w & 0xff, (w >> 8) & 0x0f, 0x00];
    return [0x10, this.events, 0xff, this.cadence, this.acc & 0xff, this.acc >> 8, w & 0xff, w >> 8];
  }
}

/** 방송 메시지 + 확장 정보(기기 ID·RSSI) 바이트. */
export function broadcastFrame(sensor, payload, rssi = -60) {
  const n = sensor.deviceNumber;
  return encode(MSG.BROADCAST, [0, ...payload, 0x80 | 0x40, n & 0xff, (n >> 8) & 0xff, sensor.deviceType, 0x05 | ((n >> 16) << 4), 0x20, rssi & 0xff, -90 & 0xff]);
}

/** 한 방의 센서들. step(t)는 t까지 송신된 것들을 시각 순으로 돌려준다. */
export class MockField {
  constructor(sensors) { this.sensors = sensors; }
  /** 선수 n명 × (파워 또는 스마트로라 + 심박). 기기 번호는 가짜(시험용). */
  static room(athletes = 16, seed = 7) {
    const r = rng(seed), sensors = [];
    for (let i = 0; i < athletes; i++) {
      sensors.push(new MockSensor({ deviceType: i % 4 === 3 ? DEVICE.FEC : DEVICE.POWER, deviceNumber: 10000 + i, watts: 120 + Math.round(r() * 200), cadence: 80 + Math.round(r() * 20), phase: r() * 250 }));
      sensors.push(new MockSensor({ deviceType: DEVICE.HR, deviceNumber: 20000 + i, hr: 110 + Math.round(r() * 60), phase: r() * 250 }));
    }
    return new MockField(sensors);
  }
  step(t) {
    const out = [];
    for (const s of this.sensors) while (s.next <= t) { const at = s.next; s.next += s.period; if (!s.silent) out.push({ t: at, sensor: s, payload: s.payload() }); }
    return out.sort((a, b) => a.t - b.t);
  }
}

/**
 * 모의 동글: 같은 방(field)을 듣되 drop 비율만큼 놓치고, hears(sensor)가 거짓이면 아예 못 듣는다.
 * deliver(전송들) → USB 덩어리(최대 64바이트, 메시지 경계와 무관하게 자름).
 */
export class MockDongle {
  constructor(name, { drop = 0, hears = () => true, seed = 3 } = {}) { Object.assign(this, { name, drop, hears }); this.random = rng(seed); }
  chunks(transmissions) {
    const bytes = [];
    for (const tx of transmissions) if (this.hears(tx.sensor) && this.random() >= this.drop) bytes.push(...broadcastFrame(tx.sensor, tx.payload));
    const out = [];
    for (let i = 0; i < bytes.length;) { const n = 1 + Math.floor(this.random() * 64); out.push(Uint8Array.from(bytes.slice(i, i + n))); i += n; }
    return out;
  }
}
