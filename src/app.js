// 화면 묶기. 전송(WebUSB·모의 센서)은 hub.receive 만 부르고, 화면은 1초마다 hub.snapshot 만 읽는다.
// 2단계: 훈련 세션(목표 구간·그래프) · 목표 와트 비교 · 끝나면 요약 저장 · V2 명단 파일(FTP·그룹).
import { Hub, LEVELS } from './core/hub.js';
import { Settings, GROUPS } from './core/settings.js';
import { parseNetworkKey, sensorKey, parseBroadcast } from './ant/scan.js';
import { Parser } from './ant/message.js';
import { WebUsbTransport, pickDongle, knownDongles } from './transport/webusb.js';
import { MockField, MockDongle, MockRider } from './transport/mock.js';
import { PRESETS, checkPlan, totalSec, targetWatts, compare, SessionRun, mmss } from './core/session.js';
import { Recorder, loadHistory, saveToHistory, removeFromHistory, toCsv } from './core/record.js';
import { FileRosterSource, applyRoster, exportRoster } from './core/roster.js';
import { zoneOf } from './core/zones.js';

const $ = id => document.getElementById(id);
const KEY_STORE = 'mk-indoor-monitor.netkey';
const NAMES = ['A', 'B', 'C', 'D'];
let settings = new Settings(localStorage), hub = new Hub(settings), mock = null, size = 2;
let run = null, recorder = null, customPlan = null, lastResult = null;
const transports = new Map();
const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dash = v => v === null || v === undefined ? '—' : v;

function notice(text) { const n = $('notice'); n.textContent = text; n.hidden = !text; }

// ── 타일 ──
const tiles = new Map(), trail = new Map();   // trail: 선수별 최근 90초 { p, lo, hi } (그래프용, 화면에만)
const TRAIL = 90;
function buildBoard() {
  const board = $('board'); board.replaceChildren(); tiles.clear(); trail.clear();
  for (const code of settings.codes()) {
    const el = document.createElement('article'); el.className = 'tile'; el.dataset.level = LEVELS.NONE;
    el.innerHTML = '<div class="head"><span><span class="code"></span><span class="grp"></span></span><span class="state"></span></div><div class="mid"><div class="watts"></div><svg class="spark" viewBox="0 0 90 100" preserveAspectRatio="none" aria-hidden="true"></svg></div><div class="target" hidden></div><div class="sub"><span class="ftp"></span><span class="cad"></span><span class="hr"></span></div><span class="zone" hidden></span><span class="via" hidden></span>';
    el.querySelector('.code').textContent = code;
    board.append(el); tiles.set(code, el); trail.set(code, []);
  }
}
const show = (v, unit) => v === null || v === undefined ? '—' : `${v}${unit}`;

function sparkSvg(points) {
  if (points.length < 2) return '';
  const top = Math.max(50, ...points.map(x => Math.max(x.p ?? 0, x.hi ?? 0))) * 1.1, y = w => (100 - w / top * 100).toFixed(1);
  const off = TRAIL - points.length;
  const band = points.map((x, i) => x.lo === null ? null : [i + off, x.lo, x.hi]).filter(Boolean);
  const bandPath = band.length ? `<polygon fill="#22c55e" opacity=".35" points="${band.map(([i, , hi]) => `${i},${y(hi)}`).join(' ')} ${band.slice().reverse().map(([i, lo]) => `${i},${y(lo)}`).join(' ')}"/>` : '';
  const line = points.map((x, i) => x.p === null ? null : `${i + off},${y(x.p)}`).filter(Boolean).join(' ');
  return `${bandPath}<polyline fill="none" stroke="#f3f6f9" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${line}"/>`;
}

function render() {
  const now = performance.now(), view = hub.snapshot(now);
  const pos = run ? run.at(now) : null;
  if (run && pos.done && !run.finished) finishSession(now);
  for (const t of view.tiles) {
    const el = tiles.get(t.code); if (!el) continue;
    const group = settings.group(t.code), ftp = settings.ftp(t.code);
    const target = run && pos && run.includes(group) ? targetWatts(pos.step, ftp) : null, cmp = compare(t.power, target);
    el.dataset.level = t.level;
    el.dataset.cmp = cmp?.state ?? '';
    el.classList.toggle('hidden', t.level === LEVELS.NONE && $('pair').getAttribute('aria-pressed') !== 'true' && hideEmpty);
    el.classList.toggle('alerting', !!t.alerting);
    el.querySelector('.grp').textContent = group ?? '';
    el.querySelector('.state').textContent = t.level === LEVELS.OK ? '' : t.lost.length ? `${t.level} · ${t.lost.map(r => ({ power: '파워', hr: '심박', cadence: '케이던스' })[r]).join('·')}` : t.level;
    el.querySelector('.watts').innerHTML = t.power === null ? '—' : `${t.power}<small>W</small>`;
    const tg = el.querySelector('.target');
    tg.hidden = !(run && run.includes(group) && pos.step.lo !== null);
    tg.dataset.cmp = cmp?.state ?? '';
    tg.textContent = !target ? (ftp ? '' : '목표: FTP 없음') : `목표 ${target.low}–${target.high}W · ${!cmp ? '—' : cmp.state === 'in' ? '✓ 범위 안' : cmp.state === 'low' ? `▼ ${-cmp.diff}W 낮음` : `▲ ${cmp.diff}W 높음`}`;
    el.querySelector('.ftp').textContent = t.ftpPercent === null ? 'FTP —' : `${t.ftpPercent}%`;
    el.querySelector('.cad').textContent = show(t.cadence, ' rpm');
    el.querySelector('.hr').textContent = show(t.hr, ' bpm');
    const z = el.querySelector('.zone'); z.hidden = !t.zone; if (t.zone) { z.textContent = t.zone.key; z.style.background = t.zone.color; z.title = t.zone.name; }
    const via = el.querySelector('.via'); via.hidden = !t.via; via.textContent = t.via ? `${t.via} 경유` : '';
    const tr = trail.get(t.code); tr.push({ p: t.power, lo: target?.low ?? null, hi: target?.high ?? null }); if (tr.length > TRAIL) tr.shift();
    el.querySelector('.spark').innerHTML = sparkSvg(tr);
  }
  if (recorder && run && !run.finished) recorder.tick(now, view.tiles);
  renderSession(pos);
  if (view.alerts.length) beep();
  $('dongles').replaceChildren(...view.dongles.map(d => { const s = document.createElement('span');
    s.textContent = `동글 ${d.name}: ${d.status} · 센서 ${d.sensors} · 초당 ${d.perSecond ?? '—'}건 · 빠짐 ${d.missing === null ? '—' : Math.round(d.missing * 100) + '%'} · 다시 연결 ${d.reconnects}`; return s; }));
  renderUnpaired(view.unpaired);
}
let hideEmpty = false;

// ── 세션 그래프(구간 막대 · 지금 위치) ──
function profileSvg(plan, elapsed = null) {
  const total = totalSec(plan), top = Math.max(130, ...plan.steps.map(s => s.hi ?? 60)); let x = 0, out = '';
  for (const s of plan.steps) {
    const w = s.sec / total * 1000, hi = s.hi ?? 40, lo = s.lo ?? 40, zone = s.lo === null ? null : zoneOf((lo + hi) / 2, 100);
    out += `<rect x="${x.toFixed(1)}" y="${(100 - hi / top * 100).toFixed(1)}" width="${Math.max(0.5, w - 1).toFixed(1)}" height="${(hi / top * 100).toFixed(1)}" fill="${zone?.color ?? '#4b5563'}" opacity="${elapsed === null ? 0.9 : 0.75}"><title>${esc(s.label)} ${mmss(s.sec)}${s.lo === null ? '' : ` · ${s.lo}~${s.hi}%FTP`}</title></rect>`;
    x += w;
  }
  if (elapsed !== null) { const cx = (elapsed / total * 1000).toFixed(1); out += `<rect x="0" y="0" width="${cx}" height="100" fill="#000" opacity=".35"/><line x1="${cx}" x2="${cx}" y1="0" y2="100" stroke="#fff" stroke-width="3" vector-effect="non-scaling-stroke"/>`; }
  return out;
}
function renderSession(pos) {
  $('session').hidden = !run; $('board').classList.toggle('in-session', !!run);
  if (!run) return;
  const st = pos.step;
  $('s-step').textContent = `${pos.index + 1}/${run.plan.steps.length} ${st.label}`;
  $('s-range').textContent = st.lo === null ? '자유' : `${st.lo}~${st.hi}%FTP`;
  $('s-left').textContent = pos.paused ? `일시정지 ${mmss(pos.stepRemaining)}` : mmss(pos.stepRemaining);
  $('s-name').textContent = `${run.plan.name}${run.group ? ` · ${run.group}만` : ''}`;
  $('s-total').textContent = `${mmss(pos.elapsed)} / ${mmss(pos.total)}`;
  $('s-next').textContent = pos.next ? `${pos.next.label}${pos.next.lo === null ? '' : ` ${pos.next.lo}~${pos.next.hi}%`}` : '끝';
  $('s-pause').textContent = pos.paused ? '다시 시작' : '일시정지';
  $('s-profile').innerHTML = profileSvg(run.plan, pos.elapsed);
}

// ── 세션 시작·끝 ──
function selectedPlan() { return $('preset').value === 'custom' && customPlan ? customPlan : PRESETS.find(p => p.id === $('preset').value) ?? PRESETS[0]; }
function fillPresets() {
  $('preset').replaceChildren(...PRESETS.map(p => new Option(`${p.name} (${mmss(totalSec(p))})`, p.id)), ...(customPlan ? [new Option(`파일: ${customPlan.name} (${mmss(totalSec(customPlan))})`, 'custom')] : []));
}
function previewPlan() {
  const plan = selectedPlan();
  $('preview-source').textContent = `${mmss(totalSec(plan))}${plan.source ? ` · 출처: ${plan.source}` : ''}`;
  $('target-group').value = (plan.groups ?? []).join(',');
  $('preview').innerHTML = profileSvg(plan);
  $('preview-steps').replaceChildren(...plan.steps.map(s => { const li = document.createElement('li'); li.textContent = `${s.label} ${mmss(s.sec)}${s.lo === null ? ' · 자유' : ` · ${s.lo}~${s.hi}%FTP`}`; return li; }));
}
$('session-btn').addEventListener('click', () => {
  if (run) { notice('세션이 진행 중입니다. 끝낸 뒤 새로 시작하세요.'); return; }
  fillPresets(); previewPlan(); $('session-dialog').showModal();
});
$('preset').addEventListener('change', previewPlan);
$('plan-file').addEventListener('change', async e => {
  const f = e.target.files?.[0]; if (!f) return;
  try { customPlan = checkPlan(JSON.parse(await f.text())); fillPresets(); $('preset').value = 'custom'; previewPlan(); notice(''); }
  catch (err) { notice(`세션 파일: ${err.message}`); }
  e.target.value = '';
});
$('start-session').addEventListener('click', () => {
  audio ??= new AudioContext(); keepAwake();
  const now = performance.now();
  run = new SessionRun(selectedPlan(), { group: $('target-group').value || null }).start(now);
  recorder = new Recorder(run, settings, { mock: !!mock });
  mock?.stepRiders();
  for (const tr of trail.values()) tr.length = 0;
  render();
});
$('s-pause').addEventListener('click', () => { if (!run) return; const now = performance.now(); run.paused ? run.resume(now) : run.pause(now); render(); });
$('s-stop').addEventListener('click', () => { if (run) finishSession(performance.now()); });

function finishSession(now) {
  run.stop(now); run.finished = true;
  const summary = recorder.summary(now);
  try { if (summary.athletes.length) saveToHistory(localStorage, summary); } catch (e) { notice(`기록 저장 못 함: ${e.message}`); }
  run = null; recorder = null; beep();
  showResult(summary); render();
}

// ── 결과 ──
function resultTable(s) {
  const head = `<tr><th>선수</th><th>그룹</th><th>FTP</th><th>평균W</th><th>최대W</th><th>목표 안</th><th>평균 심박</th><th>최대 심박</th><th>평균 rpm</th><th>kJ</th><th>기록률</th>${s.plan.steps.map((st, i) => `<th title="${esc(st.label)}">${i + 1}. ${esc(st.label)}</th>`).join('')}</tr>`;
  const rows = s.athletes.map(a => `<tr><td>${esc(a.code)}</td><td>${esc(a.group ?? '—')}</td><td>${dash(a.ftp)}</td><td>${dash(a.avgPower)}</td><td>${dash(a.maxPower)}</td><td>${a.inTarget === null ? '—' : a.inTarget + '%'}</td><td>${dash(a.avgHr)}</td><td>${dash(a.maxHr)}</td><td>${dash(a.avgCadence)}</td><td>${dash(a.kj)}</td><td>${a.recorded}%</td>${a.steps.map(x => `<td>${dash(x.avgPower)}${x.inTarget === null ? '' : ` <small>${x.inTarget}%</small>`}</td>`).join('')}</tr>`).join('');
  return head + rows;
}
function showResult(s) {
  lastResult = s;
  $('r-title').textContent = `세션 결과 — ${s.plan.name}${s.mock ? ' (모의)' : ''}`;
  $('r-meta').textContent = `${new Date(s.startedAt).toLocaleString('ko-KR')} 시작 · ${mmss(s.seconds)}${s.complete ? '' : ' (중간에 끝냄)'} · ${s.group ? s.group + '만' : '전체'} · 선수 ${s.athletes.length}명 · 이 크롬에 요약 저장됨`;
  $('r-table').innerHTML = s.athletes.length ? resultTable(s) : '<tr><td>기록된 선수가 없습니다(센서 짝·대상 그룹을 확인하세요).</td></tr>';
  if (!$('result').open) $('result').showModal();
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const localStamp = iso => { const d = new Date(iso), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };
const fileStem = s => `실내세션_${localStamp(s.startedAt)}${s.mock ? '_모의' : ''}`;
const csvOut = s => download(`${fileStem(s)}.csv`, '﻿' + toCsv(s), 'text/csv;charset=utf-8');
const jsonOut = s => download(`${fileStem(s)}.json`, JSON.stringify(s, null, 1), 'application/json');
$('r-csv').addEventListener('click', () => lastResult && csvOut(lastResult));
$('r-json').addEventListener('click', () => lastResult && jsonOut(lastResult));

// ── 지난 기록 ──
function renderHistory() {
  const list = loadHistory(localStorage);
  $('h-table').innerHTML = list.length ? `<tr><th>시작</th><th>세션</th><th>길이</th><th>인원</th><th>평균 목표 안</th><th></th></tr>` + list.map((s, i) => {
    const ins = s.athletes.map(a => a.inTarget).filter(v => v !== null), mean = ins.length ? Math.round(ins.reduce((a, b) => a + b, 0) / ins.length) + '%' : '—';
    return `<tr><td>${esc(new Date(s.startedAt).toLocaleString('ko-KR'))}</td><td>${esc(s.plan.name)}${s.mock ? ' <small>(모의)</small>' : ''}</td><td>${mmss(s.seconds)}</td><td>${s.athletes.length}</td><td>${mean}</td>
      <td><button type="button" data-i="${i}" data-act="open">보기</button> <button type="button" data-i="${i}" data-act="csv">CSV</button> <button type="button" data-i="${i}" data-act="del">지우기</button></td></tr>`;
  }).join('') : '<tr><td>저장된 세션이 없습니다.</td></tr>';
}
$('history-btn').addEventListener('click', () => { renderHistory(); $('history').showModal(); });
$('h-table').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const s = loadHistory(localStorage)[Number(b.dataset.i)]; if (!s) return;
  if (b.dataset.act === 'open') { $('history').close(); showResult(s); }
  if (b.dataset.act === 'csv') csvOut(s);
  if (b.dataset.act === 'del') { removeFromHistory(localStorage, s.startedAt); renderHistory(); }
});

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

// ── 소리: 끊김 경보 1번(같은 타일 5초 안 재알림 없음은 Hub 가 정함) · 세션 끝 ──
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

// ── 모의 센서: 동글 없이 화면·경보·세션 확인. 진짜 설정은 건드리지 않는 별도 메모리 설정 ──
// 모의 선수: P01~04 중E · P05~08 중S · P09~12 고E · P13~16 고S, FTP 는 진짜 설정 값(없으면 그룹별 가짜 값).
function startMock() {
  if (run) finishSession(performance.now());
  const n = settings.data.athletes, real = settings;
  settings = new Settings(memory()); settings.setAthletes(n);
  for (const [i, c] of real.codes().entries()) {
    const g = real.group(c) ?? GROUPS[Math.min(3, Math.floor(i / 4))];
    settings.setGroup(c, g); settings.setFtp(c, real.ftp(c) ?? (g.startsWith('중') ? 190 : 250) + (i % 4) * 15);
  }
  hub = new Hub(settings);
  const field = MockField.room(n), dongles = ['A', 'B', 'C'].map((name, i) => ({ d: new MockDongle(name, { seed: 5 + i, drop: 0.03 }), p: new Parser() }));
  field.sensors.forEach((s, i) => settings.assign(sensorKey(s), 'P' + String(Math.floor(i / 2) + 1).padStart(2, '0'), s.deviceType === 120 ? 'hr' : 'power'));
  const riders = settings.codes().map((c, i) => ({ code: c, rider: new MockRider(field.sensors[i * 2], field.sensors[i * 2 + 1], 7919 * (i + 1)) }));
  dongles.forEach(({ d }) => hub.setDongleStatus(d.name, '모의'));
  const t0 = performance.now();
  mock = { real, field, timer: setInterval(() => {
    const now = performance.now(), tx = field.step(now - t0);
    for (const { d, p } of dongles) for (const c of d.chunks(tx)) for (const m of p.push(c)) hub.receive(d.name, now, parseBroadcast(m));
  }, 50) };
  // 세션 중이면 모의 선수가 1초마다 목표를 따라 밟는다(선수마다 실력 배율이 달라 목표 안·밖이 섞여 보임).
  mock.stepRiders = () => {
    if (!run || run.paused) return;
    const pos = run.at(performance.now());
    for (const { code, rider } of riders) if (run.includes(settings.group(code))) rider.step(targetWatts(pos.step, settings.ftp(code)), settings.ftp(code));
  };
  mock.follow = setInterval(mock.stepRiders, 1000);
  // 시험용: 20초마다 선수 1명 센서를 4초 멈춰 끊김 경보를 보여 준다.
  mock.chaos = setInterval(() => { const s = field.sensors[Math.floor(Math.random() * field.sensors.length)]; s.silent = true; setTimeout(() => { s.silent = false; }, 4000); }, 20000);
  $('mock').setAttribute('aria-pressed', 'true'); notice('모의 센서로 보는 중입니다(실제 센서 아님). 「훈련 세션」으로 목표 비교를 시험할 수 있습니다.');
  buildBoard();
}
function stopMock() {
  if (!mock) return;
  if (run) finishSession(performance.now());
  clearInterval(mock.timer); clearInterval(mock.chaos); clearInterval(mock.follow); settings = mock.real; hub = new Hub(settings); mock = null;
  $('mock').setAttribute('aria-pressed', 'false'); notice(''); buildBoard();
}
$('mock').addEventListener('click', () => { audio ??= new AudioContext(); mock ? stopMock() : startMock(); });

// ── 설정(인원·FTP·그룹·명단 파일)·크기·전체 화면 ──
function fillSettings() {
  $('athletes').value = settings.data.athletes; $('netkey').value = localStorage.getItem(KEY_STORE) ?? '';
  $('ftp-list').replaceChildren(...settings.codes().map(c => {
    const l = document.createElement('label'); l.textContent = `${c} FTP`;
    const i = document.createElement('input'); Object.assign(i, { type: 'number', min: 50, max: 600, step: 1, value: settings.ftp(c) ?? '' }); i.dataset.code = c;
    const g = document.createElement('select'); g.dataset.code = c; g.setAttribute('aria-label', `${c} 그룹`);
    g.append(new Option('그룹 —', ''), ...GROUPS.map(x => new Option(x, x))); g.value = settings.group(c) ?? '';
    l.append(i, g); return l;
  }));
}
$('settings-btn').addEventListener('click', () => {
  if (mock) notice('모의 센서 중에는 설정이 모의용 메모리에만 바뀝니다. 진짜 설정은 모의를 끈 뒤 바꾸세요.');
  fillSettings(); $('settings').showModal();
});
$('save-settings').addEventListener('click', () => {
  try {
    settings.setAthletes(Number($('athletes').value));
    for (const i of $('ftp-list').querySelectorAll('input')) settings.setFtp(i.dataset.code, i.value === '' ? '' : Number(i.value));
    for (const g of $('ftp-list').querySelectorAll('select')) settings.setGroup(g.dataset.code, g.value);
    const k = $('netkey').value.trim();
    if (k && !parseNetworkKey(k)) throw new Error('네트워크 키는 16자리 16진수입니다');
    if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE);
    notice(''); buildBoard();
  } catch (e) { notice(e.message); }
});
$('roster-file').addEventListener('change', async e => {
  const f = e.target.files?.[0]; if (!f) return;
  try {
    const roster = await new FileRosterSource(f).load(), changed = applyRoster(settings, roster);
    notice(`명단 반영: FTP ${changed.ftp}명 · 그룹 ${changed.group}명 바뀜${roster.warnings.length ? ` · 확인 ${roster.warnings.length}건: ${roster.warnings.slice(0, 3).join(' / ')}` : ''}`);
    fillSettings(); buildBoard();
  } catch (err) { notice(`명단 파일: ${err.message}`); }
  e.target.value = '';
});
$('roster-export').addEventListener('click', () => download('실내모니터_명단.json', JSON.stringify(exportRoster(settings), null, 1), 'application/json'));
$('pair').addEventListener('click', e => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', String(on)); $('board').classList.toggle('pairing', on); render(); });
$('size').addEventListener('click', () => { size = size % 3 + 1; $('board').classList.remove('size-1', 'size-2', 'size-3'); $('board').classList.add(`size-${size}`); hideEmpty = size === 1; });
$('full').addEventListener('click', () => { keepAwake(); document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); });

buildBoard(); render(); setInterval(render, 1000);
