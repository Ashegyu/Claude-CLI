# CLI Chat 현재 폴더 상세 분석

분석 기준일: 2026-04-27  
대상 폴더: `C:\Users\GC\Desktop\Works\Personal\Claude CLI`

이 문서는 현재 폴더의 실제 파일 상태를 기준으로 Electron 앱 구조, 실행 흐름, 데이터 경계, 성능 관점의 위험, 유지보수 포인트, 검증 결과를 정리한다. line 번호는 이 문서를 작성한 시점의 파일 스냅샷 기준이다.

## 1. Scope

### 분석 범위

- 소스 및 설정: `main.js`, `preload.js`, `renderer/`, `package.json`, `scripts/verify.ps1`, `.codex/`, `.claude/agents/`, `.gitignore`, 컨텍스트 메뉴 `.reg` 파일
- 빌드/의존성 산출물: `dist/`, `dist-temp-subagent-*`, `node_modules/`
- 기존 분석 문서: `FOLDER_ANALYSIS_AND_USAGE.md`

### 의도적으로 제한한 범위

- `node_modules/`, `dist/`, `dist-temp-subagent-*`, `.git/`는 크기와 상위 구조만 확인했다. 내부 전체 소스 분석 대상은 아니다.
- `.claude/settings.local.json`은 존재와 크기만 확인했다. 로컬 권한 설정 파일이므로 본문에 상세 내용을 옮기지 않았다.
- Git 전역 설정은 변경하지 않았다. 일반 `git status`는 소유자 차이로 차단되었고, 임시 `git -c safe.directory=... status --short` 방식으로 현재 작업트리가 깨끗한 것만 확인했다.

### 폴더 성격

현재 폴더는 Codex CLI를 데스크톱 채팅 UI로 감싸는 Electron 앱이다. 핵심 구조는 다음과 같다.

- `main.js`: Electron 메인 프로세스, 창 생성, CLI 실행, PTY/pipe 스트림, 파일 읽기, Git IPC, Codex 설정/세션/스킬/에이전트 연동, 대화 저장
- `preload.js`: renderer에 노출되는 `window.electronAPI` 브리지
- `renderer/index.html`: 앱 셸과 주요 DOM 슬롯
- `renderer/app.js`: 대부분의 UI 상태, Codex 실행 인자 구성, 스트리밍 파싱, 메시지 렌더링, 서브에이전트 패널, Git 커밋 모달, 설정 모달
- `renderer/styles.css`: 전체 UI 스타일

## 2. Relevant files and call chain

### 파일/폴더 인벤토리

상위 디렉터리 크기 요약:

| 항목 | 파일 수 | 크기 | 판단 |
| --- | ---: | ---: | --- |
| `_workspace/` | 0 | 0 MB | 현재 비어 있음 |
| `.claude/` | 2 | 0.01 MB | 로컬 Claude 설정 및 agent 정의 |
| `.codex/` | 5 | 0 MB | 프로젝트 Codex agent 설정 |
| `.git/` | 557 | 540.27 MB | Git 저장소 메타데이터, 크기가 큼 |
| `assets/` | 0 | 0 MB | 현재 정적 리소스 없음 |
| `dist/` | 263 | 647.34 MB | 현재 빌드 산출물 |
| `dist-temp-subagent-panel-check/` | 257 | 367.03 MB | 서브에이전트 패널 검증 산출물 |
| `dist-temp-subagent-per-conv-layout-check/` | 257 | 367.04 MB | 대화별 레이아웃 검증 산출물 |
| `dist-temp-subagent-process-check/` | 257 | 367.06 MB | 프로세스 패널 검증 산출물 |
| `dist-temp-subagent-rail-check/` | 257 | 367.04 MB | rail 검증 산출물 |
| `dist-temp-subagent-resize-check/` | 257 | 367.04 MB | resize 검증 산출물 |
| `dist-temp-subagent-turn-layout-check/` | 257 | 367.06 MB | turn layout 검증 산출물 |
| `node_modules/` | 9283 | 612.86 MB | 설치 의존성 |
| `renderer/` | 4 | 0.59 MB | UI 소스 |
| `scripts/` | 1 | 0 MB | 검증 스크립트 |

주요 파일 크기:

| 파일 | 라인 | 바이트 | 역할 |
| --- | ---: | ---: | --- |
| `main.js` | 3641 | 126828 | 메인 프로세스와 IPC 전체 |
| `preload.js` | 104 | 4310 | renderer API 브리지 |
| `renderer/app.js` | 12491 | 493459 | UI, 상태, 파싱, 실행 흐름 대부분 |
| `renderer/index.html` | 169 | 11323 | DOM 셸 |
| `renderer/styles.css` | 4435 | 111873 | 전체 스타일 |
| `renderer/manual.html` | 141 | 4001 | 사용 설명서 창 |
| `package.json` | 67 | 1638 | npm scripts, dependencies, builder 설정 |
| `scripts/verify.ps1` | 59 | 1103 | 정적 검증 및 선택적 빌드 |
| `AGENTS.md` | 38 | 2350 | repo 작업 규칙 |
| `.gitignore` | 10 | 107 | 산출물/로컬 설정 제외 |

### 실행/빌드 진입점

Evidence:

- `package.json:7-11`에 `start`, `build`, `build:portable`, `verify`, `verify:build` 스크립트가 있다.
- `package.json:24-30`은 `electron`, `electron-builder`, `highlight.js`, `marked`, `node-pty` 의존성을 선언한다.
- `package.json:32`부터 `electron-builder` 설정이 있고, 출력 디렉터리는 `dist`, artifact 이름은 `CLI-Chat-Setup-${version}.${ext}`다.
- `scripts/verify.ps1:31-40`은 `node --check`를 `main.js`, `preload.js`, `renderer/app.js`에 수행한다.
- `scripts/verify.ps1:43-48`은 `npm ls --depth=0`와 `npm audit --audit-level=moderate`를 수행한다.
- `scripts/verify.ps1:52-53`은 `-Build` 옵션일 때 `npm run build`를 수행한다.

### Electron 메인 프로세스 체인

Evidence:

- `main.js:847-869`에서 `createWindow()`가 `BrowserWindow`를 만들고 `renderer/index.html`을 로드한다.
- `main.js:861-864`는 `preload.js`, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`를 설정한다.
- `main.js:905-928`은 별도 사용 설명서 창을 만들며, 이 창은 `sandbox: true`다.
- `main.js:817-844`는 초기 CWD를 `--cwd`, `--cwd=`, 마지막 인자 폴더, `os.homedir()` 순서로 해석한다.
- `main.js:1973-2001`은 `cwd:get`, `cwd:set`, `cwd:select` IPC를 제공한다.

메인 실행 흐름:

1. `npm run start` 또는 패키지된 exe 실행
2. Electron이 `main.js`를 entry point로 로드
3. `resolveInitialCwd()`가 작업 폴더를 결정
4. `createWindow()`가 frameless window를 만들고 `renderer/index.html` 로드
5. renderer는 `preload.js`의 `window.electronAPI`로 메인 IPC를 호출

### CLI 실행 체인

Evidence:

- `renderer/app.js:829-830`의 프로필은 `codex exec --full-auto --skip-git-repo-check` 기반이다.
- `renderer/app.js:2745-2795`의 `buildCodexArgs()`가 `exec`, `resume`, approval, sandbox, image, `--json`, model, reasoning 인자를 조합한다.
- `renderer/app.js:11704-11718`에서 일반 메시지 전송이 `window.electronAPI.cli.run()`으로 넘어간다.
- `preload.js:6-28`은 `cli:run`, `cli:stop`, `cli:write`, `cli:stream`, `cli:done`, `cli:error`, `cli:turnDone`을 renderer에 노출한다.
- `main.js:1682-1811`은 `cli:run` IPC에서 실행 모드를 결정하고, Windows Codex 기본 경로는 PTY 대신 spawn pipe 모드를 선호한다.
- `main.js:1700-1703`은 Windows + Codex + 비명시 PTY 요청이면 spawn mode를 강제한다.
- `main.js:1755-1781`은 pipe mode에서 stdout/stderr를 `cli:stream`으로 보낸다.
- `main.js:1803-1811`은 PTY mode에서 `node-pty`를 사용한다.

Inference:

- 일반 Codex 응답은 `--json` pipe 출력으로 받아 renderer에서 구조화하는 것이 현재 주 경로다.
- PTY 경로는 interactive 또는 명시적 pty 모드용 fallback 성격이 강하다.

### Renderer/UI 체인

Evidence:

- `renderer/index.html:6`은 CSP를 선언한다.
- `renderer/index.html:8-9`는 highlight.js 테마와 `styles.css`를 로드한다.
- `renderer/index.html:90-111`은 메시지 영역과 서브에이전트 rail DOM을 정의한다.
- `renderer/index.html:118-159`는 입력창, 첨부, 커밋, 런타임 설정, status bar 슬롯을 정의한다.
- `renderer/index.html:165-166`은 `marked.min.js`와 `app.js`를 로드한다.
- `renderer/app.js:40-121`은 저장된 대화 모델을 정규화한다.
- `renderer/app.js:123-145`는 디스크 저장소에서 대화를 읽고, 기존 localStorage 데이터를 migration한다.
- `renderer/app.js:192-224`는 markdown 렌더 결과를 sanitizer로 정리한다.
- `renderer/app.js:6010-6048`은 메시지를 `DocumentFragment`로 일괄 렌더링한다.
- `renderer/app.js:6117-6128`은 markdown 렌더링과 sanitizer 적용 경로다.
- `renderer/app.js:7975-7995`는 Codex JSON/text 출력을 구조화하고 approval/sandbox 정보를 보강한다.
- `renderer/app.js:10116-10131`은 응답/과정/코드 탭 구조를 생성한다.

### 파일 첨부와 로컬 파일 열기

Evidence:

- `main.js:13-15`는 import 크기 제한을 텍스트 180 KB, 이미지 20 MB, PDF 10 MB로 둔다.
- `main.js:714-733`은 파일 타입을 분기하고 이미지면 base64/data URL을 만든다.
- `main.js:2026-2036`은 단일/다중 파일 읽기 IPC를 제공한다.
- `main.js:2039-2059`는 `shell.openPath()`로 로컬 파일을 연다.
- `renderer/app.js:2920-3039`는 첨부 목록 상태와 미리보기를 관리한다.
- `renderer/app.js:3042-3053`은 첨부 파일을 prompt 본문 또는 Codex image 인자로 변환한다.

Inference:

- 첨부는 소형 텍스트는 prompt에 직접 삽입하고, 이미지는 Codex CLI의 `--image` 경로 인자를 같이 넘기는 구조다.
- 이 구조는 구현이 단순하지만, 큰 텍스트/다중 첨부에서는 prompt 크기와 저장소 크기를 빠르게 키울 수 있다.

### Git 기능 체인

Evidence:

- `preload.js:42-45`는 `repo:getFileDiffs`, `repo:getStatus`, `repo:commit`, `repo:generateCommitMessage`를 노출한다.
- `main.js:478-517`은 `spawn('git', args)` 기반 비동기 Git 실행 helper다.
- `main.js:2066-2202`는 Codex exec를 활용해 커밋 메시지를 생성한다.
- `main.js:2205-2238`은 `git status --porcelain=v1 -z`와 최근 로그, diff stat을 수집한다.
- `main.js:2241-2299`는 선택 파일만 stage/commit하는 커밋 경로다.
- `main.js:2301-2457` 이후는 실제 파일 diff와 session diff 추출 경로로 이어진다.
- `renderer/app.js:11879-12011`은 Git 커밋 모달에서 상태 조회, 메시지 생성, 커밋 실행을 호출한다.

### Codex 설정/세션/스킬/에이전트 체인

Evidence:

- `main.js:57-80`은 UI에서 편집 가능한 Codex config field allow-list를 정의한다.
- `main.js:1396-1568`은 `~/.codex/config.toml` 읽기/쓰기용 TOML 파싱과 upsert를 구현한다.
- `main.js:2902-3004`는 model catalog, command catalog, skill list, config read/save/open IPC를 제공한다.
- `main.js:3009-3479`는 Codex session `.jsonl` 목록, load, delete, diff 추출을 담당한다.
- `main.js:3350-3381`은 프로젝트 `.codex/agents`와 글로벌 `~/.codex/agents`를 읽어 agent 목록을 만든다.
- `.codex/config.toml:2-3`은 `max_threads = 6`, `max_depth = 1`을 설정한다.
- `.codex/agents/`에는 `bug_fixer`, `code_explorer`, `electron_specialist`, `ui_reviewer`가 정의되어 있다.
- `.claude/agents/study.agent.md:2-4`에는 `study` agent 정의가 있다.

### 서브에이전트 UI 체인

Evidence:

- `renderer/app.js:12-38`은 `subagentPanel` 저장 모델을 정규화한다.
- `renderer/app.js:5354-5361`은 사용 가능한 agent 목록 표시를 담당한다.
- `renderer/app.js:5364-5378`은 agent picker modal을 만든다.
- `renderer/app.js:5627-5641`은 서브에이전트 실행 args를 만들고 `cli.run()`으로 별도 Codex 실행을 시작한다.
- `renderer/app.js:5671-5704`는 Codex 출력의 `spawn_agent` 활동을 감지해 UI 패널로 재실행/표시하려는 경로다.
- `renderer/app.js:10458-10480`은 질문 턴별 서브에이전트 rail 레이아웃을 만든다.
- `renderer/app.js:10517-10545`는 글로벌 서브에이전트 rail 렌더링 경로다.
- `renderer/styles.css:893-1367`, `renderer/styles.css:1521-1972`는 서브에이전트 목록, rail, 질문별 rail, resize UI 스타일을 포함한다.

### 빌드 산출물과 컨텍스트 메뉴

Evidence:

- `dist/latest.yml:3-6`은 `CLI-Chat-Setup-2.0.0.exe`를 최신 artifact로 가리킨다.
- `dist/`에는 `CLI Chat Setup 1.0.1.exe`, `CLI Chat Setup 2.0.0.exe`, `CLI-Chat-Setup-2.0.0.exe`, `win-unpacked.zip`, `win-unpacked/`가 같이 있다.
- 각 `dist-temp-subagent-*` 폴더에는 `CLI-Chat-Setup-2.0.0.exe`, `.blockmap`, `latest.yml`, `builder-debug.yml`, `win-unpacked/`가 있다.
- `.gitignore:1-9`는 `node_modules/`, `dist/`, `dist2/`, `build_out/`, `dist-temp/`, `dist-temp*/`, `.claude/settings.local.json`, `*.exe`, `*.blockmap`을 제외한다.
- `context-menu-install.reg:15-28`은 Windows 폴더 배경/폴더 우클릭 메뉴에 `CLI Chat` 실행과 `--cwd` 전달을 등록한다.
- `context-menu-uninstall.reg:5-6`은 같은 registry key를 제거한다.

## 3. Hot-path assessment

### Hot paths

1. CLI streaming path
   - Renderer: `sendMessage()`부터 `cli.run()` 호출까지 `renderer/app.js:11287-11718`
   - Main: `cli:run` spawn/PTY 처리 `main.js:1682-1811`
   - Renderer parsing/rendering: `parseCodexOutput()` `renderer/app.js:7975-7995`, `renderCodexStructured()` `renderer/app.js:10116-10131`

2. 메시지 렌더링 path
   - `renderMessages()`가 전체 메시지 DOM을 재구성한다. `renderer/app.js:6010-6048`
   - markdown rendering은 `marked.parse()` 후 sanitizer를 통과한다. `renderer/app.js:6117-6128`

3. 서브에이전트 진행 표시 path
   - 서브에이전트별 stream preview와 panel update가 반복 수행된다. `renderer/app.js:5536-5641`, `renderer/app.js:10458-10548`

4. 대화 저장 path
   - 메인 저장은 atomic write + backup copy다. `main.js:3540-3628`
   - renderer는 저장 전 binary/base64를 제거하는 방어 로직을 둔다. `renderer/app.js:5103-5155`

### Warm paths

- 프로젝트/대화 목록 렌더링: `renderer/app.js:4499-4603`, `renderer/app.js:5099` 이후
- Git status/diff/commit modal: `main.js:2066-2301`, `renderer/app.js:11879-12011`
- Codex command/model/skill catalog refresh: `main.js:1201-1393`, `main.js:2915-2949`

### Cold paths

- Electron packaging
- Windows registry install/uninstall
- Manual window open
- Codex config modal open/save

## 4. Allocation and copy analysis

### Evidence

- `renderer/app.js`는 약 493 KB, 12491 line의 단일 파일이며, streaming output을 문자열 누적, JSON parse, markdown 변환, DOM 문자열 생성 방식으로 처리한다.
- `renderer/app.js:993-1017`에는 content hash 기반 markdown render cache가 있어 같은 content 반복 렌더 비용을 줄이려 한다.
- `renderer/app.js:985-986`은 streaming render throttle 및 parse interval 상수를 둔다.
- `renderer/app.js:6010-6048`은 `DocumentFragment`를 사용해 전체 메시지 reflow 횟수를 줄인다.
- `main.js:714-733`에서 이미지는 파일 전체를 읽고 base64 문자열로 변환한다.
- `main.js:3579-3595`는 대화 저장 시 전체 JSON을 문자열화하고 기존 파일을 `.bak`로 복사한 뒤 rename한다.
- `renderer/app.js:5103-5127`은 저장 전 binary/base64/dataUrl 필드를 제거해 저장 데이터 폭증을 방지한다.

### Inference

- 스트리밍이 긴 응답에서는 chunk마다 문자열 누적과 JSON parsing 후보 탐색이 CPU와 allocation을 유발할 수 있다. 현재 throttle/cache가 일부 완충하지만, `renderer/app.js` 내부 파싱 함수들이 많아 장문 응답에서 비용이 분산되어 발생할 가능성이 있다.
- 파일 첨부가 많거나 이미지가 큰 경우, main process에서 base64 문자열과 data URL을 만들고 renderer 상태에 넘기는 과정은 peak memory를 키울 수 있다.
- 대화 저장은 atomic하고 안전하지만, 대화 수와 메시지 크기가 커지면 전체 JSON rewrite 방식이 latency spike를 만들 수 있다.

### Uncertainty

- 실제 p95/p99 UI latency, 긴 JSONL stream에서의 parse cost, 대화 저장 파일 크기별 blocking 시간은 계측이 필요하다.
- 현재 사용자 workload가 짧은 대화 중심이면 위 비용은 체감되지 않을 수 있다.

## 5. CPU and dispatch analysis

### Evidence

- Windows Codex 실행은 기본적으로 spawn pipe mode를 강제한다. `main.js:1700-1703`
- pipe mode는 ANSI 제거 후 stdout/stderr chunk를 바로 renderer로 보낸다. `main.js:1768-1781`
- PTY mode에는 가상 터미널 버퍼 `VTermBuffer`가 있다. `main.js:116-297`
- noisy/status/progress line 분류 함수가 있다. `main.js:299-375`
- Renderer는 Codex JSON/text 출력 파싱, response/process/code tab 구성, diff extraction, search hit formatting 등 많은 CPU 작업을 한 파일 안에서 수행한다. 관련 핵심 함수는 `renderer/app.js:7975`, `renderer/app.js:9099`, `renderer/app.js:9222`, `renderer/app.js:9869`, `renderer/app.js:9987`, `renderer/app.js:10116`이다.

### Inference

- Codex `--json` pipe mode는 PTY line wrapping/ANSI 처리 부담을 줄이는 방향이라 일반 응답 hot path에는 적합하다.
- 반대로 renderer의 출력 정리, patch extraction, markdown preprocess가 계속 누적되면 renderer main thread가 긴 프레임을 만들 수 있다.
- 단일 `renderer/app.js`에 parsing/rendering/state/IPC binding이 밀집되어 있어, CPU hot spot을 분리 측정하기 어렵다.

### Uncertainty

- 현재 구조에서 병목이 실제로 renderer parsing인지, DOM 업데이트인지, Codex process 자체 latency인지는 performance trace 없이는 확정할 수 없다.

## 6. Concurrency and latency analysis

### Evidence

- `runningProcesses`는 stream id별 실행 프로세스를 관리한다. `main.js:10`, `main.js:1688-1689`, `main.js:1757`, `main.js:1811`
- `cli:stop`은 Ctrl+C write 후 kill을 시도한다. `main.js:1958-1968`
- 서브에이전트는 panel message별로 별도 stream id를 만들고, 1초 timer로 진행 UI를 갱신한다. `renderer/app.js:5536-5548`
- 저장 경로는 async save와 beforeunload sync save를 모두 제공한다. `preload.js:76-78`, `main.js:3613-3628`
- Git command helper는 stdout/stderr를 전부 누적한 뒤 resolve한다. `main.js:478-517`
- commit message 생성은 timeout 45초다. `main.js:16`, `main.js:2194-2197`
- Codex model/command catalog timeout은 각각 8초다. `main.js:17-18`, `main.js:1201`, `main.js:1251`

### Inference

- 여러 Codex/서브에이전트 프로세스가 동시에 실행되면 renderer update timer, stream event, save debounce, DOM rendering이 한 renderer thread에 모인다.
- Git diff/status는 프로세스 단위로 분리되어 UI freeze는 적지만, stdout 누적 방식이라 매우 큰 diff에서는 memory와 completion latency가 커질 수 있다.
- sync save는 종료 직전 데이터 보존에는 유리하지만, 대화 JSON이 커지면 앱 종료나 reload path에서 blocking 가능성이 있다.

### Uncertainty

- 서브에이전트 동시 실행 개수 6개(`.codex/config.toml:2`) 기준으로 실제 UI frame drop이 발생하는지는 browser performance trace가 필요하다.

## 7. Ranked recommendations

### 1. 의존성 설치 상태를 `package.json`/`package-lock.json`과 동기화

Evidence:

- `package.json:24-30`은 `electron ^41.3.0`, `electron-builder ^26.8.1`을 요구한다.
- 현재 `npm ls --depth=0` 결과는 `electron@33.4.11 invalid`, `electron-builder@25.1.8 invalid`, `xterm@5.3.0 extraneous`로 실패했다.

Impact:

- `scripts/verify.ps1`의 공식 검증 흐름이 현재 실패한다.
- 빌드/실행 Electron 버전이 lockfile 기대와 다르면 packaging, native module, security behavior 차이가 생긴다.

Risk:

- 의존성 재설치는 네트워크/캐시/Node 환경 영향을 받는다. 현재 문서 작업 범위에서는 변경하지 않았다.

Recommendation:

- 일반 개발 환경에서 `npm install` 또는 명시적 버전 정리 후 `npm ls --depth=0`를 먼저 통과시킨다.
- `xterm`이 실제로 필요하면 `package.json`에 추가하고, 아니면 제거한다.

### 2. 빌드 산출물 정리 정책 명확화

Evidence:

- `dist/`가 647.34 MB이고, `dist-temp-subagent-*` 6개가 각각 약 367 MB다.
- `.gitignore:2`, `.gitignore:5-6`, `.gitignore:8-9`가 `dist/`, `dist-temp*/`, exe/blockmap을 이미 제외한다.

Impact:

- 작업 폴더 총량이 커지고 백업/검색/안티바이러스/압축 비용이 증가한다.

Recommendation:

- 검증 완료 후 보관할 artifact는 `dist/` 하나로 제한한다.
- 임시 검증 폴더는 CI나 별도 build cache 위치로 빼거나, 수동 정리 규칙을 README에 명시한다.

### 3. Renderer hot path 계측 추가

Evidence:

- `renderer/app.js`가 12491 line으로, streaming parsing, markdown rendering, diff extraction, code tab rendering이 집중되어 있다.
- 이미 render cache와 throttle이 있으나 실제 비용 수치가 없다.

Impact:

- 장문 Codex 응답, 큰 diff, 다중 서브에이전트 상황에서 UI latency가 악화될 수 있다.

Recommendation:

- `parseCodexOutput`, `renderCodexStructured`, `renderMessages`, `saveConversations` 호출 시간과 입력 크기를 개발 모드에서 샘플링한다.
- 최소 지표: chunk count, final output bytes, parse ms, render ms, save ms, message count.

### 4. 대화 저장 파일 크기와 sync save blocking 기준 마련

Evidence:

- `main.js:3579-3595`는 전체 JSON stringify + backup copy + rename 방식이다.
- `main.js:3625-3628`은 sync IPC에서도 같은 atomic write를 수행한다.

Impact:

- 안전성은 좋지만 큰 대화 기록에서는 종료/전환 시 지연 가능성이 있다.

Recommendation:

- 저장 파일 크기가 일정 기준을 넘으면 사용자에게 기록 정리 또는 project별 archive를 안내한다.
- 장기적으로는 append-only log 또는 conversation 단위 분할 저장을 검토한다.

### 5. 파일 읽기/열기 권한 경계 문서화

Evidence:

- `main.js:426-430`은 상대 경로를 `workingDirectory` 기준으로 해석하지만, 절대 경로도 허용한다.
- `main.js:2039-2059`는 renderer 요청 경로를 `shell.openPath()`로 연다.

Impact:

- 로컬 데스크톱 앱에서는 편의성이 높지만, renderer compromise 가정에서는 local file open/read 표면이 커진다.

Recommendation:

- 현재 정책이 의도된 것인지 문서화한다.
- 보안 우선 모드가 필요하면 selected project boundary 또는 확인 dialog를 추가한다.

### 6. Codex config/session 경로의 user home 접근을 운영 문서에 명시

Evidence:

- `main.js:1396-1397`은 `~/.codex/config.toml`을 대상으로 한다.
- `main.js:3009-3013` 이후는 `~/.codex/sessions`를 대상으로 session 목록을 읽는다.

Impact:

- 앱 데이터 일부는 프로젝트 폴더 밖에 있다. 백업/이관/디버깅 시 사용자가 혼동할 수 있다.

Recommendation:

- README나 manual에 대화 저장 위치와 Codex config/session 읽기 위치를 분리해서 적는다.

### 7. 빌드 실패 로그 정리

Evidence:

- `build_retry.log:5-9`는 과거 `electron-builder 25.1.8`, `electron 33.4.11`, `spawn EPERM` 실패를 기록한다.

Impact:

- 현재 `package.json`이 요구하는 버전과 다르므로, 현재 상태를 대표하는 로그인지 불명확하다.

Recommendation:

- 재현 가능한 최신 build 실패 로그로 교체하거나, stale 로그로 표시한다.

## 8. Proposed minimal implementation plan

현재 요청은 문서화 작업이므로 소스 코드는 변경하지 않았다. 다음 단계로 실제 정리를 진행한다면 범위를 작게 나누는 것이 안전하다.

### Phase 1: 검증 흐름 복구

1. `npm ls --depth=0` 실패 원인을 정리한다.
2. `electron`, `electron-builder`, `node-pty` 설치 상태를 `package-lock.json`과 맞춘다.
3. `xterm`이 필요하면 dependency로 등록하고, 아니면 제거한다.
4. `powershell -File scripts/verify.ps1`가 `npm audit`까지 도달하는지 확인한다.

### Phase 2: 산출물 정리

1. 보관할 최신 installer와 `latest.yml`을 결정한다.
2. `dist-temp-subagent-*` 폴더는 검증 목적/생성 명령/삭제 가능 여부를 README 또는 이 문서에 표시한다.
3. 필요하면 `scripts/clean-artifacts.ps1` 같은 명시적 청소 스크립트를 추가한다.

### Phase 3: Hot path 계측

1. 개발 모드에서만 켜지는 lightweight timing helper를 추가한다.
2. `parseCodexOutput`, `renderCodexStructured`, `renderMessages`, `saveConversations`에 측정 지점을 둔다.
3. 다중 서브에이전트, 큰 diff, 긴 markdown 응답을 샘플 workload로 측정한다.

### Phase 4: 문서/사용자 안내 보강

1. `README.md`를 추가해 실행, 빌드, 검증, 데이터 저장 위치, Codex 설정 위치, 컨텍스트 메뉴 설치를 정리한다.
2. `renderer/manual.html`도 같은 내용을 사용자용으로 축약 반영한다.

## 9. Verification plan

### 이번 문서 작성 중 수행한 검증

Passed:

```powershell
node --check main.js
node --check preload.js
node --check renderer\app.js
```

Failed:

```powershell
npm ls --depth=0
```

실패 내용:

- `electron-builder@25.1.8 invalid: "^26.8.1" from the root project`
- `electron@33.4.11 invalid: "^41.3.0" from the root project`
- `xterm@5.3.0 extraneous`

Git 상태:

- 일반 `git status --short`는 repository owner와 실행 사용자 차이로 `dubious ownership` 오류가 났다.
- 전역 설정을 변경하지 않고 임시 `git -c safe.directory=... status --short`로 확인했을 때 출력은 없었다. 문서 작성 전 기준 작업트리는 clean이었다.

### 권장 추가 검증

1. 의존성 정리 후:

```powershell
npm install
npm ls --depth=0
```

2. 전체 정적 검증:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1
```

3. 빌드 검증:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify.ps1 -Build
```

4. UI 수동 검증:

- 앱 시작: `npm run start`
- 새 프로젝트 선택 및 CWD 표시 확인
- 일반 질문 전송과 streaming 응답 확인
- `/status`, `/model`, `/reasoning`, `/sandbox`, `/agents` 확인
- 파일 첨부: 텍스트, 이미지, PDF 각각 확인
- Git 커밋 모달: status, 선택/해제, AI 메시지 생성, commit 실패/성공 표시 확인
- 서브에이전트: agent picker, 진행 rail, resize, 완료/오류 상태 확인

5. 성능 측정 계획:

- 큰 markdown 응답 1개: parse/render ms, UI freeze 여부
- 큰 diff 응답 1개: code tab lazy render ms
- 서브에이전트 3-6개 동시 실행: p50/p95 frame delay, stream update delay
- 대화 100개 이상 저장 상태: save ms, `conversations.json` 크기, 종료 시 sync save 지연

## Appendix A. 현재 사용 관점 요약

### 개발 실행

```powershell
npm install
npm run start
```

단, 현재 설치 상태에서는 `npm ls --depth=0`가 실패하므로 먼저 dependency 상태를 정리하는 것이 좋다.

### 빌드

```powershell
npm run build
npm run build:portable
```

현재 `dist/`에는 최신 `CLI-Chat-Setup-2.0.0.exe`와 과거 artifact가 같이 존재한다.

### 컨텍스트 메뉴

- 설치: `context-menu-install.reg`
- 제거: `context-menu-uninstall.reg`
- 실행 파일 기본 경로는 `%LOCALAPPDATA%\Programs\cli-chat-app\CLI Chat.exe`
- 등록 명령은 `--cwd "%V"` 또는 `--cwd "%1"`로 작업 폴더를 전달한다.

### 데이터 위치

Evidence:

- 앱 대화 저장: Electron `app.getPath('userData')/conversations.json` (`main.js:3540-3541`)
- 백업 파일: `conversations.json.bak` (`main.js:3544-3545`)
- Codex 설정: `~/.codex/config.toml` (`main.js:1396-1397`)
- Codex 세션: `~/.codex/sessions` (`main.js:3009-3013`)

## Appendix B. 핵심 위험 요약

1. 현재 dependency 설치 상태는 `package.json` 요구 범위와 맞지 않아 공식 검증이 실패한다.
2. `dist/`와 여러 `dist-temp-subagent-*` 폴더가 약 2.85 GB를 차지한다.
3. `renderer/app.js`가 매우 크고 hot path가 집중되어 있어 변경 영향 분석과 성능 계측이 어렵다.
4. 대화 저장은 안전하지만 전체 JSON rewrite 방식이라 기록이 커질수록 latency spike 가능성이 있다.
5. 로컬 파일 read/open은 데스크톱 앱 편의성을 우선한 넓은 권한 표면이다.
6. 메인 채팅 창은 `contextIsolation: true`, `nodeIntegration: false`지만 `sandbox: false`다. 현재 preload 요구사항 때문일 수 있으나 보안 posture 문서화가 필요하다.

