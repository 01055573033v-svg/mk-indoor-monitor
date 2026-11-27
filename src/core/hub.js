// 합치기(설계안 §3-3 Merger + Board 상태). 전송 계층이 무엇이든(WebUSB·모의 센서·2단계 브리지) 여기로는
// hub.receive(동글 이름, 받은 시각, parseBroadcast 결과) 한 가지 형식만 들어온다. 화면은 hub.snapshot(now)만 읽는다.
import { decode } from '../ant/profiles.js';
import { DEVICE, sensorKey } from '../ant/scan.js';
import { SensorMetrics } from './metrics.js';
import { zoneOf } from './zones.js';

export const LEVELS = Object.freeze({ OK: '정상', LATE: '주의', LOST: '끊김', OFFLINE: '오프라인', NONE: '센서 없음' });
const ORDER = [LEVELS.OK, LEVELS.LATE, LEVELS.LOST, LEVELS.OFFLINE];
export const LIMITS = Object.freeze({ lateMs: 1000, lostMs: 3000, offlineMs: 10000, dupMs: 120, alertQuietMs: 5000, statsMs: 10000, handoverMs: 3000 });
const EXPECTED_HZ = { [DEVICE.POWER]: 32768 / 8182, [DEVICE.FEC]: 4, [DEVICE.HR]: 32768 / 8070, [DEVICE.CADENCE]: 32768 / 8102, [DEVICE.SPEED_CADENCE]: 32768 / 8086 };
const ROLE = { [DEVICE.POWER]: 'power', [DEVICE.FEC]: 'power', [DEVICE.HR]: 'hr', [DEVICE.CADENCE]: 'cadence', [DEVICE.SPEED_CADENCE]: 'cadence' };
export const TYPE_LABEL = { [DEVICE.POWER]: '파워', [DEVICE.FEC]: '스마트로라', [DEVICE.HR]: '심박', [DEVICE.CADENCE]: '케이던스', [DEVICE.SPEED_CADENCE]: '속도·케이던스' };

export const levelFor = age => age === null ? LEVELS.NONE : age <= LIMITS.lateMs ? LEVELS.OK : age <= LIMITS.lostMs ? LEVELS.LATE : age <= LIMITS.offlineMs ? LEVELS.LOST : LEVELS.OFFLINE;
const worse = (a, b) => ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;

export class Hub {
  /** settings: pairing.js 의 설정(센서↔코드, FTP, 주 동글). */
  constructor(settings) { this.settings = settings; this.sensors = new Map(); this.dongles = new Map(); this.alerts = new Map(); this.lastLevel = new Map(); }

  dongle(name) {
    if (!this.dongles.has(name)) this.dongles.set(name, { name, status: '연결 전', reconnects: 0, packets: [], bad: 0, since: null });
    return this.dongles.get(name);
  }
  setDongleStatus(name, status) { const d = this.dongle(name); if (status === '다시 연결' ) d.reconnects++; d.status = status; }

  receive(dongleName, t, b) {
    if (!b || !b.extended || b.deviceType === null || !ROLE[b.deviceType]) return false;
    const key = sensorKey(b), d = this.dongle(dongleName);
    d.packets.push({ t, key }); d.since ??= t;
    let s = this.sensors.get(key);
    if (!s) { s = { key, deviceType: b.deviceType, deviceNumber: b.deviceNumber, metrics: new SensorMetrics(), last: null, lastPayload: null, by: new Map() }; this.sensors.set(key, s); }
    s.by.set(dongleName, t);
    if (b.rssi !== null && b.rssi !== undefined) s.rssi = b.rssi;
    // 같은 송신을 다른 동글이 받은 것: 같은 8바이트가 120ms 안에 다른 동글에서 → 1건만 쓴다.
    const hex = Array.from(b.payload, x => x.toString(16).padStart(2, '0')).join('');
    if (s.lastPayload && s.lastPayload.hex === hex && s.lastPayload.dongle !== dongleName && t - s.lastPayload.t <= LIMITS.dupMs) return false;
    s.lastPayload = { hex, dongle: dongleName, t };
    s.last = t; s.via = dongleName;
    s.metrics.add(t, decode(b.deviceType, b.payload));
    return true;
  }

  /** 오래된 수신 기록 정리 + 동글 통계. */
  dongleStats(now) {
    const out = [];
    for (const d of this.dongles.values()) {
      d.packets = d.packets.filter(p => p.t > now - LIMITS.statsMs);
      const keys = new Set(d.packets.map(p => p.key));
      // 창: 최근 10초(받기 시작한 지 10초가 안 됐으면 그만큼). 1초 미만이면 아직 셈하지 않는다.
      const span = d.since === null ? 0 : Math.min(LIMITS.statsMs, now - d.since) / 1000;
      let expected = 0;
      for (const key of keys) { const s = this.sensors.get(key); expected += (EXPECTED_HZ[s?.deviceType] ?? 4) * span; }
      const ready = span >= 1;
      out.push({ name: d.name, status: d.status, sensors: keys.size, perSecond: ready ? Math.round(d.packets.length / span) : null,
        missing: ready && expected ? Math.max(0, 1 - d.packets.length / expected) : null, reconnects: d.reconnects });
    }
    return out;
  }

  sensorView(key, now, code) {
    const s = this.sensors.get(key); if (!s) return { level: LEVELS.OFFLINE, age: null };
    const age = s.last === null ? null : now - s.last;
    const primary = this.settings.primaryDongle(code), primarySeen = primary ? s.by.get(primary) : undefined;
    const via = primary && s.via !== primary && (primarySeen === undefined || now - primarySeen > LIMITS.handoverMs) ? s.via : null;
    return { level: levelFor(age), age, via, s };
  }

  /** 화면 한 장: 선수 타일(P01~), 짝 없는 센서, 동글 상태, 새 경보. */
  snapshot(now) {
    const tiles = [], alerts = [];
    for (const code of this.settings.codes()) {
      const assigned = this.settings.sensorsOf(code);
      const tile = { code, level: LEVELS.NONE, power: null, cadence: null, hr: null, zone: null, ftpPercent: null, via: null, lost: [], battery: [] };
      for (const { key, role } of assigned) {
        const v = this.sensorView(key, now, code);
        tile.level = tile.level === LEVELS.NONE ? v.level : worse(tile.level, v.level);
        if (v.level === LEVELS.LOST || v.level === LEVELS.OFFLINE) tile.lost.push(role);
        if (v.via && (v.level === LEVELS.OK || v.level === LEVELS.LATE)) tile.via = v.via;   // 이어받아 들어오는 중일 때만
        if (!v.s || v.level === LEVELS.LOST || v.level === LEVELS.OFFLINE) continue;   // 끊긴 센서 값은 0이 아니라 비움
        const m = v.s.metrics;
        if (m.battery) tile.battery.push({ role, battery: m.battery });
        if (role === 'power') { tile.power = m.power(now); tile.cadence ??= m.cadence(now); }
        if (role === 'cadence') tile.cadence = m.cadence(now);
        if (role === 'hr' && m.hr && now - m.hr.t <= LIMITS.offlineMs) tile.hr = m.hr.value;
      }
      const ftp = this.settings.ftp(code);
      if (tile.power !== null && ftp) { tile.ftpPercent = Math.round(tile.power / ftp * 100); tile.zone = zoneOf(tile.power, ftp); }
      // 경보: 끊김(3초)·오프라인으로 바뀌는 순간 1번, 같은 타일은 5초 안에 다시 울리지 않는다.
      const before = this.lastLevel.get(code); this.lastLevel.set(code, tile.level);
      const bad = tile.level === LEVELS.LOST || tile.level === LEVELS.OFFLINE, wasBad = before === LEVELS.LOST || before === LEVELS.OFFLINE;
      if (bad && !wasBad && before !== undefined) {
        const lastAlert = this.alerts.get(code);
        if (lastAlert === undefined || now - lastAlert >= LIMITS.alertQuietMs) { this.alerts.set(code, now); alerts.push({ code, level: tile.level }); }
      }
      tile.alerting = bad && this.alerts.has(code);
      tiles.push(tile);
    }
    const paired = this.settings.pairedKeys();
    const unpaired = [...this.sensors.values()].filter(s => !paired.has(s.key) && s.last !== null && now - s.last <= LIMITS.offlineMs)
      .map(s => ({ key: s.key, type: TYPE_LABEL[s.deviceType], role: ROLE[s.deviceType], tail: String(s.deviceNumber % 100).padStart(2, '0'),
        power: ROLE[s.deviceType] === 'power' ? s.metrics.power(now) : null, hr: s.metrics.hr?.value ?? null, cadence: ROLE[s.deviceType] === 'cadence' ? s.metrics.cadence(now) : null }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return { tiles, unpaired, dongles: this.dongleStats(now), alerts };
  }
}
