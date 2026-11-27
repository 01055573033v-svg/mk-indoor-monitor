// 3단계(11-27): 동글 자동 재연결. 동글 하나 = DongleLink 하나. 전송(WebUsbTransport)이 끊기면(읽기 실패·USB 빠짐)
// 1·2·4·8·10초… 간격으로 같은 동글을 다시 열어 본다. 동글을 뽑았다 다시 꽂으면 크롬이 새 장치로 알려 주므로(replug) 바로 다시 연다.
// 처음 열기부터 실패한 동글은 재시도하지 않는다(키·다른 프로그램 문제는 「연결 진단」에서 사람이 고칠 일).
// 실물 동글 전 코드다 — 시험은 test/reconnect.test.js 의 가짜 동글·가짜 시계로 한다.
export const BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 10000]);
/** 이만큼 연속 실패하면 멈추고 「다시 연결 못 함」(약 4분). 사람이 다시 꽂으면 replug 로 다시 시작한다. */
export const MAX_TRIES = 25;

export const LINK_LABEL = Object.freeze({ connecting: '여는 중', up: '스캔 중', retrying: '다시 연결 중', failed: '다시 연결 못 함', stopped: '멈춤' });

export class DongleLink {
  /**
   * makeTransport(device) → { start({onPacket,onStatus,onClose}), stop(), diag }.
   * onPacket(t, broadcast) 는 hub.receive 로, onChange(link) 는 화면 갱신용.
   */
  constructor({ name, device, makeTransport, onPacket, onChange = () => {}, schedule = (fn, ms) => setTimeout(fn, ms), cancel = clearTimeout, now = () => performance.now() }) {
    Object.assign(this, { name, device, makeTransport, onPacket, onChange, schedule, cancel, now });
    this.state = 'connecting'; this.transport = null; this.tries = 0; this.timer = null; this.nextAt = null;
    this.everUp = false; this.reconnects = 0; this.downSince = null; this.downMs = 0; this.reason = '';
  }

  /** 처음 열기. 실패하면 오류를 그대로 던진다(재시도 없음). */
  async connect() { await this.open(); }

  async open() {
    this.state = this.everUp ? 'retrying' : 'connecting'; this.onChange(this);
    const t = this.makeTransport(this.device);
    this.transport = t; this.opening = true;
    try {
      await t.start({ onPacket: (at, b) => this.onPacket(at, b), onStatus: () => {}, onClose: reason => this.lost(reason, t) });
    } catch (e) {
      this.opening = false;
      try { await t.stop(); } catch { /* 이미 닫힘 */ }
      if (!this.everUp) { this.state = 'failed'; this.reason = e.message; this.onChange(this); throw e; }
      this.reason = e.message; this.retry(); return;
    }
    this.opening = false;
    if (this.state === 'stopped') { await t.stop(); return; }
    if (this.everUp) { this.reconnects++; this.downMs += this.now() - this.downSince; }
    this.everUp = true; this.state = 'up'; this.tries = 0; this.downSince = null; this.nextAt = null; this.reason = '';
    this.onChange(this);
  }

  /** 전송이 끊김을 알림. 지금 쓰는 전송의 알림만 받는다(옛 전송의 늦은 알림 무시). */
  lost(reason, from = this.transport) {
    if (from !== this.transport || this.state === 'stopped' || this.state === 'retrying' || this.state === 'failed') return;
    this.reason = reason; this.downSince ??= this.now(); this.retry();
  }

  retry() {
    if (this.state === 'stopped') return;
    if (this.tries >= MAX_TRIES) { this.state = 'failed'; this.nextAt = null; this.onChange(this); return; }
    const wait = BACKOFF_MS[Math.min(this.tries, BACKOFF_MS.length - 1)];
    this.tries++; this.state = 'retrying'; this.nextAt = this.now() + wait; this.onChange(this);
    this.cancel(this.timer);
    this.timer = this.schedule(() => { this.timer = null; this.open(); }, wait);
  }

  /** 크롬이 같은 동글을 다시 꽂았다고 알림(새 장치 객체). 끊긴 상태면 기다리지 않고 바로 연다. */
  replug(device) {
    if (this.state === 'up' || this.state === 'connecting' || this.state === 'stopped') return false;
    this.device = device; this.tries = 0; this.cancel(this.timer); this.timer = null;
    this.downSince ??= this.now(); this.everUp = true;
    if (!this.opening) this.open();   // 여는 중이면 그 시도가 실패한 뒤 새 장치로 다시 연다
    return true;
  }

  /** USB 빠짐 이벤트: 읽기 실패보다 먼저 올 수 있다. */
  unplugged() { this.lost('동글이 빠졌습니다', this.transport); }

  async stop() {
    this.state = 'stopped'; this.cancel(this.timer); this.timer = null; this.nextAt = null; this.onChange(this);
    try { await this.transport?.stop(); } catch { /* 이미 닫힘 */ }
  }

  /** 화면 한 줄: 상태 이름 · 다음 시도까지 초 · 끊긴 시간 · 다시 연결 횟수. */
  view(now = this.now()) {
    const nextIn = this.nextAt === null ? null : Math.max(0, Math.ceil((this.nextAt - now) / 1000));
    const downFor = this.downSince === null ? null : Math.floor((now - this.downSince) / 1000);
    const label = this.state === 'retrying' ? `${LINK_LABEL.retrying} (${this.tries}번째${nextIn === null ? '' : ` · ${nextIn}초 뒤`})` : LINK_LABEL[this.state];
    return { name: this.name, state: this.state, label, nextIn, downFor, reconnects: this.reconnects, reason: this.reason };
  }
}

/** 크롬이 알린 새 장치가 끊긴 링크 중 어느 것의 동글인가: 일련번호가 같으면 그것, 없으면 같은 기종의 끊긴 링크가 하나뿐일 때만. */
export function matchReplug(links, device) {
  const down = links.filter(l => l.state === 'retrying' || l.state === 'failed');
  const sn = device.serialNumber || null;
  if (sn) { const same = down.find(l => l.device?.serialNumber === sn); if (same) return same; }
  const kin = down.filter(l => l.device?.vendorId === device.vendorId && l.device?.productId === device.productId && !(sn && l.device?.serialNumber && l.device.serialNumber !== sn));
  return kin.length === 1 ? kin[0] : null;
}
