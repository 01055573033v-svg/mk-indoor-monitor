// WebUSB 전송(설계안 §3 권고 경로). 크롬에서 동글을 직접 열어 스캔에 넣고, 받은 방송을 Hub 형식으로 넘긴다.
// 실물 동글로 확인하기 전 코드다 — 선테스트 1~4(인식·엔드포인트·스캔 진입·확장 메시지)에서 처음 검증된다.
// 전송 계층 공통 형식: start({ onPacket(t, broadcast), onStatus(text) }) / stop(). 2단계 브리지(WebSocket)도 같은 형식을 따른다.
import { Parser, MSG } from '../ant/message.js';
import { scanSetup, parseBroadcast, channelResponse } from '../ant/scan.js';

/** 싱크라이더 안테나형(0x0fcf:0x1008)과 ANTUSB-m(0x0fcf:0x1009). */
export const FILTERS = [{ vendorId: 0x0fcf, productId: 0x1008 }, { vendorId: 0x0fcf, productId: 0x1009 }];
const REPLY_MS = 1000;

/** 동글 고르기 창(사용자 누름이 있어야 열림). 한 번 허용한 동글은 getDevices()로 다시 묻지 않고 연다. */
export async function pickDongle(usb = globalThis.navigator?.usb) {
  if (!usb) throw new Error('이 브라우저는 WebUSB를 지원하지 않습니다(크롬에서 여세요)');
  return usb.requestDevice({ filters: FILTERS });
}
export async function knownDongles(usb = globalThis.navigator?.usb) {
  if (!usb) return [];
  return (await usb.getDevices()).filter(d => FILTERS.some(f => f.vendorId === d.vendorId && f.productId === d.productId));
}

/** 디스크립터에서 ANT 송수신 엔드포인트 2개(벌크 in/out)를 찾는다(선테스트 2). */
export function findEndpoints(device) {
  for (const iface of device.configuration?.interfaces ?? []) {
    const alt = iface.alternate ?? iface.alternates?.[0];
    const eps = alt?.endpoints ?? [];
    const input = eps.find(e => e.direction === 'in' && e.type === 'bulk'), output = eps.find(e => e.direction === 'out' && e.type === 'bulk');
    if (input && output) return { interfaceNumber: iface.interfaceNumber, input: input.endpointNumber, output: output.endpointNumber, packetSize: input.packetSize || 64 };
  }
  return null;
}

export class WebUsbTransport {
  constructor(device, { name, networkKey, now = () => performance.now() }) {
    Object.assign(this, { device, name, networkKey, now });
    this.parser = new Parser(); this.running = false; this.waiters = [];
  }

  async start({ onPacket, onStatus }) {
    this.onPacket = onPacket; this.onStatus = onStatus ?? (() => {});
    const d = this.device;
    this.onStatus('여는 중');
    if (!d.opened) await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    const ep = findEndpoints(d);
    if (!ep) throw new Error('ANT 송수신 엔드포인트를 찾지 못했습니다(선테스트 2 실패 → 브리지 검토)');
    this.ep = ep;
    await d.claimInterface(ep.interfaceNumber);
    this.running = true;
    this.readLoop();
    for (const step of scanSetup(this.networkKey)) {
      let ok = await this.command(step);
      if (!ok && step.fallback) ok = await this.command({ ...step, bytes: step.fallback });
      if (!ok && step.name !== 'reset') throw new Error(`스캔 준비 실패: ${step.name}`);   // reset 은 시작 메시지를 안 보내는 동글도 있어 넘어간다
    }
    this.onStatus('스캔 중');
  }

  /** 명령 1건 보내고 응답(채널 응답 코드 0, 또는 시작 메시지)을 기다린다. */
  command(step) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter(w => w !== waiter); resolve(false); }, REPLY_MS);
      const waiter = msg => {
        if (step.expect === MSG.STARTUP ? msg.id === MSG.STARTUP : channelResponse(msg)?.to === step.expect) {
          clearTimeout(timer); resolve(step.expect === MSG.STARTUP || channelResponse(msg).code === 0); return true;
        }
        return false;
      };
      this.waiters.push(waiter);
      this.device.transferOut(this.ep.output, step.bytes).catch(() => { clearTimeout(timer); resolve(false); });
    });
  }

  async readLoop() {
    while (this.running) {
      let r;
      try { r = await this.device.transferIn(this.ep.input, this.ep.packetSize); }
      catch (e) { if (this.running) { this.running = false; this.onStatus('끊김'); } return; }
      if (r.status !== 'ok' || !r.data) continue;
      const t = this.now();
      for (const msg of this.parser.push(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength))) {
        const hit = this.waiters.find(w => w(msg));
        if (hit) { this.waiters = this.waiters.filter(w => w !== hit); continue; }
        const b = parseBroadcast(msg);
        if (b) this.onPacket(t, b);
      }
    }
  }

  async stop() {
    this.running = false;
    try { await this.device.close(); } catch { /* 이미 빠짐 */ }
    this.onStatus('멈춤');
  }
}
