// 연속 스캔(수신 전용) 준비 명령과 확장 방송 메시지 해석.
// 1단계는 받기만 한다: 채널 0을 와일드카드(기기 번호·종류·전송 형식 0)로 잡고 Open Rx Scan Mode 로 들리는 센서를 전부 받는다.
// 이 동글은 스캔 중 다른 채널을 열 수 없다(2단계 ERG 제어는 제어용 동글을 따로 둔다 — 설계안 §2).
import { MSG, encode } from './message.js';

export const ANT_PLUS_FREQ = 57;          // 2457 MHz
export const DEVICE = Object.freeze({ POWER: 11, FEC: 17, HR: 120, SPEED_CADENCE: 121, CADENCE: 122 });
const EXT_CHANNEL_ID = 0x80, EXT_RSSI = 0x40, EXT_TIMESTAMP = 0x20;

/** 네트워크 키(8바이트)는 코드에 넣지 않는다. 이 맥북 크롬 설정에서 한 번 넣는다(ANT+ 사용 약관 대상). */
export function parseNetworkKey(hex) {
  const clean = String(hex ?? '').replace(/[\s:,-]|0x/gi, '');
  if (!/^[0-9a-f]{16}$/i.test(clean)) return null;
  return Array.from({ length: 8 }, (_, i) => parseInt(clean.slice(i * 2, i * 2 + 2), 16));
}

/** 동글 초기화 후 스캔 진입까지 보낼 명령 순서. 각 명령은 채널 응답(0x40, 코드 0)을 기다린다(RESET 은 시작 메시지 0x6F). */
export function scanSetup(networkKey, { channel = 0, network = 0 } = {}) {
  if (!Array.isArray(networkKey) || networkKey.length !== 8) throw new Error('네트워크 키 8바이트가 필요합니다');
  return [
    { name: 'reset', bytes: encode(MSG.RESET, [0]), expect: MSG.STARTUP },
    { name: 'networkKey', bytes: encode(MSG.SET_NETWORK_KEY, [network, ...networkKey]), expect: MSG.SET_NETWORK_KEY },
    { name: 'assign', bytes: encode(MSG.ASSIGN_CHANNEL, [channel, 0x00, network]), expect: MSG.ASSIGN_CHANNEL },
    { name: 'channelId', bytes: encode(MSG.CHANNEL_ID, [channel, 0, 0, 0, 0]), expect: MSG.CHANNEL_ID },
    { name: 'rfFreq', bytes: encode(MSG.RF_FREQ, [channel, ANT_PLUS_FREQ]), expect: MSG.RF_FREQ },
    // 확장 정보: 기기 번호(필수) + 신호 세기 + 수신 시각. 동글이 거절하면 기기 번호만으로 다시 시도(선테스트 4).
    { name: 'libConfig', bytes: encode(MSG.LIB_CONFIG, [0, EXT_CHANNEL_ID | EXT_RSSI | EXT_TIMESTAMP]), expect: MSG.LIB_CONFIG,
      fallback: encode(MSG.LIB_CONFIG, [0, EXT_CHANNEL_ID]) },
    { name: 'openScan', bytes: encode(MSG.OPEN_RX_SCAN, [0]), expect: MSG.OPEN_RX_SCAN },
  ];
}

/** 채널 응답 0x40: [채널, 응답한 메시지 ID, 코드]. 코드 0 = 정상. */
export function channelResponse(msg) {
  if (msg.id !== MSG.CHANNEL_EVENT || msg.data.length < 3) return null;
  return { channel: msg.data[0], to: msg.data[1], code: msg.data[2] };
}

/**
 * 방송 메시지(0x4E) + 확장 정보 → 센서 1건.
 * data: [채널][페이로드 8][플래그][확장…]. 확장 순서: 기기 ID 4바이트 → RSSI 3바이트 → 시각 2바이트(플래그에 켜진 것만).
 * 기기 번호는 전송 형식 상위 4비트로 20비트까지 늘어난다. 기기 종류 최상위 비트(짝짓기 비트)는 뗀다.
 */
export function parseBroadcast(msg) {
  if (msg.id !== MSG.BROADCAST || msg.data.length < 9) return null;
  const d = msg.data, payload = d.slice(1, 9);
  if (d.length < 14 || !(d[9] & EXT_CHANNEL_ID)) return { payload, deviceType: null, deviceNumber: null, extended: false };
  const flag = d[9];
  const transType = d[13];
  const out = {
    payload, extended: true,
    deviceNumber: d[10] | (d[11] << 8) | ((transType >> 4) << 16),
    deviceType: d[12] & 0x7f,
    transType,
    rssi: null,
  };
  let k = 14;
  if (flag & EXT_RSSI && d.length >= k + 3) { const v = d[k + 1]; out.rssi = v > 127 ? v - 256 : v; k += 3; }
  return out;
}

export const sensorKey = s => `${s.deviceType}:${s.deviceNumber}`;
