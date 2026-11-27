// 파워 존: V2 `lib/ftp.ts` powerZones 와 같은 경계(≤55 / ~75 / ~90 / ~105 / ~120 / >120 %FTP, 상한은 FTP×비율 내림, 다음 존은 +1W).
// 색은 V2 에 한곳에 모은 정의가 없어 이 앱에서 정한다. 색만으로 구분하지 않도록 화면엔 존 번호 글자를 함께 쓴다(설계안 §6).
const RATIOS = [0.55, 0.75, 0.90, 1.05, 1.20];
export const ZONES = Object.freeze([
  { key: 'Z1', name: '회복', color: '#6b7280' },
  { key: 'Z2', name: '지구력', color: '#2563eb' },
  { key: 'Z3', name: '템포', color: '#16a34a' },
  { key: 'Z4', name: '역치', color: '#ca8a04' },
  { key: 'Z5', name: 'VO₂max', color: '#ea580c' },
  { key: 'Z6', name: '무산소 용량', color: '#dc2626' },
]);

export function zoneOf(watts, ftp) {
  if (!(ftp > 0) || watts === null || !Number.isFinite(watts)) return null;
  const ceilings = RATIOS.map(r => Math.floor(ftp * r));
  const i = ceilings.findIndex(c => watts <= c);
  return ZONES[i === -1 ? 5 : i];
}
