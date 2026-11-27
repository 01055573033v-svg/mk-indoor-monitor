// 3단계 준비(11-27): 실물 동글 연결 진단. 화면 「연결 진단」이 1초마다 다시 그린다. 값만 읽고 저장·전송하지 않는다.
// 네트워크 키는 「넣었는지」만 보이고 값은 절대 보이지 않는다.
// 선테스트(설계안 §3): 1 동글 열기 · 2 송수신 통로(엔드포인트) · 3 연속 스캔 진입 · 4 확장 메시지(누가 보냈는지).

export const STEP_LABEL = Object.freeze({
  open: '선테스트 1 · 동글 열기',
  endpoints: '선테스트 2 · 송수신 통로 찾기',
  claim: '동글 잡기(다른 프로그램이 안 씀)',
  reset: '동글 초기화',
  networkKey: 'ANT+ 네트워크 키 넣기',
  assign: '채널 배정',
  channelId: '모든 센서 받기(와일드카드)',
  rfFreq: '주파수 2457MHz',
  libConfig: '선테스트 4 · 확장 정보 켜기',
  openScan: '선테스트 3 · 연속 스캔 시작',
});
export const SENSOR_TYPE = Object.freeze({ 11: '파워', 17: '스마트 로라', 120: '심박', 121: '속도·케이던스', 122: '케이던스' });
/** 확장 정보 없이 이만큼 받으면 「누가 보냈는지 모름」으로 판정한다. */
export const EXT_FAIL_AFTER = 20;

const row = (label, state, detail = '', hint = '') => ({ label, state, detail, hint });

/** 동글을 꽂기 전에 볼 것: 크롬·보안 주소·네트워크 키·허용된 동글. */
export function preChecks({ usb, secure, key, known }) {
  return [
    row('크롬 WebUSB', usb ? 'ok' : 'fail', '', usb ? '' : '맥북 크롬 최신판으로 여세요(사파리·파이어폭스는 안 됨)'),
    row('보안 주소(https 또는 이 컴퓨터)', secure ? 'ok' : 'fail', '', secure ? '' : '게시된 https 주소로 여세요'),
    row('ANT+ 네트워크 키', key ? 'ok' : 'fail', key ? '입력됨(값은 표시 안 함)' : '', key ? '' : '「설정」에서 코치가 직접 넣습니다'),
    row('허용된 동글', known > 0 ? 'ok' : 'wait', known > 0 ? `${known}개` : '', known > 0 ? '' : '「동글 연결」을 누르고 창에서 동글을 고르세요'),
  ];
}

/** 동글 하나: 준비 단계 결과 + 받기 통계(첫 방송·확장 메시지·들리는 센서). */
export function dongleRows(diag) {
  const out = diag.steps.map(s => row(STEP_LABEL[s.name] ?? s.name, s.ok ? 'ok' : s.name === 'reset' ? 'wait' : 'fail', `${s.ms}ms${s.note ? ` · ${s.note}` : ''}`));
  const setupOk = !diag.error && diag.steps.some(s => s.name === 'openScan' && s.ok);
  if (!setupOk) return [...out, ...(diag.error ? [row('멈춘 이유', 'fail', diag.error)] : [])];
  out.push(diag.firstPacketMs === null
    ? row('첫 방송 받기', 'wait', '아직 없음', '로라 페달을 돌리거나 심박계를 차 주세요')
    : row('첫 방송 받기', 'ok', `${(diag.firstPacketMs / 1000).toFixed(1)}초 만에 · 지금까지 ${diag.packets}건`));
  out.push(diag.extended > 0 ? row('선테스트 4 · 누가 보냈는지(확장 메시지)', 'ok', `${diag.extended}건`)
    : diag.packets >= EXT_FAIL_AFTER ? row('선테스트 4 · 누가 보냈는지(확장 메시지)', 'fail', `${diag.packets}건 중 0건`, '센서를 구분할 수 없습니다 → 다른 동글 또는 브리지 검토')
    : row('선테스트 4 · 누가 보냈는지(확장 메시지)', 'wait', '받는 중'));
  const count = {};
  for (const key of diag.devices) { const t = SENSOR_TYPE[Number(key.split(':')[0])] ?? '기타'; count[t] = (count[t] ?? 0) + 1; }
  out.push(row('들리는 센서', diag.devices.size ? 'ok' : 'wait', diag.devices.size ? `${diag.devices.size}개 (${Object.entries(count).map(([t, n]) => `${t} ${n}`).join(' · ')})` : '없음'));
  return out;
}

/** 한 줄 판정: 모두 통과 / 막힌 곳 / 기다리는 중. */
export function verdict(pre, dongles) {
  const all = [...pre, ...dongles.flatMap(d => d.rows)];
  if (all.some(r => r.state === 'fail')) return { state: 'fail', text: `막힘: ${all.find(r => r.state === 'fail').label}` };
  if (!dongles.length || all.some(r => r.state === 'wait')) return { state: 'wait', text: dongles.length ? '확인 중' : '동글을 연결하면 단계별로 확인합니다' };
  return { state: 'ok', text: `통과 — 동글 ${dongles.length}개 · 센서 ${dongles.reduce((n, d) => n + d.sensors, 0)}개` };
}
