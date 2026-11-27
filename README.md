# 백만킬로 실내 로라 모니터 (2단계 · 세션·목표 비교·요약 저장)

센터 맥북 크롬에서 ANT+ 동글(최대 3개)로 16명의 파워·심박·케이던스를 받아 대형 화면 16타일로 보여 주는 독립 정적 웹앱입니다.
설계: `_작업게시판/보고/2026-11-26_Claude(개발)_실내로라_ANT모니터_1단계설계안_v01.md`. V2·서킷 타이머·업무실과 코드를 나누지 않으며 외부 의존성이 없습니다.

배포: 이 저장소의 GitHub Pages(main 맨 위 폴더). main에 올리면 1~2분 안에 다시 배포됩니다.

## 2단계(11-27)
| 기능 | 내용 | 파일 |
|---|---|---|
| 훈련 세션 | 기본 세션 5개(시연 5분·Z2 60분·SST 20×2·VO2 3×6·역치 10×3) 또는 세션 파일(JSON). 대상 그룹(전체·중E·중S·고E·고S). 일시정지·끝내기 | `src/core/session.js` |
| 목표 비교 | 타일마다 목표 와트(FTP×구간 %FTP, 내림)와 지금 파워 비교: ✓ 범위 안 / ▼ n W 낮음 / ▲ n W 높음, 왼쪽 색 띠 | `session.js` `targetWatts`·`compare` |
| 그래프 | 세션 줄: 구간 막대(존 색)·지금 위치. 타일: 최근 90초 파워 선 + 목표 띠 | `src/app.js` |
| 결과 요약·저장 | 선수별 평균·최대 W, 목표 안 %, 평균·최대 심박, 평균 rpm, kJ, 기록률, 구간별 평균 W. **요약만** 이 크롬에 최근 30개 저장(1초 원본은 저장 안 함). CSV·JSON 내려받기 | `src/core/record.js` |
| V2 명단 연동 구조 | 명단 파일(`mk-indoor-roster` v1: P코드·그룹·FTP)을 불러와 FTP·그룹을 채움. 실명 같은 다른 칸은 버림. V2 직접 연결은 `RosterSource.load()` 하나만 더하면 되게 틀만 둠 | `src/core/roster.js` |
| 모의 선수 | 세션 중 모의 선수가 목표를 따라 밟음(선수마다 실력 배율 0.9~1.08) | `src/transport/mock.js` `MockRider` |

명단 파일 예:
```json
{ "format": "mk-indoor-roster", "version": 1, "source": "V2", "exportedAt": "2026-11-27T10:00:00+09:00",
  "athletes": [ { "code": "P01", "group": "고E", "ftp": 250, "ftpDate": "2026-11-05" } ] }
```
세션 파일 예(구간 %FTP 둘 다 비우면 자유 구간):
```json
{ "name": "역치 2×15", "steps": [ { "label": "W-up", "sec": 900, "lo": 50, "hi": 65 }, { "label": "역치", "sec": 900, "lo": 91, "hi": 105 }, { "label": "자유", "sec": 300 } ] }
```
용어: 상표 용어(NP·TSS·IF 등)는 쓰지 않습니다.

## 하지 않는 것
업로드·서버 저장 0 · ERG/경사 제어·송신 0 · V2 로그인·DB 직접 연결 0 · 실명 0(P코드만).

## 구조(설계안 §3-3)
| 부품 | 파일 |
|---|---|
| 전송: WebUSB 동글 | `src/transport/webusb.js` (실물 동글 확인 전 — 선테스트 1~4에서 검증) |
| 전송: 모의 센서(동글 없이) | `src/transport/mock.js` |
| ANT 메시지·스캔·확장 방송 | `src/ant/message.js`, `src/ant/scan.js` |
| 프로파일 해석(파워·FE-C·심박·케이던스·배터리) | `src/ant/profiles.js` |
| 1초 평균(누적값 차이) | `src/core/metrics.js` |
| 합치기·중복 제거·연결 4단계·경보·동글 상태 | `src/core/hub.js` |
| 센서↔코드·FTP·그룹·주 동글(이 크롬에만 저장) | `src/core/settings.js` |
| 존(V2 `lib/ftp.ts` 경계) | `src/core/zones.js` |
| 화면 | `index.html`, `styles.css`, `src/app.js` |

전송 계층은 `hub.receive(동글 이름, 시각, 방송)` 하나로만 화면과 이어집니다. 2단계 브리지(WebSocket)도 같은 형식을 따르면 화면은 그대로입니다.

## 시험
```sh
node --test
```
모의 센서가 실제 ANT 바이트를 만들어 USB 덩어리처럼 잘라 넣고, 16명·32센서·동글 3개 방에서 값·끊김 단계·경보·이어받기·빠짐률을 확인합니다.

## 열기
WebUSB는 보안 연결(https) 또는 이 컴퓨터 주소에서만 됩니다. 이 폴더에서 `python3 -m http.server 8000` 후 크롬으로 엽니다. 「모의 센서」는 동글 없이 화면을 봅니다.
ANT+ 네트워크 키는 코드에 넣지 않습니다(ANT+ 사용 약관 대상). 동글 연결 전 「설정」에서 한 번 넣으면 이 크롬에만 저장됩니다.
