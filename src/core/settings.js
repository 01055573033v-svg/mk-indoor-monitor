// 센서↔선수 코드 짝, FTP, 주 동글. 이 맥북 크롬(localStorage)에만 저장한다. 실명은 받지 않는다 — 코드는 P01~P99 꼴만.
// 1초 원본은 어디에도 저장하지 않는다. 2단계 세션 요약은 record.js 가 따로 남긴다.
export const STORE_KEY = 'mk-indoor-monitor.settings.v1';
export const CODE = /^P\d{2}$/;
// 그룹: V2 `lib/plan/group-calendar.ts` PlanGroup 과 같은 글자(중E·중S·고E·고S).
export const GROUPS = Object.freeze(['중E', '중S', '고E', '고S']);
const ROLES = ['power', 'hr', 'cadence'];
const DEFAULT = () => ({
  version: 1, athletes: 16, ftp: {}, groups: {}, sensors: {},
  // 설계안 §4-3 기본안: A=P01~P06, B=P07~P11, C=P12~P16(자리 배치는 코치가 정함).
  primary: { A: [1, 6], B: [7, 11], C: [12, 16] },
});

export class Settings {
  /** storage: { getItem, setItem } (브라우저 localStorage 또는 시험용 메모리). */
  constructor(storage) {
    this.storage = storage;
    let data = null;
    try { data = JSON.parse(storage?.getItem(STORE_KEY) ?? 'null'); } catch { data = null; }
    this.data = clean(data);
  }
  save() { this.storage?.setItem(STORE_KEY, JSON.stringify(this.data)); }
  codes() { return Array.from({ length: this.data.athletes }, (_, i) => 'P' + String(i + 1).padStart(2, '0')); }
  setAthletes(n) { if (!Number.isInteger(n) || n < 1 || n > 24) throw new Error('인원은 1~24명'); this.data.athletes = n; this.save(); }
  ftp(code) { return this.data.ftp[code] ?? null; }
  setFtp(code, watts) {
    if (!CODE.test(code)) throw new Error('선수 코드는 P01 꼴만 씁니다');
    const w = Number(watts);
    if (watts === '' || watts === null) delete this.data.ftp[code];
    else if (Number.isInteger(w) && w >= 50 && w <= 600) this.data.ftp[code] = w;
    else throw new Error('FTP는 50~600W 정수로 넣어 주세요');
    this.save();
  }
  group(code) { return this.data.groups[code] ?? null; }
  setGroup(code, group) {
    if (!CODE.test(code)) throw new Error('선수 코드는 P01 꼴만 씁니다');
    if (group === '' || group === null) delete this.data.groups[code];
    else if (GROUPS.includes(group)) this.data.groups[code] = group;
    else throw new Error('그룹은 중E·중S·고E·고S 중 하나');
    this.save();
  }
  assign(key, code, role) {
    if (!/^\d{1,3}:\d{1,7}$/.test(key)) throw new Error('센서 번호 형식이 아닙니다');
    if (!CODE.test(code) || !ROLES.includes(role)) throw new Error('선수 코드(P01 꼴)와 센서 종류가 필요합니다');
    // 한 선수의 같은 종류 센서는 1개: 새로 지정하면 앞의 것을 뗀다.
    for (const [k, v] of Object.entries(this.data.sensors)) if (v.code === code && v.role === role) delete this.data.sensors[k];
    this.data.sensors[key] = { code, role }; this.save();
  }
  unassign(key) { delete this.data.sensors[key]; this.save(); }
  sensorsOf(code) { return Object.entries(this.data.sensors).filter(([, v]) => v.code === code).map(([key, v]) => ({ key, role: v.role })); }
  pairedKeys() { return new Set(Object.keys(this.data.sensors)); }
  primaryDongle(code) {
    const n = Number(code.slice(1));
    for (const [name, [from, to]] of Object.entries(this.data.primary)) if (n >= from && n <= to) return name;
    return null;
  }
}

function clean(d) {
  const out = DEFAULT();
  if (!d || d.version !== 1) return out;
  if (Number.isInteger(d.athletes) && d.athletes >= 1 && d.athletes <= 24) out.athletes = d.athletes;
  for (const [code, w] of Object.entries(d.ftp ?? {})) if (CODE.test(code) && Number.isInteger(w) && w >= 50 && w <= 600) out.ftp[code] = w;
  for (const [code, g] of Object.entries(d.groups ?? {})) if (CODE.test(code) && GROUPS.includes(g)) out.groups[code] = g;
  for (const [key, v] of Object.entries(d.sensors ?? {})) if (/^\d{1,3}:\d{1,7}$/.test(key) && CODE.test(v?.code) && ROLES.includes(v?.role)) out.sensors[key] = { code: v.code, role: v.role };
  if (d.primary && typeof d.primary === 'object') out.primary = d.primary;
  return out;
}
