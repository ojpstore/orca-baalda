# Baalda Notes (Orca plugin)

Orca 사이드바에서 Baalda 볼트의 노트를 보고, 편집하고, 새로 만듭니다.

- 볼트 목록: `%APPDATA%\com.baalda.context\config.json`의 최근 볼트 (`.context` 폴더가 있는 것만)
- 트리: Baalda 스타일(폴더 색 박스, sync 점). 폴더 색은 Baalda가 저장하지 않아 경로 해시로 배정
- 노트 클릭: **현재 활성 워크스페이스**의 Baalda 탭 하나에 표시. 워커가 `<워크스페이스>/.orca/baalda/Baalda.baalda`
  (자체 `.gitignore`로 git에서 제외)에 `{vault, path}`를 쓰고 그 파일을 Baalda 에디터로 연다
  (이미 열려 있으면 같은 탭). 편집은 자동 저장(0.8초) + Ctrl+S. `.orca/`는 dev 플러그인 감시에서도 제외됨
- 링크: `[[경로|별칭]]`, 상대 `.md` 링크 클릭 시 같은 탭에서 이동(볼트 경로 → 상대 경로 → 이름 순으로 찾음).
  `.html` 페이지(대시보드)는 sandbox iframe으로 렌더링하고, Baalda SDK(`baalda.app.open`) 대체 스크립트를 넣어
  대시보드의 버튼·링크도 노트 이동으로 연결
- 볼트 경로: 패널 맨 위에 표시, 버튼으로 `.context`가 있는 아무 볼트 폴더 경로나 추가(플러그인 저장소에 기억)
- 볼트 밖 경로는 워커가 거부
- 동기화: Baalda는 local-first라 데스크톱 앱이 볼트 파일 변경을 서버와 동기화합니다.
  패널은 `.context/config.json`으로 노트별 sync 상태(`대기` 표시)를 보여주고,
  구름 버튼은 Baalda 앱이 꺼져 있으면 실행합니다. 디스크 변경은 `fs.watch`로 자동 반영.

## 개발

```sh
npm i                    # typescript, @types/node (타입체크용)
npx tsc -p .
orca plugin test .       # 주의: 플러그인이 Orca 설치 드라이브(C:)와 다른 드라이브에 있으면
orca plugin check .      # 테스트 런타임을 못 찾음 → C: 아래로 복사해서 실행
orca plugin dev load . --approve <fingerprint>
node editor/vendor/emoji.gen.mjs  # 이모지 데이터(emojibase-data, 한국어) 재생성
```
