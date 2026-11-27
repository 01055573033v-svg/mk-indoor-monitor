// 2단계: V2 선수 FTP·그룹 연동 구조.
// 지금은 「명단 파일(JSON)」 한 가지 길만 연다: V2(또는 코치)가 만든 파일을 이 앱에서 불러와 FTP·그룹을 채운다.
// 나중에 V2 직접 연결을 붙여도 화면은 RosterSource.load() 결과(아래 형식)만 받으므로 바꿀 곳이 이 파일뿐이다.
//
// 형식(mk-indoor-roster v1) — P코드만. 실명·이메일·전화 같은 칸은 읽지 않고 버린다.
// { "format": "mk-indoor-roster", "version": 1, "source": "V2", "exportedAt": "2026-11-27T10:00:00+09:00",
//   "athletes": [ { "code": "P01", "group": "고E", "ftp": 250, "ftpDate": "2026-11-05" } ] }
import { CODE, GROUPS } from './settings.js';

export const ROSTER_FORMAT = 'mk-indoor-roster';
const ALLOWED = new Set(['code', 'group', 'ftp', 'ftpDate']);

/** 글(파일 내용) → { source, exportedAt, athletes[], warnings[] }. 형식이 틀리면 throw. */
export function parseRoster(text) {
  let d; try { d = JSON.parse(text); } catch { throw new Error('JSON 파일이 아닙니다'); }
  if (d?.format !== ROSTER_FORMAT || d?.version !== 1) throw new Error(`명단 형식(${ROSTER_FORMAT} v1)이 아닙니다`);
  if (!Array.isArray(d.athletes) || d.athletes.length === 0 || d.athletes.length > 24) throw new Error('선수는 1~24명');
  const warnings = [], seen = new Set(), athletes = [];
  for (const [i, a] of d.athletes.entries()) {
    const extra = Object.keys(a ?? {}).filter(k => !ALLOWED.has(k));
    if (extra.length) warnings.push(`${i + 1}번 줄: 쓰지 않는 칸(${extra.length}개)은 버렸습니다`);   // 칸 이름은 실명 칸일 수 있어 옮기지 않음
    const code = String(a?.code ?? '');
    if (!CODE.test(code)) { warnings.push(`${i + 1}번 줄: 선수 코드가 P01 꼴이 아니라 뺐습니다`); continue; }
    if (seen.has(code)) { warnings.push(`${code}: 두 번 나와 뒤의 것을 뺐습니다`); continue; }
    seen.add(code);
    const ftp = a.ftp === null || a.ftp === undefined || a.ftp === '' ? null : Number(a.ftp);
    if (ftp !== null && !(Number.isInteger(ftp) && ftp >= 50 && ftp <= 600)) { warnings.push(`${code}: FTP는 50~600W 정수가 아니라 비웠습니다`); }
    const group = a.group ?? null;
    if (group !== null && !GROUPS.includes(group)) warnings.push(`${code}: 그룹은 중E·중S·고E·고S 중 하나가 아니라 비웠습니다`);
    athletes.push({ code, ftp: ftp !== null && Number.isInteger(ftp) && ftp >= 50 && ftp <= 600 ? ftp : null,
      group: GROUPS.includes(group) ? group : null, ftpDate: /^\d{4}-\d{2}-\d{2}$/.test(a.ftpDate ?? '') ? a.ftpDate : null });
  }
  if (!athletes.length) throw new Error('쓸 수 있는 선수 줄이 없습니다');
  return { source: String(d.source ?? '').slice(0, 20), exportedAt: String(d.exportedAt ?? '').slice(0, 40), athletes, warnings };
}

/** 명단을 설정에 반영: 인원(가장 큰 코드까지 늘림, 줄이지 않음) · FTP · 그룹. 바뀐 개수를 돌려준다. */
export function applyRoster(settings, roster) {
  const top = Math.max(...roster.athletes.map(a => Number(a.code.slice(1))));
  if (top > settings.data.athletes) settings.setAthletes(Math.min(24, top));
  let ftp = 0, group = 0;
  for (const a of roster.athletes) {
    if (a.ftp !== null && settings.ftp(a.code) !== a.ftp) { settings.setFtp(a.code, a.ftp); ftp++; }
    if (a.group !== null && settings.group(a.code) !== a.group) { settings.setGroup(a.code, a.group); group++; }
  }
  return { ftp, group };
}

/** 지금 설정 → 같은 형식 파일(다른 맥으로 옮기기·V2 쪽 형식 맞추기 견본). */
export function exportRoster(settings, now = new Date()) {
  return { format: ROSTER_FORMAT, version: 1, source: '실내모니터', exportedAt: now.toISOString(),
    athletes: settings.codes().map(code => ({ code, group: settings.group(code), ftp: settings.ftp(code) })) };
}

/**
 * 명단 출처 틀. 화면은 load() 만 부른다.
 * - FileRosterSource: 지금 쓰는 길(파일 고르기).
 * - V2 직접 연결은 만들지 않았다: V2 는 팀 로그인 뒤에 있고, 실명→P코드 바꾸기와 내보내기 권한을 V2 쪽에서 정해야 한다(코치 결정).
 *   만들 때는 { name: 'V2', load: async () => parseRoster(await (await fetch(주소, { credentials })).text()) } 꼴 하나만 더한다.
 */
export class FileRosterSource {
  constructor(file) { this.file = file; this.name = '파일'; }
  async load() { return parseRoster(await this.file.text()); }
}
