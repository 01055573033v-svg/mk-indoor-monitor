// 화면 묶기. 전송(WebUSB·모의 센서)은 hub.receive 만 부르고, 화면은 1초마다 hub.snapshot 만 읽는다.
import { Hub, LEVELS } from './core/hub.js';
import { Settings } from './core/settings.js';
import { parseNetworkKey, sensorKey } from './ant/scan.js';
import { Parser } from './ant/message.js';
import { parseBroadcast } from './ant/scan.js';
import { WebUsbTransport, pickDongle, knownDongles } from './transport/webusb.js';
import { MockField, MockDongle } from './transport/mock.js';

const $ = id => document.getElementById(id);
const KEY_STORE = 'mk-indoor-monitor.netkey';
const NAMES = ['A', 'B', 'C', 'D'];
let settings = new Settings(localStorage), hub = new Hub(settings), mock = null, size = 2;
const transports = new Map();
const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

function notice(text) { const n = $('notice'); n.textContent = text; n.hidden = !text; }

// ── 타일 ──
const tiles = new Map();
function buildBoard() {
  const board = $('board'); board.replaceChildren(); tiles.clear();
  for (const code of settings.codes()) {
    const el = document.createElement('article'); el.className = 'tile'; el.dataset.level = LEVELS.NONE;
    el.innerHTML = '<div class="head"><span class="code"></span><span class="state"></span></div><div class="watts"></div><div class="sub"><span class="ftp"></span><span class="cad"></span><span class="hr"></span></div><span class="zone" hidden></span><span class="via" hidden></span>';
    el.querySelector('.code').textContent = code;
    board.append(el); tiles.set(code, el);
  }
}
const show = (v, unit) => v === null || v === undefined ? '—' : `${v}${unit}`;
function render() {
  const now = performance.now(), view = hub.snapshot(now);
  for (const t of view.tiles) {
    const el = tiles.get(t.code); if (!el) continue;
    el.dataset.level = t.level;
    el.classList.toggle('hidden', t.level === LEVELS.NONE && $('pair').getAttribute('aria-pressed') !== 'true' && hideEmpty);
    el.classList.toggle('alerting', !!t.alerting);
    el.querySelector('.state').textContent = t.level === LEVELS.OK ? '' : t.lost.length ? `${t.level} · ${t.lost.map(r => ({ power: '파워', hr: '심박', cadence: '케이던스' })[r]).join('·')}` : t.level;
    el.querySelector('.watts').innerHTML = t.power === null ? '—' : `${t.power}<small>W</small>`;
    el.querySelector('.ftp').textContent = t.ftpPercent === null ? 'FTP —' : `${t.ftpPercent}%`;
    el.querySelector('.cad').textContent = show(t.cadence, ' rpm');
    el.querySelector('.hr').textContent = show(t.hr, ' bpm');
    const z = el.querySelector('.zone'); z.hidden = !t.zone; if (t.zone) { z.textContent = t.zone.key; z.style.background = t.zone.color; z.title = t.zone.name; }
    const via = el.querySelector('.via'); via.hidden = !t.via; via.textContent = t.via ? `${t.via} 경유` : '';
  }
  if (view.alerts.length) beep();
  $('dongles').replaceChildren(...view.dongles.map(d => { const s = document.createElement('span');
    s.textContent = `동글 ${d.name}: ${d.status} · 센서 ${d.sensors} · 초당 ${d.perSecond ?? '—'}건 · 빠짐 ${d.missing === null ? '—' : Math.round(d.missing * 100) + '%'} · 다시 연결 ${d.reconnects}`; return s; }));
  renderUnpaired(view.unpaired);
}
let hideEmpty = false;

// ── 짝 맞추기: 들리는데 짝이 없는 센서 → 선수 코드·종류 지정 ──
function renderUnpaired(list) {
  const panel = $('unpaired'), on = $('pair').getAttribute('aria-pressed') === 'true';
  panel.hidden = !on; if (!on) return;
  if (document.activeElement && panel.contains(document.activeElement)) return;   // 고르는 중에는 다시 그리지 않음
  const rows = list.map(s => `<tr data-key="${s.key}"><td>${s.type}</td><td>…${s.tail}</td><td>${s.power !== null ? s.power + 'W' : s.hr !== null ? s.hr + 'bpm' : s.cadence !== null ? s.cadence + 'rpm' : '—'}</td>
    <td><select aria-label="선수 코드">${settings.codes().map(c => `<option>${c}</option>`).join('')}</select> <button type="button" data-role="${s.role}">지정</button></td></tr>`).join('');
  panel.innerHTML = `<h3>짝 없는 센서 ${list.length}개 <small>선수가 페달을 밟으면 값이 바뀌는 줄이 그 선수 센서입니다</small></h3><table><thead><tr><th>종류</th><th>번호 뒤 2자리</th><th>지금 값</th><th>선수</th></tr></thead><tbody>${rows}</tbody></table>`;
}
$('unpaired').addEventListener('click', e => {
  const b = e.target.closest('button[data-role]'); if (!b) return;
  const tr = b.closest('tr'); settings.assign(tr.dataset.key, tr.querySelector('select').value, b.dataset.role); b.blur(); render();
});

// ── 소리: 끊김 경보 1번(같은 타일 5초 안 재알림 없음은 Hub 가 정함) ──
let audio = null;
function beep() {
  try { audio ??= new AudioContext(); const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = 880; g.gain.value = 0.2; o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.25); } catch { /* 소리 못 냄 */ }
}
async function keepAwake() { try { await navigator.wakeLock?.request('screen'); } catch { /* 지원 안 함 */ } }

// ── 동글 ──
async function openDongle(device) {
  const key = parseNetworkKey(localStorage.getItem(KEY_STORE));
  if (!key) { notice('설정에서 ANT+ 네트워크 키를 먼저 넣어 주세요.'); $('settings-btn').click(); return; }
  const name = NAMES.find(n => ![...transports.values()].some(t => t.name === n)) ?? `D${transports.size + 1}`;
  const t = new WebUsbTransport(device, { name, networkKey: key });
  transports.set(device, t);
  try { await t.start({ onPacket: (at, b) => hub.receive(name, at, b), onStatus: s => hub.setDongleStatus(name, s) }); notice(''); }
  catch (e) { hub.setDongleStatus(name, '실패'); notice(`동글 ${name}: ${e.message}`); transports.delete(device); }
}
$('connect').addEventListener('click', async () => {
  stopMock(); keepAwake(); audio ??= new AudioContext();
  try { const device = await pickDongle(); if (!transports.has(device)) await openDongle(device); }
  catch (e) { if (e.name !== 'NotFoundError') notice(e.message); }
});
navigator.usb?.addEventListener('connect', e => { const t = [...transports.values()].find(x => x.device === e.device); if (!t) openDongle(e.device); });
navigator.usb?.addEventListener('disconnect', e => { const t = transports.get(e.device); if (t) { hub.setDongleStatus(t.name, '끊김'); transports.delete(e.device); } });
knownDongles().then(list => { if (list.length && parseNetworkKey(localStorage.getItem(KEY_STORE))) list.forEach(openDongle); });

// ── 모의 센서: 동글 없이 화면·경보 확인. 진짜 설정은 건드리지 않는 별도 메모리 설정 ──
function startMock() {
  const n = settings.data.athletes, real = settings;
  settings = new Settings(memory()); settings.setAthletes(n);
  for (const c of real.codes()) settings.setFtp(c, real.ftp(c) ?? 250);   // 모의: FTP 없으면 250W 로 존 색을 보여 줌
  hub = new Hub(settings);
  const field = MockField.room(n), dongles = ['A', 'B', 'C'].map((name, i) => ({ d: new MockDongle(name, { seed: 5 + i, drop: 0.03 }), p: new Parser() }));
  field.sensors.forEach((s, i) => settings.assign(sensorKey(s), 'P' + String(Math.floor(i / 2) + 1).padStart(2, '0'), s.deviceType === 120 ? 'hr' : 'power'));
  dongles.forEach(({ d }) => hub.setDongleStatus(d.name, '모의'));
  const t0 = performance.now();
  mock = { real, field, timer: setInterval(() => {
    const now = performance.now(), tx = field.step(now - t0);
    for (const { d, p } of dongles) for (const c of d.chunks(tx)) for (const m of p.push(c)) hub.receive(d.name, now, parseBroadcast(m));
  }, 50) };
  // 시험용: 8초마다 선수 1명 센서를 4초 멈춰 끊김 경보를 보여 준다.
  mock.chaos = setInterval(() => { const s = field.sensors[Math.floor(Math.random() * field.sensors.length)]; s.silent = true; setTimeout(() => { s.silent = false; }, 4000); }, 8000);
  $('mock').setAttribute('aria-pressed', 'true'); notice('모의 센서로 보는 중입니다(실제 센서 아님).');
  buildBoard();
}
function stopMock() {
  if (!mock) return;
  clearInterval(mock.timer); clearInterval(mock.chaos); settings = mock.real; hub = new Hub(settings); mock = null;
  $('mock').setAttribute('aria-pressed', 'false'); notice(''); buildBoard();
}
$('mock').addEventListener('click', () => { audio ??= new AudioContext(); mock ? stopMock() : startMock(); });

// ── 설정·크기·전체 화면 ──
$('settings-btn').addEventListener('click', () => {
  $('athletes').value = settings.data.athletes; $('netkey').value = localStorage.getItem(KEY_STORE) ?? '';
  $('ftp-list').replaceChildren(...settings.codes().map(c => { const l = document.createElement('label'); l.textContent = `${c} FTP`; const i = document.createElement('input');
    Object.assign(i, { type: 'number', min: 50, max: 600, step: 1, value: settings.ftp(c) ?? '' }); i.dataset.code = c; l.append(i); return l; }));
  $('settings').showModal();
});
$('save-settings').addEventListener('click', () => {
  try {
    settings.setAthletes(Number($('athletes').value));
    for (const i of $('ftp-list').querySelectorAll('input')) settings.setFtp(i.dataset.code, i.value === '' ? '' : Number(i.value));
    const k = $('netkey').value.trim();
    if (k && !parseNetworkKey(k)) throw new Error('네트워크 키는 16자리 16진수입니다');
    if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE);
    notice(''); buildBoard();
  } catch (e) { notice(e.message); }
});
$('pair').addEventListener('click', e => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', String(on)); $('board').classList.toggle('pairing', on); render(); });
$('size').addEventListener('click', () => { size = size % 3 + 1; $('board').classList.remove('size-1', 'size-2', 'size-3'); $('board').classList.add(`size-${size}`); hideEmpty = size === 1; });
$('full').addEventListener('click', () => { keepAwake(); document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); });

buildBoard(); render(); setInterval(render, 1000);
