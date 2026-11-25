# 포인트오목 · Point Omok

두 사람이 각자 기기에서 하는 베팅 오목. 선택 플레이어가 고른 세 자리에 몰래 포인트를 걸고, 더 많이 건 쪽의 돌이 놓입니다.

**▶ 바로 하기 / Play: https://allampaca-max.github.io/point-omok/**

- 게임 서버가 필요 없습니다. 브라우저끼리 WebRTC(PeerJS)로 직접 연결됩니다.
- 같은 집 와이파이에서도, 서로 다른 곳에서도 **방 코드 4자리**만 있으면 됩니다.
- 혼자 연습(봇) 모드, 일시정지, 이모지, 끊김 후 자동 재연결, 게임 후 **스냅샷**(모든 베팅 공개·라운드별 다시보기)을 지원합니다.
- **한국어 / English:** 첫 화면 오른쪽 위에서 바꿉니다(게임 중에는 ⋯ 메뉴). 처음에는 브라우저 언어를 따르고, 두 사람이 서로 다른 언어로 해도 됩니다.

## English

Two-player gomoku where you buy your stones. Each round the picker chooses three empty points in a line; both players secretly split their points across them, and the higher bid gets the stone (ties go to the non-picker). Unspent points carry over at half value. Exactly five in a row wins.

One player taps **Create room** and sends the 4-character code or link; the other taps **Join room**. No accounts or server needed, and each player can use their own language (toggle at the top right of the start screen, or in the ⋯ menu during a game). Try **Practice** to learn against a bot.

## GitHub Pages로 올리기 (추천)

이 폴더(`point-omok/`)를 저장소 하나로 올리면 됩니다.

```bash
cd point-omok
git init -b main && git add . && git commit -m "포인트오목"
gh repo create point-omok --public --source . --push
gh api -X POST repos/{owner}/point-omok/pages -f "source[branch]=main" -f "source[path]=/"
```

1~2분 뒤 `https://<깃헙아이디>.github.io/point-omok/` 에서 열립니다. (무료 계정의 Pages는 공개 저장소여야 합니다.)

## 집에서 바로 하기 (GitHub 없이)

맥에서:

```bash
python3 -m http.server 8790 --bind 0.0.0.0 --directory point-omok
```

- 맥: `http://localhost:8790`
- 같은 와이파이의 다른 기기: `http://<맥의 IP>:8790` (맥 IP는 시스템 설정 → Wi-Fi → 세부사항에서 확인)

어느 주소로 열든 방 코드로 연결되므로, 한 사람은 GitHub Pages 주소, 다른 사람은 로컬 주소여도 같이 할 수 있습니다. 연결 중개에 PeerJS 공개 서버를 쓰므로 인터넷 연결은 필요합니다.

## 하는 법

1. 한 사람이 **방 만들기** → 설정(판 크기, 선택·베팅 시간, 돌 색) → 방 열기.
2. 화면의 4자리 코드나 링크를 상대에게 보냅니다.
3. 상대가 **참가하기**로 코드를 입력하면, 방장이 **게임 시작**.

방장 브라우저가 판정을 맡습니다. 방장이 새로고침하거나 창을 닫았다면 로비의 **이어하기**로 같은 방을 다시 열면 되고, 참가자는 자동으로 다시 붙습니다. 끊겨 있는 동안 타이머는 멈춥니다.

## 규칙 (이 구현 기준)

- 매 라운드 선택 → 베팅 → 착수. 선택 플레이어는 라운드마다 번갈아 맡고 흑이 먼저입니다.
- 선택 플레이어는 한 줄(가로·세로·대각선)로 이어진 빈 자리 3개를 고릅니다.
- 매 라운드 두 사람 모두 10포인트를 받고, 세 자리에 자리당 1 이상 정수로 나눠 겁니다.
- 남은 포인트는 절반(내림)만 이월됩니다.
- 자리마다 더 많이 건 쪽 돌이 놓이고, 같으면 선택 플레이어가 아닌 쪽 돌이 놓입니다.
- 상대의 베팅·보유 포인트는 게임이 끝날 때까지 비공개입니다(동점이었는지도 숨깁니다).
- 세 돌이 놓인 뒤 **정확히 5개**(장목 불인정)가 생기면 승리. 둘 다 생기면 오목 개수가 많은 쪽, 개수도 같으면 그 라운드 3점 중 2점 이상을 딴 쪽이 이깁니다.
- 시간 초과: 선택은 그때까지 고른 3점(없으면 무작위), 베팅은 그때까지 입력한 값(처음엔 1·1·1)으로 자동 확정됩니다.
- 고를 3점이 더 없으면 무승부.

## 파일

| 파일 | 내용 |
|---|---|
| `index.html`, `style.css` | 화면 |
| `engine.js` | 규칙 엔진(DOM 없음) |
| `bot.js` | 연습용 봇 |
| `app.js` | 진행·네트워크·그리기 |
| `i18n.js` | 한/영 문구 |
| `assets/` | 이미지(Codex로 생성, 원본 PNG와 프롬프트는 `assets/src/`) |
| `tests/` | 규칙 테스트. 브라우저로 `tests/index.html`을 열거나 아래 명령으로 실행 |

```bash
/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc engine.js bot.js tests/engine.test.js
```

## 알아 둘 점

- 숨겨진 정보는 화면에 나오지 않지만, 방장 브라우저 메모리에는 상대 베팅이 들어 있습니다(판정을 해야 하므로). 개발자 도구로 들여다보지 않는 집안 게임용입니다.
- 회사·학교 망처럼 막힌 네트워크에서는 WebRTC 연결이 안 될 수 있습니다. PeerJS 기본 TURN 서버로 대부분 통과합니다.
