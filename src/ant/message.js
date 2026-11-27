// ANT USB 직렬 메시지: [동기 0xA4][길이 N][메시지 ID][데이터 N바이트][체크섬 = 앞 바이트 전부 XOR].
// 동글에서 오는 USB 덩어리는 메시지 경계와 맞지 않을 수 있다 → Parser 가 이어 붙이고, 깨진 바이트는 다음 동기 바이트까지 건너뛴다.
export const SYNC = 0xa4;
export const MAX_DATA = 64;

export const MSG = Object.freeze({
  RESET: 0x4a, STARTUP: 0x6f, SET_NETWORK_KEY: 0x46, ASSIGN_CHANNEL: 0x42, CHANNEL_ID: 0x51, RF_FREQ: 0x45,
  LIB_CONFIG: 0x6e, ENABLE_EXT_RX: 0x66, OPEN_RX_SCAN: 0x5b, CLOSE_CHANNEL: 0x4c,
  CHANNEL_EVENT: 0x40, BROADCAST: 0x4e, ACK: 0x4f, BURST: 0x50, SERIAL_ERROR: 0xae,
});

export function checksum(bytes) {
  let x = 0;
  for (const b of bytes) x ^= b;
  return x;
}

/** 메시지 1건을 바이트로. */
export function encode(id, data = []) {
  if (data.length > MAX_DATA) throw new RangeError('ANT 메시지 데이터가 너무 깁니다');
  const out = new Uint8Array(data.length + 4);
  out[0] = SYNC; out[1] = data.length; out[2] = id; out.set(data, 3);
  out[out.length - 1] = checksum(out.subarray(0, out.length - 1));
  return out;
}

/** USB 덩어리를 받아 완성된 메시지만 돌려준다. 체크섬이 틀린 메시지는 버리고 건수만 센다. */
export class Parser {
  constructor() { this.buf = new Uint8Array(0); this.bad = 0; }
  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf); merged.set(chunk, this.buf.length);
    const out = [];
    let i = 0;
    while (i < merged.length) {
      if (merged[i] !== SYNC) { i++; continue; }
      if (i + 1 >= merged.length) break;
      const len = merged[i + 1];
      if (len > MAX_DATA) { this.bad++; i++; continue; }
      const end = i + len + 4;
      if (end > merged.length) break;
      const frame = merged.subarray(i, end);
      if (checksum(frame.subarray(0, frame.length - 1)) !== frame[frame.length - 1]) { this.bad++; i++; continue; }
      out.push({ id: frame[2], data: frame.slice(3, 3 + len) });
      i = end;
    }
    this.buf = merged.slice(i);
    return out;
  }
}
