// ANT+ 프로파일 페이지 해석(1단계에 필요한 것만). 값은 "그 순간 받은 것"이고, 1초 평균은 metrics.js 가 누적값으로 낸다.
//   파워(11)  0x10 파워 전용: 이벤트 수·누적 파워·순간 파워·순간 케이던스
//   FE-C(17)  0x19 고정 자전거·트레이너: 이벤트 수·누적 파워·순간 파워(12비트)·순간 케이던스
//   심박(120) 모든 페이지 4~7바이트: 박동 시각(1/1024초)·박동 수·계산 심박
//   케이던스(122) / 속도·케이던스(121): 크랭크 이벤트 시각(1/1024초)·누적 회전 수
//   공통 0x52 배터리 상태(보내는 기기만)
import { DEVICE } from './scan.js';

const u16 = (p, i) => p[i] | (p[i + 1] << 8);
const BATTERY = { 1: '새것', 2: '좋음', 3: '보통', 4: '낮음', 5: '위험' };

export function decode(deviceType, p) {
  if (!p || p.length < 8) return null;
  const page = p[0];
  if (page === 0x52 && deviceType !== DEVICE.HR) {
    const status = (p[7] >> 4) & 0x07;
    return { kind: 'battery', battery: BATTERY[status] ?? null };
  }
  switch (deviceType) {
    case DEVICE.POWER:
      if (page !== 0x10) return null;
      return { kind: 'power', events: p[1], accPower: u16(p, 4), power: u16(p, 6), cadence: p[3] === 0xff ? null : p[3] };
    case DEVICE.FEC: {
      if (page !== 0x19) return null;
      const power = p[5] | ((p[6] & 0x0f) << 8);
      return { kind: 'power', events: p[1], accPower: u16(p, 3), power: power === 0xfff ? null : power, cadence: p[2] === 0xff ? null : p[2] };
    }
    case DEVICE.HR: {
      const out = { kind: 'hr', beatTime: u16(p, 4), beats: p[6], hr: p[7] || null };
      if ((page & 0x7f) === 0x07) out.battery = p[1] <= 100 ? `${p[1]}%` : null;
      return out;
    }
    case DEVICE.CADENCE:
      return { kind: 'cadence', time: u16(p, 4), revs: u16(p, 6) };
    case DEVICE.SPEED_CADENCE:
      return { kind: 'cadence', time: u16(p, 0), revs: u16(p, 2) };
    default:
      return null;
  }
}
