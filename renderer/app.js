// app.js - CLI Chat 메인 앱

(async function () {

  window.addEventListener('error', (event) => {
    try { console.error('[renderer-error]', event?.error || event?.message || event); } catch { /* ignore */ }
  });
  window.addEventListener('unhandledrejection', (event) => {
    try { console.error('[renderer-rejection]', event?.reason || event); } catch { /* ignore */ }
  });

  function normalizeConversations(parsed) {
    if (!Array.isArray(parsed)) return [];
    const normalized = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' && item.id ? item.id : `conv_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      const title = typeof item.title === 'string' ? item.title : '';
      const profileId = 'codex';
      const messagesRaw = Array.isArray(item.messages) ? item.messages : [];
      const messages = messagesRaw
        .filter(msg => msg && typeof msg === 'object')
        .map(msg => {
          const actualCodeDiffs = Array.isArray(msg.actualCodeDiffs)
            ? msg.actualCodeDiffs
              .map(item => ({
                file: typeof item?.file === 'string' ? item.file : '',
                diff: typeof item?.diff === 'string' ? item.diff : '',
              }))
              .filter(item => item.file && item.diff)
              .slice(0, 12)
            : [];
          return {
            id: typeof msg.id === 'string' && msg.id ? msg.id : `msg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
            role: msg.role === 'user' || msg.role === 'error' ? msg.role : 'ai',
            content: typeof msg.content === 'string' ? msg.content : '',
            profileId: 'codex',
            timestamp: Number.isFinite(Number(msg.timestamp)) ? Number(msg.timestamp) : Date.now(),
            actualCodeDiffs,
          };
        });
      const cwd = typeof item.cwd === 'string' ? item.cwd : '';
      const codexSessionId = typeof item.codexSessionId === 'string' ? item.codexSessionId : null;
      normalized.push({ id, title, messages, profileId, cwd, codexSessionId });
    }
    return normalized;
  }

  async function loadConversationsSafe() {
    try {
      const result = await window.electronAPI.store.loadConversations();
      if (result?.success && Array.isArray(result.data) && result.data.length > 0) {
        return normalizeConversations(result.data);
      }
      // 파일이 비어있으면 localStorage에서 마이그레이션 시도
      try {
        const legacy = JSON.parse(localStorage.getItem('conversations') || '[]');
        if (Array.isArray(legacy) && legacy.length > 0) {
          const migrated = normalizeConversations(legacy);
          if (migrated.length > 0) {
            await window.electronAPI.store.saveConversations(migrated);
            localStorage.removeItem('conversations');
          }
          return migrated;
        }
      } catch { /* ignore legacy */ }
      return [];
    } catch {
      return [];
    }
  }

  function escapeHtmlLite(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // === marked 설정 ===
  const markedLib = globalThis.marked;
  const hasMarked = !!(markedLib && typeof markedLib.Renderer === 'function' && typeof markedLib.parse === 'function');
  const marked = hasMarked ? markedLib : {
    Renderer: function RendererFallback() { return {}; },
    setOptions: () => { },
    parse: (text) => escapeHtmlLite(text).replace(/\r?\n/g, '<br>'),
  };

  if (!hasMarked) {
    try { console.error('[renderer] marked library is unavailable, fallback renderer is active'); } catch { /* ignore */ }
  }

  const renderer = new marked.Renderer();
  const hljsApi = globalThis.hljs && typeof globalThis.hljs.highlight === 'function'
    ? globalThis.hljs
    : null;

  const LANG_ALIAS = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    py: 'python',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    bat: 'dos',
    cmd: 'dos',
    ps: 'powershell',
    ps1: 'powershell',
    yml: 'yaml',
    md: 'markdown',
  };

  function normalizeCodeLanguage(rawLang) {
    if (!rawLang) return '';
    const token = String(rawLang)
      .trim()
      .toLowerCase()
      .replace(/^language-/, '')
      .split(/[\s,{]/)[0];
    return LANG_ALIAS[token] || token;
  }

  function isLikelyLocalFileLinkTarget(href) {
    const v = String(href || '').trim();
    if (!v) return false;
    if (/^\/?[A-Za-z]:[\\/]/.test(v)) return true; // C:/...
    if (/^\\\\[^\\\/]+[\\\/][^\\\/]+/.test(v)) return true; // \\server\share\...
    if (/^\/\/[^/]+\/[^/]+/.test(v)) return true; // //server/share/...
    if (/^file:\/\/\/?/i.test(v)) return true;
    if (/^\.\.?[\\/]/.test(v)) return true;
    if (/^\/(?:Users|home|tmp|var|opt|etc)\//.test(v)) return true;
    return false;
  }

  function normalizeLocalFileLinkTarget(href) {
    if (!href) return '';
    let value = String(href).trim();
    if (!value) return '';
    if (!isLikelyLocalFileLinkTarget(value)) return value;
    const isUncLike = /^\\\\/.test(value) || /^\/\/[^/]+\/[^/]+/.test(value);

    // angle-bracket autolink 표기 보정
    if (value.startsWith('<') && value.endsWith('>')) {
      value = value.slice(1, -1).trim();
    }

    let hashPart = '';
    const hashIndex = value.indexOf('#');
    if (hashIndex >= 0) {
      hashPart = value.slice(hashIndex);
      value = value.slice(0, hashIndex);
    }

    value = value
      .replace(/\\/g, '/')
      .replace(/\s*\/\s*/g, '/')
      .replace(/\s*:\s*(?=\/)/g, ':')
      .replace(/([A-Za-z0-9_])\s*\.\s*(?=[A-Za-z0-9_])/g, '$1.')
      .trim();

    // Windows 절대경로를 앱에서 일관되게 /C:/... 형태로 유지
    if (/^[A-Za-z]:\//.test(value)) {
      value = `/${value}`;
    } else if (isUncLike) {
      // UNC 경로는 //server/share/... 형태로 표준화
      value = `//${value.replace(/^\/+/, '')}`;
    }

    if (hashPart) {
      const normalizedHash = hashPart.replace(/\s+/g, '');
      return `${value}${normalizedHash}`;
    }
    return value;
  }

  function safeDecodeURIComponentOnce(value) {
    const raw = String(value || '');
    if (!raw) return '';
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  function encodeLocalPathForDataAttr(rawPath) {
    const normalizedPath = normalizeLocalFileLinkTarget(rawPath) || String(rawPath || '');
    const decodedPath = safeDecodeURIComponentOnce(normalizedPath);
    return encodeURIComponent(decodedPath);
  }

  function mergeWrappedTokenBoundary(leftPart, rightPart) {
    const left = String(leftPart || '');
    const right = String(rightPart || '');
    if (!right) return left;

    // 전체 문자열 스캔을 피하기 위해 경계 구간만 검사
    const leftTailSource = left.slice(-96);
    const rightHeadSource = right.slice(0, 96);
    const leftTail = /([A-Za-z0-9_.$%/+\\:\-가-힣]+)$/.exec(leftTailSource)?.[1] || '';
    const rightHead = /^([A-Za-z0-9_.$%/+\\:\-가-힣]+)/.exec(rightHeadSource)?.[1] || '';
    let overlap = 0;
    if (leftTail && rightHead) {
      const maxOverlap = Math.min(leftTail.length, rightHead.length, 48);
      for (let k = maxOverlap; k >= 1; k--) {
        if (leftTail.slice(-k).toLowerCase() === rightHead.slice(0, k).toLowerCase()) {
          overlap = k;
          break;
        }
      }
    }

    const adjustedRight = overlap > 0 ? right.slice(overlap) : right;
    if (!adjustedRight) return left;
    return `${left}${adjustedRight}`;
  }

  // 스트리밍 chunk 경계에서 중복된 접두/접미를 제거해 문장/코드 분리 오동작을 줄인다.
  function appendStreamingChunk(accumulatedText, incomingChunk) {
    const base = String(accumulatedText || '');
    let chunk = String(incomingChunk || '');
    if (!chunk) return base;
    if (!base) return chunk;

    // 대형 출력에서는 병합 보정 연산을 생략해 UI 멈춤을 방지
    if (base.length > 200000 || chunk.length > 8192) {
      return `${base}${chunk}`;
    }

    if (base.endsWith(chunk)) return base;

    // transport 재전송으로 큰 접두 중복이 붙는 경우 우선 제거
    const maxExact = Math.min(base.length, chunk.length, 256);
    let exactOverlap = 0;
    for (let k = maxExact; k >= 8; k--) {
      if (base.slice(-k) === chunk.slice(0, k)) {
        exactOverlap = k;
        break;
      }
    }
    if (exactOverlap > 0) {
      chunk = chunk.slice(exactOverlap);
      if (!chunk) return base;
    }
    return `${base}${chunk}`;
  }

  // 마크다운 링크 URL이 줄바꿈으로 끊긴 경우 한 줄로 복원
  // 예) [label](/C:/.../GCECDIS \n SEngine/...) -> [label](/C:/.../GCECDISEngine/...)
  function mergeWrappedMarkdownLinks(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    const MAX_LINK_WRAP_MERGE_LINES = 4;
    const MAX_LINK_WRAP_MERGE_LENGTH = 1800;

    const hasUnclosedLinkTarget = (line) => {
      const s = String(line || '');
      const start = s.lastIndexOf('](');
      if (start < 0) return false;
      const close = s.indexOf(')', start + 2);
      return close < 0;
    };

    const isLinkMergeStopLine = (trimmedLine) => {
      const t = String(trimmedLine || '');
      if (!t) return true;
      if (/^\|/.test(t)) return true;
      if (/^```/.test(t)) return true;
      if (/^[-*+]\s+/.test(t)) return true;
      if (/^\d+\.\s+/.test(t)) return true;
      return false;
    };

    const isLikelyLinkTargetContinuation = (trimmedLine) => {
      const t = String(trimmedLine || '');
      if (!t) return false;
      if (t.length > 400) return false;
      const hasPathHint = (
        /[\\/]/.test(t)
        || /^[A-Za-z]:/.test(t)
        || /^[#?&=)/]/.test(t)
        || /%[0-9A-Fa-f]{2}/.test(t)
        || /\.[A-Za-z0-9]{1,8}\)?$/.test(t)
      );
      if (!hasPathHint) return false;
      return /^[A-Za-z0-9_.$%/+\\:\-#?=&()~,\[\];@가-힣 ]+$/.test(t);
    };

    for (let i = 0; i < lines.length; i++) {
      let current = String(lines[i] || '');
      if (!hasUnclosedLinkTarget(current)) {
        out.push(current);
        continue;
      }

      const original = current;
      let consumedUntil = i;
      let mergedLines = 0;
      for (let j = i + 1; j < lines.length; j++) {
        const nextRaw = String(lines[j] || '');
        const nextTrimmed = nextRaw.trim();
        if (isLinkMergeStopLine(nextTrimmed)) break;
        if (!isLikelyLinkTargetContinuation(nextTrimmed)) break;

        const merged = mergeWrappedTokenBoundary(current, nextTrimmed);
        if (merged.length > MAX_LINK_WRAP_MERGE_LENGTH) break;
        current = merged;
        consumedUntil = j;
        mergedLines += 1;
        if (!hasUnclosedLinkTarget(current)) break;
        if (mergedLines >= MAX_LINK_WRAP_MERGE_LINES) break;
      }

      // 닫힘이 확정된 경우에만 병합 결과를 채택한다.
      if (!hasUnclosedLinkTarget(current) && consumedUntil > i) {
        out.push(current);
        i = consumedUntil;
        continue;
      }

      out.push(original);
    }

    return out.join('\n');
  }

  function normalizeMarkdownLocalLinks(text) {
    const mergedText = mergeWrappedMarkdownLinks(text);
    return String(mergedText || '').replace(
      /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
      (match, label, href) => {
        const normalizedHref = normalizeLocalFileLinkTarget(href);
        if (!normalizedHref || normalizedHref === href) return match;
        return `[${label}](${normalizedHref})`;
      }
    );
  }

  function parseLocalLinkPathAndLine(href, label) {
    let value = String(href || '').trim();
    let line = null;

    const hashLineMatch = /#L?(\d+)$/i.exec(value);
    if (hashLineMatch) {
      const parsed = Number(hashLineMatch[1]);
      line = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      value = value.slice(0, hashLineMatch.index);
    }

    if (!line) {
      const pathLineMatch = /^(.*\.[A-Za-z0-9_+\-]+):(\d+)$/.exec(value);
      if (pathLineMatch) {
        const parsed = Number(pathLineMatch[2]);
        line = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        value = pathLineMatch[1];
      }
    }

    if (!line) {
      const labelLineMatch = /:(\d+)\)?$/.exec(String(label || '').trim());
      if (labelLineMatch) {
        const parsed = Number(labelLineMatch[1]);
        line = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      }
    }

    return { path: value, line };
  }

  function renderHighlightedCode(text, language) {
    if (!hljsApi) return escapeHtml(text);
    try {
      return language && hljsApi.getLanguage(language)
        ? hljsApi.highlight(text, { language }).value
        : hljsApi.highlightAuto(text).value;
    } catch {
      return escapeHtml(text);
    }
  }

  // 코드 블록: 언어 표시 + 복사 버튼
  renderer.code = function (codeOrToken, maybeLang) {
    const text = typeof codeOrToken === 'string'
      ? codeOrToken
      : String(codeOrToken?.text || '');
    const rawLang = typeof codeOrToken === 'string' ? maybeLang : codeOrToken?.lang;
    const parsedLang = normalizeCodeLanguage(rawLang);
    const language = (parsedLang === 'diff' || parsedLang === 'patch') ? '' : parsedLang;
    const highlighted = renderHighlightedCode(text, language);
    const langLabel = language || 'code';
    const langClass = language ? ` language-${language.replace(/[^a-z0-9_-]/gi, '')}` : '';
    return `<div class="code-block-wrapper">
      <div class="code-block-header">
        <span class="code-lang">${escapeHtml(langLabel)}</span>
        <button class="code-copy-btn" data-action="copy">복사</button>
      </div>
      <pre><code class="hljs${langClass}">${highlighted}</code></pre>
    </div>`;
  };

  // 링크 렌더러: 파일 경로를 안전하게 처리
  renderer.link = function (tokenOrHref, maybeTitle, maybeText) {
    let href, title, text;
    if (typeof tokenOrHref === 'object' && tokenOrHref !== null) {
      href = tokenOrHref.href || '';
      title = tokenOrHref.title || '';
      text = tokenOrHref.text || '';
    } else {
      href = String(tokenOrHref || '');
      title = String(maybeTitle || '');
      text = String(maybeText || '');
    }
    // 로컬 파일 경로는 앱 내부 클릭 링크로 렌더링
    if (isLikelyLocalFileLinkTarget(href)) {
      const normalizedHref = normalizeLocalFileLinkTarget(href) || href;
      const parsed = parseLocalLinkPathAndLine(normalizedHref, text);
      const encodedPath = encodeLocalPathForDataAttr(parsed.path || normalizedHref);
      const lineAttr = Number.isFinite(parsed.line) && parsed.line > 0
        ? ` data-line="${parsed.line}"`
        : '';
      const safeTitle = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="#" class="file-path-link markdown-local-link" data-local-path="${encodedPath}"${lineAttr}${safeTitle}>${escapeHtml(text || href)}</a>`;
    }
    const safeHref = escapeHtml(href);
    const safeTitle = title ? ` title="${escapeHtml(title)}"` : '';
    const safeText = escapeHtml(text || href);
    return `<a href="${safeHref}"${safeTitle} target="_blank" rel="noopener">${safeText}</a>`;
  };

  marked.setOptions({
    renderer,
    gfm: true,
    breaks: true,
  });

  // === 프로필 ===
  const PROFILES = [
    { id: 'codex', name: 'Codex CLI', command: 'codex', args: ['exec', '--full-auto', '--skip-git-repo-check'], mode: 'pipe', color: '#10A37F', icon: 'X' },
  ];

  // === 상태 ===
  let activeProfileId = 'codex';
  let conversations = await loadConversationsSafe();
  let activeConvId = null;
  let isStreaming = false;
  let currentStreamId = null;
  let currentCwd = '';
  let runtimeMenuType = '';

  // 대화별 스트리밍 상태: convId → { streamId, unsubStream, unsubDone, unsubError, elapsedTimer }
  const convStreams = new Map();

  const MESSAGE_SCROLL_BOTTOM_THRESHOLD = 20;
  const STREAM_INLINE_PROGRESS_VISIBLE_LINES = 5;
  const STREAM_INLINE_PROGRESS_HISTORY_LIMIT = 300;
  let shouldAutoScrollMessages = true;
  let suppressMessagesScrollEvent = false;
  let historyEditingId = null;
  const SIDEBAR_PREF_WIDTH_KEY = 'sidebarWidthPx';
  const SIDEBAR_PREF_COLLAPSED_KEY = 'sidebarCollapsed';
  const SIDEBAR_MIN_WIDTH = 190;
  const SIDEBAR_MAX_WIDTH = 520;
  let sidebarWidthPx = null;
  let sidebarCollapsed = false;
  let sidebarResizeSession = null;

  // === DOM ===
  const $messages = document.getElementById('messages');
  const $sidebar = document.getElementById('sidebar');
  const $sidebarResizer = document.getElementById('sidebar-resizer');
  const $welcome = document.getElementById('welcome');
  const $input = document.getElementById('prompt-input');
  const $btnSend = document.getElementById('btn-send');
  const $btnStop = document.getElementById('btn-stop');
  const $btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
  const $profileList = document.getElementById('profile-list');
  const $historyList = document.getElementById('history-list');
  const $profileName = document.getElementById('current-profile-name');
  const $profileBadge = document.getElementById('active-profile-badge');
  const $cwdPath = document.getElementById('cwd-path');
  const $cwdHint = document.getElementById('input-cwd-display');
  const $modelHint = document.getElementById('current-model-name');
  const $planModeHint = document.getElementById('current-plan-mode');
  const $sandboxHint = document.getElementById('current-sandbox-mode');
  const $runtimeMenu = document.getElementById('runtime-selector-menu');
  const $slashMenu = document.getElementById('slash-command-menu');
  const $sessionPicker = document.getElementById('session-picker');
  const $slashFeedback = document.getElementById('slash-command-feedback');
  const $codexStatusbar = document.getElementById('codex-statusbar');
  const $appVersion = document.getElementById('app-version');
  const $btnUserManual = document.getElementById('btn-user-manual');

  const SLASH_COMMANDS = [
    // --- Codex 실행 ---
    { command: '/search', description: '웹 검색 활성화하여 질문', usage: '/search [질문]' },
    { command: '/review', description: '코드 리뷰 (uncommitted)', usage: '/review [지시사항]' },
    { command: '/review-base', description: '브랜치 기준 코드 리뷰', usage: '/review-base [브랜치] [지시]' },
    { command: '/review-commit', description: '커밋 리뷰', usage: '/review-commit [SHA]' },
    { command: '/apply', description: 'Codex diff를 git apply', usage: '/apply [task-id]' },
    // --- Codex 세션 ---
    { command: '/resume', description: '이전 세션 이어서 실행 (인자 없으면 목록 표시)', usage: '/resume [session-id]' },
    { command: '/resume-raw', description: '원본 로그 전체 복원 (commentary/메타 포함)', usage: '/resume-raw [session-id]' },
    { command: '/fork', description: '이전 세션 복제 후 실행', usage: '/fork [session-id]' },
    // --- MCP ---
    { command: '/mcp-list', description: 'MCP 서버 목록', usage: '/mcp-list' },
    { command: '/mcp-add', description: 'MCP 서버 추가', usage: '/mcp-add [이름] [--url URL | -- 명령어]' },
    { command: '/mcp-remove', description: 'MCP 서버 제거', usage: '/mcp-remove [이름]' },
    // --- Cloud (실험적) ---
    { command: '/cloud-exec', description: 'Cloud 태스크 생성', usage: '/cloud-exec --env [ENV] [질문]' },
    { command: '/cloud-list', description: 'Cloud 태스크 목록', usage: '/cloud-list [--env ENV]' },
    { command: '/cloud-status', description: 'Cloud 태스크 상태', usage: '/cloud-status [task-id]' },
    { command: '/cloud-diff', description: 'Cloud 태스크 diff', usage: '/cloud-diff [task-id]' },
    { command: '/cloud-apply', description: 'Cloud 태스크 diff 적용', usage: '/cloud-apply [task-id]' },
    // --- 인증 ---
    { command: '/login', description: '로그인 상태 확인', usage: '/login' },
    { command: '/logout', description: '인증 정보 제거', usage: '/logout' },
    // --- 설정 ---
    { command: '/model', description: '모델 변경', usage: '/model [모델명]' },
    { command: '/reasoning', description: 'Reasoning effort 변경', usage: '/reasoning [low|medium|high|extra high]' },
    { command: '/sandbox', description: '샌드박스 모드 변경', usage: '/sandbox [read-only|workspace-write|danger-full-access]' },
    { command: '/cwd', description: '작업 폴더 변경', usage: '/cwd [경로]' },
    // --- 앱 기능 ---
    { command: '/file', description: '파일 불러오기', usage: '/file [경로]' },
    { command: '/status', description: '5h/weekly limit 갱신', usage: '/status' },
    { command: '/clear', description: '현재 대화 초기화', usage: '/clear' },
    { command: '/features', description: 'Codex feature flag 목록', usage: '/features' },
    { command: '/version', description: 'Codex CLI 버전', usage: '/version' },
    { command: '/help', description: '명령어 목록', usage: '/help' },
  ];
  const MODEL_OPTIONS = [
    { id: 'GPT-5.3-Codex', cliModel: 'gpt-5.3-codex' },
    { id: 'GPT-5.2-Codex', cliModel: 'gpt-5.2-codex' },
    { id: 'GPT-5.1-Codex-Max', cliModel: 'gpt-5.1-codex-max' },
    { id: 'GPT-5.2', cliModel: 'gpt-5.2' },
    { id: 'GPT-5.1.Codex-Mini', cliModel: 'gpt-5.1-codex-mini' },
  ];
  const MODEL_OPTION_IDS = MODEL_OPTIONS.map(item => item.id);
  const REASONING_OPTIONS = ['low', 'medium', 'high', 'extra high'];
  const DEFAULT_MODEL_ID = 'GPT-5.3-Codex';
  const DEFAULT_REASONING = 'extra high';
  const RUNTIME_INFO_VERSION = 3;
  const STREAM_RENDER_THROTTLE_MS = 70;
  const STREAM_SECTIONS_PARSE_INTERVAL_MS = 280;
  const SHOW_STREAMING_WORK_PANEL = false;

  let slashMenuItems = [];
  let slashSelectedIndex = 0;
  let slashFeedbackTimer = null;
  let codexLimitSnapshot = loadCodexLimitSnapshot();
  let codexRuntimeInfo = loadCodexRuntimeInfo();
  let sandboxMode = localStorage.getItem('codexSandboxMode') || 'workspace-write';

  // === Codex 사용량 트래커 ===
  const codexUsage = {
    _key: 'codexUsageLog',
    _limitKey: 'codexUsageLimits',

    loadLog() {
      try {
        const raw = JSON.parse(localStorage.getItem(this._key) || '[]');
        return Array.isArray(raw) ? raw : [];
      } catch {
        return [];
      }
    },

    saveLog(log) {
      localStorage.setItem(this._key, JSON.stringify(log));
    },

    record(tokens, effort) {
      if (!tokens || tokens <= 0) return;
      const log = this.loadLog();
      log.push({ ts: Date.now(), tokens, effort: effort || 'medium' });
      const weekAgo = Date.now() - 7 * 24 * 3600000;
      this.saveLog(log.filter(e => e.ts > weekAgo));
    },

    getStats() {
      const log = this.loadLog();
      const now = Date.now();
      const h5Ago = now - 5 * 3600000;
      const weekAgo = now - 7 * 24 * 3600000;
      let h5 = 0, weekly = 0;
      for (const e of log) {
        const tokens = Number(e.tokens) || 0;
        if (tokens <= 0) continue;
        if (e.ts > weekAgo) { weekly += tokens; if (e.ts > h5Ago) h5 += tokens; }
      }
      return { h5, weekly };
    },

    getLimits() {
      try {
        const raw = JSON.parse(localStorage.getItem(this._limitKey) || '{}');
        const h5 = Number(raw.h5);
        const weekly = Number(raw.weekly);
        return {
          h5: Number.isFinite(h5) && h5 > 0 ? h5 : null,
          weekly: Number.isFinite(weekly) && weekly > 0 ? weekly : null,
        };
      } catch {
        return { h5: null, weekly: null };
      }
    },

    updateLimits(next) {
      const current = this.getLimits();
      const merged = {
        h5: Number.isFinite(Number(next?.h5)) && Number(next.h5) > 0 ? Number(next.h5) : current.h5,
        weekly: Number.isFinite(Number(next?.weekly)) && Number(next.weekly) > 0 ? Number(next.weekly) : current.weekly,
      };
      localStorage.setItem(this._limitKey, JSON.stringify(merged));
      return merged;
    },
  };

  function parseTokenNumber(raw) {
    if (!raw) return 0;
    const text = String(raw).trim();
    const compact = text.replace(/,/g, '').replace(/_/g, '').replace(/\s+/g, '');
    const scaled = compact.match(/^([0-9]+(?:\.[0-9]+)?)([kKmMbBtT])?$/);
    if (scaled) {
      const base = Number(scaled[1]);
      const unit = (scaled[2] || '').toLowerCase();
      const mul = unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : unit === 'b' ? 1e9 : unit === 't' ? 1e12 : 1;
      const value = Math.round(base * mul);
      return Number.isFinite(value) ? value : 0;
    }
    const n = parseInt(text.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }

  function formatTokenNumber(n) {
    return (Number(n) || 0).toLocaleString('en-US');
  }

  function extractTokenUsage(text) {
    if (!text) return 0;
    const source = String(text);
    const metaContext = /(OpenAI\s+Codex|tokens?|_tokens|reasoning\s+effort|model:|approval:|토큰|사용량)/i.test(source);
    if (!metaContext) return 0;

    // 1) 항목별 토큰 합산 (input/output/reasoning/cache 등)
    const partRe = /(input|prompt|output|completion|reasoning|cache(?:d)?(?:\s+read)?|response|tool(?:\s+output)?|입력|출력|추론|캐시|응답)\s*(?:[_\s-]*tokens?|토큰)?\s*[:=]?\s*([0-9][0-9,._\s]*)/ig;
    let partSum = 0;
    let partCount = 0;
    let p;
    while ((p = partRe.exec(source)) !== null) {
      const parsed = parseTokenNumber(p[2]);
      if (parsed > 0) {
        partSum += parsed;
        partCount += 1;
      }
    }
    if (partCount >= 2) return partSum;

    // 2) 총합 토큰 표현
    const totalPatterns = [
      /total\s+tokens?\s+used\s*[:=]\s*([0-9][0-9,._\s]*)/ig,
      /tokens?\s+used\s*[:=]\s*([0-9][0-9,._\s]*)\s*$/ig,
      /total[_\s]?tokens?\s*[:=]\s*([0-9][0-9,._\s]*)/ig,
      /tokens?[_\s-]*total\s*[:=]\s*([0-9][0-9,._\s]*)/ig,
      /토큰(?:\s*사용량)?\s*[:=]\s*([0-9][0-9,._\s]*)/ig,
      /총\s*토큰(?:\s*사용량)?\s*[:=]\s*([0-9][0-9,._\s]*)/ig,
      /token(?:s)?\s*usage\s*[:=][^\n]*?(?:total|총)\s*[:=]\s*([0-9][0-9,._\s]*)/ig,
      /토큰(?:\s*사용량)?\s*[:=][^\n]*?(?:total|총)\s*[:=]\s*([0-9][0-9,._\s]*)/ig,
    ];
    for (const re of totalPatterns) {
      let m;
      let last = 0;
      while ((m = re.exec(source)) !== null) {
        const parsed = parseTokenNumber(m[1]);
        if (parsed > 0) last = parsed;
      }
      if (last > 0) return last;
    }

    // 3) 항목이 1개만 잡힌 경우도 보조로 허용
    if (partCount === 1) return partSum;

    return 0;
  }

  function estimateTokenCount(text) {
    if (!text) return 0;
    const source = String(text);
    let asciiChars = 0;
    let nonAsciiChars = 0;

    for (const ch of source) {
      if (/\s/.test(ch)) continue;
      if (ch.charCodeAt(0) < 128) asciiChars += 1;
      else nonAsciiChars += 1;
    }

    const asciiTokens = Math.ceil(asciiChars / 4);
    const nonAsciiTokens = Math.ceil(nonAsciiChars * 0.9);
    return Math.max(0, asciiTokens + nonAsciiTokens);
  }

  function resolveCodexTurnUsage(promptText, outputText) {
    const parsed = extractTokenUsage(outputText);
    if (parsed > 0) {
      return { total: parsed, estimated: false };
    }

    const promptTokens = estimateTokenCount(promptText);
    const outputTokens = estimateTokenCount(outputText);
    const estimatedTotal = promptTokens + outputTokens;
    if (estimatedTotal <= 0) {
      return { total: 0, estimated: false };
    }

    return { total: estimatedTotal, estimated: true };
  }

  function ensureTokenSummary(sections, fallbackText) {
    const fromSummary = parseTokenNumber(sections.tokens.summary || '');
    if (fromSummary > 0) return fromSummary;

    const inferred = extractTokenUsage(
      fallbackText || [
        sections.tokens.content,
        sections.session.content,
        sections.thinking.content,
      ].filter(Boolean).join('\n')
    );
    if (inferred > 0) {
      sections.tokens.summary = formatTokenNumber(inferred);
      if (!sections.tokens.content) {
        sections.tokens.content = `Tokens used: ${sections.tokens.summary}`;
      }
    }
    return inferred;
  }

  function normalizePercent(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return null;
    return Math.max(0, Math.min(100, Number(num.toFixed(1))));
  }

  const H5_SCOPE_PATTERN = /(?:5\s*h(?:ours?)?|5h\s*limit|5시간)/;
  const WEEKLY_SCOPE_PATTERN = /(?:week(?:ly)?|weekly\s*limit|주간|주)/;

  function extractRemainingPercent(text, scopePattern) {
    if (!text) return null;
    const source = String(text);
    const patterns = [
      new RegExp(`${scopePattern.source}[^\\n%]{0,40}?(\\d{1,3}(?:\\.\\d+)?)\\s*%[^\\n]{0,24}`, 'ig'),
      new RegExp(`(\\d{1,3}(?:\\.\\d+)?)\\s*%[^\\n]{0,40}?${scopePattern.source}[^\\n]{0,24}`, 'ig'),
      new RegExp(`${scopePattern.source}[^\\n]{0,30}?(?:잔여|remaining|left|사용률|usage)?[^\\n]{0,12}?[=:]\\s*(\\d{1,3}(?:\\.\\d+)?)\\b`, 'ig'),
      new RegExp(`(\\d{1,3}(?:\\.\\d+)?)\\b[^\\n]{0,30}?${scopePattern.source}[^\\n]{0,15}?(?:잔여|remaining|left|사용률|usage)`, 'ig'),
    ];

    for (const re of patterns) {
      let m;
      while ((m = re.exec(source)) !== null) {
        const rawPct = normalizePercent(m[1]);
        if (rawPct === null) continue;
        const snippet = m[0].toLowerCase();
        const hasLimit = /\blimit\b|한도/.test(snippet);
        const hasDirection = /(used|usage|remaining|left|잔여|소진|사용)/i.test(snippet);
        if (hasLimit && !hasDirection) continue;
        const looksUsed = /(used|usage|소진|사용)/i.test(snippet);
        const remaining = looksUsed ? normalizePercent(100 - rawPct) : rawPct;
        if (remaining !== null) return remaining;
      }
    }
    return null;
  }

  function extractRemainingPercents(sections) {
    const source = [
      sections.session.content || '',
      sections.tokens.content || '',
      sections.thinking.content || '',
      sections.response.content || '',
    ].join('\n');
    return {
      h5: extractRemainingPercent(source, H5_SCOPE_PATTERN),
      weekly: extractRemainingPercent(source, WEEKLY_SCOPE_PATTERN),
    };
  }

  function extractUsageLimitPair(text, scopePattern) {
    if (!text) return null;
    const source = String(text);
    const amountPattern = '([0-9][0-9,._\\s]*(?:\\.[0-9]+)?\\s*[kKmMbBtT]?)';
    const patterns = [
      { re: new RegExp(`${scopePattern.source}[^\\n]{0,60}?${amountPattern}\\s*(?:/|of|out\\s*of|중)\\s*${amountPattern}`, 'ig'), swap: false },
      { re: new RegExp(`${amountPattern}\\s*(?:/|of|out\\s*of|중)\\s*${amountPattern}[^\\n]{0,60}?${scopePattern.source}`, 'ig'), swap: false },
      { re: new RegExp(`${scopePattern.source}[^\\n]{0,60}?used[^\\n]{0,15}?${amountPattern}[^\\n]{0,20}?(?:limit|max)[^\\n]{0,15}?${amountPattern}`, 'ig'), swap: false },
      { re: new RegExp(`${scopePattern.source}[^\\n]{0,60}?(?:limit|max)[^\\n]{0,15}?${amountPattern}[^\\n]{0,20}?used[^\\n]{0,15}?${amountPattern}`, 'ig'), swap: true },
    ];

    for (const item of patterns) {
      const re = item.re;
      let m;
      while ((m = re.exec(source)) !== null) {
        let used = parseTokenNumber(m[1]);
        let limit = parseTokenNumber(m[2]);
        if (item.swap) {
          const t = used;
          used = limit;
          limit = t;
        }

        if (!(used > 0 && limit > 0 && limit >= used)) {
          const swapUsed = parseTokenNumber(m[2]);
          const swapLimit = parseTokenNumber(m[1]);
          if (swapUsed > 0 && swapLimit > 0 && swapLimit >= swapUsed) {
            used = swapUsed;
            limit = swapLimit;
          }
        }

        if (used > 0 && limit > 0 && limit >= used) {
          return { used, limit };
        }
      }
    }
    return null;
  }

  function extractRemainingByUsageLimit(sections) {
    const source = [
      sections.session.content || '',
      sections.tokens.content || '',
      sections.thinking.content || '',
      sections.response.content || '',
    ].join('\n');

    const h5Pair = extractUsageLimitPair(source, H5_SCOPE_PATTERN);
    const weeklyPair = extractUsageLimitPair(source, WEEKLY_SCOPE_PATTERN);

    return {
      h5: h5Pair ? remainingByLimit(h5Pair.used, h5Pair.limit) : null,
      weekly: weeklyPair ? remainingByLimit(weeklyPair.used, weeklyPair.limit) : null,
      limits: {
        h5: h5Pair?.limit || null,
        weekly: weeklyPair?.limit || null,
      },
    };
  }

  function inferLimitFromRemaining(usedTokens, remainingPercent) {
    const used = Number(usedTokens);
    const remaining = Number(remainingPercent);
    if (!Number.isFinite(used) || used <= 0) return null;
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining >= 100) return null;
    const usedPercent = 100 - remaining;
    if (usedPercent <= 0) return null;
    const limit = used / (usedPercent / 100);
    if (!Number.isFinite(limit) || limit <= 0) return null;
    return Math.max(used, Math.ceil(limit));
  }

  function remainingByLimit(usedTokens, limitTokens) {
    const used = Number(usedTokens);
    const limit = Number(limitTokens);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
    return normalizePercent(100 - (used / limit) * 100);
  }

  function resolveRemainingPercents(sections, stats) {
    const direct = extractRemainingPercents(sections);
    const byUsageLimit = extractRemainingByUsageLimit(sections);
    const inferredLimits = {
      h5: byUsageLimit.limits.h5 || inferLimitFromRemaining(stats.h5, direct.h5),
      weekly: byUsageLimit.limits.weekly || inferLimitFromRemaining(stats.weekly, direct.weekly),
    };
    const learned = codexUsage.updateLimits(inferredLimits);

    return {
      h5: byUsageLimit.h5 != null ? byUsageLimit.h5 : (direct.h5 != null ? direct.h5 : remainingByLimit(stats.h5, learned.h5)),
      weekly: byUsageLimit.weekly != null ? byUsageLimit.weekly : (direct.weekly != null ? direct.weekly : remainingByLimit(stats.weekly, learned.weekly)),
      source: {
        h5: byUsageLimit.h5 != null ? 'usage-limit' : (direct.h5 != null ? 'direct' : (learned.h5 ? 'estimated' : 'none')),
        weekly: byUsageLimit.weekly != null ? 'usage-limit' : (direct.weekly != null ? 'direct' : (learned.weekly ? 'estimated' : 'none')),
      },
    };
  }

  function loadCodexLimitSnapshot() {
    try {
      const raw = JSON.parse(localStorage.getItem('codexLimitSnapshot') || '{}');
      return {
        h5: normalizePercent(raw.h5),
        weekly: normalizePercent(raw.weekly),
        h5ResetAt: normalizeResetTimestamp(raw.h5ResetAt ?? raw.h5ResetsAt),
        weeklyResetAt: normalizeResetTimestamp(raw.weeklyResetAt ?? raw.weeklyResetsAt),
        updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
      };
    } catch {
      return { h5: null, weekly: null, h5ResetAt: null, weeklyResetAt: null, updatedAt: 0 };
    }
  }

  function saveCodexLimitSnapshot() {
    localStorage.setItem('codexLimitSnapshot', JSON.stringify(codexLimitSnapshot));
  }

  function mergeCodexLimitSnapshot(next) {
    let changed = false;
    const h5 = normalizePercent(next?.h5);
    const weekly = normalizePercent(next?.weekly);
    const h5ResetAt = normalizeResetTimestamp(next?.h5ResetAt ?? next?.h5ResetsAt);
    const weeklyResetAt = normalizeResetTimestamp(next?.weeklyResetAt ?? next?.weeklyResetsAt);

    if (h5 !== null) {
      codexLimitSnapshot.h5 = h5;
      changed = true;
    }
    if (weekly !== null) {
      codexLimitSnapshot.weekly = weekly;
      changed = true;
    }
    if (h5ResetAt !== null) {
      codexLimitSnapshot.h5ResetAt = h5ResetAt;
      changed = true;
    }
    if (weeklyResetAt !== null) {
      codexLimitSnapshot.weeklyResetAt = weeklyResetAt;
      changed = true;
    }
    if (changed) {
      codexLimitSnapshot.updatedAt = Date.now();
      saveCodexLimitSnapshot();
    }
    return changed;
  }

  function normalizeResetTimestamp(value) {
    if (value == null) return null;
    if (value instanceof Date) {
      const ts = value.getTime();
      return Number.isFinite(ts) ? ts : null;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value <= 0) return null;
      if (value < 1e11) return Math.round(value * 1000); // unix seconds
      return Math.round(value); // unix milliseconds
    }

    const raw = String(value).trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return null;
      if (n < 1e11) return Math.round(n * 1000);
      return Math.round(n);
    }

    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed);
  }

  function formatResetEta(targetTs) {
    const ts = normalizeResetTimestamp(targetTs);
    if (!ts) return '초기화 시간 미확인';

    const diffMs = ts - Date.now();
    const absText = new Date(ts).toLocaleString('ko-KR', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    if (diffMs <= 0) return `초기화 시각 ${absText}`;

    const totalMinutes = Math.max(1, Math.floor(diffMs / 60000));
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const mins = totalMinutes % 60;

    let relative = '';
    if (days > 0) {
      relative = `${days}일 ${hours}시간`;
    } else if (hours > 0) {
      relative = `${hours}시간 ${mins}분`;
    } else {
      relative = `${mins}분`;
    }
    return `${relative} 후 초기화 (${absText})`;
  }

  function resolveSnapshotFromStoredLimits() {
    const stats = codexUsage.getStats();
    const limits = codexUsage.getLimits();
    const h5 = remainingByLimit(stats.h5, limits.h5);
    const weekly = remainingByLimit(stats.weekly, limits.weekly);
    mergeCodexLimitSnapshot({ h5, weekly });
  }

  function getRemainingLevel(pct) {
    const n = normalizePercent(pct);
    if (n === null) return 'unknown';
    if (n <= 20) return 'danger';
    if (n <= 40) return 'warn';
    return 'good';
  }

  function formatRemainingPercent(pct) {
    const n = normalizePercent(pct);
    if (n === null) return '--';
    if (Number.isInteger(n)) return `${n}%`;
    return `${n.toFixed(1)}%`;
  }

  function renderCodexStatusbar() {
    if (!$codexStatusbar) return;

    const h5Pct = normalizePercent(codexLimitSnapshot.h5);
    const weeklyPct = normalizePercent(codexLimitSnapshot.weekly);
    const h5Level = getRemainingLevel(h5Pct);
    const weeklyLevel = getRemainingLevel(weeklyPct);
    const updatedAtText = codexLimitSnapshot.updatedAt
      ? new Date(codexLimitSnapshot.updatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '-';

    const buildUsageItem = (label, pct, level, resetAt) => {
      const safePct = pct === null ? 100 : Math.max(0, Math.min(100, pct));
      const fillClass = level === 'danger'
        ? 'danger'
        : (level === 'warn' ? 'warn' : (level === 'unknown' ? 'unknown' : ''));
      const pctText = pct === null ? '--' : `${formatRemainingPercent(pct)} 남음`;
      const resetText = formatResetEta(resetAt);
      return `<div class="codex-usage-item">
        <div class="codex-usage-main">
          <span class="codex-usage-label">${label}</span>
          <div class="codex-usage-bar">
            <div class="codex-usage-fill ${fillClass}" style="width:${safePct}%"></div>
          </div>
          <span class="codex-usage-pct">${pctText}</span>
        </div>
        <span class="codex-usage-reset">${resetText}</span>
      </div>`;
    };

    $codexStatusbar.innerHTML = `<div class="codex-usage-row">
      ${buildUsageItem('5h', h5Pct, h5Level, codexLimitSnapshot.h5ResetAt)}
      ${buildUsageItem('Week', weeklyPct, weeklyLevel, codexLimitSnapshot.weeklyResetAt)}
    </div>
    <div class="codex-usage-note">5h limit / weekly limit 자동 갱신 · 마지막 갱신 ${updatedAtText}</div>`;
  }

  function parseEffort(sections) {
    const text = sections.session.content + '\n' + sections.thinking.content;
    const m = text.match(/(?:reasoning|effort)\s*[:=]\s*(low|medium|high|xhigh|extra[\s-]?high)/i);
    if (m) return m[1].toLowerCase().replace(/extra[\s-]?high/, 'xhigh');
    return 'medium';
  }

  function normalizeReasoning(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
    if (normalized === 'xhigh') return 'extra high';
    return normalized;
  }

  function formatReasoningLabel(value) {
    const normalized = normalizeReasoning(value);
    if (!normalized) return 'Extra High';
    return normalized.replace(/\b\w/g, ch => ch.toUpperCase());
  }

  function getModelOptionById(id) {
    return MODEL_OPTIONS.find(option => option.id === id) || null;
  }

  function normalizeModelOptionId(value) {
    const raw = String(value || '').trim();
    if (!raw) return DEFAULT_MODEL_ID;

    // 현재 버전 ID 저장값
    if (MODEL_OPTION_IDS.includes(raw)) return raw;

    // 과거/외부 저장값 보정
    const lower = raw.toLowerCase();
    if (lower === 'gpt-5.3-codex') return 'GPT-5.3-Codex';
    if (lower === 'gpt-5.2-codex') return 'GPT-5.2-Codex';
    if (lower === 'gpt-5.1-codex-max') return 'GPT-5.1-Codex-Max';
    if (lower === 'gpt-5.2') return 'GPT-5.2';
    if (lower === 'gpt-5.1.codex-mini' || lower === 'gpt-5.1-codex-mini') return 'GPT-5.1.Codex-Mini';
    if (lower === 'gpt-5' || lower === 'gpt-5-mini' || lower === 'gpt-5-nano' || lower === 'auto') return DEFAULT_MODEL_ID;

    return DEFAULT_MODEL_ID;
  }

  function getCodexCliModel(modelId) {
    const normalizedId = normalizeModelOptionId(modelId);
    const option = getModelOptionById(normalizedId);
    if (option?.cliModel) return option.cliModel;
    const fallback = getModelOptionById(DEFAULT_MODEL_ID);
    return fallback?.cliModel || 'gpt-5.3-codex';
  }

  function loadCodexRuntimeInfo() {
    try {
      const saved = JSON.parse(localStorage.getItem('codexRuntimeInfo') || '{}');
      const savedModelId = normalizeModelOptionId(saved.model);
      const savedReasoning = normalizeReasoning(saved.reasoning);
      const hasSavedModel = typeof saved.model === 'string' && saved.model.trim().length > 0;
      const hasSavedReasoning = typeof saved.reasoning === 'string' && saved.reasoning.trim().length > 0;
      return {
        model: hasSavedModel && MODEL_OPTION_IDS.includes(savedModelId) ? savedModelId : DEFAULT_MODEL_ID,
        reasoning: hasSavedReasoning && REASONING_OPTIONS.includes(savedReasoning) ? savedReasoning : DEFAULT_REASONING,
      };
    } catch {
      return { model: DEFAULT_MODEL_ID, reasoning: DEFAULT_REASONING };
    }
  }

  function saveCodexRuntimeInfo() {
    localStorage.setItem('codexRuntimeInfo', JSON.stringify({
      ...codexRuntimeInfo,
      version: RUNTIME_INFO_VERSION,
    }));
  }

  function closeRuntimeMenu() {
    runtimeMenuType = '';
    if ($runtimeMenu) {
      $runtimeMenu.classList.add('hidden');
      $runtimeMenu.innerHTML = '';
    }
  }

  const SANDBOX_OPTIONS = ['workspace-write', 'read-only', 'danger-full-access'];
  const SANDBOX_LABELS = {
    'workspace-write': 'Workspace Write (기본)',
    'read-only': 'Read Only',
    'danger-full-access': 'Full Access (위험)',
  };

  function renderRuntimeMenu(type) {
    if (!$runtimeMenu) return;
    runtimeMenuType = type;
    let options, currentValue, labelFn;
    if (type === 'model') {
      options = MODEL_OPTION_IDS;
      currentValue = codexRuntimeInfo.model;
      labelFn = opt => opt;
    } else if (type === 'reasoning') {
      options = REASONING_OPTIONS;
      currentValue = codexRuntimeInfo.reasoning;
      labelFn = opt => formatReasoningLabel(opt);
    } else if (type === 'sandbox') {
      options = SANDBOX_OPTIONS;
      currentValue = sandboxMode;
      labelFn = opt => SANDBOX_LABELS[opt] || opt;
    } else {
      return;
    }
    $runtimeMenu.innerHTML = options.map(opt => `
      <button type="button" class="runtime-option ${opt === currentValue ? 'active' : ''}" data-runtime-type="${type}" data-runtime-value="${opt}">
        ${escapeHtml(labelFn(opt))}
      </button>
    `).join('');
    $runtimeMenu.classList.remove('hidden');
  }

  function setRuntimeOption(type, value) {
    if (type === 'model' && MODEL_OPTION_IDS.includes(value)) {
      codexRuntimeInfo.model = normalizeModelOptionId(value);
      saveCodexRuntimeInfo();
      updateRuntimeHint();
    }
    if (type === 'reasoning' && REASONING_OPTIONS.includes(value)) {
      codexRuntimeInfo.reasoning = normalizeReasoning(value);
      saveCodexRuntimeInfo();
      updateRuntimeHint();
    }
    if (type === 'sandbox' && SANDBOX_OPTIONS.includes(value)) {
      sandboxMode = value;
      localStorage.setItem('codexSandboxMode', sandboxMode);
      updateRuntimeHint();
      showSlashFeedback(`샌드박스 모드: ${SANDBOX_LABELS[value] || value}`, false);
    }
    closeRuntimeMenu();
  }

  function updateRuntimeHint() {
    if ($modelHint) {
      const modelId = normalizeModelOptionId(codexRuntimeInfo.model);
      $modelHint.textContent = `모델: ${modelId}`;
    }
    if ($planModeHint) {
      $planModeHint.textContent = `이성모델: ${formatReasoningLabel(codexRuntimeInfo.reasoning)}`;
    }
    if ($sandboxHint) {
      $sandboxHint.textContent = `샌드박스: ${SANDBOX_LABELS[sandboxMode] || sandboxMode}`;
    }
  }

  function updateCodexRuntimeInfo() {
    updateRuntimeHint();
  }

  function extractCodexSessionId(sections) {
    if (!sections || !sections.session || !sections.session.content) return null;
    const m = sections.session.content.match(/session\s*id\s*:\s*(\S+)/i);
    return m ? m[1] : null;
  }

  function extractCodexSessionIdFromText(text) {
    const source = String(text || '');
    const plain = source.match(/session\s*id\s*:\s*(\S+)/i);
    if (plain) return plain[1];
    const thread = source.match(/"thread_id"\s*:\s*"([0-9a-f-]{16,})"/i);
    if (thread) return thread[1];
    const sessionMeta = source.match(/"type"\s*:\s*"session_meta"[\s\S]{0,400}?"id"\s*:\s*"([0-9a-f-]{16,})"/i);
    if (sessionMeta) return sessionMeta[1];
    return null;
  }

  function createThrottledInvoker(intervalMs, fn) {
    const minInterval = Math.max(16, Number(intervalMs) || 70);
    let timer = null;
    let lastRunAt = 0;
    let pending = false;

    const invoke = () => {
      timer = null;
      if (!pending) return;
      pending = false;
      lastRunAt = Date.now();
      try {
        fn();
      } catch (err) {
        console.error('[throttle-invoke]', err);
      }
    };

    const schedule = () => {
      pending = true;
      if (timer) return;
      const elapsed = Date.now() - lastRunAt;
      if (elapsed >= minInterval) {
        invoke();
        return;
      }
      timer = setTimeout(invoke, minInterval - elapsed);
    };

    schedule.flush = () => {
      if (!pending) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      invoke();
    };

    schedule.cancel = () => {
      pending = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    return schedule;
  }

  function buildCodexArgs(sessionId) {
    const args = ['exec'];
    if (sessionId) {
      args.push('resume', sessionId);
    }
    args.push('--skip-git-repo-check');
    // sandbox 모드에 따라 실행 방식 결정
    if (sandboxMode === 'danger-full-access') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (sandboxMode === 'read-only') {
      args.push('--full-auto', '--sandbox', 'read-only');
    } else {
      args.push('--full-auto');
    }
    args.push('--json');
    args.push('--model', getCodexCliModel(codexRuntimeInfo.model));
    const effort = normalizeReasoning(codexRuntimeInfo.reasoning);
    if (effort === 'extra high') {
      args.push('-c', 'model_reasoning_effort=xhigh');
    } else if (effort === 'low' || effort === 'medium' || effort === 'high') {
      args.push('-c', `model_reasoning_effort=${effort}`);
    } else {
      args.push('-c', 'model_reasoning_effort=xhigh');
    }
    return args;
  }

  function buildCodexPrompt(promptText) {
    const userPrompt = String(promptText || '').trim();
    const diffPolicy = [
      '',
      '[응답 형식 규칙]',
      '파일을 수정/추가/삭제했다면, 최종 답변 끝에 반드시 "변경 Diff" 섹션을 추가하세요.',
      '해당 섹션에는 unified diff 형식 코드블록만 포함하세요.',
      '예시 형식:',
      '```diff',
      'diff --git a/path/to/file b/path/to/file',
      '--- a/path/to/file',
      '+++ b/path/to/file',
      '@@ -old,+new @@',
      '-old line',
      '+new line',
      '```',
      '파일 변경이 없으면 "변경 Diff" 섹션을 추가하지 마세요.',
    ].join('\n');
    return `${userPrompt}\n${diffPolicy}`.trim();
  }

  function stripWrappingQuotes(text) {
    if (!text) return '';
    const value = String(text).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      return value.slice(1, -1);
    }
    return value;
  }

  function inferCodeFenceLanguage(filePath) {
    const ext = (String(filePath || '').split('.').pop() || '').toLowerCase();
    const map = {
      js: 'javascript',
      jsx: 'jsx',
      ts: 'typescript',
      tsx: 'tsx',
      json: 'json',
      md: 'markdown',
      css: 'css',
      html: 'html',
      htm: 'html',
      py: 'python',
      cs: 'csharp',
      cpp: 'cpp',
      c: 'c',
      java: 'java',
      go: 'go',
      rs: 'rust',
      sh: 'bash',
      ps1: 'powershell',
      xml: 'xml',
      yml: 'yaml',
      yaml: 'yaml',
      sql: 'sql',
      txt: 'text',
    };
    return map[ext] || ext || 'text';
  }

  function buildImportedFilePrompt(fileData) {
    const language = inferCodeFenceLanguage(fileData.path);
    const truncatedNote = fileData.truncated ? '\n주의: 파일이 커서 앞부분만 불러왔습니다.\n' : '\n';
    return `[불러온 파일]\n경로: ${fileData.path}${truncatedNote}\`\`\`${language}\n${fileData.content}\n\`\`\``;
  }

  function isSlashMenuOpen() {
    return !!$slashMenu && !$slashMenu.classList.contains('hidden');
  }

  function hideSlashMenu() {
    if (!$slashMenu) return;
    $slashMenu.classList.add('hidden');
    $slashMenu.innerHTML = '';
    slashMenuItems = [];
    slashSelectedIndex = 0;
  }

  // === 세션 피커 ===
  let sessionPickerSelectedIndex = 0;
  let sessionPickerItems = [];
  let sessionPickerRestoreMode = 'default'; // default | raw
  let sessionPickerLastCodexListError = '';

  function parseSessionTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string' || !value) return 0;
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }

  function normalizeSessionCwd(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw
      .replace(/\//g, '\\')
      .replace(/[\\]+$/, '')
      .toLowerCase();
  }

  function normalizeSessionDescription(text, maxLen = 140) {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    return compact.length > maxLen ? `${compact.slice(0, maxLen - 3)}...` : compact;
  }

  function isIgnorableSessionPrompt(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return true;
    if (/^#\s*AGENTS\.md instructions\b/i.test(trimmed)) return true;
    if (/^<environment_context>/i.test(trimmed)) return true;
    if (/^<collaboration_mode>/i.test(trimmed)) return true;
    if (/^<permissions instructions>/i.test(trimmed)) return true;
    return false;
  }

  function getConversationDescription(conv) {
    if (!conv || !Array.isArray(conv.messages)) return '';
    for (const msg of conv.messages) {
      if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') continue;
      if (isIgnorableSessionPrompt(msg.content)) continue;
      const normalized = normalizeSessionDescription(msg.content, 140);
      if (normalized) return normalized;
    }
    return '';
  }

  function buildImportedMessage(role, content, timestamp, idx) {
    const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
    const normalizedRole = role === 'user' || role === 'error' ? role : 'ai';
    return {
      id: `msg_${ts}_${idx}_${Math.random().toString(16).slice(2, 6)}`,
      role: normalizedRole,
      content: typeof content === 'string' ? content : '',
      profileId: 'codex',
      timestamp: ts,
    };
  }

  async function restoreCodexSession(sessionId, options = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) return { success: false, error: 'invalid session id' };
    if (!window.electronAPI?.codex?.loadSession) return { success: false, error: 'session loader unavailable' };
    const restoreMode = options.mode === 'raw' ? 'raw' : 'default';

    const loadResult = await window.electronAPI.codex.loadSession({
      sessionId: sid,
      filePath: typeof options.filePath === 'string' ? options.filePath : '',
      mode: restoreMode,
    });
    if (!loadResult?.success || !loadResult?.data) {
      return { success: false, error: loadResult?.error || '세션 파일을 읽을 수 없습니다.' };
    }

    let conv = getActiveConversation();
    const shouldCreateNew = !conv || conv.messages.length > 0 || (!!conv.codexSessionId && conv.codexSessionId !== sid);
    if (shouldCreateNew) {
      newConversation();
      conv = getActiveConversation();
    }
    if (!conv) return { success: false, error: '대화를 생성할 수 없습니다.' };

    const data = loadResult.data;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    conv.messages = messages
      .filter(msg => msg && typeof msg === 'object' && typeof msg.content === 'string' && msg.content.trim())
      .map((msg, idx) => buildImportedMessage(msg.role, msg.content, msg.timestamp, idx));

    const resolvedSessionId = typeof data.id === 'string' && data.id ? data.id : sid;
    conv.codexSessionId = resolvedSessionId;
    const loadedTitle = typeof data.title === 'string' ? data.title.trim() : '';
    const fallbackTitle = options.title || `세션 ${resolvedSessionId.slice(0, 8)}`;
    conv.title = loadedTitle || fallbackTitle;

    const resolvedCwd = typeof data.cwd === 'string' && data.cwd
      ? data.cwd
      : (typeof options.cwd === 'string' ? options.cwd : '');
    if (resolvedCwd) {
      const setResult = await window.electronAPI.cwd.set(resolvedCwd);
      if (setResult?.success) {
        conv.cwd = resolvedCwd;
        currentCwd = resolvedCwd;
        updateCwdDisplay();
      }
    }

    saveConversations();
    renderMessages();
    renderHistory();
    syncStreamingUI();
    return {
      success: true,
      sessionId: resolvedSessionId,
      messageCount: conv.messages.length,
      description: typeof data.description === 'string' ? data.description : '',
      mode: restoreMode,
    };
  }

  function getSavedSessionItems() {
    return conversations
      .filter(c => c && c.codexSessionId)
      .map((c) => {
        const lastTs = c.messages.length > 0 ? Number(c.messages[c.messages.length - 1].timestamp) : 0;
        const sid = c.codexSessionId;
        return {
          sessionId: sid,
          convId: c.id,
          title: c.title || `세션 ${sid.slice(0, 8)}`,
          description: getConversationDescription(c),
          cwd: c.cwd || '',
          timestamp: Number.isFinite(lastTs) ? lastTs : 0,
          source: 'saved',
          filePath: '',
          hasSaved: true,
          hasCodex: false,
          savedCount: 1,
        };
      });
  }

  async function getCodexSessionItems(limit = 80, options = {}) {
    try {
      if (!window.electronAPI?.codex?.listSessions) return [];
      const request = {
        limit,
        cwd: typeof options.cwd === 'string' ? options.cwd : '',
        includeAll: options.includeAll === true,
      };
      const result = await window.electronAPI.codex.listSessions(request);
      if (!result?.success) {
        sessionPickerLastCodexListError = String(result?.error || 'unknown');
        console.error('[session-picker] codex:listSessions failed:', sessionPickerLastCodexListError);
        return [];
      }
      sessionPickerLastCodexListError = '';
      if (!Array.isArray(result.data)) return [];
      return result.data
        .map((item) => {
          const sid = typeof item?.id === 'string' ? item.id : '';
          if (!sid) return null;
          const startedAtMs = parseSessionTime(item?.startedAt);
          const updatedAtMs = Number.isFinite(Number(item?.updatedAt)) ? Number(item.updatedAt) : 0;
          const description = normalizeSessionDescription(item?.description || '', 140);
          return {
            sessionId: sid,
            convId: null,
            title: typeof item?.title === 'string' && item.title ? item.title : `세션 ${sid.slice(0, 8)}`,
            description,
            cwd: typeof item?.cwd === 'string' ? item.cwd : '',
            timestamp: startedAtMs || updatedAtMs,
            source: 'codex',
            filePath: typeof item?.filePath === 'string' ? item.filePath : '',
            hasSaved: false,
            hasCodex: true,
            savedCount: 0,
          };
        })
        .filter(Boolean);
    } catch (err) {
      sessionPickerLastCodexListError = String(err?.message || err || 'unknown');
      console.error('[session-picker] codex:listSessions exception:', err);
      return [];
    }
  }

  async function buildSessionPickerItems() {
    const merged = new Map();
    const currentCwdKey = normalizeSessionCwd(currentCwd);
    const codexItems = await getCodexSessionItems(1000, {
      cwd: currentCwd,
      includeAll: false,
    });
    for (const item of codexItems) {
      if (currentCwdKey) {
        const itemCwdKey = normalizeSessionCwd(item.cwd);
        if (!itemCwdKey || itemCwdKey !== currentCwdKey) continue;
      }
      merged.set(item.sessionId, item);
    }

    const savedItems = getSavedSessionItems().filter((item) => {
      if (!currentCwdKey) return true;
      const itemCwdKey = normalizeSessionCwd(item.cwd);
      if (!itemCwdKey) return false;
      return itemCwdKey === currentCwdKey;
    });
    for (const item of savedItems) {
      const existing = merged.get(item.sessionId);
      if (!existing) {
        merged.set(item.sessionId, item);
        continue;
      }
      merged.set(item.sessionId, {
        ...existing,
        convId: item.convId || existing.convId,
        title: item.title || existing.title,
        description: item.description || existing.description,
        cwd: item.cwd || existing.cwd,
        timestamp: Math.max(existing.timestamp || 0, item.timestamp || 0),
        source: (item.hasSaved || existing.hasSaved) ? 'saved' : 'codex',
        filePath: existing.filePath || '',
        hasSaved: !!item.hasSaved || !!existing.hasSaved,
        hasCodex: !!item.hasCodex || !!existing.hasCodex,
        savedCount: (Number(existing.savedCount) || 0) + (Number(item.savedCount) || 0),
      });
    }

    return Array.from(merged.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  function getSessionItemSourceLabel(item) {
    const labels = [];
    if (item?.hasSaved) {
      const savedCount = Math.max(1, Number(item?.savedCount) || 0);
      labels.push(`앱 저장 ${savedCount}개`);
    }
    if (item?.hasCodex) labels.push('Codex 기록');
    return labels.length > 0 ? labels.join(' + ') : '알 수 없음';
  }

  function renderSessionPickerEmpty(detail = '') {
    if (!$sessionPicker) return;
    const detailHtml = detail
      ? `<div class="session-picker-error">${escapeHtml(detail)}</div>`
      : '';
    $sessionPicker.innerHTML = `
      <div class="session-picker-header">
        <span>세션 목록 ${sessionPickerRestoreMode === 'raw' ? '(원본 로그)' : '(일반)'}</span>
        <button class="session-picker-close" type="button">&times;</button>
      </div>
      <div class="session-picker-empty">저장된/Codex 세션이 없습니다.</div>
      ${detailHtml}`;
    $sessionPicker.classList.remove('hidden');
    $sessionPicker.querySelector('.session-picker-close').addEventListener('click', hideSessionPicker);
  }

  function removeSavedSessionConversationsBySessionId(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return 0;

    const remain = [];
    let removed = 0;
    let removedActive = false;
    for (const conv of conversations) {
      if (conv && conv.codexSessionId === sid) {
        removed += 1;
        if (conv.id === activeConvId) removedActive = true;
        if (historyEditingId === conv.id) historyEditingId = null;
        continue;
      }
      remain.push(conv);
    }
    if (removed <= 0) return 0;

    conversations = remain;
    if (removedActive) {
      activeConvId = conversations.length > 0 ? conversations[0].id : null;
    }

    saveConversations();
    renderMessages();
    renderHistory();
    return removed;
  }

  async function reloadSessionPickerItems() {
    sessionPickerItems = await buildSessionPickerItems();
    if (sessionPickerItems.length === 0) {
      sessionPickerSelectedIndex = 0;
      renderSessionPickerEmpty();
      return;
    }
    if (sessionPickerSelectedIndex >= sessionPickerItems.length) {
      sessionPickerSelectedIndex = sessionPickerItems.length - 1;
    }
    if (sessionPickerSelectedIndex < 0) sessionPickerSelectedIndex = 0;
    renderSessionPickerItems();
  }

  async function deleteSessionPickerItem(item, target) {
    if (!item || !item.sessionId) return;
    const sid = item.sessionId;

    if (target === 'saved') {
      if (!item.hasSaved) {
        showSlashFeedback(`앱 저장 데이터가 없습니다: ${sid}`, true);
        return;
      }
      const savedCount = Math.max(1, Number(item.savedCount) || 0);
      const confirmed = window.confirm(`앱 저장 대화 ${savedCount}개를 삭제할까요?\nsession-id: ${sid}\n이 작업은 되돌릴 수 없습니다.`);
      if (!confirmed) return;

      const removedCount = removeSavedSessionConversationsBySessionId(sid);
      if (removedCount <= 0) {
        showSlashFeedback(`삭제할 앱 저장 대화가 없습니다: ${sid}`, true);
        return;
      }
      showSlashFeedback(`앱 저장 대화 ${removedCount}개를 삭제했습니다: ${sid}`, false);
      await reloadSessionPickerItems();
      return;
    }

    if (target === 'codex') {
      if (!item.hasCodex) {
        showSlashFeedback(`Codex 기록이 없습니다: ${sid}`, true);
        return;
      }
      if (!window.electronAPI?.codex?.deleteSession) {
        showSlashFeedback('Codex 세션 삭제 기능을 사용할 수 없습니다.', true);
        return;
      }
      const confirmed = window.confirm(`Codex 원본 세션 로그를 삭제할까요?\nsession-id: ${sid}\n이 작업은 되돌릴 수 없습니다.`);
      if (!confirmed) return;

      const result = await window.electronAPI.codex.deleteSession({
        sessionId: sid,
        filePath: item.filePath || '',
      });
      if (!result?.success) {
        showSlashFeedback(`Codex 세션 삭제 실패: ${result?.error || '알 수 없는 오류'}`, true);
        return;
      }

      showSlashFeedback(`Codex 세션 로그를 삭제했습니다: ${sid}`, false);
      await reloadSessionPickerItems();
    }
  }

  async function applySessionPickerItem(item, restoreMode = sessionPickerRestoreMode) {
    if (!item || !item.sessionId) return;

    if (item.convId) {
      await loadConversation(item.convId);
      showSlashFeedback(`세션을 이어서 진행합니다. session-id: ${item.sessionId}`, false);
      return;
    }

    const restored = await restoreCodexSession(item.sessionId, {
      filePath: item.filePath,
      title: item.title,
      cwd: item.cwd,
      mode: restoreMode,
    });
    if (restored.success) {
      const desc = normalizeSessionDescription(restored.description || item.description || '', 70);
      const suffix = desc ? ` · ${desc}` : '';
      const modeLabel = restoreMode === 'raw' ? '원본 로그' : '일반';
      showSlashFeedback(`세션을 불러왔습니다 [${modeLabel}] (${restored.messageCount}개): ${restored.sessionId}${suffix}`, false);
      return;
    }

    // 복원에 실패하면 기존 동작처럼 세션 ID만 설정
    let conv = getActiveConversation();
    if (!conv || conv.messages.length > 0 || !!conv.codexSessionId) {
      newConversation();
      conv = getActiveConversation();
    }
    if (conv) {
      conv.codexSessionId = item.sessionId;
      if (!conv.title) conv.title = `세션 ${item.sessionId.slice(0, 8)}`;
      saveConversations();
      renderMessages();
      renderHistory();
    }
    const modeLabel = restoreMode === 'raw' ? '원본 로그' : '일반';
    showSlashFeedback(`세션 복원 실패[${modeLabel}], ID만 설정했습니다: ${item.sessionId}`, true);
  }

  function isSessionPickerOpen() {
    return !!$sessionPicker && !$sessionPicker.classList.contains('hidden');
  }

  function hideSessionPicker() {
    if (!$sessionPicker) return;
    $sessionPicker.classList.add('hidden');
    $sessionPicker.innerHTML = '';
    sessionPickerItems = [];
    sessionPickerSelectedIndex = 0;
  }

  async function showSessionPicker(restoreMode = 'default') {
    if (!$sessionPicker) return;
    hideSlashMenu();
    sessionPickerRestoreMode = restoreMode === 'raw' ? 'raw' : 'default';

    sessionPickerItems = await buildSessionPickerItems();
    if (sessionPickerLastCodexListError) {
      showSlashFeedback(`Codex 세션 목록 로딩 실패: ${sessionPickerLastCodexListError}`, true);
    }

    if (sessionPickerItems.length === 0) {
      const detail = sessionPickerLastCodexListError
        ? `Codex 세션 목록 로딩 실패: ${sessionPickerLastCodexListError}`
        : '';
      renderSessionPickerEmpty(detail);
      return;
    }

    sessionPickerSelectedIndex = 0;
    renderSessionPickerItems();
    $sessionPicker.classList.remove('hidden');
  }

  function renderSessionPickerItems() {
    if (!$sessionPicker || sessionPickerItems.length === 0) return;
    const html = sessionPickerItems.map((item, idx) => {
      const date = item.timestamp ? new Date(item.timestamp).toLocaleString() : '';
      const title = item.title || '(제목 없음)';
      const description = item.description || '';
      const sid = item.sessionId || '';
      const sourceLabel = getSessionItemSourceLabel(item);
      const deleteButtons = [
        item.hasSaved
          ? `<button type="button" class="session-picker-delete-btn" data-index="${idx}" data-delete-target="saved" title="앱 저장 대화 삭제">앱</button>`
          : '',
        item.hasCodex
          ? `<button type="button" class="session-picker-delete-btn" data-index="${idx}" data-delete-target="codex" title="Codex 원본 로그 삭제">Codex</button>`
          : '',
      ].filter(Boolean).join('');

      return `<div class="session-picker-row ${idx === sessionPickerSelectedIndex ? 'active' : ''}" data-index="${idx}">
        <button type="button" class="session-picker-item ${idx === sessionPickerSelectedIndex ? 'active' : ''}" data-index="${idx}" data-session-id="${sid}">
          <span class="session-picker-title">${escapeHtml(title)}</span>
          ${description ? `<span class="session-picker-desc">${escapeHtml(description)}</span>` : ''}
          <span class="session-picker-meta">
            <span class="session-picker-id">${escapeHtml(sid)}</span>
            <span class="session-picker-submeta"><span>${escapeHtml(sourceLabel)}</span><span>${escapeHtml(date)}</span></span>
          </span>
        </button>
        ${deleteButtons ? `<div class="session-picker-actions">${deleteButtons}</div>` : ''}
      </div>`;
    }).join('');

    $sessionPicker.innerHTML = `
      <div class="session-picker-header">
        <span>세션 선택 (${sessionPickerItems.length}개) ${sessionPickerRestoreMode === 'raw' ? '· 원본 로그' : '· 일반'}</span>
        <button class="session-picker-close" type="button">&times;</button>
      </div>
      ${html}`;

    $sessionPicker.querySelector('.session-picker-close').addEventListener('click', hideSessionPicker);

    // 클릭 이벤트
    $sessionPicker.querySelectorAll('.session-picker-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = Number(el.dataset.index);
        const selected = Number.isFinite(idx) ? sessionPickerItems[idx] : null;
        hideSessionPicker();
        if (selected) void applySessionPickerItem(selected, sessionPickerRestoreMode);
      });
    });

    $sessionPicker.querySelectorAll('.session-picker-delete-btn').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(el.dataset.index);
        const selected = Number.isFinite(idx) ? sessionPickerItems[idx] : null;
        const target = String(el.dataset.deleteTarget || '');
        if (selected && (target === 'saved' || target === 'codex')) {
          void deleteSessionPickerItem(selected, target);
        }
      });
    });
  }

  function moveSessionPickerSelection(delta) {
    if (!isSessionPickerOpen() || sessionPickerItems.length === 0) return false;
    sessionPickerSelectedIndex = (sessionPickerSelectedIndex + delta + sessionPickerItems.length) % sessionPickerItems.length;
    renderSessionPickerItems();
    const activeEl = $sessionPicker.querySelector('.session-picker-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
    return true;
  }

  function applySessionPickerSelection() {
    if (!isSessionPickerOpen() || sessionPickerItems.length === 0) return false;
    const selected = sessionPickerItems[sessionPickerSelectedIndex];
    if (!selected) return false;
    hideSessionPicker();
    void applySessionPickerItem(selected, sessionPickerRestoreMode);
    return true;
  }

  function filterSlashCommands(token) {
    const normalized = String(token || '').toLowerCase();
    if (!normalized || normalized === '/') return SLASH_COMMANDS.slice();
    return SLASH_COMMANDS.filter(cmd => cmd.command.startsWith(normalized));
  }

  function renderSlashMenu(items) {
    if (!$slashMenu) return;
    slashMenuItems = items.slice();
    if (slashMenuItems.length === 0) {
      $slashMenu.innerHTML = '<div class="slash-command-empty">일치하는 명령어가 없습니다.</div>';
      $slashMenu.classList.remove('hidden');
      return;
    }

    if (slashSelectedIndex >= slashMenuItems.length) slashSelectedIndex = 0;

    $slashMenu.innerHTML = slashMenuItems.map((item, idx) => `
      <button type="button" class="slash-command-item ${idx === slashSelectedIndex ? 'active' : ''}" data-command="${item.command}">
        <span class="slash-command-name">${escapeHtml(item.command)}</span>
        <span class="slash-command-desc">${escapeHtml(item.description)}</span>
        <span class="slash-command-usage">${escapeHtml(item.usage)}</span>
      </button>
    `).join('');

    $slashMenu.classList.remove('hidden');
  }

  function updateSlashCommandMenu() {
    if (isStreaming && currentStreamId) {
      hideSlashMenu();
      return;
    }
    const raw = String($input.value || '');
    const trimmedStart = raw.trimStart();
    if (!trimmedStart.startsWith('/')) {
      hideSlashMenu();
      return;
    }
    const token = (trimmedStart.split(/\s+/)[0] || '/').toLowerCase();
    renderSlashMenu(filterSlashCommands(token));
  }

  function moveSlashSelection(delta) {
    if (!isSlashMenuOpen() || slashMenuItems.length === 0) return false;
    slashSelectedIndex = (slashSelectedIndex + delta + slashMenuItems.length) % slashMenuItems.length;
    renderSlashMenu(slashMenuItems);
    const activeEl = $slashMenu.querySelector('.slash-command-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
    return true;
  }

  function applySlashSelection() {
    if (!isSlashMenuOpen() || slashMenuItems.length === 0) return false;
    const selected = slashMenuItems[slashSelectedIndex];
    if (!selected) return false;
    $input.value = selected.command === '/file' ? '/file ' : selected.command;
    autoResizeInput();
    updateSlashCommandMenu();
    $input.focus();
    return true;
  }

  function showSlashFeedback(message, isError) {
    if (!$slashFeedback) return;
    clearTimeout(slashFeedbackTimer);
    $slashFeedback.textContent = message;
    $slashFeedback.classList.toggle('error', !!isError);
    $slashFeedback.classList.remove('hidden');
    slashFeedbackTimer = setTimeout(() => {
      $slashFeedback.classList.add('hidden');
    }, 2600);
  }

  async function runFileSlashCommand(argText) {
    const pathArg = stripWrappingQuotes(argText);
    const result = pathArg
      ? await window.electronAPI.file.read(pathArg)
      : await window.electronAPI.file.pickAndRead();

    if (!result || !result.success) {
      if (!result?.canceled) {
        showSlashFeedback(result?.error || '파일을 불러오지 못했습니다.', true);
      }
      return;
    }

    $input.value = buildImportedFilePrompt(result);
    autoResizeInput();
    hideSlashMenu();
    $input.focus();
    const suffix = result.truncated ? ' (크기 제한으로 일부만 로드)' : '';
    showSlashFeedback(`파일을 불러왔습니다: ${result.path}${suffix}`, false);
  }

  async function handleAtFileCommand(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('@')) return false;

    const argText = stripWrappingQuotes(trimmed.slice(1).trim());
    await runFileSlashCommand(argText);
    return true;
  }

  async function handleSlashCommand(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('/')) return false;

    const commandMatch = trimmed.match(/^(\S+)(?:\s+(.+))?$/);
    const command = (commandMatch?.[1] || '').toLowerCase();
    const argText = (commandMatch?.[2] || '').trim();

    if (command === '/status') {
      showSlashFeedback('Codex 사용량 상태를 갱신 중입니다...', false);
      await refreshCodexRateLimits('slash');
      showSlashFeedback('5h/weekly limit 상태를 갱신했습니다.', false);
      return true;
    }

    if (command === '/help') {
      $input.value = '/';
      autoResizeInput();
      slashSelectedIndex = 0;
      renderSlashMenu(SLASH_COMMANDS);
      $input.focus();
      return true;
    }

    if (command === '/file') {
      await runFileSlashCommand(argText);
      return true;
    }

    if (command === '/model') {
      if (argText) {
        const match = MODEL_OPTION_IDS.find(id => id.toLowerCase() === argText.toLowerCase());
        if (match) {
          setRuntimeOption('model', match);
          showSlashFeedback(`모델을 ${match}(으)로 변경했습니다.`, false);
        } else {
          showSlashFeedback(`알 수 없는 모델: ${argText}. 사용 가능: ${MODEL_OPTION_IDS.join(', ')}`, true);
        }
      } else {
        renderRuntimeMenu('model');
      }
      return true;
    }

    if (command === '/reasoning') {
      if (argText) {
        const normalized = normalizeReasoning(argText);
        if (REASONING_OPTIONS.includes(normalized)) {
          setRuntimeOption('reasoning', normalized);
          showSlashFeedback(`Reasoning effort를 ${formatReasoningLabel(normalized)}(으)로 변경했습니다.`, false);
        } else {
          showSlashFeedback(`알 수 없는 값: ${argText}. 사용 가능: ${REASONING_OPTIONS.join(', ')}`, true);
        }
      } else {
        renderRuntimeMenu('reasoning');
      }
      return true;
    }

    if (command === '/review') {
      const reviewPrompt = argText || '';
      showSlashFeedback('코드 리뷰를 시작합니다...', false);
      await runCodexSubcommand('review', ['--uncommitted'], reviewPrompt);
      return true;
    }

    if (command === '/search') {
      if (!argText) {
        showSlashFeedback('/search 뒤에 질문을 입력하세요.', true);
        return true;
      }
      await runCodexWithExtraArgs(['--search'], argText);
      return true;
    }

    if (command === '/cwd') {
      if (argText) {
        const result = await window.electronAPI.cwd.set(argText);
        if (result.success) {
          currentCwd = result.cwd;
          localStorage.setItem('lastCwd', currentCwd);
          const conv = getActiveConversation();
          if (conv) { conv.cwd = currentCwd; saveConversations(); }
          updateCwdDisplay();
          showSlashFeedback(`작업 폴더: ${currentCwd}`, false);
        } else {
          showSlashFeedback(`폴더를 찾을 수 없습니다: ${argText}`, true);
        }
      } else {
        await selectCwd();
      }
      return true;
    }

    if (command === '/clear') {
      const conv = getActiveConversation();
      if (conv) {
        conv.messages = [];
        saveConversations();
        renderMessages();
        showSlashFeedback('대화를 초기화했습니다.', false);
      }
      return true;
    }

    if (command === '/version') {
      await runCodexSubcommand('--version', [], '');
      return true;
    }

    if (command === '/review-base') {
      const parts = argText.split(/\s+/);
      const branch = parts[0] || 'main';
      const prompt = parts.slice(1).join(' ');
      showSlashFeedback(`${branch} 기준 코드 리뷰를 시작합니다...`, false);
      await runCodexSubcommand('review', ['--base', branch], prompt);
      return true;
    }

    if (command === '/review-commit') {
      if (!argText) {
        showSlashFeedback('/review-commit 뒤에 커밋 SHA를 입력하세요.', true);
        return true;
      }
      showSlashFeedback(`커밋 ${argText} 리뷰를 시작합니다...`, false);
      await runCodexSubcommand('review', ['--commit', argText], '');
      return true;
    }

    if (command === '/apply') {
      if (!argText) {
        showSlashFeedback('/apply 뒤에 task-id를 입력하세요.', true);
        return true;
      }
      showSlashFeedback(`diff를 적용합니다: ${argText}`, false);
      await runCodexSubcommand('apply', [argText], '');
      return true;
    }

    if (command === '/resume' || command === '/resume-raw') {
      const restoreMode = command === '/resume-raw' ? 'raw' : 'default';
      const sessionArg = (argText || '').trim();
      if (!sessionArg) {
        // 인자 없으면 세션 피커 표시
        await showSessionPicker(restoreMode);
        return true;
      }
      // 인자 있으면 세션 대화 복원 시도
      const restored = await restoreCodexSession(sessionArg, {
        title: `세션 ${sessionArg.slice(0, 8)}`,
        mode: restoreMode,
      });
      if (restored.success) {
        const desc = normalizeSessionDescription(restored.description || '', 70);
        const suffix = desc ? ` · ${desc}` : '';
        const modeLabel = restoreMode === 'raw' ? '원본 로그' : '일반';
        showSlashFeedback(`세션을 불러왔습니다 [${modeLabel}] (${restored.messageCount}개): ${restored.sessionId}${suffix}`, false);
        return true;
      }

      // 복원 실패 시 기존 동작 유지
      if (!activeConvId || !getActiveConversation()) {
        newConversation();
      }
      const conv = getActiveConversation();
      conv.codexSessionId = sessionArg;
      saveConversations();
      const modeLabel = restoreMode === 'raw' ? '원본 로그' : '일반';
      showSlashFeedback(`세션 복원 실패[${modeLabel}], ID만 설정했습니다: ${sessionArg}`, true);
      return true;
    }

    if (command === '/mcp-list') {
      await runCodexSubcommand('mcp', ['list'], '');
      return true;
    }

    if (command === '/features') {
      await runCodexSubcommand('features', ['list'], '');
      return true;
    }

    if (command === '/sandbox') {
      if (argText && SANDBOX_OPTIONS.includes(argText.toLowerCase())) {
        setRuntimeOption('sandbox', argText.toLowerCase());
      } else if (argText) {
        showSlashFeedback(`알 수 없는 모드: ${argText}. 사용 가능: ${SANDBOX_OPTIONS.join(', ')}`, true);
      } else {
        renderRuntimeMenu('sandbox');
      }
      return true;
    }

    if (command === '/fork') {
      const sessionArg = argText || '';
      showSlashFeedback('세션을 복제하여 실행합니다...', false);
      const forkArgs = sessionArg ? [sessionArg] : ['--last'];
      await runCodexSubcommand('fork', forkArgs, '');
      return true;
    }

    if (command === '/mcp-add') {
      if (!argText) {
        showSlashFeedback('/mcp-add [이름] [--url URL | -- 명령어]', true);
        return true;
      }
      showSlashFeedback('MCP 서버를 추가합니다...', false);
      const mcpAddParts = argText.split(/\s+/);
      await runCodexSubcommand('mcp', ['add', ...mcpAddParts], '');
      return true;
    }

    if (command === '/mcp-remove') {
      if (!argText) {
        showSlashFeedback('/mcp-remove [이름]을 입력하세요.', true);
        return true;
      }
      showSlashFeedback(`MCP 서버 제거: ${argText}`, false);
      await runCodexSubcommand('mcp', ['remove', argText], '');
      return true;
    }

    if (command === '/cloud-exec') {
      if (!argText) {
        showSlashFeedback('/cloud-exec --env [ENV] [질문]을 입력하세요.', true);
        return true;
      }
      showSlashFeedback('Cloud 태스크를 생성합니다...', false);
      const cloudExecParts = argText.split(/\s+/);
      await runCodexSubcommand('cloud', ['exec', ...cloudExecParts], '');
      return true;
    }

    if (command === '/cloud-list') {
      const cloudListArgs = argText ? argText.split(/\s+/) : [];
      await runCodexSubcommand('cloud', ['list', ...cloudListArgs], '');
      return true;
    }

    if (command === '/cloud-status') {
      if (!argText) {
        showSlashFeedback('/cloud-status [task-id]를 입력하세요.', true);
        return true;
      }
      await runCodexSubcommand('cloud', ['status', argText], '');
      return true;
    }

    if (command === '/cloud-diff') {
      if (!argText) {
        showSlashFeedback('/cloud-diff [task-id]를 입력하세요.', true);
        return true;
      }
      await runCodexSubcommand('cloud', ['diff', argText], '');
      return true;
    }

    if (command === '/cloud-apply') {
      if (!argText) {
        showSlashFeedback('/cloud-apply [task-id]를 입력하세요.', true);
        return true;
      }
      showSlashFeedback(`Cloud diff를 적용합니다: ${argText}`, false);
      await runCodexSubcommand('cloud', ['apply', argText], '');
      return true;
    }

    if (command === '/login') {
      await runCodexSubcommand('login', [], '');
      return true;
    }

    if (command === '/logout') {
      await runCodexSubcommand('logout', [], '');
      return true;
    }

    // 로컬 명령이 아닌 슬래시 커맨드는 Codex/CLI로 그대로 전달
    return false;
  }

  function clampSidebarWidth(px) {
    if (px === null || px === undefined || px === '') return null;
    const raw = Number(px);
    if (!Number.isFinite(raw)) return null;
    const viewportMax = Math.max(SIDEBAR_MIN_WIDTH, Math.floor(window.innerWidth * 0.6));
    const maxWidth = Math.min(SIDEBAR_MAX_WIDTH, viewportMax);
    return Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxWidth, Math.round(raw)));
  }

  function updateSidebarToggleUI() {
    if (!$btnSidebarToggle) return;
    const expanded = !sidebarCollapsed;
    $btnSidebarToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    $btnSidebarToggle.title = expanded ? '사이드바 접기' : '사이드바 펼치기';
  }

  function applySidebarWidth() {
    if (Number.isFinite(sidebarWidthPx) && sidebarWidthPx > 0) {
      document.documentElement.style.setProperty('--sidebar-w', `${sidebarWidthPx}px`);
      return;
    }
    document.documentElement.style.removeProperty('--sidebar-w');
  }

  function saveSidebarPrefs() {
    if (Number.isFinite(sidebarWidthPx) && sidebarWidthPx > 0) {
      localStorage.setItem(SIDEBAR_PREF_WIDTH_KEY, String(sidebarWidthPx));
    } else {
      localStorage.removeItem(SIDEBAR_PREF_WIDTH_KEY);
    }
    localStorage.setItem(SIDEBAR_PREF_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }

  function applySidebarState() {
    document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
    applySidebarWidth();
    updateSidebarToggleUI();
  }

  function setSidebarCollapsed(nextCollapsed) {
    const next = Boolean(nextCollapsed);
    if (sidebarCollapsed === next) return;
    sidebarCollapsed = next;
    saveSidebarPrefs();
    applySidebarState();
  }

  function setSidebarWidth(nextWidth, options = {}) {
    const clamped = clampSidebarWidth(nextWidth);
    if (!Number.isFinite(clamped) || clamped <= 0) return;
    if (sidebarWidthPx === clamped) return;
    sidebarWidthPx = clamped;
    applySidebarWidth();
    if (options.save !== false) saveSidebarPrefs();
  }

  function loadSidebarPrefs() {
    const rawWidth = localStorage.getItem(SIDEBAR_PREF_WIDTH_KEY);
    const savedWidth = rawWidth == null ? null : clampSidebarWidth(rawWidth);
    sidebarWidthPx = Number.isFinite(savedWidth) ? savedWidth : null;
    sidebarCollapsed = localStorage.getItem(SIDEBAR_PREF_COLLAPSED_KEY) === '1';
  }

  function beginSidebarResize(e) {
    if (sidebarCollapsed || !$sidebar) return;
    if (e.button !== 0) return;
    e.preventDefault();
    sidebarResizeSession = {
      startX: e.clientX,
      startWidth: $sidebar.getBoundingClientRect().width,
    };
    document.body.classList.add('sidebar-resizing');
    document.addEventListener('mousemove', onSidebarResizeMove);
    document.addEventListener('mouseup', endSidebarResize);
  }

  function onSidebarResizeMove(e) {
    if (!sidebarResizeSession) return;
    const delta = e.clientX - sidebarResizeSession.startX;
    setSidebarWidth(sidebarResizeSession.startWidth + delta, { save: false });
  }

  function endSidebarResize() {
    if (!sidebarResizeSession) return;
    sidebarResizeSession = null;
    document.body.classList.remove('sidebar-resizing');
    document.removeEventListener('mousemove', onSidebarResizeMove);
    document.removeEventListener('mouseup', endSidebarResize);
    saveSidebarPrefs();
  }

  function initSidebarLayout() {
    loadSidebarPrefs();
    applySidebarState();
    window.addEventListener('resize', () => {
      if (!Number.isFinite(sidebarWidthPx)) return;
      const clamped = clampSidebarWidth(sidebarWidthPx);
      if (!Number.isFinite(clamped)) return;
      if (clamped !== sidebarWidthPx) {
        sidebarWidthPx = clamped;
        applySidebarWidth();
        saveSidebarPrefs();
      }
    });
  }

  function runInitStep(name, fn) {
    try {
      const out = typeof fn === 'function' ? fn() : null;
      if (out && typeof out.then === 'function') {
        out.catch((err) => {
          try { console.error(`[init:${name}]`, err); } catch { /* ignore */ }
        });
      }
      return out;
    } catch (err) {
      try { console.error(`[init:${name}]`, err); } catch { /* ignore */ }
      return null;
    }
  }

  async function initSidebarMeta() {
    if ($appVersion) {
      $appVersion.textContent = '버전 확인 중...';
    }
    try {
      const info = await window.electronAPI.system.info();
      const appVersion = String(info?.appVersion || '').trim();
      if ($appVersion) {
        $appVersion.textContent = appVersion ? `v${appVersion}` : 'v-';
      }
    } catch {
      if ($appVersion) $appVersion.textContent = 'v-';
    }
  }

  // === 초기화 ===
  runInitStep('sidebar-layout', () => initSidebarLayout());
  runInitStep('sidebar-meta', () => initSidebarMeta());
  runInitStep('cwd', () => initCwd());
  runInitStep('profiles', () => renderProfiles());
  runInitStep('history', () => renderHistory());
  runInitStep('active-profile', () => setActiveProfile(activeProfileId));
  runInitStep('statusbar', () => updateCodexStatusbar());
  runInitStep('rate-limits', () => refreshCodexRateLimits('init'));

  if ($modelHint) {
    $modelHint.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      renderRuntimeMenu('model');
    });
  }

  if ($planModeHint) {
    $planModeHint.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      renderRuntimeMenu('reasoning');
    });
  }

  if ($sandboxHint) {
    $sandboxHint.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      renderRuntimeMenu('sandbox');
    });
  }

  // 새 대화 시작 (또는 마지막 대화 복원)
  if (conversations.length > 0) {
    runInitStep('restore-conversation', () => loadConversation(conversations[0].id));
  }

  // === 작업 폴더 ===
  async function initCwd() {
    // localStorage에 저장된 마지막 작업 폴더 복원
    const savedCwd = localStorage.getItem('lastCwd');
    if (savedCwd) {
      const setResult = await window.electronAPI.cwd.set(savedCwd);
      if (setResult.success) {
        currentCwd = savedCwd;
        updateCwdDisplay();
        return;
      }
    }
    currentCwd = await window.electronAPI.cwd.get();
    updateCwdDisplay();
  }

  function updateCwdDisplay() {
    const short = shortenPath(currentCwd);
    $cwdPath.textContent = short;
    $cwdPath.title = currentCwd;
    $cwdHint.textContent = short;
    $cwdHint.title = currentCwd;
  }

  function shortenPath(p) {
    // C:\Users\Name\... → ~\...
    const home = currentCwd.includes('\\') ? '' : '';
    const parts = p.replace(/\//g, '\\').split('\\');
    if (parts.length > 3) return parts[0] + '\\..\\' + parts.slice(-2).join('\\');
    return p;
  }

  async function selectCwd() {
    const result = await window.electronAPI.cwd.select();
    if (result.success) {
      currentCwd = result.cwd;
      localStorage.setItem('lastCwd', currentCwd);
      // 현재 대화에 폴더 저장
      const conv = getActiveConversation();
      if (conv) {
        conv.cwd = currentCwd;
        saveConversations();
      }
      updateCwdDisplay();
    }
  }

  document.getElementById('btn-cwd').addEventListener('click', selectCwd);
  $cwdHint.addEventListener('click', selectCwd);

  // === 프로필 렌더링 ===
  function renderProfiles() {
    $profileList.innerHTML = PROFILES.map(p => `
      <button class="profile-item ${p.id === activeProfileId ? 'active' : ''}" data-id="${p.id}">
        <span class="profile-dot" style="background:${p.color}"></span>
        <span class="profile-name">${p.name}</span>
        <span class="profile-check">✓</span>
      </button>
    `).join('');

    $profileList.querySelectorAll('.profile-item').forEach(el => {
      el.addEventListener('click', () => setActiveProfile(el.dataset.id));
    });
  }

  function setActiveProfile(id) {
    if (id !== 'codex') return;
    activeProfileId = 'codex';
    localStorage.setItem('activeProfile', 'codex');
    const p = getProfileById(id);
    if (!p) return;
    $profileName.textContent = p.name;
    $profileBadge.style.background = p.color;
    $profileList.querySelectorAll('.profile-item').forEach(el => {
      el.classList.toggle('active', el.dataset.id === id);
    });
    updateRuntimeHint();
    updateCodexStatusbar();
  }

  // === 대화 히스토리 ===
  function renderHistory() {
    $historyList.innerHTML = conversations.map((c) => {
      const isEditing = historyEditingId === c.id;
      if (isEditing) {
        return `
          <div class="history-row history-row-editing">
            <input
              class="history-rename-input"
              data-rename-input-id="${c.id}"
              type="text"
              maxlength="120"
              placeholder="대화 이름"
            />
            <button class="history-rename-save-btn" data-rename-save-id="${c.id}" title="이름 저장">✓</button>
            <button class="history-rename-cancel-btn" data-rename-cancel-id="${c.id}" title="이름 편집 취소">↩</button>
            <button class="history-delete-btn" data-delete-id="${c.id}" title="이 대화 삭제">✕</button>
          </div>
        `;
      }
      return `
        <div class="history-row">
          <button class="history-item ${c.id === activeConvId ? 'active' : ''}" data-id="${c.id}">
            ${escapeHtml(c.title || '새 대화')}
          </button>
          <button class="history-rename-btn" data-rename-id="${c.id}" title="대화 이름 변경">✎</button>
          <button class="history-delete-btn" data-delete-id="${c.id}" title="이 대화 삭제">✕</button>
        </div>
      `;
    }).join('');

    $historyList.querySelectorAll('.history-item').forEach(el => {
      el.addEventListener('click', () => loadConversation(el.dataset.id));
    });

    $historyList.querySelectorAll('.history-rename-input').forEach(el => {
      const conv = conversations.find(c => c.id === el.dataset.renameInputId);
      if (!conv) return;
      el.value = conv.title || '';
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitRenameConversation(conv.id, el.value);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          cancelRenameConversation();
        }
      });
    });

    $historyList.querySelectorAll('.history-rename-btn').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        beginRenameConversation(el.dataset.renameId);
      });
    });

    $historyList.querySelectorAll('.history-rename-save-btn').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = el.dataset.renameSaveId;
        const input = $historyList.querySelector(`.history-rename-input[data-rename-input-id="${id}"]`);
        commitRenameConversation(id, input?.value || '');
      });
    });

    $historyList.querySelectorAll('.history-rename-cancel-btn').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cancelRenameConversation();
      });
    });

    $historyList.querySelectorAll('.history-delete-btn').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        deleteConversation(el.dataset.deleteId);
      });
    });
  }

  let lastAutoSave = 0;
  const AUTO_SAVE_INTERVAL = 5000; // 5초마다 자동 저장

  function saveConversations() {
    lastAutoSave = Date.now();
    window.electronAPI.store.saveConversations(conversations).catch(err => {
      console.error('[save] conversations error:', err);
    });
    renderHistory();
  }

  // 스트리밍 중 주기적 자동 저장 (5초마다)
  function autoSaveIfNeeded() {
    if (convStreams.size > 0 && Date.now() - lastAutoSave >= AUTO_SAVE_INTERVAL) {
      lastAutoSave = Date.now();
      window.electronAPI.store.saveConversations(conversations).catch(() => {});
    }
  }

  // 앱 종료 시 동기 저장 — 스트리밍 중이어도 받은 데이터까지 보존
  window.addEventListener('beforeunload', () => {
    try {
      window.electronAPI.store.saveConversationsSync(conversations);
    } catch { /* ignore */ }
  });

  function deleteConversation(id) {
    const idx = conversations.findIndex(c => c.id === id);
    if (idx < 0) return;

    const removingActive = activeConvId === id;
    conversations.splice(idx, 1);

    if (removingActive) {
      activeConvId = conversations.length > 0 ? conversations[0].id : null;
    }
    if (historyEditingId === id) historyEditingId = null;

    saveConversations();
    renderMessages();
    renderHistory();
  }

  function beginRenameConversation(id) {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    historyEditingId = id;
    renderHistory();
    requestAnimationFrame(() => {
      const input = $historyList.querySelector(`.history-rename-input[data-rename-input-id="${id}"]`);
      if (!input) return;
      input.focus();
      input.select();
    });
  }

  function cancelRenameConversation() {
    if (!historyEditingId) return;
    historyEditingId = null;
    renderHistory();
  }

  function commitRenameConversation(id, nextTitleRaw) {
    const conv = conversations.find(c => c.id === id);
    if (!conv) {
      cancelRenameConversation();
      return;
    }

    const currentTitle = String(conv.title || '').trim();
    const nextTitle = String(nextTitleRaw || '').trim();
    historyEditingId = null;

    if (!nextTitle || nextTitle === currentTitle) {
      renderHistory();
      return;
    }

    conv.title = nextTitle;
    saveConversations();
  }

  function newConversation() {
    const conv = {
      id: `conv_${Date.now()}`,
      title: '',
      messages: [],
      profileId: activeProfileId,
      cwd: currentCwd,
      codexSessionId: null,
    };
    conversations.unshift(conv);
    activeConvId = conv.id;
    saveConversations();
    renderMessages();
    renderHistory();
    syncStreamingUI();
    $input.focus();
  }

  async function loadConversation(id) {
    try {
      activeConvId = id;
      const conv = getActiveConversation();
      // 대화별 작업 폴더 복원
      if (conv && conv.cwd) {
        const result = await window.electronAPI.cwd.set(conv.cwd);
        if (result.success) {
          currentCwd = conv.cwd;
          updateCwdDisplay();
        }
      }
      renderMessages();
      renderHistory();
      syncStreamingUI();
      $input.focus();
    } catch (err) {
      console.error('[loadConversation] failed:', err);
      // 깨진 대화 데이터가 있어도 앱 전체 입력/클릭이 멈추지 않도록 복구
      activeConvId = null;
      renderMessages();
      renderHistory();
      syncStreamingUI();
      $input.focus();
    }
  }

  function getActiveConversation() {
    return conversations.find(c => c.id === activeConvId);
  }

  // === 메시지 렌더링 ===
  function renderMessages() {
    const conv = getActiveConversation();
    if (!conv || conv.messages.length === 0) {
      $welcome.style.display = '';
      // 기존 메시지 요소 제거 (웰컴 제외)
      $messages.querySelectorAll('.message').forEach(el => el.remove());
      return;
    }
    $welcome.style.display = 'none';

    // 기존 메시지 요소 제거
    $messages.querySelectorAll('.message').forEach(el => el.remove());

    for (const msg of conv.messages) {
      try {
        appendMessageDOM(msg);
      } catch (err) {
        console.error('[renderMessages] skip message:', err, msg?.id);
      }
    }
    scrollToBottom({ force: true });
  }

  function appendMessageDOM(msg) {
    const profile = PROFILES.find(p => p.id === msg.profileId) || PROFILES[0];
    const el = document.createElement('div');
    el.className = `message ${msg.role}`;
    el.dataset.msgId = msg.id;

    const avatarColor = msg.role === 'user' ? 'var(--accent)' : profile.color;
    const avatarText = msg.role === 'user' ? 'U' : profile.icon;
    const name = msg.role === 'user' ? 'You' : profile.name;
    const time = new Date(msg.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    const bodyContent = msg.role === 'user'
      ? escapeHtml(msg.content)
      : renderAIBody(msg);

    el.innerHTML = `
      <div class="msg-header">
        <div class="msg-avatar" style="background:${avatarColor}">${avatarText}</div>
        <span class="msg-name">${name}</span>
        <span class="msg-time">${time}</span>
      </div>
      <div class="msg-body">${bodyContent}</div>
    `;

    $messages.appendChild(el);
    if (msg.profileId === 'codex' && msg.role !== 'user') {
      requestAnimationFrame(() => stickProcessStackToBottom(el.querySelector('.msg-body')));
    }
    return el;
  }

  function renderMarkdown(text, options = {}) {
    if (!text) return '';
    try {
      const skipPreprocess = Boolean(options?.skipPreprocess);
      const normalizedLinks = normalizeMarkdownLocalLinks(text);
      const markdownSource = skipPreprocess
        ? normalizedLinks
        : preprocessMarkdown(normalizedLinks);
      return marked.parse(markdownSource);
    } catch {
      return escapeHtml(text).replace(/\r?\n/g, '<br>');
    }
  }

  function isLikelyMarkdownStructureLine(trimmedLine) {
    const t = String(trimmedLine || '').trim();
    if (!t) return false;
    return /^(#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+|`{3,}|-{3,}\s*$|\|.+\|)/.test(t);
  }

  function isLikelyDiffMetaLine(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    return /^(@@|diff --git|index\s+\S+|---\s|\+\+\+\s|\\\sNo newline|\*{3}\s*(Begin Patch|End Patch|Update File:|Add File:|Delete File:|Move to:|End of File))/i.test(t);
  }

  function isLikelyDiffChangeLine(line) {
    const raw = String(line || '');
    if (!raw) return false;
    if (/^[+-]/.test(raw)) return true;
    return false;
  }

  function isLikelyDiffBlockStart(lines, index) {
    const current = String(lines[index] || '');
    if (isLikelyDiffMetaLine(current)) return true;

    // 통일 diff 표식이 없는 +/- 블록도 감지
    let plus = 0;
    let minus = 0;
    let changed = 0;
    for (let i = index; i < Math.min(lines.length, index + 8); i++) {
      const line = String(lines[i] || '');
      if (!line.trim()) {
        if (changed > 0) break;
        continue;
      }
      if (line.startsWith('+')) { plus += 1; changed += 1; continue; }
      if (line.startsWith('-')) { minus += 1; changed += 1; continue; }
      if (isLikelyDiffMetaLine(line)) return true;
      // 변동 라인 수집이 시작됐으면 일반 문장 등장 시 중단
      if (changed > 0) break;
    }
    return changed >= 4 && plus >= 1 && minus >= 1;
  }

  // 명령어 출력 (디렉토리 목록, 테이블 형식 등) — 코드가 아닌 출력
  function isLikelyCommandOutput(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    // PowerShell/cmd dir 출력: d----, -a---, Mode, LastWriteTime 등
    if (/^[d\-][a-z\-]{4,}\s+\d{4}-/.test(t)) return true;
    if (/^Mode\s+LastWriteTime/i.test(t)) return true;
    if (/^-{4,}\s+-{4,}/i.test(t)) return true;
    // ls -l 출력: drwxr-xr-x, -rw-r--r--
    if (/^[d\-][rwx\-]{8,}\s+\d+/.test(t)) return true;
    // 파일 크기 + 파일명 패턴 (숫자 + 공백 + 파일명)
    if (/^\d+\s+[\w.\-]+$/.test(t)) return true;
    // 날짜+시간 패턴이 있고 파일명으로 끝나는 라인
    if (/\d{4}[-\/]\d{2}[-\/]\d{2}/.test(t) && /\s+[\w.\-]+\s*$/.test(t)) return true;
    // git status 짧은 형식: M file, ?? file, A file, D file, R file 등
    if (/^(\?\?|[MADRCU!]{1,2})\s+[\w.\-\/\\]/.test(t)) return true;
    // 검색 결과 히트: path/to/file.ext:123: ...
    if (isLikelySearchHitLine(t)) return true;
    return false;
  }

  function isLikelyCodeSyntaxLine(line) {
    const raw = String(line || '');
    const t = raw.trim();
    if (!t) return false;
    if (isLikelyMarkdownStructureLine(t)) return false;
    if (isLikelyDiffMetaLine(t)) return false;
    if (isLikelyCommandOutput(t)) return false;
    // 한국어가 주가 되는 라인은 코드가 아님
    if (/[가-힣]/.test(t) && (t.match(/[가-힣]/g) || []).length > 3) return false;
    if (/^[{}[\]();,]+$/.test(t)) return true;
    // JSON 객체/배열
    if (/^\{["\w]/.test(t) && /[":,]/.test(t) && !/[가-힣]/.test(t)) return true;
    if (/^\[[\{"\w]/.test(t) && /[":,\{]/.test(t) && !/[가-힣]/.test(t)) return true;
    // 주석: // comment, /* comment, * continuation, */ close, # comment (shell/python)
    if (/^\/\//.test(t)) return true;
    if (/^\/\*/.test(t)) return true;
    if (/^\*\//.test(t)) return true;
    if (/^\*\s/.test(t)) return true;
    if (/^#!/.test(t)) return true;
    if (/^#\s*[A-Za-z_]/.test(t) && !/^#{1,6}\s/.test(t)) return true;
    if (/^(const|let|var|function|class|interface|type|enum|import|export|return|if|else|for|while|switch|case|try|catch|finally|async|await|def|from|print\(|public|private|protected|using|namespace|package|func|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|#include|<\w+)/i.test(t)) return true;
    if (/=>/.test(t) && !/[가-힣]/.test(t)) return true;
    if (/^[A-Za-z_]\w*\s*\(/.test(t) && /[){;]/.test(t)) return true;
    if (/[;{}]$/.test(t) && /[=()]/.test(t)) return true;
    if (/^\$[A-Za-z_]\w*/.test(t)) return true;
    if (/^<\/?[A-Za-z][\w-]*(\s+[\w:-]+=(["']).*?\2)*\s*\/?>$/.test(t)) return true;
    // 괄호로 시작하고 코드 키워드 포함: (async function () {
    if (/^\(/.test(t) && /\b(function|async|await|new|return|if|for|while)\b/.test(t)) return true;
    return false;
  }

  function hasStrongCodeSignal(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    if (isLikelyCommandOutput(t)) return false;
    // 한국어가 많이 포함된 라인은 괄호가 있어도 코드가 아님
    const koreanChars = (t.match(/[가-힣]/g) || []).length;
    if (koreanChars > 3) return false;
    if (isLikelyDiffMetaLine(t)) return true;
    if (/^[{}[\]();,]+$/.test(t)) return true;
    // JSON 객체/배열 (여러 키-값 쌍 포함)
    if (/^\{["\w]/.test(t) && /":/.test(t) && koreanChars === 0) return true;
    if (/=>|::|->|:=/.test(t) && koreanChars === 0) return true;
    // 주석 패턴
    if (/^\/\//.test(t)) return true;
    if (/^\/\*/.test(t)) return true;
    if (/^\*[\s\/]/.test(t)) return true;
    // 구조적 코드 신호: 세미콜론/중괄호 + 한국어 없음
    if (/[;{}]/.test(t) && /[=()]/.test(t) && koreanChars === 0) return true;
    // 괄호만으로 판단하지 않음 — 세미콜론이나 중괄호 필요
    if (/[;{}]$/.test(t) && /[A-Za-z0-9_$]/.test(t) && koreanChars === 0) return true;
    if (/^[A-Za-z_]\w*\s*[:=]\s*.+/.test(t) && koreanChars === 0) return true;
    if (/^(const|let|var|function|class|interface|type|enum|import|export|return|if|else|for|while|switch|case|try|catch|finally|async|await|def|from|print\(|public|private|protected|using|namespace|package|func)\b/i.test(t)) return true;
    if (/^(npm|pnpm|yarn|node|npx|git|python|pip|cargo|go|dotnet|java|javac|docker|kubectl|curl|pwsh|powershell|cmd)\b/i.test(t)) return true;
    if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(t)) return true;
    // 괄호로 시작하는 코드 구문
    if (/^\(/.test(t) && /\b(function|async|await|new|return)\b/.test(t)) return true;
    return false;
  }

  function isLikelyProseLine(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    if (isLikelyMarkdownStructureLine(t)) return false;
    if (isLikelyCodeSyntaxLine(t) || hasStrongCodeSignal(t)) return false;
    const words = t.split(/\s+/).filter(Boolean);
    const hasSentenceEnd = /[.!?:。]$/.test(t) || /[다요죠네임고면서든]$/.test(t);
    const hasKorean = /[가-힣]/.test(t);
    // 한국어가 포함된 라인은 대부분 산문
    if (hasKorean && words.length >= 2) return true;
    // 영문 산문: 단어 5개 이상이거나 문장 끝 패턴
    if (words.length >= 5 && hasSentenceEnd) return true;
    if (words.length >= 8) return true;
    return false;
  }

  function isCodeIntroLine(line) {
    const t = String(line || '').trim().toLowerCase();
    if (!t) return false;
    return /(코드|예시|샘플|명령어|command|cmd|snippet|diff|patch)\s*[:：]$/.test(t);
  }

  function findNextNonEmptyLine(lines, startIndex) {
    for (let i = startIndex; i < lines.length; i++) {
      const candidate = String(lines[i] || '');
      if (candidate.trim()) return candidate;
    }
    return '';
  }

  function findPrevNonEmptyLine(lines, indexExclusive) {
    for (let i = indexExclusive - 1; i >= 0; i--) {
      const candidate = String(lines[i] || '');
      if (candidate.trim()) return candidate;
    }
    return '';
  }

  // 파일 경로 라인 감지 (main.js, renderer\app.js, dist/win-unpacked/foo.dll 등)
  function isLikelyFilePathLine(line) {
    const t = String(line || '').trim();
    if (!t || t.length > 200) return false;
    // 한국어/산문이 포함되면 파일 경로가 아님
    if (/[가-힣]/.test(t)) return false;
    // 공백이 너무 많으면 파일 경로가 아님 (문장일 가능성)
    if ((t.match(/\s/g) || []).length > 3) return false;
    // 확장자가 있는 파일 경로: foo.js, dir\bar.txt, path/to/file.ext
    if (/^[\w.\-\/\\]+\.\w{1,10}$/.test(t)) return true;
    // 디렉토리 경로: renderer\, dist/win-unpacked/
    if (/^[\w.\-\/\\]+[\/\\]$/.test(t)) return true;
    return false;
  }

  function isLikelySearchHitLine(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    return /^(?:[A-Za-z]:)?(?:[^:\r\n]+[\\/])*[^:\r\n]+\.[A-Za-z0-9_+-]+:\d+:\s*/.test(t);
  }

  function parsePowerShellListing(text) {
    const source = String(text || '');
    if (!source) return [];

    const entryRe = /(?<mode>[d-][a-z-]{4})\s+(?<date>\d{4}-\d{2}-\d{2})\s+(?<ampm>오전|오후|AM|PM|am|pm)\s+(?<time>\d{1,2}:\d{2})\s*(?<tail>.*?)(?=(?:\s+[d-][a-z-]{4}\s+\d{4}-\d{2}-\d{2}\s+(?:오전|오후|AM|PM|am|pm)\s+\d{1,2}:\d{2})|$)/gs;
    const items = [];

    for (const m of source.matchAll(entryRe)) {
      const mode = m.groups?.mode || '';
      const date = m.groups?.date || '';
      const ampm = m.groups?.ampm || '';
      const time = m.groups?.time || '';
      let tail = String(m.groups?.tail || '').trim();
      if (!mode || !date || !ampm || !time) continue;

      let length = null;
      let name = tail;
      const lenName = /^(\d[\d,]*)\s+(.+)$/.exec(tail);
      if (lenName) {
        const parsedLength = Number(lenName[1].replace(/,/g, ''));
        length = Number.isFinite(parsedLength) ? parsedLength : null;
        name = lenName[2];
      }

      items.push({
        mode,
        isDir: mode[0] === 'd',
        isHidden: mode.includes('h'),
        lastWriteText: `${date} ${ampm} ${time}`,
        length,
        name: String(name || '').trim(),
      });
    }

    return items.filter(item => item.name);
  }

  function escapeMdCell(value) {
    return String(value ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, '<br>');
  }

  function toPowerShellListingMarkdownTable(items) {
    if (!Array.isArray(items) || items.length === 0) return '';

    const lines = [];
    lines.push('| Type | Hidden | LastWriteTime | Length | Name |');
    lines.push('| --- | --- | --- | ---: | --- |');
    for (const item of items) {
      const row = [
        item.isDir ? 'DIR' : 'FILE',
        item.isHidden ? 'H' : '',
        item.lastWriteText || '',
        item.isDir ? '' : (item.length ?? ''),
        item.name || '',
      ].map(escapeMdCell);
      lines.push(`| ${row.join(' | ')} |`);
    }
    return lines.join('\n');
  }

  function normalizeSearchHitContent(text) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return '';
    let merged = lines[0];
    for (let i = 1; i < lines.length; i++) {
      const next = lines[i];
      if (!next) continue;

      // 터미널 줄바꿈 중복(앞줄 끝과 뒷줄 시작이 겹침) 보정
      const prevTokenMatch = /([A-Za-z0-9_.$]+)$/.exec(merged);
      const nextTokenMatch = /^([A-Za-z0-9_.$]+)/.exec(next);
      let overlap = 0;
      if (prevTokenMatch && nextTokenMatch) {
        const prevToken = prevTokenMatch[1];
        const nextToken = nextTokenMatch[1];
        const maxOverlap = Math.min(prevToken.length, nextToken.length, 24);
        for (let k = maxOverlap; k >= 1; k--) {
          if (prevToken.slice(-k).toLowerCase() === nextToken.slice(0, k).toLowerCase()) {
            overlap = k;
            break;
          }
        }
      }

      const adjustedNext = overlap > 0 ? next.slice(overlap) : next;
      if (!adjustedNext) continue;

      const prevCh = merged.slice(-1);
      const nextCh = adjustedNext.slice(0, 1);
      const needNoGap = (
        /[A-Za-z0-9_]/.test(prevCh) && /[A-Za-z0-9_]/.test(nextCh)
      ) || /^[,.;:)\]}]/.test(adjustedNext) || /[\[({]$/.test(merged);

      merged += needNoGap ? adjustedNext : ` ${adjustedNext}`;
    }
    return merged.replace(/\s+/g, ' ').trim();
  }

  function shouldAppendSearchHitContinuation(blockLines, line) {
    const t = String(line || '').trim();
    if (!t) return false;
    if (isLikelySearchHitLine(t)) return false;
    if (isLikelyCommandOutput(t) || isLikelyFilePathLine(t)) return false;
    if (isLikelyMarkdownStructureLine(t)) return false;
    if (isLikelyDiffMetaLine(t) || isLikelyDiffChangeLine(t)) return false;

    const prev = findPrevNonEmptyLine(blockLines, blockLines.length);
    const prevTrim = String(prev || '').trim();
    if (!prevTrim) return false;
    if (!isLikelySearchHitLine(prevTrim) && !/[,.;:)\]}]$/.test(prevTrim) && !/[A-Za-z0-9_.$]$/.test(prevTrim)) {
      return false;
    }

    // 산문 문장 흡수를 피하기 위한 제한
    if ((t.match(/[가-힣]/g) || []).length > 4) return false;
    if (/^[A-Za-z]/.test(t) && /\b(the|and|with|from|this|that|then|when)\b/i.test(t) && t.length > 60) {
      return false;
    }

    if (/^[,.;:)\]}]/.test(t)) return true;
    if (/^[A-Za-z0-9_.$]/.test(t)) return true;
    if (/^[\[(<{'"`]/.test(t)) return true;
    return /[(){}[\].,;:+\-/*%<>=!&|^~]/.test(t);
  }

  function shouldKeepSearchHitBlockLine(blockLines, line) {
    if (shouldAppendSearchHitContinuation(blockLines, line)) return true;

    const t = String(line || '').trim();
    if (!t) return false;
    if (isLikelySearchHitLine(t)) return true;
    if (isLikelyCommandOutput(t) || isLikelyFilePathLine(t)) return false;
    if (isLikelyMarkdownStructureLine(t)) return false;
    if (isLikelyDiffMetaLine(t) || isLikelyDiffChangeLine(t)) return false;
    if (/^```/.test(t)) return false;

    const prev = findPrevNonEmptyLine(blockLines, blockLines.length);
    const prevTrim = String(prev || '').trim();
    if (!prevTrim) return false;
    const prevIsSearchHit = isLikelySearchHitLine(prevTrim);
    const prevHasCodeTail = /([A-Za-z0-9_.$,)\]}]+)$/.test(prevTrim);
    if (!prevIsSearchHit && !prevHasCodeTail) return false;

    // 일반 설명 문장 흡수 방지
    if (isLikelyProseLine(t) && !/[(){}[\].,;:=<>+\-/*%]/.test(t)) return false;

    const prevTail = /([A-Za-z0-9_.$,)\]}]+)$/.exec(prevTrim)?.[1] || '';
    const startsCodeTail = /^[A-Za-z0-9_.$,)\]}]/.test(t);
    if (prevTail && startsCodeTail) return true;

    if (/^[,.;:)\]}]/.test(t)) return true;
    if (/^[\[(<{'"`]/.test(t)) return true;
    if (/[=(),<>[\]{}:+\-/*%&|^~]/.test(t)) return true;
    const tokenCount = t.split(/\s+/).filter(Boolean).length;
    if (tokenCount <= 7 && t.length <= 180) return true;
    return false;
  }

  function parseSearchHitLine(line) {
    const raw = String(line || '');
    if (!raw.trim()) return null;
    const m = /^\s*(?<path>(?:[A-Za-z]:)?(?:[^:\r\n]+[\\/])*[^:\r\n]+\.[A-Za-z0-9_+-]+):(?<line>\d+):\s*(?<content>.*)$/.exec(raw);
    if (!m) return null;
    const file = String(m.groups?.path || '').trim();
    const lineNum = Number(m.groups?.line || '');
    if (!file || !Number.isFinite(lineNum)) return null;
    return {
      file,
      line: lineNum,
      content: String(m.groups?.content || ''),
    };
  }

  function parseSearchHitEntriesInline(source) {
    const entryRe = /(?<path>(?:[A-Za-z]:)?(?:[^:\r\n]+[\\/])*[^:\r\n]+\.[A-Za-z0-9_+-]+):(?<line>\d+):\s*(?<content>.*?)(?=(?:\s+(?:[A-Za-z]:)?(?:[^:\r\n]+[\\/])*[^:\r\n]+\.[A-Za-z0-9_+-]+:\d+:)|$)/gs;
    const items = [];
    for (const m of source.matchAll(entryRe)) {
      const file = String(m.groups?.path || '').trim();
      const lineNum = Number(m.groups?.line || '');
      if (!file || !Number.isFinite(lineNum)) continue;
      items.push({
        file,
        line: lineNum,
        match: normalizeSearchHitContent(m.groups?.content || ''),
      });
    }
    return items;
  }

  function parseSearchHitEntries(text) {
    const source = String(text || '');
    if (!source) return [];

    // 한 줄로 뭉개진 출력은 기존 inline 정규식 파서가 더 안정적
    if (!/\r?\n/.test(source)) {
      return parseSearchHitEntriesInline(source);
    }

    const items = [];
    let current = null;

    const pushCurrent = () => {
      if (!current) return;
      items.push({
        file: current.file,
        line: current.line,
        match: normalizeSearchHitContent(current.parts.join('\n')),
      });
      current = null;
    };

    for (const rawLine of source.split(/\r?\n/)) {
      const parsed = parseSearchHitLine(rawLine);
      if (parsed) {
        pushCurrent();
        current = {
          file: parsed.file,
          line: parsed.line,
          parts: [parsed.content],
        };
        continue;
      }

      if (!current) continue;
      const continuation = String(rawLine || '').trim();
      if (!continuation) continue;
      current.parts.push(continuation);
    }

    pushCurrent();
    if (items.length > 0) return items;
    return parseSearchHitEntriesInline(source);
  }

  function toSearchHitFileLinkCell(filePath, lineNum) {
    const rawPath = String(filePath || '').trim();
    if (!rawPath) return '';
    const encodedPath = encodeLocalPathForDataAttr(rawPath);
    const parsedLine = Number(lineNum);
    const safeLine = Number.isFinite(parsedLine) && parsedLine > 0 ? String(parsedLine) : '';
    const lineAttr = safeLine ? ` data-line="${safeLine}"` : '';
    return `<a href="#" class="file-path-link" data-local-path="${encodedPath}"${lineAttr}>${escapeHtml(rawPath)}</a>`;
  }

  function toSearchHitLineLinkCell(filePath, lineNum) {
    const rawPath = String(filePath || '').trim();
    const parsedLine = Number(lineNum);
    const safeLine = Number.isFinite(parsedLine) && parsedLine > 0 ? String(parsedLine) : '';
    if (!rawPath || !safeLine) return escapeHtml(String(lineNum ?? ''));
    const encodedPath = encodeLocalPathForDataAttr(rawPath);
    return `<a href="#" class="search-hit-line-link" data-local-path="${encodedPath}" data-line="${safeLine}">${safeLine}</a>`;
  }

  function groupSearchHitItems(items) {
    const groups = [];
    const byFile = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const file = String(item?.file || '').trim();
      const lineNum = Number(item?.line || '');
      const matchText = String(item?.match || '').trim();
      if (!file || !Number.isFinite(lineNum)) continue;

      let group = byFile.get(file);
      if (!group) {
        group = { file, entries: [] };
        byFile.set(file, group);
        groups.push(group);
      }

      const last = group.entries[group.entries.length - 1];
      if (last && Number(last.line) === lineNum) {
        last.match = normalizeSearchHitContent(`${last.match}\n${matchText}`);
        continue;
      }

      group.entries.push({
        line: lineNum,
        match: matchText,
      });
    }
    return groups;
  }

  function toSearchHitMarkdownTable(items) {
    if (!Array.isArray(items) || items.length === 0) return '';
    const groups = groupSearchHitItems(items);
    if (groups.length === 0) return '';

    const lines = [];
    lines.push('<table class="search-hit-table">');
    lines.push('<thead><tr><th>File</th><th>Line</th><th>Match</th></tr></thead>');
    lines.push('<tbody>');
    for (const group of groups) {
      for (let i = 0; i < group.entries.length; i++) {
        const entry = group.entries[i];
        const fileCell = i === 0
          ? (toSearchHitFileLinkCell(group.file, entry.line) || escapeHtml(group.file))
          : '';
        const lineCell = toSearchHitLineLinkCell(group.file, entry.line);
        const safeMatch = escapeHtml(String(entry.match ?? ''));
        lines.push('<tr>');
        lines.push(`<td>${fileCell}</td>`);
        lines.push(`<td class="search-hit-line">${lineCell}</td>`);
        lines.push(`<td><code class="search-hit-snippet">${safeMatch}</code></td>`);
        lines.push('</tr>');
      }
    }
    lines.push('</tbody>');
    lines.push('</table>');
    return lines.join('');
  }

  function tryFormatSearchHitsMarkdown(text) {
    const source = String(text || '');
    if (!source) return '';
    if (!/(?:(?:[A-Za-z]:)?(?:[^:\r\n]+[\\/])*[^:\r\n]+\.[A-Za-z0-9_+-]+:\d+:)/.test(source)) return '';
    const items = parseSearchHitEntries(source);
    if (items.length < 1) return '';
    return toSearchHitMarkdownTable(items);
  }

  function tryFormatPowerShellListingMarkdown(text) {
    const source = String(text || '');
    if (!source) return '';
    if (!/[d-][a-z-]{4}\s+\d{4}-\d{2}-\d{2}\s+(오전|오후|AM|PM|am|pm)\s+\d{1,2}:\d{2}/.test(source)) {
      return '';
    }

    const items = parsePowerShellListing(source);
    if (items.length < 2) return '';
    return toPowerShellListingMarkdownTable(items);
  }

  // search hit(path:line:) 출력이 터미널 폭으로 잘려 다음 줄로 떨어지는 경우를
  // 미리 병합해 표 렌더링 시 라인이 분리되지 않도록 보정한다.
  function mergeWrappedSearchHitLines(lines) {
    const merged = [];
    for (let i = 0; i < lines.length; i++) {
      const line = String(lines[i] || '');
      if (!isLikelySearchHitLine(line)) {
        merged.push(line);
        continue;
      }

      const parsed = parseSearchHitLine(line);
      if (!parsed) {
        merged.push(line);
        continue;
      }

      const candidateLines = [line];
      const contentParts = [String(parsed.content || '')];
      let consumedUntil = i;

      for (let j = i + 1; j < lines.length; j++) {
        const nextRaw = String(lines[j] || '');
        const nextTrim = nextRaw.trim();
        if (!nextTrim) {
          const lookahead = findNextNonEmptyLine(lines, j + 1);
          if (lookahead && shouldKeepSearchHitBlockLine(candidateLines, lookahead)) {
            consumedUntil = j;
            continue;
          }
          break;
        }

        if (isLikelySearchHitLine(nextRaw)) break;
        if (isLikelyFilePathLine(nextRaw) || isLikelyCommandOutput(nextRaw)) break;
        if (isLikelyMarkdownStructureLine(nextTrim)) break;
        if (isLikelyDiffMetaLine(nextRaw) || isLikelyDiffChangeLine(nextRaw)) break;
        if (!shouldKeepSearchHitBlockLine(candidateLines, nextRaw)) break;

        candidateLines.push(nextRaw);
        contentParts.push(nextTrim);
        consumedUntil = j;
      }

      if (candidateLines.length > 1) {
        const mergedContent = normalizeSearchHitContent(contentParts.join('\n'));
        merged.push(`${parsed.file}:${parsed.line}: ${mergedContent}`);
        i = consumedUntil;
        continue;
      }

      merged.push(line);
    }
    return merged;
  }

  // 자동 블록 감지에서 누락된 search hit(path:line:) 출력도
  // 마지막 단계에서 다시 스캔해 표 렌더링으로 강제 정리한다.
  function rewriteStandaloneSearchHitRuns(lines) {
    const output = [];
    let inFencedBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = String(lines[i] || '');
      const trimmed = line.trim();

      if (/^```/.test(trimmed)) {
        inFencedBlock = !inFencedBlock;
        output.push(line);
        continue;
      }

      if (inFencedBlock || !isLikelySearchHitLine(line)) {
        output.push(line);
        continue;
      }

      const runLines = [line];
      let endIndex = i;

      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = String(lines[j] || '');
        const nextTrimmed = nextLine.trim();
        if (/^```/.test(nextTrimmed)) break;

        if (isLikelySearchHitLine(nextLine)) {
          runLines.push(nextLine);
          endIndex = j;
          continue;
        }

        if (!nextTrimmed) {
          const lookahead = findNextNonEmptyLine(lines, j + 1);
          if (lookahead && (isLikelySearchHitLine(lookahead) || shouldKeepSearchHitBlockLine(runLines, lookahead))) {
            runLines.push('');
            endIndex = j;
            continue;
          }
          break;
        }

        if (!shouldKeepSearchHitBlockLine(runLines, nextLine)) break;
        runLines.push(nextLine);
        endIndex = j;
      }

      const tableHtml = tryFormatSearchHitsMarkdown(runLines.join('\n'));
      if (tableHtml) {
        output.push(tableHtml);
        i = endIndex;
        continue;
      }

      output.push(line);
    }

    return output;
  }

  function isLikelyPlainCodeBlockStart(lines, index) {
    // 첫 줄이 코드가 아니면 코드블록을 시작하지 않음 (산문이 코드에 포함되는 것 방지)
    const firstLine = String(lines[index] || '');
    const firstT = firstLine.trim();
    if (!firstT) return false;
    if (!isLikelyCodeSyntaxLine(firstLine) && !hasStrongCodeSignal(firstLine)) return false;

    let codeLikeCount = 0;
    let strongSignalCount = 0;
    let proseCount = 0;
    let scanned = 0;
    let consecutiveBlank = 0;

    for (let i = index; i < Math.min(lines.length, index + 12); i++) {
      const line = String(lines[i] || '');
      const t = line.trim();
      if (!t) {
        consecutiveBlank += 1;
        // 빈 줄 2개 연속이면 스캔 중단
        if (consecutiveBlank >= 2 && scanned > 0) break;
        // 빈 줄 1개는 허용 — runCount 리셋 안 함
        continue;
      }
      consecutiveBlank = 0;
      if (isLikelyDiffBlockStart(lines, i)) return false;
      if (isLikelyMarkdownStructureLine(t)) { if (scanned > 0) break; return false; }
      if (isLikelyCommandOutput(line)) { if (scanned > 0) break; return false; }

      scanned += 1;
      if (isLikelyCodeSyntaxLine(line) || hasStrongCodeSignal(line)) {
        codeLikeCount += 1;
        if (hasStrongCodeSignal(line)) strongSignalCount += 1;
      } else {
        if (isLikelyProseLine(line)) proseCount += 1;
      }
      if (scanned >= 6) break;
    }

    if (proseCount >= 2 && strongSignalCount < 2) return false;

    // 단일 라인이지만 매우 강한 코드 신호 (긴 코드 라인)
    if (codeLikeCount === 1 && strongSignalCount >= 1 && firstT.length > 30 && proseCount === 0) {
      return true;
    }

    // 2줄 이상 코드 + 강한 신호 1개 이상 (빈 줄 갭 허용)
    return codeLikeCount >= 2 && strongSignalCount >= 1;
  }

  // 코드 블록이 마크다운으로 감싸져 있지 않은 경우 자동 감지 + 래핑
  function preprocessMarkdown(text) {
    if (!text) return '';
    const rawLines = text.split(/\r?\n/);
    const lines = mergeWrappedSearchHitLines(rawLines);
    const result = [];
    const enableAutoPlainCodeWrap = true;
    let inFencedBlock = false;
    let codeIndentBlock = false;
    let autoCodeBlock = false;
    let autoDiffBlock = false;
    let autoFileListBlock = false;
    let autoFileListLines = [];
    let autoCodeLanguage = '';

    const closeAutoCodeBlock = () => {
      if (!autoCodeBlock) return;
      result.push('```');
      autoCodeBlock = false;
      autoCodeLanguage = '';
    };

    const closeAutoDiffBlock = () => {
      if (!autoDiffBlock) return;
      result.push('```');
      autoDiffBlock = false;
    };

    const closeAutoFileListBlock = () => {
      if (!autoFileListBlock) return;
      const blockText = autoFileListLines.join('\n');
      const searchHitTable = tryFormatSearchHitsMarkdown(blockText);
      const listingTable = searchHitTable ? '' : tryFormatPowerShellListingMarkdown(blockText);
      if (searchHitTable) {
        result.push(searchHitTable);
      } else if (listingTable) {
        result.push(listingTable);
      } else {
        for (const outputLine of autoFileListLines) {
          result.push(outputLine + '  ');
        }
      }
      autoFileListBlock = false;
      autoFileListLines = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // 이미 펜스드 코드블록 안에 있으면 그대로
      if (/^```/.test(line.trimStart())) {
        closeAutoDiffBlock();
        closeAutoCodeBlock();
        closeAutoFileListBlock();
        if (inFencedBlock) {
          inFencedBlock = false;
          result.push(line);
          continue;
        }
        // 코드 인덴트 블록이 열려있으면 먼저 닫기
        if (codeIndentBlock) {
          result.push('```');
          codeIndentBlock = false;
        }
        inFencedBlock = true;
        result.push(line);
        continue;
      }
      if (inFencedBlock) {
        result.push(line);
        continue;
      }

      if (autoDiffBlock) {
        if (trimmed === '') {
          const next = i + 1 < lines.length ? lines[i + 1] : '';
          if (isLikelyDiffMetaLine(next) || isLikelyDiffChangeLine(next)) {
            result.push(line);
            continue;
          }
          closeAutoDiffBlock();
          result.push(line);
          continue;
        }

        if (isLikelyDiffMetaLine(line) || isLikelyDiffChangeLine(line) || /^[ \t]/.test(line)) {
          result.push(line);
          continue;
        }

        closeAutoDiffBlock();
      }

      if (!codeIndentBlock && !autoCodeBlock && isLikelyDiffBlockStart(lines, i)) {
        result.push('```diff');
        autoDiffBlock = true;
        result.push(line);
        continue;
      }

      // 파일 리스트 / 명령어 출력 블록 처리 (코드블록 아닌 줄바꿈 보존)
      if (autoFileListBlock) {
        const hasSearchHitSeed = autoFileListLines.some(item => isLikelySearchHitLine(item));
        if (isLikelyFilePathLine(line) || isLikelyCommandOutput(line)) {
          autoFileListLines.push(line);
          continue;
        }
        if (hasSearchHitSeed && shouldKeepSearchHitBlockLine(autoFileListLines, line)) {
          autoFileListLines.push(line);
          continue;
        }
        if (trimmed === '') {
          const nextLine = findNextNonEmptyLine(lines, i + 1);
          if (
            isLikelyFilePathLine(nextLine)
            || isLikelyCommandOutput(nextLine)
            || (hasSearchHitSeed && shouldKeepSearchHitBlockLine(autoFileListLines, nextLine))
          ) {
            autoFileListLines.push('');
            continue;
          }
        }
        closeAutoFileListBlock();
      }

      // 파일 경로 또는 명령어 출력이 2줄 이상 연속 → 줄바꿈 보존 (코드블록 X)
      const isTerminalOutput = isLikelyFilePathLine(line) || isLikelyCommandOutput(line);
      if (!inFencedBlock && !codeIndentBlock && !autoCodeBlock && !autoDiffBlock && !autoFileListBlock && isTerminalOutput) {
        // 검색 히트(path:line:)는 단일 라인이어도 우선 블록으로 시작해
        // 뒤따르는 래핑/연속 라인을 같은 항목으로 흡수한다.
        if (isLikelySearchHitLine(line)) {
          autoFileListBlock = true;
          autoFileListLines = [line];
          continue;
        }

        const nextLine = findNextNonEmptyLine(lines, i + 1);
        const hasNextOutput = isLikelyFilePathLine(nextLine) || isLikelyCommandOutput(nextLine);
        const hasWrappedSearchContinuation = isLikelySearchHitLine(line) && shouldAppendSearchHitContinuation([line], nextLine);
        if (hasNextOutput || hasWrappedSearchContinuation) {
          autoFileListBlock = true;
          autoFileListLines = [line];
          continue;
        }

        // 한 줄로 뭉개진 PowerShell listing은 표로 복원
        const oneLineSearchHitTable = tryFormatSearchHitsMarkdown(line);
        if (oneLineSearchHitTable) {
          result.push(oneLineSearchHitTable);
          continue;
        }

        // 한 줄로 뭉개진 PowerShell listing은 표로 복원
        const oneLineTable = tryFormatPowerShellListingMarkdown(line);
        if (oneLineTable) {
          result.push(oneLineTable);
          continue;
        }
      }

      // 들여쓰기 4칸 이상이 연속되는 패턴 → 코드블록으로 변환
      const isIndentedCode = /^(    |\t)/.test(line) && line.trim().length > 0;
      const isBlank = trimmed === '';

      if (isIndentedCode && !codeIndentBlock) {
        // 코드블록 시작 감지 — 앞 라인이 빈 줄이거나 첫 줄
        const prevLine = result.length > 0 ? result[result.length - 1] : '';
        if (prevLine.trim() === '' || result.length === 0) {
          codeIndentBlock = true;
          const lang = guessLanguageFromLine(line.trim());
          result.push('```' + lang);
          result.push(line.replace(/^(    |\t)/, ''));
          continue;
        }
      }

      if (codeIndentBlock) {
        if (isIndentedCode) {
          result.push(line.replace(/^(    |\t)/, ''));
          continue;
        }
        if (isBlank) {
          // 빈 줄은 다음 라인이 코드인지 확인
          const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
          if (/^(    |\t)/.test(nextLine) && nextLine.trim().length > 0) {
            result.push('');
            continue;
          }
          // 코드블록 종료
          result.push('```');
          result.push(line);
          codeIndentBlock = false;
          continue;
        }
        // 비코드 라인 → 코드블록 종료
        result.push('```');
        codeIndentBlock = false;
      }

      if (autoCodeBlock) {
        if (isBlank) {
          result.push(line);
          continue;
        }

        if (isLikelyCodeSyntaxLine(line) || hasStrongCodeSignal(line) || /^[ \t]/.test(line)
          || /^(\/\/|\/\*|\*\/|\* |#!|#include|#if|#endif|#define|#pragma|#\s*[A-Za-z_][\w-]*\s*=)/.test(trimmed)) {
          result.push(line);
          continue;
        }

        if (isLikelyMarkdownStructureLine(trimmed)) {
          closeAutoCodeBlock();
          result.push(line);
          continue;
        }

        const nextNonEmpty = findNextNonEmptyLine(lines, i + 1);
        if (isLikelyProseLine(line) && isLikelyProseLine(nextNonEmpty)) {
          closeAutoCodeBlock();
          result.push(line);
          continue;
        }

        // 한 줄 잡음으로 코드 블록이 분리되지 않도록 기본적으로 유지
        result.push(line);
        continue;
      }

      const prevNonEmpty = findPrevNonEmptyLine(lines, i);
      const nextNonEmpty = findNextNonEmptyLine(lines, i + 1);
      const introTriggered = isCodeIntroLine(prevNonEmpty) && (
        isLikelyCodeSyntaxLine(line) ||
        hasStrongCodeSignal(line) ||
        hasStrongCodeSignal(nextNonEmpty)
      );

      if (enableAutoPlainCodeWrap && !codeIndentBlock && !autoCodeBlock && (isLikelyPlainCodeBlockStart(lines, i) || introTriggered)) {
        autoCodeLanguage = guessLanguageFromLine(trimmed);
        result.push('```' + autoCodeLanguage);
        autoCodeBlock = true;
        result.push(line);
        continue;
      }

      result.push(line);
    }

    // 열린 블록 닫기
    if (codeIndentBlock) result.push('```');
    if (autoCodeBlock) result.push('```');
    if (autoDiffBlock) result.push('```');
    closeAutoFileListBlock();
    if (inFencedBlock) result.push('```');

    return rewriteStandaloneSearchHitRuns(result).join('\n');
  }

  function guessLanguageFromLine(line) {
    if (/^(import |from |def |class |print\(|if __name__)/.test(line)) return 'python';
    if (/^(const |let |var |function |import |export |=>|async )/.test(line)) return 'javascript';
    if (/^(interface |type |enum |const \w+:\s)/.test(line)) return 'typescript';
    if (/^(package |func |import \()/.test(line)) return 'go';
    if (/^(use |fn |let mut |pub |mod |impl )/.test(line)) return 'rust';
    if (/^(public |private |protected |class |static |void )/.test(line)) return 'java';
    if (/^(#include|int main|void |std::)/.test(line)) return 'cpp';
    if (/^(<\?php|namespace |use |echo )/.test(line)) return 'php';
    if (/^(SELECT |INSERT |UPDATE |DELETE |CREATE |ALTER |DROP )/i.test(line)) return 'sql';
    if (/^(\$|Write-|Get-|Set-|New-)/.test(line)) return 'powershell';
    if (/^(<!DOCTYPE|<html|<div|<span|<head)/i.test(line)) return 'html';
    if (/^(\.|#|@media|:root|body\s*\{)/.test(line)) return 'css';
    if (/^\{/.test(line) || /^\[/.test(line)) return 'json';
    if (/^(FROM |RUN |CMD |COPY |WORKDIR |EXPOSE )/i.test(line)) return 'dockerfile';
    if (/^(apiVersion:|kind:|metadata:)/.test(line)) return 'yaml';
    return '';
  }

  function isNoisyExecutionLogLine(line) {
    const raw = String(line || '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
    const t = raw.trim();
    if (!t) return false;
    if (/^exec$/i.test(t)) return true;
    if (/^exec\b/i.test(t)) return true;
    if (/\bexited\s+\d+\s+in\s+\d+(?:\.\d+)?m?s\b[:.,]?/i.test(t)) return true;
    if (/\brunning:\s*task interrupted\b/i.test(t)) return true;
    if (/\btask interrupted\b/i.test(t)) return true;
    if (/\b(?:Buffer\|CenterSize\|RotDepthPivot\|pivot\|symbol center\|center)\b/i.test(t)) return true;
    if (/^\s*"(?:[A-Za-z]:\\|\/).+\b(?:pwsh|powershell|cmd|bash|zsh|sh)(?:\.exe)?"/i.test(t)) return true;
    if (/\b(?:succeeded|failed)\s+in\s+\d+(?:\.\d+)?ms\b/i.test(t)) return true;
    if (/\bin\s+[A-Za-z]:\\.+\b(?:succeeded|failed)\s+in\s+\d+(?:\.\d+)?ms\b/i.test(t)) return true;
    // Codex 내부 협업/디버그 로그
    if (/^collab\s+/i.test(t)) return true;
    // 내부 함수 호출 ID (call_xxxx, receivers: uuid)
    if (/\b(?:call_[A-Za-z0-9]{10,}|receivers?:\s*[0-9a-f-]{20,})\b/i.test(t)) return true;
    // 에이전트/세션 내부 상태
    if (/^(?:agent|worker|scheduler|dispatch|heartbeat|ping|pong)\s*[\(:]/i.test(t)) return true;
    // Codex 내부 실행 로그: "file" in C:\path\exec, path\exec 등
    if (/\bin\s+[A-Za-z]:\\.*exec\s*$/i.test(t)) return true;
    if (/[\\\/]exec\s*$/i.test(t)) return true;
    // grep/검색 패턴 로그: "pattern" file" in path
    if (/"\s+in\s+[A-Za-z]:\\/.test(t) && /exec\s*$/i.test(t)) return true;
    // 검색 패턴이 포함된 실행 로그 (파이프 구분 패턴 + 파일 경로)
    if (/[|].*"\s+[\w\\\/]+\.\w+"\s+in\s+/i.test(t)) return true;
    // 단순 "exec" 뒤에 파일 경로가 붙은 형태
    if (/\bexec\s*$/.test(t) && /[\\\/]/.test(t)) return true;
    // CLIexec 패턴 (잘린 경로 + exec)
    if (/CLIexec\s*$/i.test(t)) return true;
    // 잘린 노이즈: "ude CLIexec", "de CLIexec" 등
    if (/^[a-z]{1,5}\s+CLIexec\s*$/i.test(t)) return true;
    // 길게 잘린 검색 실행 문자열 (패턴+글롭 옵션)은 사용자용 출력에서 제외
    if (/\b(?:rg|grep|findstr)\b/i.test(t) && /\|/.test(t) && /-g\s*["']?\*?\.[A-Za-z0-9]+["']?/i.test(t) && t.length > 70) return true;
    if (/\b(?:GCECDISEngine|GCDXGLFWTest|GCECDISKernnel)\b/.test(t) && /-g\s*["']?\*?\.[A-Za-z0-9]+["']?/i.test(t)) return true;
    if (/\b(?:rg|grep|findstr)\b/i.test(t) && /(?:\||,).*(?:\||,).*(?:\||,)/.test(t) && t.length > 80) return true;
    return false;
  }

  function stripNoisyExecutionFragments(line) {
    let text = String(line || '');
    if (!text) return '';

    // 실행 종료/중단 로그 파편 제거
    text = text
      .replace(/\bexited\s+\d+\s+in\s+\d+(?:\.\d+)?m?s\b[:.,]?\s*/gi, ' ')
      .replace(/\brunning:\s*task interrupted\b[:.,]?\s*/gi, ' ')
      .replace(/\btask interrupted\b[:.,]?\s*/gi, ' ');

    // 잘린 검색 실행 파편 제거
    text = text
      .replace(/\b(?:Buffer\|CenterSize\|RotDepthPivot\|pivot\|symbol center\|center)\b/gi, ' ')
      .replace(/\b(?:rg|grep|findstr)\b[^,\n]{0,220}-g\s*["']?\*?\.[A-Za-z0-9]+["']?(?:\s+-g\s*["']?\*?\.[A-Za-z0-9]+["']?)*/gi, ' ');

    return text.replace(/\s{2,}/g, ' ').trim();
  }

  // 사용자가 볼 필요 없는 Codex 시스템 메타 라인
  function isSystemMetaLine(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    // 세션 메타 정보
    if (/^OpenAI\s+Codex\b/i.test(t)) return true;
    if (/^(workdir|model|provider|approval|sandbox|reasoning\s*effort|reasoning\s*summaries|session\s*id)\s*:/i.test(t)) return true;
    // 구분선
    if (/^[─━\-]{8,}$/.test(t)) return true;
    // thinking 헤더 (e.g. "thinking (1234ms)")
    if (/^thinking\s*(\([\d.]+m?s\))?\s*$/i.test(t)) return true;
    // "codex" 단독 라인 (응답 시작 마커)
    if (/^codex\s*$/i.test(t)) return true;
    // 토큰 사용량
    if (/^(tokens?\s+used|token(?:s)?\s*usage)\b/i.test(t)) return true;
    if (/^토큰\s*(사용량|잔여율)/i.test(t)) return true;
    if (/^\d+\s+tokens?\s+used/i.test(t)) return true;
    // MCP 연결 상태
    if (/^mcp:/i.test(t)) return true;
    return false;
  }

  function isPromptMetaLine(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    if (/^\[출력\s*형식\s*규칙\]$/i.test(t)) return true;
    if (/^-\s*코드,\s*명령어,\s*설정\s*파일\s*내용은/i.test(t)) return true;
    if (/^-\s*변경점\s*패치\/?비교는/i.test(t)) return true;
    if (/^(system|user|assistant)\s*prompt\s*[:=]/i.test(t)) return true;
    if (/^(prompt|request|question)\s*[:=]/i.test(t)) return true;
    if (/^(프롬프트|요청|질문)\s*[:=]/.test(t)) return true;
    return false;
  }

  function parseOutputChannelMarker(line) {
    const t = String(line || '').trim();
    if (!t) return null;

    const toChannel = (name) => {
      const key = String(name || '').toLowerCase();
      if (key === 'final' || key === 'assistant') return 'final';
      if (key === 'analysis' || key === 'commentary' || key === 'summary' || key === 'user') return 'process';
      return '';
    };

    let m = t.match(/^\[(analysis|commentary|summary|final|assistant|user)\]\s*(?::|-)?\s*(.*)$/i);
    if (m) {
      const channel = toChannel(m[1]);
      if (!channel) return null;
      return { channel, inline: String(m[2] || '').trim() };
    }

    m = t.match(/^(analysis|commentary|summary|final|assistant|user)\s*$/i);
    if (m) {
      const channel = toChannel(m[1]);
      if (!channel) return null;
      return { channel, inline: '' };
    }

    m = t.match(/^(analysis|commentary|summary|final|assistant|user)\s*[:\-]\s*(.*)$/i);
    if (m) {
      const channel = toChannel(m[1]);
      if (!channel) return null;
      return { channel, inline: String(m[2] || '').trim() };
    }

    return null;
  }

  function splitChannelTaggedOutput(text) {
    const lines = String(text || '').split(/\r?\n/);
    const finalLines = [];
    const processLines = [];
    let current = 'final';
    let hasMarker = false;
    let inFence = false;

    const pushToCurrent = (line) => {
      if (current === 'process') {
        processLines.push(line);
      } else {
        finalLines.push(line);
      }
    };

    for (const raw of lines) {
      const line = String(raw || '');
      const trimmed = line.trim();

      if (!inFence) {
        const marker = parseOutputChannelMarker(trimmed);
        if (marker) {
          hasMarker = true;
          current = marker.channel;
          if (marker.inline) pushToCurrent(marker.inline);
          continue;
        }
      }

      if (/^```/.test(trimmed)) {
        inFence = !inFence;
      }
      pushToCurrent(line);
    }

    return {
      hasMarker,
      finalText: finalLines.join('\n').trim(),
      processText: processLines.join('\n').trim(),
    };
  }

  function mergeSectionText(baseText, extraText) {
    const base = String(baseText || '').trim();
    const extra = String(extraText || '').trim();
    if (!base) return extra;
    if (!extra) return base;
    if (base.includes(extra)) return base;
    return `${base}\n${extra}`;
  }

  function sanitizeFinalAnswerText(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    let inFence = false;

    for (let raw of lines) {
      let line = String(raw || '');
      let t = line.trim();
      if (!t) {
        if (!inFence) out.push('');
        continue;
      }

      // 최종 답변 탭에서는 과정 중 코드/패치 블록을 제거
      if (/^```/.test(t)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      // 채널 표식 제거
      const marker = parseOutputChannelMarker(t);
      if (marker) {
        if (marker.channel !== 'final') continue;
        if (!marker.inline) continue;
        line = marker.inline;
        t = line.trim();
      }

      if (!t) continue;
      if (isPromptMetaLine(t) || isSystemMetaLine(t) || isNoisyExecutionLogLine(t)) continue;
      if (isLikelyCommandOutput(t) || isLikelyFilePathLine(t)) continue;
      if (isLikelyDiffMetaLine(t) || isLikelyDiffChangeLine(t)) continue;
      if (/^\*{3}\s*(Begin|End|Update|Add|Delete|Move)\b/i.test(t)) continue;
      if (/^(analysis|commentary|summary|user)\s*[:\-]/i.test(t)) continue;
      if (/^CODE$/i.test(t)) continue;

      out.push(line);
    }

    return out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function extractMessageTextFromJsonContent(content) {
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.text === 'string' && item.text.trim()) parts.push(item.text);
      else if (typeof item.output_text === 'string' && item.output_text.trim()) parts.push(item.output_text);
      else if (typeof item.input_text === 'string' && item.input_text.trim()) parts.push(item.input_text);
      else if (typeof item.summary_text === 'string' && item.summary_text.trim()) parts.push(item.summary_text);
    }
    return parts.join('\n').trim();
  }

  function appendUniqueLine(target, text) {
    const normalized = normalizeDetailLine(String(text || ''));
    if (!normalized) return;
    const last = target[target.length - 1];
    if (last === normalized) return;
    if (target.length >= 480) target.shift();
    target.push(normalized);
  }

  function appendUniqueParagraph(target, text) {
    const value = String(text || '').trim();
    if (!value) return;
    const last = target[target.length - 1];
    if (last === value) return;
    if (target.length >= 120) target.shift();
    target.push(value);
  }

  function compactPathTail(pathText, keepSegments = 3) {
    const raw = String(pathText || '').trim();
    if (!raw) return '';
    const normalized = raw.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length <= keepSegments) return normalized;
    return parts.slice(-keepSegments).join('/');
  }

  function summarizeFileChangeItem(item, maxEntries = 4, maxLen = 320) {
    const changes = Array.isArray(item?.changes) ? item.changes : [];
    if (changes.length === 0) return '';
    const chunks = [];
    for (const change of changes.slice(0, Math.max(1, maxEntries))) {
      const pathText = normalizeDetailLine(String(change?.path || change?.file || ''));
      const kind = normalizeDetailLine(String(change?.kind || change?.type || 'update'));
      if (!pathText) continue;
      const shortPath = compactPathTail(pathText, 4);
      chunks.push(kind ? `${shortPath} (${kind})` : shortPath);
    }
    if (chunks.length === 0) return '';
    const extra = changes.length > chunks.length ? ` +${changes.length - chunks.length}` : '';
    return compactPreviewText(`파일 변경: ${chunks.join(', ')}${extra}`, maxLen);
  }

  function extractItemText(item) {
    if (!item || typeof item !== 'object') return '';
    const direct = ['text', 'message', 'output_text', 'summary_text'];
    const parts = [];
    for (const key of direct) {
      const value = item[key];
      if (typeof value === 'string' && value.trim()) parts.push(value);
    }
    const fileChangeSummary = summarizeFileChangeItem(item, 6, 420);
    if (fileChangeSummary) parts.push(fileChangeSummary);
    const content = extractMessageTextFromJsonContent(item.content);
    if (content) parts.push(content);
    return parts.join('\n').trim();
  }

  function appendAssistantTextFromJsonObject(obj, target) {
    if (!obj || typeof obj !== 'object') return;
    const contentText = extractMessageTextFromJsonContent(obj.content);
    if (contentText) appendUniqueParagraph(target, contentText);

    const textFields = ['text', 'message', 'output_text', 'summary_text', 'final_answer', 'last_agent_message'];
    for (const field of textFields) {
      const value = obj[field];
      if (typeof value === 'string' && value.trim()) {
        appendUniqueParagraph(target, value);
      }
    }
  }

  function collectAssistantParagraphsFromJson(node, target, depth = 0) {
    if (depth > 8 || node == null) return;

    if (Array.isArray(node)) {
      for (const item of node) collectAssistantParagraphsFromJson(item, target, depth + 1);
      return;
    }

    if (typeof node !== 'object') return;

    const role = String(node.role || node?.author?.role || node?.speaker || '').toLowerCase();
    if (role === 'assistant') {
      appendAssistantTextFromJsonObject(node, target);
    }

    // task_complete 류 이벤트의 마지막 응답 텍스트를 보조 수집
    if (typeof node.last_agent_message === 'string' && node.last_agent_message.trim()) {
      appendUniqueParagraph(target, node.last_agent_message);
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'arguments' || key === 'input' || key === 'command') continue;
      collectAssistantParagraphsFromJson(value, target, depth + 1);
    }
  }

  function parseCodexJsonOutput(text) {
    const source = String(text || '');
    if (!source) return null;

    const sections = {
      session: { title: '세션 정보', content: '', summary: '', open: false },
      mcp: { title: 'MCP 상태', content: '', summary: '', open: false },
      thinking: { title: '생각 과정', content: '', summary: '', open: true },
      response: { title: '응답', content: '', raw: '', summary: '', open: true },
      tokens: { title: '토큰 사용량', content: '', summary: '', open: false },
    };

    const allLines = source.split(/\r?\n/);
    const lines = allLines.length > 3600
      ? [...allLines.slice(0, 120), ...allLines.slice(-3200)]
      : allLines;

    const sessionLines = [];
    const processLines = [];
    const finalLines = [];
    let parsedJsonCount = 0;
    let typedJsonCount = 0;
    let fallbackFinalFromTask = '';
    const parsedObjects = [];

    for (const rawLine of lines) {
      const trimmed = String(rawLine || '').trim();
      if (!trimmed) continue;

      let obj = null;
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          obj = JSON.parse(trimmed);
          parsedJsonCount += 1;
        } catch {
          obj = null;
        }
      }

      if (!obj || typeof obj !== 'object') {
        if (parsedJsonCount > 0 && !isNoisyExecutionLogLine(trimmed)) {
          appendUniqueLine(processLines, trimmed);
        }
        continue;
      }

      const type = String(obj.type || '').toLowerCase();
      if (type) {
        typedJsonCount += 1;
        parsedObjects.push(obj);
        if (parsedObjects.length > 1000) parsedObjects.shift();
      }

      if (type === 'thread.started') {
        const threadId = String(obj.thread_id || '').trim();
        if (threadId) appendUniqueLine(sessionLines, `session id: ${threadId}`);
        continue;
      }

      if (type === 'turn.started') {
        appendUniqueLine(processLines, 'turn started');
        continue;
      }

      if (type === 'turn.failed') {
        const msg = String(obj?.error?.message || obj?.message || '').trim();
        if (msg) appendUniqueLine(processLines, `turn failed: ${msg}`);
        continue;
      }

      if (type === 'turn.completed') {
        const usage = obj.usage || obj.payload?.usage || {};
        const total = Number(usage.total_tokens) ||
          (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
        if (Number.isFinite(total) && total > 0) {
          sections.tokens.summary = formatTokenNumber(total);
          sections.tokens.content = `Tokens used: ${sections.tokens.summary}`;
        }
        continue;
      }

      if (type === 'error') {
        const msg = String(obj?.message || obj?.error?.message || '').trim();
        if (msg) appendUniqueLine(processLines, `error: ${msg}`);
        continue;
      }

      if (type === 'session_meta') {
        const payload = obj.payload || {};
        if (typeof payload.id === 'string' && payload.id) appendUniqueLine(sessionLines, `session id: ${payload.id}`);
        if (typeof payload.cwd === 'string' && payload.cwd) appendUniqueLine(sessionLines, `workdir: ${payload.cwd}`);
        if (typeof payload.model_provider === 'string' && payload.model_provider) appendUniqueLine(sessionLines, `provider: ${payload.model_provider}`);
        if (typeof payload.source === 'string' && payload.source) appendUniqueLine(sessionLines, `source: ${payload.source}`);
        continue;
      }

      if (type === 'turn_context') {
        const payload = obj.payload || {};
        if (typeof payload.model === 'string' && payload.model) appendUniqueLine(sessionLines, `model: ${payload.model}`);
        if (typeof payload.cwd === 'string' && payload.cwd) appendUniqueLine(sessionLines, `workdir: ${payload.cwd}`);
        if (typeof payload.approval_policy === 'string' && payload.approval_policy) appendUniqueLine(sessionLines, `approval: ${payload.approval_policy}`);
        if (typeof payload?.sandbox_policy?.type === 'string' && payload.sandbox_policy.type) appendUniqueLine(sessionLines, `sandbox: ${payload.sandbox_policy.type}`);
        continue;
      }

      if (type === 'event_msg') {
        const payload = obj.payload || {};
        const eventType = String(payload.type || '').toLowerCase();
        if (eventType === 'agent_message') {
          const message = String(payload.message || '').trim();
          const phase = String(payload.phase || '').toLowerCase();
          if (message) {
            if (/final/.test(phase)) appendUniqueParagraph(finalLines, message);
            else appendUniqueLine(processLines, message);
          }
          continue;
        }
        if (eventType === 'agent_reasoning') {
          appendUniqueLine(processLines, payload.text || payload.message || '');
          continue;
        }
        if (eventType === 'task_complete') {
          const lastMessage = String(payload.last_agent_message || '').trim();
          if (lastMessage) fallbackFinalFromTask = lastMessage;
          continue;
        }
        if (eventType === 'token_count') {
          const totalTokens = Number(payload?.info?.total_token_usage?.total_tokens);
          if (Number.isFinite(totalTokens) && totalTokens > 0) {
            sections.tokens.summary = formatTokenNumber(totalTokens);
            sections.tokens.content = `Tokens used: ${sections.tokens.summary}`;
          }
          const primaryUsed = Number(payload?.rate_limits?.primary?.used_percent);
          const secondaryUsed = Number(payload?.rate_limits?.secondary?.used_percent);
          if (Number.isFinite(primaryUsed) || Number.isFinite(secondaryUsed)) {
            const pRemain = Number.isFinite(primaryUsed) ? `${Math.max(0, 100 - primaryUsed)}%` : '--';
            const sRemain = Number.isFinite(secondaryUsed) ? `${Math.max(0, 100 - secondaryUsed)}%` : '--';
            appendUniqueLine(processLines, `limit remaining: 5h ${pRemain}, weekly ${sRemain}`);
          }
          continue;
        }
        if (eventType && eventType !== 'user_message') {
          appendUniqueLine(processLines, `event: ${eventType}`);
        }
        continue;
      }

      if (type === 'response_item') {
        const payload = obj.payload || {};
        const itemType = String(payload.type || '').toLowerCase();
        if (itemType === 'message') {
          const role = String(payload.role || '').toLowerCase();
          const phase = String(payload.phase || '').toLowerCase();
          const messageText = extractMessageTextFromJsonContent(payload.content);
          if (role === 'assistant') {
            if (/final/.test(phase)) appendUniqueParagraph(finalLines, messageText);
            else if (phase && /(analysis|commentary|summary|tool|debug)/.test(phase)) appendUniqueLine(processLines, messageText);
            else if (messageText) appendUniqueParagraph(finalLines, messageText);
          }
          continue;
        }
        if (itemType === 'reasoning') {
          const summary = Array.isArray(payload.summary)
            ? payload.summary.map(item => item?.text || item?.summary_text || '').filter(Boolean).join('\n')
            : '';
          appendUniqueLine(processLines, summary);
          continue;
        }
        if (itemType === 'function_call' || itemType === 'custom_tool_call') {
          const name = String(payload.name || 'tool');
          const argsRaw = typeof payload.arguments === 'string'
            ? payload.arguments
            : JSON.stringify(payload.arguments || '');
          const shortArgs = normalizeDetailLine(argsRaw).slice(0, 420);
          appendUniqueLine(processLines, shortArgs ? `tool call: ${name} ${shortArgs}` : `tool call: ${name}`);
          continue;
        }
        if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
          const outputText = typeof payload.output === 'string'
            ? payload.output
            : extractMessageTextFromJsonContent(payload.output);
          const firstLine = String(outputText || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .find(Boolean) || '';
          appendUniqueLine(processLines, firstLine ? `tool output: ${firstLine}` : 'tool output');
        }
      }

      if (type === 'item.completed' || type === 'item.started' || type === 'item.delta' || type === 'item.updated') {
        const item = obj.item || obj.payload?.item || obj.payload || {};
        const itemType = String(item.type || obj.item_type || '').toLowerCase();
        const itemText = extractItemText(item);
        const deltaText = String(obj.delta?.text || obj.text || '').trim();
        const mergedText = [itemText, deltaText].filter(Boolean).join('\n').trim();

        if (itemType === 'agent_message' || itemType === 'assistant_message' || itemType === 'message') {
          if (mergedText) appendUniqueParagraph(finalLines, mergedText);
          continue;
        }
        if (itemType === 'reasoning' || itemType === 'analysis') {
          if (mergedText) appendUniqueLine(processLines, mergedText);
          continue;
        }
        if (itemType === 'file_change') {
          const changeSummary = summarizeFileChangeItem(item, 6, 420) || mergedText;
          if (changeSummary) appendUniqueLine(processLines, changeSummary);
          continue;
        }
        if (itemType === 'tool_call' || itemType === 'tool_result' || itemType === 'command_execution' || itemType === 'file_change') {
          if (mergedText) appendUniqueLine(processLines, mergedText);
          continue;
        }
        if (mergedText) {
          if (type === 'item.completed') appendUniqueLine(processLines, mergedText);
        }
      }
    }

    if (typedJsonCount === 0) return null;

    // 이벤트 타입이 달라도 assistant role 텍스트를 전체 JSON 객체에서 재수집
    if (finalLines.length === 0 && parsedObjects.length > 0) {
      for (const obj of parsedObjects) {
        collectAssistantParagraphsFromJson(obj, finalLines);
      }
    }

    if (finalLines.length === 0 && fallbackFinalFromTask) {
      appendUniqueParagraph(finalLines, fallbackFinalFromTask);
    }

    sections.session.content = sessionLines.join('\n').trim();
    sections.thinking.content = processLines.join('\n').trim();
    sections.response.content = finalLines.join('\n').trim();
    sections.response.raw = sections.response.content;

    if (!sections.response.content) {
      const errorLine = [...processLines].reverse().find(line => /^(error:|turn failed:|실패:|오류:)/i.test(String(line || '').trim()));
      if (errorLine) {
        sections.response.content = String(errorLine).trim();
      } else {
        const failureHint = [...processLines].reverse().find(line => /(stream disconnected|reconnecting|failed|failure|timed out|timeout)/i.test(String(line || '').toLowerCase()));
        if (failureHint) sections.response.content = String(failureHint).trim();
      }
    }

    const modelMatch = sections.session.content.match(/model:\s*(\S+)/i);
    if (modelMatch) sections.session.summary = modelMatch[1];

    return sections;
  }

  function stripNoisyExecutionLogLines(text) {
    return String(text || '')
      .split(/\r?\n/)
      .filter(line => !isNoisyExecutionLogLine(line))
      .join('\n');
  }

  // Codex 응답에서 패치/코드 블록을 마크다운 코드펜스로 감싸기
  // response 섹션 내용을 정리: 패치 블록 감싸기, 메타 라인 제거
  // 펜스드 블록 내용이 터미널/명령어 출력만으로 구성되었는지 확인
  function isFencedBlockTerminalOnly(blockLines) {
    if (!blockLines || blockLines.length === 0) return false;
    let nonEmpty = 0;
    let terminalCount = 0;
    for (const bl of blockLines) {
      const bt = bl.trim();
      if (!bt) continue;
      nonEmpty += 1;
      if (isLikelyCommandOutput(bl) || isLikelyFilePathLine(bl)) terminalCount += 1;
    }
    return nonEmpty > 0 && terminalCount >= nonEmpty * 0.7;
  }

  function shouldMergeWrappedResponseLines(prevLine, nextLine) {
    const prev = String(prevLine || '').trimEnd();
    const next = String(nextLine || '').trimStart();
    if (!prev || !next) return false;
    if (prev.length > 280 || next.length > 280) return false;
    if (isLikelyMarkdownStructureLine(prev) || isLikelyMarkdownStructureLine(next)) return false;
    if (isLikelyDiffMetaLine(prev) || isLikelyDiffMetaLine(next)) return false;
    if (isLikelyDiffChangeLine(prev) || isLikelyDiffChangeLine(next)) return false;
    if (isLikelySearchHitLine(prev) || isLikelySearchHitLine(next)) return false;
    if (isLikelyCommandOutput(prev) || isLikelyCommandOutput(next)) return false;
    if (isLikelyFilePathLine(prev) || isLikelyFilePathLine(next)) return false;
    if (/[.!?。]\s*$/.test(prev)) return false;
    if (/^[\-*+]\s+/.test(next) || /^\d+\.\s+/.test(next)) return false;
    if (/^```/.test(prev) || /^```/.test(next)) return false;

    const merged = mergeWrappedTokenBoundary(prev, next);
    return merged.length < (prev.length + next.length);
  }

  function mergeWrappedResponseLines(text) {
    const source = String(text || '');
    if (!source) return '';
    if (source.length > 120000) return source;

    const lines = source.split(/\r?\n/);
    const out = [];
    let inFence = false;

    for (const raw of lines) {
      const line = String(raw || '');
      const trimmed = line.trimStart();
      if (/^```/.test(trimmed)) {
        inFence = !inFence;
        out.push(line);
        continue;
      }

      if (!inFence && out.length > 0 && shouldMergeWrappedResponseLines(out[out.length - 1], line)) {
        const prev = out[out.length - 1].trimEnd();
        const next = line.trimStart();
        out[out.length - 1] = mergeWrappedTokenBoundary(prev, next);
        continue;
      }

      out.push(line);
    }

    return out.join('\n');
  }

  function cleanCodexResponse(text) {
    if (!text) return '';
    const lines = text.split(/\r?\n/);
    const result = [];
    let inPatch = false;
    let inFence = false;
    let fenceStart = -1;
    let fenceBuffer = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (!inFence && !inPatch) {
        line = stripNoisyExecutionFragments(line);
      }
      const t = String(line || '').trim();
      if (!inFence && !inPatch && !t) continue;

      // 코드블록 밖에서 노이즈 라인 제거
      if (!inFence && !inPatch && isNoisyExecutionLogLine(line)) continue;

      // ── 펜스드 코드블록 토글 ──
      if (/^```/.test(t)) {
        if (inPatch) { result.push('```'); inPatch = false; }
        if (inFence) {
          // 펜스드 블록 종료 — 터미널 출력만이면 펜스 제거
          if (isFencedBlockTerminalOnly(fenceBuffer)) {
            // 펜스 시작 라인(```) 제거 (이미 result에 추가됨)
            result.splice(fenceStart, 1);
            // 각 줄에 줄바꿈 유지용 trailing space 추가
            for (const fl of fenceBuffer) {
              result.push(fl + '  ');
            }
            // 닫는 펜스 추가 안 함
          } else {
            for (const fl of fenceBuffer) result.push(fl);
            result.push(line);
          }
          inFence = false;
          fenceBuffer = [];
          continue;
        }
        inFence = true;
        fenceStart = result.length;
        result.push(line);
        fenceBuffer = [];
        continue;
      }
      if (inFence) { fenceBuffer.push(line); continue; }

      // ── *** Begin/End Patch 무시 ──
      if (/^\*{3}\s*(Begin|End)\s+Patch\b/i.test(t)) continue;
      // ── *** End of File 무시 ──
      if (/^\*{3}\s*End of File\b/i.test(t)) continue;

      // ── *** Update/Add/Delete/Move File → diff 블록 ──
      const patchHeader = t.match(/^\*{3}\s*(Update|Add|Delete|Move(?:\s+to)?)\s+File:\s*(.+)$/i);
      if (patchHeader) {
        const op = patchHeader[1].trim();
        const filePath = patchHeader[2].trim();
        if (!inPatch) {
          result.push('');
          result.push('```diff');
          inPatch = true;
        }
        result.push(`--- ${op}: ${filePath}`);
        continue;
      }

      // ── 패치 내부 ──
      if (inPatch) {
        if (t === '') {
          const nextT = (i + 1 < lines.length) ? lines[i + 1].trim() : '';
          const isContinuation = !nextT || /^[+-@\\]/.test(nextT) || /^\*{3}\s*(Update|Add|Delete|Move|End)/i.test(nextT);
          if (!isContinuation) {
            result.push('```');
            inPatch = false;
            result.push('');
            result.push(line);
            continue;
          }
        }
        result.push(line);
        continue;
      }

      result.push(line);
    }

    if (inPatch) result.push('```');
    if (inFence) {
      // 미닫힌 펜스드 블록 처리
      if (isFencedBlockTerminalOnly(fenceBuffer)) {
        result.splice(fenceStart, 1);
        for (const fl of fenceBuffer) result.push(fl + '  ');
      } else {
        for (const fl of fenceBuffer) result.push(fl);
        result.push('```');
      }
    }
    return mergeWrappedResponseLines(result.join('\n'));
  }

  // === Codex 출력 구조화 ===
  // Codex exec 출력 구조:
  //   [세션 헤더: OpenAI Codex ... session id]
  //   --------
  //   user
  //   [사용자 질문 텍스트]
  //   mcp: ...
  //   thinking
  //   [사고과정]
  //   codex
  //   [실제 응답]
  //   tokens used
  //   [숫자]
  //   [응답 내용 중복 반복] ← 제거 대상
  function parseCodexOutput(text) {
    const sourceText = String(text || '');
    const jsonSections = parseCodexJsonOutput(sourceText);
    if (jsonSections) {
      ensureTokenSummary(jsonSections, sourceText);
      jsonSections.response.raw = String(jsonSections.response.raw || jsonSections.response.content || '');
      jsonSections.response.content = sanitizeFinalAnswerText(cleanCodexResponse(jsonSections.response.content || ''));
      for (const key in jsonSections) jsonSections[key].content = String(jsonSections[key].content || '').trim();
      return jsonSections;
    }

    const sections = {
      session: { title: '세션 정보', content: '', summary: '', open: false },
      mcp: { title: 'MCP 상태', content: '', summary: '', open: false },
      thinking: { title: '생각 과정', content: '', summary: '', open: true },
      response: { title: '응답', content: '', raw: '', summary: '', open: true },
      tokens: { title: '토큰 사용량', content: '', summary: '', open: false },
    };

    const lines = sourceText.split(/\r?\n/);
    // 상태: null → 'session' → 'user_echo' → 'mcp' → 'thinking' → 'response' → 'tokens' → 'tail'
    let state = null;
    let tokensValue = '';

    for (let i = 0; i < lines.length; i++) {
      const line = stripNoisyExecutionFragments(lines[i]);
      const t = line.trim();
      if (!t) continue;

      // 노이즈 라인 무시
      if (isNoisyExecutionLogLine(line)) continue;
      if (isPromptMetaLine(line)) continue;

      // 구분선 건너뛰기
      if (/^[─━\-]{8,}$/.test(t)) continue;

      // ── 세션 헤더 시작 ──
      if (/^OpenAI\s+Codex/i.test(t)) {
        state = 'session';
        sections.session.content += line + '\n';
        continue;
      }

      // 세션 메타 라인 (어떤 state에서든 session으로)
      if (/^(workdir|model|provider|approval|sandbox|reasoning\s*effort|reasoning\s*summaries|session\s*id)\s*:/i.test(t)) {
        sections.session.content += line + '\n';
        continue;
      }

      // ── user 마커: 사용자 입력 에코 시작 ──
      if (/^user\s*$/i.test(t) && (state === 'session' || state === null)) {
        state = 'user_echo';
        continue;
      }

      // 사용자 입력 에코 구간 — mcp/thinking/codex가 올 때까지 무시
      if (state === 'user_echo') {
        if (/^mcp[\s:]/i.test(t)) {
          state = 'mcp';
          sections.mcp.content += line + '\n';
          continue;
        }
        if (/^mcp\s+startup\b/i.test(t)) continue; // mcp startup 라인도 무시
        if (/^thinking\b/i.test(t)) {
          state = 'thinking';
          const m = t.match(/\(([^)]+)\)/);
          if (m) sections.thinking.summary = m[1];
          continue;
        }
        if (/^codex\s*$/i.test(t)) {
          state = 'response';
          continue;
        }
        // 사용자 질문 에코 → 무시
        continue;
      }

      // ── MCP 라인 ──
      if (/^mcp[\s:]/i.test(t) || /^mcp\s+startup\b/i.test(t)) {
        state = 'mcp';
        sections.mcp.content += line + '\n';
        continue;
      }

      // ── thinking 시작 ──
      if (/^thinking\b/i.test(t)) {
        state = 'thinking';
        const m = t.match(/\(([^)]+)\)/);
        if (m) sections.thinking.summary = m[1];
        continue;
      }

      // ── codex 응답 시작 ──
      if (/^codex\s*$/i.test(t)) {
        state = 'response';
        continue;
      }

      // ── tokens used ──
      if (/^tokens?\s+used\s*$/i.test(t)) {
        state = 'tokens';
        sections.tokens.content += line + '\n';
        continue;
      }

      // tokens 직후의 숫자 라인
      if (state === 'tokens' && /^[\d,._]+$/.test(t)) {
        sections.tokens.content += line + '\n';
        const total = extractTokenUsage(t);
        if (total > 0) sections.tokens.summary = formatTokenNumber(total);
        // tokens 이후는 응답 중복(tail)이므로 무시
        state = 'tail';
        continue;
      }

      // ── tail (응답 중복 반복 영역) → 무시 ──
      if (state === 'tail') continue;

      // ── 각 섹션에 콘텐츠 추가 ──
      if (state === 'thinking') {
        sections.thinking.content += line + '\n';
      } else if (state === 'response') {
        // 응답 안에 섞인 내부 로그 제거
        if (!isNoisyExecutionLogLine(line)) {
          sections.response.content += line + '\n';
        }
      } else if (state === 'tokens') {
        sections.tokens.content += line + '\n';
      } else if (state === 'mcp') {
        sections.mcp.content += line + '\n';
      } else if (state === 'session') {
        sections.session.content += line + '\n';
      }
      // state === null → 아직 구조가 시작 안 됨 → 무시
    }

    // response에 섞인 채널 표식(commentary/final 등)을 분리해
    // 최종 답변은 answer로, 진행 중 메시지는 process(thinking)로 이동
    const taggedFromResponse = splitChannelTaggedOutput(sections.response.content || '');
    if (taggedFromResponse.hasMarker) {
      if (taggedFromResponse.processText) {
        sections.thinking.content = mergeSectionText(sections.thinking.content, taggedFromResponse.processText);
      }
      if (taggedFromResponse.finalText) {
        sections.response.content = taggedFromResponse.finalText;
      } else {
        sections.response.content = '';
      }
    }

    // 요약 생성
    const modelMatch = sections.session.content.match(/model:\s*(\S+)/i);
    if (modelMatch) {
      sections.session.summary = modelMatch[1];
    }

    // 파싱 fallback:
    // 1) 전체 텍스트에서 채널 표식 기반 final 재추출
    // 2) 그래도 없으면 메타/노이즈 제거 텍스트를 최종 답변 후보로 사용
    if (!sections.response.content.trim()) {
      const taggedFromAll = splitChannelTaggedOutput(String(text || ''));
      if (taggedFromAll.hasMarker) {
        if (taggedFromAll.processText) {
          sections.thinking.content = mergeSectionText(sections.thinking.content, taggedFromAll.processText);
        }
        if (taggedFromAll.finalText) {
          sections.response.content = taggedFromAll.finalText;
        }
      }
    }

    if (!sections.response.content.trim()) {
      sections.response.content = sanitizeFinalAnswerText(
        String(text)
          .split(/\r?\n/)
          .filter(l => !isSystemMetaLine(l) && !isNoisyExecutionLogLine(l) && !isPromptMetaLine(l))
          .join('\n')
      );
    }

    ensureTokenSummary(sections, text);

    sections.response.raw = sections.response.content || '';
    sections.response.content = sanitizeFinalAnswerText(cleanCodexResponse(sections.response.content || ''));
    for (const key in sections) sections[key].content = sections[key].content.trim();
    return sections;
  }

  function normalizeProcessLine(line) {
    const raw = stripNoisyExecutionFragments(
      String(line || '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    );
    if (isNoisyExecutionLogLine(raw)) return '';
    if (isPromptMetaLine(raw)) return '';
    const cleaned = raw
      .replace(/^[(\[]?(analysis|commentary|summary|final|assistant|user)[)\]]?\s*[:\-]?\s*/i, '')
      .replace(/^[\-\*\d\.\)\s]+/, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return '';
    return cleaned.slice(0, 480);
  }

  function summarizeSearchCommandLine(line) {
    const cleaned = normalizeDetailLine(String(line || ''));
    if (!cleaned) return '';
    const toolMatch = /\b(rg|grep|findstr)\b/i.exec(cleaned);
    if (!toolMatch) return '';

    const tool = toolMatch[1].toLowerCase();
    const knownScopes = ['GCECDISEngine', 'GCDXGLFWTest', 'GCECDISKernnel'];
    const scopes = knownScopes.filter(scope => new RegExp(`\\b${scope}\\b`, 'i').test(cleaned));
    const extMatches = [...cleaned.matchAll(/-g\s*["']?\*?\.([A-Za-z0-9]+)["']?/g)]
      .map(match => `.${String(match[1] || '').toLowerCase()}`)
      .filter(Boolean);
    const exts = [...new Set(extMatches)].slice(0, 4);

    const parts = [`코드 검색 (${tool})`];
    if (scopes.length > 0) parts.push(`대상: ${scopes.join(', ')}`);
    if (exts.length > 0) parts.push(`필터: ${exts.join(', ')}`);
    return parts.join(' | ');
  }

  function normalizeCommandDisplayText(commandText) {
    const cleaned = normalizeDetailLine(String(commandText || ''));
    if (!cleaned) return '';
    if (isNoisyExecutionLogLine(cleaned)) return '';
    return cleaned.slice(0, 420);
  }

  function classifyProcessKind(line) {
    const t = line.toLowerCase();
    if (/(error|fail|failed|warning|warn|exception|오류|실패|경고|예외)/i.test(t)) return 'issue';
    if (/(build|compile|package|test|verify|run|exec|실행|빌드|패키징|테스트|검증)/i.test(t)) return 'run';
    if (/(apply_patch|patch|edit|modify|update|write|create|delete|remove|rename|수정|변경|추가|삭제|생성)/i.test(t)) return 'edit';
    if (/(read|open|get-content|cat|inspect|parse|확인|검토|읽기|파싱)/i.test(t)) return 'read';
    if (/(search|find|rg|grep|scan|lookup|탐색|검색|조회)/i.test(t)) return 'search';
    if (/(plan|analysis|analy|reason|요구사항|계획|분석|설계)/i.test(t)) return 'plan';
    if (/(done|complete|completed|finish|finished|완료|마무리|반영)/i.test(t)) return 'done';
    return 'progress';
  }

  function extractLineHint(line) {
    const fileMatch = line.match(/([A-Za-z]:\\[^\s'"`]+|(?:[\w.-]+[\\/])+[\w.-]+)/);
    if (fileMatch) {
      const path = fileMatch[1].replace(/\\/g, '/');
      const parts = path.split('/');
      return `대상: ${parts[parts.length - 1]}`;
    }
    const quoted = line.match(/"([^"]{2,80})"/) || line.match(/'([^']{2,80})'/);
    if (quoted) return `기준: ${quoted[1]}`;
    return '';
  }

  function toReadableProcessItem(line) {
    const kind = classifyProcessKind(line);
    const hint = extractLineHint(line);

    if (kind === 'plan') {
      return { kind, title: '요청 분석', detail: hint ? `요청 범위를 정리했습니다. ${hint}` : '요청 범위와 작업 순서를 정리했습니다.' };
    }
    if (kind === 'search') {
      return { kind, title: '코드 탐색', detail: hint ? `관련 위치를 탐색했습니다. ${hint}` : '관련 코드와 설정 위치를 탐색했습니다.' };
    }
    if (kind === 'read') {
      return { kind, title: '내용 확인', detail: hint ? `구현 상태를 확인했습니다. ${hint}` : '파일과 출력을 확인해 현재 상태를 파악했습니다.' };
    }
    if (kind === 'edit') {
      return { kind, title: '코드 수정', detail: hint ? `변경을 적용했습니다. ${hint}` : '요구사항에 맞게 코드 변경을 적용했습니다.' };
    }
    if (kind === 'run') {
      return { kind, title: '검증 실행', detail: hint ? `명령 실행으로 결과를 검증했습니다. ${hint}` : '실행/빌드/테스트로 변경 결과를 검증했습니다.' };
    }
    if (kind === 'issue') {
      return { kind, title: '이슈 확인', detail: hint ? `문제 원인을 확인했습니다. ${hint}` : '오류 또는 경고 원인을 확인하고 대응했습니다.' };
    }
    if (kind === 'done') {
      return { kind, title: '정리 완료', detail: '수정 사항을 반영하고 결과를 정리했습니다.' };
    }
    return { kind: 'progress', title: '진행 상태', detail: hint ? `작업을 진행 중입니다. ${hint}` : '작업 단계를 순차적으로 진행 중입니다.' };
  }

  function buildProcessEntriesFromRawLines(rawLines) {
    const entries = [];
    for (const rawLine of Array.isArray(rawLines) ? rawLines : []) {
      const line = stripNoisyExecutionFragments(String(rawLine || '')).trim();
      if (!line) continue;
      if (isNoisyExecutionLogLine(line)) continue;
      if (isPromptMetaLine(line)) continue;
      if (/^(OpenAI\s+Codex|Model:|Directory:|Approval:|Sandbox:|Reasoning effort:|tokens?\s+used|token(?:s)?\s*usage|mcp:|codex)$/i.test(line)) continue;
      if (/^[─━\-]{8,}$/.test(line)) continue;

      const normalized = normalizeProcessLine(line);
      if (!normalized) continue;
      entries.push({
        raw: line,
        normalized,
        kind: classifyProcessKind(normalized),
      });
    }
    return entries;
  }

  function toReadableProcessDetailLine(line) {
    const raw = stripNoisyExecutionFragments(
      String(line || '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    ).trim();
    if (!raw || isNoisyExecutionLogLine(raw)) return '';

    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const obj = JSON.parse(raw);
        const jsonDetail = toProcessJsonDetailLine(obj, 420);
        if (jsonDetail) return normalizeDetailLine(jsonDetail);
      } catch {
        // JSON 파싱 실패 시 일반 텍스트 경로로 계속 처리
      }
    }

    const fileOp = raw.match(/^(?:\*\*\*\s*)?(Update|Add|Delete)\s+File:\s+(.+)$/i);
    if (fileOp) {
      const opMap = { update: '수정 파일', add: '추가 파일', delete: '삭제 파일' };
      const op = opMap[fileOp[1].toLowerCase()] || '변경 파일';
      return normalizeDetailLine(`${op}: ${fileOp[2]}`);
    }

    const moveOp = raw.match(/^\*{3}\s*Move to:\s+(.+)$/i);
    if (moveOp) return normalizeDetailLine(`파일 이동: ${moveOp[1]}`);

    const cleaned = normalizeProcessLine(raw);
    if (!cleaned) return '';

    if (/\b(rg|grep|findstr)\b/i.test(cleaned)) {
      return normalizeDetailLine(`코드 탐색 명령: ${cleaned}`);
    }
    if (/^(get-childitem|ls|dir)\b/i.test(cleaned)) {
      return normalizeDetailLine(`파일 탐색 명령: ${cleaned}`);
    }
    if (/^(npm|pnpm|yarn|node|npx|git|python|pwsh|powershell|cmd)\b/i.test(cleaned)) {
      return normalizeDetailLine(`실행 명령: ${cleaned}`);
    }
    return normalizeDetailLine(cleaned);
  }

  function extractCommandFromRawLine(line) {
    const raw = stripNoisyExecutionFragments(
      String(line || '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    ).trim();
    if (!raw) return '';

    // exec "...pwsh..." -Command 'node ...' in ...
    const commandInShell = raw.match(/\b-Command\s+(['"])([\s\S]*?)\1/i);
    if (commandInShell?.[2]) {
      return normalizeCommandDisplayText(commandInShell[2]);
    }

    const directCmd = raw.match(/^(npm|pnpm|yarn|node|npx|git|python|py|pwsh|powershell|cmd|rg|grep|findstr|get-childitem|ls|dir)\b.*$/i);
    if (directCmd) {
      return normalizeCommandDisplayText(raw);
    }

    return '';
  }

  function getLatestProcessCommand(entries, preferredKind) {
    const source = Array.isArray(entries) ? entries : [];
    if (source.length === 0) return '';

    const pools = [];
    if (preferredKind) {
      const preferred = source.filter(entry => entry.kind === preferredKind);
      if (preferred.length > 0) pools.push(preferred);
    }
    pools.push(source);

    for (const pool of pools) {
      for (const entry of [...pool].reverse()) {
        const cmd = extractCommandFromRawLine(entry.raw);
        if (cmd) return cmd;
      }
    }
    return '';
  }

  function toReadableWorkLine(entry, fallbackKind) {
    const raw = String(entry?.raw || '').trim();
    if (!raw) return '';
    const commandText = extractCommandFromRawLine(raw);
    if (commandText) {
      return normalizeDetailLine(`실행 명령: ${commandText}`);
    }

    const detail = toReadableProcessDetailLine(raw);
    if (!detail) return '';

    const hint = extractLineHint(raw);
    const kind = entry?.kind || fallbackKind || 'progress';

    if ((kind === 'read' || kind === 'search') && hint) {
      return normalizeDetailLine(`코드 확인: ${hint.replace(/^대상:\s*/, '')}`);
    }

    if (hint && /(update file|add file|delete file|apply_patch|patch|수정|추가|삭제|변경)/i.test(raw)) {
      return normalizeDetailLine(`변경 작업: ${hint.replace(/^대상:\s*/, '')}`);
    }

    if (kind === 'read' || kind === 'search') {
      return normalizeDetailLine(`코드 탐색: ${detail}`);
    }
    return normalizeDetailLine(`작업 진행: ${detail}`);
  }

  function buildProcessSummaryLines(entries, kind, maxLines = null) {
    const source = Array.isArray(entries) ? entries : [];
    if (source.length === 0) return ['작업 진행 중입니다.', '관련 코드 위치를 확인 중입니다.', '출력을 수집하고 있습니다.'];
    const hasLimit = Number.isFinite(maxLines) && Number(maxLines) > 0;
    const max = hasLimit ? Number(maxLines) : Number.POSITIVE_INFINITY;

    const seen = new Set();
    const lines = [];
    const preferred = source.filter(entry => entry.kind === kind);
    const pool = preferred.length > 0 ? preferred : source;

    for (const entry of [...pool].reverse()) {
      const readable = toReadableWorkLine(entry, kind);
      if (!readable || seen.has(readable)) continue;
      seen.add(readable);
      lines.push(readable);
      if (lines.length >= max) break;
    }

    const fallbackLines = kind === 'read' || kind === 'search'
      ? ['관련 코드 위치를 확인 중입니다.', '읽은 코드 기준으로 영향 범위를 점검 중입니다.', '다음 변경 지점을 정리 중입니다.']
      : ['현재 작업 단계를 진행 중입니다.', '연관 코드와 출력 내용을 점검 중입니다.', '결과를 정리해 다음 단계로 반영 중입니다.'];

    if (lines.length === 0) {
      for (const fallback of fallbackLines) {
        if (lines.length >= 3 || lines.length >= max) break;
        if (seen.has(fallback)) continue;
        seen.add(fallback);
        lines.push(fallback);
      }
    }

    return hasLimit ? lines.slice(0, max) : lines;
  }

  function getActualProcessDetails(entries, kind, limit = 4) {
    const source = Array.isArray(entries) ? entries : [];
    if (source.length === 0) return [];

    const seen = new Set();
    const details = [];

    const byKind = source.filter(entry => entry.kind === kind);
    const pool = byKind.length > 0 ? byKind : source;
    for (const entry of [...pool].reverse()) {
      const detail = toReadableProcessDetailLine(entry.raw);
      if (!detail || seen.has(detail)) continue;
      seen.add(detail);
      details.push(detail);
      if (details.length >= limit) break;
    }
    return details;
  }

  function buildPendingThinkingUpdates(fullOutputText) {
    const previewLineLimit = 19;
    const rawLines = String(fullOutputText || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    const entries = buildProcessEntriesFromRawLines(rawLines).slice(-24);
    const command = getLatestProcessCommand(entries, 'run') || getLatestProcessCommand(entries);
    const details = buildProcessSummaryLines(entries, 'progress', command ? 3 : 4);
    const lines = [];
    if (command) lines.push(`진행 명령어: ${command}`);
    lines.push(...details);
    if (lines.length > 0) return lines.slice(0, previewLineLimit);
    return ['진행 명령어를 확인 중입니다.', '과정 상세 데이터를 수신 중입니다.', '관련 코드와 로그를 분석 중입니다.'];
  }

  function createStreamingPreviewState(maxLines = 19) {
    return {
      maxLines: Math.max(1, Number(maxLines) || 19),
      lines: [],
      lastSignature: '',
      pendingRawLine: '',
    };
  }

  function pushStreamingPreviewLine(state, line) {
    if (!state) return;
    const normalized = normalizeDetailLine(String(line || ''));
    if (!normalized) return;
    const last = state.lines[state.lines.length - 1];
    if (last === normalized) return;
    state.lines.push(normalized);
    while (state.lines.length > state.maxLines) {
      state.lines.shift();
    }
    state.lastSignature = state.lines.join('\n');
  }

  function compactPreviewText(text, maxLen = 280) {
    const compact = String(text || '').replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    if (compact.length <= maxLen) return compact;
    return `${compact.slice(0, Math.max(1, maxLen - 3))}...`;
  }

  function toProcessArgsDetailText(value, maxLen = 280) {
    if (value == null) return '';
    let text = '';
    if (typeof value === 'string') {
      text = value;
    } else {
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
    }
    const normalized = normalizeDetailLine(text);
    if (!normalized) return '';
    return compactPreviewText(normalized, maxLen);
  }

  function toItemEventStatusLabel(eventType) {
    const type = String(eventType || '').toLowerCase();
    if (type.endsWith('.started')) return '시작';
    if (type.endsWith('.completed')) return '완료';
    if (type.endsWith('.updated')) return '업데이트';
    if (type.endsWith('.delta')) return '스트리밍';
    return '';
  }

  function toStreamingActionLabel(itemType) {
    const type = String(itemType || '').toLowerCase();
    if (type === 'command_execution') return '명령 실행';
    if (type === 'file_change') return '파일 변경';
    if (type === 'function_call' || type === 'tool_call' || type === 'custom_tool_call') return '도구 호출';
    if (type === 'function_call_output' || type === 'tool_result' || type === 'custom_tool_call_output') return '도구 결과';
    return '작업 단계';
  }

  function toStreamingDetailTail(parts, maxLen = 280) {
    const merged = (Array.isArray(parts) ? parts : [])
      .map(part => normalizeDetailLine(String(part || '')))
      .filter(Boolean)
      .join(' | ');
    if (!merged) return '';
    return compactPreviewText(merged, maxLen);
  }

  function toProcessJsonDetailLine(obj, maxLen = 300) {
    if (!obj || typeof obj !== 'object') return '';
    const type = String(obj.type || '').toLowerCase();

    if (type === 'thread.started') {
      const threadId = String(obj.thread_id || '').trim();
      return threadId ? `세션 시작: ${threadId}` : '세션 시작';
    }
    if (type === 'turn.started') return '응답 생성 시작';
    if (type === 'turn.completed') {
      const usage = obj.usage || obj.payload?.usage || {};
      const total = Number(usage.total_tokens)
        || (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
      return Number.isFinite(total) && total > 0
        ? `응답 완료 (tokens ${formatTokenNumber(total)})`
        : '응답 완료';
    }
    if (type === 'turn.failed') {
      const message = String(obj?.error?.message || obj?.message || '').trim();
      return message ? `실패: ${compactPreviewText(message, maxLen)}` : '실패';
    }
    if (type === 'error') {
      const message = String(obj?.message || obj?.error?.message || '').trim();
      return message ? `오류: ${compactPreviewText(message, maxLen)}` : '오류';
    }

    if (type === 'event_msg') {
      const payload = obj.payload || {};
      const eventType = String(payload.type || '').toLowerCase();
      if (eventType === 'agent_message') {
        const phase = String(payload.phase || '').trim();
        const text = String(payload.message || payload.text || '').trim();
        if (text) {
          const phaseLabel = phase ? ` (${phase})` : '';
          return `응답 업데이트${phaseLabel}: ${compactPreviewText(text, maxLen)}`;
        }
        return '응답 생성 중...';
      }
      if (eventType === 'agent_reasoning') {
        const text = String(payload.text || payload.message || '').trim();
        return text ? `추론 업데이트: ${compactPreviewText(text, maxLen)}` : '추론 업데이트 수신';
      }
      if (eventType === 'token_count') {
        const primaryUsed = Number(payload?.rate_limits?.primary?.used_percent);
        const secondaryUsed = Number(payload?.rate_limits?.secondary?.used_percent);
        if (Number.isFinite(primaryUsed) || Number.isFinite(secondaryUsed)) {
          const pRemain = Number.isFinite(primaryUsed) ? `${Math.max(0, 100 - primaryUsed)}%` : '--';
          const sRemain = Number.isFinite(secondaryUsed) ? `${Math.max(0, 100 - secondaryUsed)}%` : '--';
          return `limit remaining: 5h ${pRemain}, weekly ${sRemain}`;
        }
      }
      if (eventType) return `이벤트: ${eventType}`;
    }

    if (type === 'response_item') {
      const payload = obj.payload || {};
      const itemType = String(payload.type || '').toLowerCase();
      if (itemType === 'function_call' || itemType === 'custom_tool_call') {
        const name = String(payload.name || 'tool').trim();
        const args = toProcessArgsDetailText(
          payload.arguments ?? payload.input ?? payload.command ?? '',
          Math.max(120, maxLen - 70)
        );
        const tail = toStreamingDetailTail([
          name ? `도구=${name}` : '',
          args ? `인자=${args}` : '',
        ], maxLen);
        return tail ? `도구 호출: ${tail}` : `도구 호출: ${name || 'tool'}`;
      }
      if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
        const outputText = typeof payload.output === 'string'
          ? payload.output
          : extractMessageTextFromJsonContent(payload.output);
        const firstLine = String(outputText || '')
          .split(/\r?\n/)
          .map(line => line.trim())
          .find(Boolean) || '';
        const name = String(payload.name || payload.tool_name || '').trim();
        const tail = toStreamingDetailTail([
          name ? `도구=${name}` : '',
          firstLine ? `요약=${firstLine}` : '',
        ], maxLen);
        return tail ? `도구 결과: ${tail}` : '도구 결과 수신';
      }
      if (itemType === 'message') {
        const messageText = extractMessageTextFromJsonContent(payload.content);
        if (messageText) return `응답 본문: ${compactPreviewText(messageText, maxLen)}`;
      }
      if (itemType === 'reasoning') {
        const summary = Array.isArray(payload.summary)
          ? payload.summary.map(item => item?.text || item?.summary_text || '').filter(Boolean).join(' ')
          : '';
        if (summary) return `추론 요약: ${compactPreviewText(summary, maxLen)}`;
      }
    }

    if (type === 'item.completed' || type === 'item.started' || type === 'item.delta' || type === 'item.updated') {
      const item = obj.item || obj.payload?.item || obj.payload || {};
      const itemType = String(item.type || obj.item_type || '').toLowerCase();
      const itemName = String(item.name || item.tool_name || item.command_name || '').trim();
      const itemText = extractItemText(item) || String(obj.delta?.text || obj.text || '').trim();
      const statusLabel = toItemEventStatusLabel(type);
      const statusSuffix = statusLabel ? ` (${statusLabel})` : '';

      if (itemType === 'agent_message' || itemType === 'assistant_message' || itemType === 'message') {
        return itemText ? `응답 업데이트${statusSuffix}: ${compactPreviewText(itemText, maxLen)}` : `응답 업데이트${statusSuffix}`;
      }
      if (itemType === 'reasoning' || itemType === 'analysis') {
        return itemText ? `추론 단계${statusSuffix}: ${compactPreviewText(itemText, maxLen)}` : `추론 단계${statusSuffix}`;
      }
      if (itemType === 'function_call' || itemType === 'tool_call' || itemType === 'command_execution' || itemType === 'file_change') {
        if (itemType === 'file_change') {
          const changeSummary = summarizeFileChangeItem(item, 6, maxLen);
          if (changeSummary) return `${toStreamingActionLabel(itemType)}${statusSuffix}: ${changeSummary}`;
        }
        const args = toProcessArgsDetailText(
          item.arguments ?? item.input ?? item.command ?? '',
          Math.max(120, maxLen - 110)
        );
        const label = toStreamingActionLabel(itemType);
        const hint = extractLineHint(itemText);
        const tail = toStreamingDetailTail([
          itemName ? `대상=${itemName}` : '',
          args ? `인자=${args}` : '',
          hint ? hint.replace(/^대상:\s*/, '파일=') : '',
          itemText ? `요약=${itemText}` : '',
        ], maxLen);
        return tail ? `${label}${statusSuffix}: ${tail}` : `${label}${statusSuffix}`;
      }
      if (itemType) return `아이템: ${itemType}`;
    }

    return type ? `이벤트: ${type}` : '';
  }

  function toStreamingPreviewLine(rawLine) {
    const raw = stripNoisyExecutionFragments(String(rawLine || '')).trim();
    if (!raw) return '';
    if (isNoisyExecutionLogLine(raw) || isPromptMetaLine(raw)) return '';

    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const obj = JSON.parse(raw);
        const detail = toProcessJsonDetailLine(obj, 320);
        if (detail) return detail;
      } catch {
        // JSON 미완성 라인은 일반 텍스트 경로로 처리
      }
    }

    const cmd = extractCommandFromRawLine(raw);
    if (cmd) return `실행: ${compactPreviewText(cmd, 320)}`;

    const detail = toReadableProcessDetailLine(raw);
    if (detail) return compactPreviewText(detail, 320);

    return compactPreviewText(raw, 320);
  }

  function collectStreamingRawCandidates(fullOutputText, limit = 24) {
    const text = String(fullOutputText || '');
    if (!text) return [];
    const tailText = text.length > 60000 ? text.slice(-60000) : text;
    const rawLines = tailText.split(/\r?\n/);
    const candidates = [];

    for (const line of rawLines) {
      const preview = toStreamingPreviewLine(line);
      if (!preview) continue;
      const last = candidates[candidates.length - 1];
      if (last === preview) continue;
      candidates.push(preview);
    }
    return candidates.slice(-Math.max(6, limit));
  }

  function updateStreamingPreviewFromChunk(state, chunkText) {
    const st = state || createStreamingPreviewState(19);
    const chunk = String(chunkText || '');
    if (!chunk) return st.lines.slice();

    const merged = `${st.pendingRawLine || ''}${chunk}`;
    const normalized = merged.replace(/\r\n/g, '\n');
    const parts = normalized.split('\n');
    st.pendingRawLine = parts.pop() || '';

    for (const part of parts) {
      const preview = toStreamingPreviewLine(part);
      if (preview) pushStreamingPreviewLine(st, preview);
    }

    // 줄바꿈 없이 길게 오는 경우에도 진행 상태가 비지 않도록 마지막 파편을 보조 표시
    if (st.lines.length === 0 && st.pendingRawLine) {
      const preview = toStreamingPreviewLine(st.pendingRawLine);
      if (preview) pushStreamingPreviewLine(st, preview);
    }

    return st.lines.slice();
  }

  function buildStreamingPreviewCandidates(fullOutputText, limit = 8, parsedSections) {
    const sectionProcessLines = String(parsedSections?.thinking?.content || '')
      .split(/\r?\n/)
      .map(line => normalizeDetailLine(line))
      .filter(Boolean);

    const rawCandidates = collectStreamingRawCandidates(fullOutputText, Math.max(8, limit));
    if (sectionProcessLines.length > 0 || rawCandidates.length > 0) {
      return [...sectionProcessLines, ...rawCandidates].slice(-Math.max(4, limit));
    }

    const text = String(fullOutputText || '');
    const rawLines = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const entries = buildProcessEntriesFromRawLines(rawLines).slice(-180);
    if (entries.length === 0) {
      return buildPendingThinkingUpdates(text).slice(0, Math.max(4, limit));
    }

    const candidates = [];
    const command = getLatestProcessCommand(entries, 'run') || getLatestProcessCommand(entries);
    if (command) candidates.push(`진행 명령어: ${command}`);

    const tail = entries.slice(-Math.max(limit, 8));
    for (const entry of tail) {
      const readable = toReadableWorkLine(entry, entry.kind);
      if (readable) candidates.push(readable);
    }

    if (candidates.length === 0) {
      candidates.push(...buildPendingThinkingUpdates(text));
    }
    return candidates.slice(-Math.max(4, limit));
  }

  function updateStreamingPreviewLines(state, fullOutputText, parsedSections) {
    const st = state || createStreamingPreviewState(19);
    const candidates = buildStreamingPreviewCandidates(fullOutputText, st.maxLines * 2, parsedSections)
      .map(line => normalizeDetailLine(String(line || '')))
      .filter(Boolean)
      .slice(-st.maxLines);

    if (candidates.length === 0) {
      const fallbacks = buildPendingThinkingUpdates(fullOutputText)
        .slice(0, st.maxLines)
        .map(line => normalizeDetailLine(line))
        .filter(Boolean);
      const fallbackSig = fallbacks.join('\n');
      if (fallbackSig !== st.lastSignature) {
        st.lines = fallbacks;
        st.lastSignature = fallbackSig;
      }
      return st.lines.slice();
    }

    const signature = candidates.join('\n');
    if (signature !== st.lastSignature) {
      st.lines = candidates;
      st.lastSignature = signature;
    }

    return st.lines.slice();
  }

  function renderThinkingLogLines(logEl, lines) {
    if (!logEl) return;
    const maxLines = 19;
    const safeLines = Array.isArray(lines)
      ? lines.map(line => normalizeDetailLine(String(line || ''))).filter(Boolean).slice(0, maxLines)
      : [];
    while (safeLines.length < maxLines) safeLines.push('');
    logEl.innerHTML = safeLines.map((line) => (
      line
        ? `<div class="log-line">${escapeHtml(line)}</div>`
      : '<div class="log-line is-placeholder">&nbsp;</div>'
    )).join('');
  }

  function formatAnswerLineBreaks(text) {
    const source = String(text || '').replace(/\r\n/g, '\n');
    if (!source.trim()) return '';

    const lines = source.split('\n');
    const out = [];
    let inFence = false;

    for (const raw of lines) {
      const line = String(raw || '');
      const trimmed = line.trim();

      if (/^```/.test(trimmed)) {
        inFence = !inFence;
        out.push(line);
        continue;
      }

      if (inFence || !trimmed || isLikelyMarkdownStructureLine(trimmed)) {
        out.push(line);
        continue;
      }

      let formatted = line.trim();
      const numberedCount = (formatted.match(/\b\d{1,2}[.)]\s+/g) || []).length;
      if (numberedCount >= 2) {
        // "1) ... 2) ..." 또는 "1. ... 2. ..." 패턴을 줄단위로 분리
        formatted = formatted.replace(/\s+(?=\d{1,2}[.)]\s+)/g, '\n');
      }

      const sentenceTokenCount = (formatted.match(/[.!?。](?=\s+)/g) || []).length;
      if (!/https?:\/\//i.test(formatted) && (sentenceTokenCount >= 2 || formatted.length >= 90)) {
        formatted = formatted
          .replace(/([.!?。])\s+(?=[^\s])/g, '$1\n')
          .replace(/(다\.|요\.|죠\.|니다\.)\s+(?=[^\s])/g, '$1\n');
      }

      if (!/https?:\/\//i.test(formatted)) {
        const semicolonCount = (formatted.match(/;\s+/g) || []).length;
        if (semicolonCount >= 2 || formatted.length >= 120) {
          formatted = formatted.replace(/;\s+(?=[^\s])/g, ';\n');
        }
      }

      const segments = formatted.split('\n');
      for (const segment of segments) {
        const seg = String(segment || '').trim();
        if (!seg) {
          out.push('');
          continue;
        }

        out.push(seg);
      }
    }

    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function renderStreamingResponseWithProgress(responseText, progressLines, visibleLines = STREAM_INLINE_PROGRESS_VISIBLE_LINES) {
    const safeVisibleLines = Math.max(1, Number(visibleLines) || STREAM_INLINE_PROGRESS_VISIBLE_LINES);
    const rows = (Array.isArray(progressLines) ? progressLines : [])
      .map(line => normalizeDetailLine(String(line || '')))
      .filter(Boolean);
    while (rows.length < safeVisibleLines) rows.unshift('');

    const progressHtml = `<div class="stream-inline-progress">
      <div class="stream-inline-progress-title">현재 진행</div>
      <div class="stream-inline-progress-lines" style="--stream-inline-visible-lines:${safeVisibleLines};">
        ${rows.map(line => (
          line
            ? `<div class="stream-inline-line">${escapeHtml(line)}</div>`
            : '<div class="stream-inline-line is-placeholder">&nbsp;</div>'
        )).join('')}
      </div>
    </div>`;

    const answer = formatAnswerLineBreaks(String(responseText || '').trim());
    const answerHtml = answer
      ? renderMarkdown(answer)
      : '<div class="streaming-answer-placeholder">응답 생성 중...</div>';

    return `${progressHtml}<div class="streaming-answer-body">${answerHtml}</div>`;
  }

  function captureInlineProgressScrollState(containerEl) {
    const linesEl = containerEl?.querySelector('.stream-inline-progress-lines');
    if (!linesEl) return null;
    const maxTop = Math.max(0, linesEl.scrollHeight - linesEl.clientHeight);
    return {
      scrollTop: linesEl.scrollTop,
      nearBottom: (maxTop - linesEl.scrollTop) <= 4,
    };
  }

  function restoreInlineProgressScrollState(containerEl, scrollState) {
    if (!scrollState) return;
    const linesEl = containerEl?.querySelector('.stream-inline-progress-lines');
    if (!linesEl) return;
    const maxTop = Math.max(0, linesEl.scrollHeight - linesEl.clientHeight);
    linesEl.scrollTop = scrollState.nearBottom
      ? maxTop
      : Math.min(maxTop, Math.max(0, scrollState.scrollTop));
  }

  function renderStreamingResponsePreview(containerEl, responseText, progressLines, visibleLines = STREAM_INLINE_PROGRESS_VISIBLE_LINES) {
    if (!containerEl) return;
    const scrollState = captureInlineProgressScrollState(containerEl);
    containerEl.innerHTML = renderStreamingResponseWithProgress(responseText, progressLines, visibleLines);
    restoreInlineProgressScrollState(containerEl, scrollState);
  }

  function normalizeDetailLine(line) {
    if (!line) return '';
    return line
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200);
  }

  function extractCodeChangeDetailsFromResponse(responseText) {
    if (!responseText) return [];
    const lines = responseText.split(/\r?\n/);
    const details = [];
    let inCodeSection = false;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (/^(#+\s*)?(코드\s*변경\s*내용|code\s*changes?)\b/i.test(line) || /^\*\*(코드\s*변경\s*내용|code\s*changes?)\*\*/i.test(line)) {
        inCodeSection = true;
        continue;
      }

      if (inCodeSection && (/^(#+\s*)?(기타\s*변경\s*사항|other\s*changes?)\b/i.test(line) || /^\*\*(기타\s*변경\s*사항|other\s*changes?)\*\*/i.test(line))) {
        break;
      }

      if (!inCodeSection) continue;

      const bullet = line.match(/^[-*]\s+(.+)/) || line.match(/^\d+\.\s+(.+)/);
      if (bullet) {
        const normalized = normalizeDetailLine(bullet[1]);
        if (normalized) details.push(normalized);
      }
    }

    return details;
  }

  function extractCodeChangeDetailsFromThinking(thinkingText) {
    if (!thinkingText) return [];
    const details = [];
    const lines = thinkingText.split(/\r?\n/);

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      const fileOp = line.match(/^(?:\*\*\*\s*)?(Update|Add|Delete)\s+File:\s+(.+)$/i);
      if (fileOp) {
        const opMap = { update: '수정 파일', add: '추가 파일', delete: '삭제 파일' };
        const op = opMap[fileOp[1].toLowerCase()] || '변경 파일';
        const path = normalizeDetailLine(fileOp[2]);
        details.push(`${op}: ${path}`);
        continue;
      }

      if (/apply_patch|update file|add file|delete file|코드\s*수정|변경\s*적용/i.test(line)) {
        const normalized = normalizeDetailLine(line);
        if (normalized) details.push(normalized);
      }
    }

    return details;
  }

  function extractCodeChangeDetailsFromRaw(rawText) {
    if (!rawText) return [];
    const details = [];
    const lines = String(rawText).split(/\r?\n/);

    for (const raw of lines) {
      if (!raw) continue;
      let line = String(raw).trim();
      if (!line) continue;

      // JSON 문자열 내부에 포함된 패치 라인을 잡기 위해 이스케이프를 일부 복원
      line = line
        .replace(/\\"/g, '"')
        .replace(/\\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const fileOp = line.match(/\*{3}\s*(Update|Add|Delete)\s+File:\s+([^"]+?)(?=\s*\*{3}|$)/i)
        || line.match(/(?:^|\s)(Update|Add|Delete)\s+File:\s+(.+?)(?:\s*$)/i);
      if (fileOp) {
        const opMap = { update: '수정 파일', add: '추가 파일', delete: '삭제 파일' };
        const op = opMap[fileOp[1].toLowerCase()] || '변경 파일';
        const filePath = normalizeDetailLine(fileOp[2]);
        if (filePath) details.push(`${op}: ${filePath}`);
      }

      const moveOp = line.match(/\*{3}\s*Move to:\s+([^"]+?)(?=\s*\*{3}|$)/i)
        || line.match(/(?:^|\s)Move to:\s+(.+?)(?:\s*$)/i);
      if (moveOp) {
        const moved = normalizeDetailLine(moveOp[1]);
        if (moved) details.push(`파일 이동: ${moved}`);
      }

      if (/\bapply_patch\b/i.test(line)) {
        details.push('패치 적용 실행');
      }

      const mdLink = line.match(/\[([^\]]+)\]\(([^)\n]+)\)/);
      if (mdLink && /[:\\/].+\.\w+/.test(mdLink[2])) {
        const linkPath = normalizeDetailLine(mdLink[2]);
        if (linkPath) details.push(`관련 파일: ${linkPath}`);
      }
    }

    return details;
  }

  function getCodeChangeDetails(sections, rawText = '') {
    const fromResponse = extractCodeChangeDetailsFromResponse(sections.response.content || '');
    const fromThinking = extractCodeChangeDetailsFromThinking(sections.thinking.content || '');
    const fromRaw = extractCodeChangeDetailsFromRaw(rawText);
    const merged = [...fromResponse, ...fromThinking, ...fromRaw].map(normalizeDetailLine).filter(Boolean);
    const deduped = [];
    const seen = new Set();
    for (const d of merged) {
      // 단독 구두점/기호 라인은 코드 탭 잡음으로 제거
      if (!/[A-Za-z0-9가-힣]/.test(d) && !/[:\\/]/.test(d)) continue;
      if (seen.has(d)) continue;
      seen.add(d);
      deduped.push(d);
    }
    return deduped;
  }

  function collectJsonTextPayloads(rawText) {
    const texts = [];
    const lines = String(rawText || '').split(/\r?\n/);
    for (const raw of lines) {
      const trimmed = String(raw || '').trim();
      if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
      try {
        const obj = JSON.parse(trimmed);
        const type = String(obj.type || '').toLowerCase();
        if (type === 'item.completed' || type === 'item.started' || type === 'item.updated' || type === 'item.delta') {
          const item = obj.item || obj.payload?.item || obj.payload || {};
          const itemText = extractItemText(item) || String(obj.delta?.text || obj.text || '').trim();
          if (itemText) texts.push(itemText);
          continue;
        }
        if (type === 'event_msg') {
          const payload = obj.payload || {};
          const msgText = String(payload.message || payload.text || '').trim();
          if (msgText) texts.push(msgText);
          continue;
        }
      } catch {
        // ignore malformed json line
      }
    }
    return texts;
  }

  function hasPatchSignalInText(text) {
    return /(\*{3}\s*(Begin Patch|End Patch|Update File:|Add File:|Delete File:|Move to:|End of File)|^@@|^diff --git|^---\s|^\+\+\+\s)/im
      .test(String(text || ''));
  }

  function normalizePatchCandidateText(text) {
    let value = String(text || '');
    if (!value) return '';
    if (/\\n/.test(value) && /(Begin Patch|Update File:|Add File:|Delete File:|Move to:|diff --git|@@)/i.test(value)) {
      value = value.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
    }
    return value.replace(/\\"/g, '"');
  }

  function collectPatchStringsFromJsonNode(node, pushFn, depth = 0) {
    if (depth > 8 || node == null) return;
    if (typeof node === 'string') {
      pushFn(node);
      const trimmed = node.trim();
      if (
        trimmed.length > 2
        && trimmed.length < 200000
        && ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))
      ) {
        try {
          const parsed = JSON.parse(trimmed);
          collectPatchStringsFromJsonNode(parsed, pushFn, depth + 1);
        } catch {
          // ignore nested json parse failures
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) collectPatchStringsFromJsonNode(item, pushFn, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    for (const value of Object.values(node)) {
      collectPatchStringsFromJsonNode(value, pushFn, depth + 1);
    }
  }

  function collectPatchCandidatesFromRaw(rawText) {
    const source = String(rawText || '');
    if (!source) return [];

    const clipped = source.length > 220000 ? source.slice(-220000) : source;
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (value) => {
      const normalized = normalizePatchCandidateText(value);
      if (!normalized || !hasPatchSignalInText(normalized)) return;
      const key = normalizeDetailLine(normalized).slice(0, 520);
      if (!key || seen.has(key)) return;
      seen.add(key);
      candidates.push(normalized);
    };

    pushCandidate(clipped);
    for (const rawLine of clipped.split(/\r?\n/)) {
      const line = String(rawLine || '').trim();
      if (!line || !line.startsWith('{') || !line.endsWith('}')) continue;
      try {
        const obj = JSON.parse(line);
        collectPatchStringsFromJsonNode(obj, pushCandidate);
      } catch {
        // ignore malformed json
      }
      if (candidates.length >= 18) break;
    }

    return candidates;
  }

  function extractPatchBlocksFromText(text, maxBlocks = 6) {
    const source = normalizePatchCandidateText(text);
    if (!source) return [];

    const lines = source.split(/\r?\n/);
    const blocks = [];
    const seen = new Set();
    const pushBlock = (blockLines) => {
      const body = String((blockLines || []).join('\n') || '')
        .replace(/\r/g, '')
        .replace(/^```[a-zA-Z0-9_-]*\s*$/gm, '')
        .trim();
      if (!body) return;
      const key = normalizeDetailLine(body).slice(0, 540);
      if (!key || seen.has(key)) return;
      seen.add(key);
      blocks.push(body.length > 12000 ? `${body.slice(0, 12000)}\n...` : body);
    };

    const shouldKeepDiffLine = (rawLine) => {
      const t = String(rawLine || '').trim();
      if (!t) return false;
      if (isLikelyDiffMetaLine(rawLine) || isLikelyDiffChangeLine(rawLine)) return true;
      if (/^\*{3}\s*(Update|Add|Delete|Move(?:\s+to)?|End of File)\b/i.test(t)) return true;
      return false;
    };

    // 문자열 중간에 포함된 Begin/End Patch 블록도 우선 추출
    const patchRangeRe = /\*{3}\s*Begin Patch[\s\S]*?\*{3}\s*End Patch/gi;
    for (const m of source.matchAll(patchRangeRe)) {
      const block = String(m[0] || '').trim();
      if (!block) continue;
      pushBlock(block.split(/\r?\n/));
      if (blocks.length >= maxBlocks) return blocks;
    }

    for (let i = 0; i < lines.length && blocks.length < maxBlocks; i++) {
      const line = String(lines[i] || '');
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!/^\*{3}\s*Begin Patch\b/i.test(trimmed)) continue;

      const block = [line];
      for (let j = i + 1; j < lines.length; j++) {
        const next = String(lines[j] || '');
        block.push(next);
        if (/^\*{3}\s*End Patch\b/i.test(next.trim())) {
          i = j;
          break;
        }
        if (block.length > 1400) {
          i = j;
          break;
        }
      }
      pushBlock(block);
    }

    for (let i = 0; i < lines.length && blocks.length < maxBlocks; i++) {
      const line = String(lines[i] || '');
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!(
        /^\*{3}\s*(Update|Add|Delete|Move(?:\s+to)?)\s+File:/i.test(trimmed)
        || /^diff --git\b/i.test(trimmed)
        || /^@@/.test(trimmed)
      )) continue;

      const block = [line];
      let consumed = i;
      for (let j = i + 1; j < lines.length; j++) {
        const next = String(lines[j] || '');
        const nextTrim = next.trim();
        if (!nextTrim) {
          const lookahead = findNextNonEmptyLine(lines, j + 1);
          if (lookahead && shouldKeepDiffLine(lookahead)) {
            block.push(next);
            consumed = j;
            continue;
          }
          break;
        }
        if (!shouldKeepDiffLine(next)) break;
        block.push(next);
        consumed = j;
        if (block.length > 1400) break;
      }

      const hasMeaningfulChange = block.some(entry => /^[+-]/.test(String(entry || '')) || /^@@/.test(String(entry || '').trim()));
      if (hasMeaningfulChange) {
        pushBlock(block);
      }
      i = consumed;
    }

    return blocks.slice(0, Math.max(1, maxBlocks));
  }

  function extractPatchBlocksFromRaw(rawText, maxBlocks = 6) {
    const blocks = [];
    const seen = new Set();
    const candidates = collectPatchCandidatesFromRaw(rawText);
    for (const candidate of candidates) {
      const parsed = extractPatchBlocksFromText(candidate, maxBlocks);
      for (const block of parsed) {
        const key = normalizeDetailLine(block).slice(0, 540);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        blocks.push(block);
        if (blocks.length >= maxBlocks) return blocks;
      }
    }
    return blocks;
  }

  function summarizePatchFilesFromBlocks(patchBlocks) {
    const fileMap = new Map();
    const opMap = {
      update: '수정 파일',
      add: '추가 파일',
      delete: '삭제 파일',
      move: '파일 이동',
      move_to: '파일 이동',
    };

    const ensureFile = (filePath, op) => {
      const file = normalizeDetailLine(String(filePath || '').replace(/^['"]|['"]$/g, ''));
      if (!file) return null;
      const key = file.toLowerCase();
      if (!fileMap.has(key)) {
        fileMap.set(key, { file, ops: new Set(), added: 0, deleted: 0 });
      }
      const item = fileMap.get(key);
      if (op) item.ops.add(op);
      return item;
    };

    for (const block of Array.isArray(patchBlocks) ? patchBlocks : []) {
      let current = null;
      const lines = String(block || '').split(/\r?\n/);
      for (const rawLine of lines) {
        const line = String(rawLine || '');
        const t = line.trim();
        if (!t) continue;

        let matched = t.match(/^\*{3}\s*(Update|Add|Delete)\s+File:\s+(.+)$/i);
        if (matched) {
          const op = opMap[String(matched[1] || '').toLowerCase()] || '변경 파일';
          current = ensureFile(matched[2], op);
          continue;
        }
        matched = t.match(/^\*{3}\s*Move to:\s+(.+)$/i);
        if (matched) {
          current = ensureFile(matched[1], '파일 이동');
          continue;
        }
        matched = t.match(/^---\s*(Update|Add|Delete|Move(?:\s+to)?)\s*:\s*(.+)$/i);
        if (matched) {
          const rawOp = String(matched[1] || '').toLowerCase().replace(/\s+/g, '_');
          const op = opMap[rawOp] || '변경 파일';
          current = ensureFile(matched[2], op);
          continue;
        }
        matched = t.match(/^diff --git\s+a\/(.+)\s+b\/(.+)$/i);
        if (matched) {
          current = ensureFile(matched[2], '변경 파일');
          continue;
        }
        matched = t.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
        if (matched && !/^\+\+\+\s+\/dev\/null$/i.test(t)) {
          current = ensureFile(matched[1], current ? [...current.ops][0] : '변경 파일');
          continue;
        }
        if (!current) continue;

        if (line.startsWith('+') && !line.startsWith('+++')) {
          current.added += 1;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          current.deleted += 1;
        }
      }
    }

    return [...fileMap.values()];
  }

  function toCodeSnippetsForCodeTab(sections, rawText = '') {
    const snippets = [];
    const seen = new Set();
    const pushSnippet = (lang, code) => {
      const body = String(code || '').replace(/\r\n/g, '\n').trim();
      if (!body) return;
      const safeBody = body.length > 8000 ? `${body.slice(0, 8000)}\n...` : body;
      const snippetLang = String(lang || '').trim().toLowerCase();
      const key = `${snippetLang}|${safeBody.slice(0, 700)}`;
      if (seen.has(key)) return;
      seen.add(key);
      snippets.push({ lang: snippetLang, code: safeBody });
    };

    const patchBlocks = extractPatchBlocksFromRaw(rawText, 4);
    for (const patch of patchBlocks) {
      pushSnippet('', patch);
      if (snippets.length >= 8) return snippets;
    }

    const sources = [
      String(sections?.response?.raw || ''),
      String(sections?.thinking?.content || ''),
      ...collectJsonTextPayloads(rawText),
    ].filter(Boolean);

    for (const source of sources) {
      const extracted = extractPatchBlocksFromText(source, 2);
      for (const patch of extracted) {
        pushSnippet('', patch);
        if (snippets.length >= 8) return snippets;
      }
    }

    for (const source of sources) {
      const text = String(source || '');
      const fenceRe = /```([a-zA-Z0-9_+#.-]*)\n([\s\S]*?)```/g;
      for (const m of text.matchAll(fenceRe)) {
        pushSnippet(m[1] || '', m[2] || '');
        if (snippets.length >= 8) return snippets;
      }
    }

    if (snippets.length > 0) return snippets;

    const combined = sources.join('\n');
    const lines = combined.split(/\r?\n/);
    let buffer = [];

    const flushDiff = () => {
      if (buffer.length === 0) return;
      pushSnippet('', buffer.join('\n'));
      buffer = [];
    };

    const isDiffLikeLine = (line) => {
      const raw = String(line || '');
      const t = raw.trim();
      if (!t) return false;
      if (/^\*{3}\s*(Begin Patch|End Patch|Update File:|Add File:|Delete File:|Move to:|End of File)/i.test(t)) return true;
      if (/^@@/.test(t)) return true;
      if (/^(diff --git|index\s+\S+|---\s|\+\+\+\s)/i.test(t)) return true;
      if (/^[+\-].+/.test(raw)) return true;
      return false;
    };

    for (const line of lines) {
      const raw = String(line || '').replace(/\\"/g, '"');
      if (isDiffLikeLine(raw)) {
        buffer.push(raw);
        continue;
      }
      if (buffer.length > 0) {
        if (/^\s/.test(raw) && raw.trim()) {
          buffer.push(raw);
          continue;
        }
        flushDiff();
        if (snippets.length >= 8) return snippets;
      }
    }
    flushDiff();
    return snippets;
  }

  function toSafeCodeFenceMarkdown(code, lang = '') {
    const body = String(code || '');
    const fence = body.includes('```') ? '````' : '```';
    const header = lang ? `${fence}${lang}` : fence;
    return `${header}\n${body}\n${fence}`;
  }

  function escapeMarkdownText(text) {
    return String(text || '')
      .replace(/\\/g, '\\\\')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/`/g, '\\`');
  }

  function decodeUriComponentSafe(value) {
    const raw = String(value || '');
    if (!raw) return '';
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  function normalizeCodeFilePathForGrouping(filePath) {
    let value = normalizePatchFilePath(filePath);
    if (!value) return '';

    value = decodeUriComponentSafe(value)
      .replace(/^file:\/\/\/?/i, '')
      .replace(/^\/([A-Za-z]:\/)/, '$1')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .trim();

    const hashLine = /#L(\d+)(?::\d+)?$/i.exec(value);
    if (hashLine) {
      value = value.slice(0, hashLine.index);
    } else {
      const pathLine = /^(.*\.[A-Za-z0-9_+\-]+):(\d+)(?::\d+)?\)?$/.exec(value);
      if (pathLine) {
        value = pathLine[1];
      }
    }

    const cwd = decodeUriComponentSafe(String(currentCwd || '').trim())
      .replace(/\\/g, '/')
      .replace(/^\/([A-Za-z]:\/)/, '$1')
      .replace(/\/+$/, '');
    if (cwd) {
      const lowerValue = value.toLowerCase();
      const lowerCwd = cwd.toLowerCase();
      if (lowerValue === lowerCwd) return '.';
      if (lowerValue.startsWith(`${lowerCwd}/`)) {
        value = value.slice(cwd.length + 1);
      }
    }

    return value.replace(/^\.\/+/, '').replace(/\/+$/, '').trim();
  }

  function toCodeFileGroupKey(filePath) {
    const normalized = normalizeCodeFilePathForGrouping(filePath);
    return normalized ? normalized.toLowerCase() : '';
  }

  function choosePreferredCodeFilePath(currentPath, nextPath) {
    const a = normalizeCodeFilePathForGrouping(currentPath);
    const b = normalizeCodeFilePathForGrouping(nextPath);
    if (!a) return b || '';
    if (!b) return a;

    const aAbs = /^(?:[A-Za-z]:\/|\/[A-Za-z]:\/)/.test(a);
    const bAbs = /^(?:[A-Za-z]:\/|\/[A-Za-z]:\/)/.test(b);
    if (aAbs !== bAbs) return aAbs ? b : a;
    if (a.length !== b.length) return a.length <= b.length ? a : b;
    return a;
  }

  function toCodeFileMarkdownLink(filePath) {
    const raw = normalizeDetailLine(String(filePath || ''))
      .replace(/^['"]|['"]$/g, '')
      .trim();
    if (!raw) return '';

    let pathPart = raw;
    let linePart = '';

    const hashLine = /#L(\d+)(?::\d+)?$/i.exec(pathPart);
    if (hashLine) {
      linePart = hashLine[1];
      pathPart = pathPart.slice(0, hashLine.index);
    } else {
      const pathLine = /^(.*\.[A-Za-z0-9_+\-]+):(\d+)(?::\d+)?\)?$/.exec(pathPart);
      if (pathLine) {
        pathPart = pathLine[1];
        linePart = pathLine[2];
      }
    }

    const toLocalLinkPath = (value) => {
      const input = decodeUriComponentSafe(String(value || '').trim());
      if (!input) return '';
      if (
        /^\/?[A-Za-z]:[\\/]/.test(input)
        || /^\\\\[^\\\/]+[\\\/][^\\\/]+/.test(input)
        || /^\/\/[^/]+\/[^/]+/.test(input)
        || /^file:\/\/\/?/i.test(input)
        || /^\/(?:Users|home|tmp|var|opt|etc)\//.test(input)
      ) {
        return normalizeLocalFileLinkTarget(input) || input;
      }
      const rel = input
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/^\/+/, '')
        .trim();
      if (!rel) return '';
      const cwd = decodeUriComponentSafe(String(currentCwd || '').trim());
      if (!cwd) {
        return normalizeLocalFileLinkTarget(`./${rel}`) || `./${rel}`;
      }
      const normalizedCwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
      return normalizeLocalFileLinkTarget(`${normalizedCwd}/${rel}`) || `${normalizedCwd}/${rel}`;
    };

    const linkedPath = toLocalLinkPath(pathPart);
    const hrefCandidate = linePart && linkedPath ? `${linkedPath}#L${linePart}` : linkedPath;
    const href = normalizeLocalFileLinkTarget(hrefCandidate);
    if (!href) return `\`${escapeMarkdownText(raw)}\``;

    const displayBase = normalizeCodeFilePathForGrouping(pathPart)
      || decodeUriComponentSafe(pathPart).replace(/^\/([A-Za-z]:\/)/, '$1');
    const display = linePart ? `${displayBase}:${linePart}` : displayBase;
    return `[${escapeMarkdownText(display || raw)}](${href})`;
  }

  function isMeaningfulPatchBlock(blockText) {
    const text = String(blockText || '');
    if (!text.trim()) return false;
    if (!/(^\*{3}\s*Begin Patch\b|^\*{3}\s*(Update|Add|Delete)\s+File:|^diff --git\b|^@@)/mi.test(text)) {
      return false;
    }
    const changeCount = text
      .split(/\r?\n/)
      .filter(line => /^[+-]/.test(String(line || '')) && !/^(---|\+\+\+)/.test(String(line || '')))
      .length;
    return changeCount > 0;
  }

  function normalizePatchFilePath(filePath) {
    let value = normalizeDetailLine(String(filePath || '').trim());
    if (!value) return '';
    value = value.replace(/^['"`]+|['"`]+$/g, '');
    value = value.replace(/^a\//, '').replace(/^b\//, '');
    value = value.replace(/[)\],;]+$/, '');
    return value.trim();
  }

  function splitPatchBlockByFile(blockText) {
    const lines = String(blockText || '').split(/\r?\n/);
    const chunks = [];
    let currentFile = '';
    let buffer = [];

    const flush = () => {
      const body = buffer.join('\n').trim();
      if (!currentFile || !body) {
        buffer = [];
        return;
      }
      chunks.push({ file: currentFile, diff: body });
      buffer = [];
    };

    for (const rawLine of lines) {
      const line = String(rawLine || '');
      const trimmed = line.trim();

      const diffMatch = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/i.exec(trimmed);
      if (diffMatch) {
        flush();
        currentFile = normalizePatchFilePath(diffMatch[2]);
        buffer.push(line);
        continue;
      }

      const fileOp = /^\*{3}\s*(Update|Add|Delete)\s+File:\s+(.+)$/i.exec(trimmed);
      if (fileOp) {
        flush();
        currentFile = normalizePatchFilePath(fileOp[2]);
        buffer.push(line);
        continue;
      }

      if (!currentFile) {
        const plusMatch = /^\+\+\+\s+(?:b\/)?(.+)$/.exec(trimmed);
        if (plusMatch && !/^\+\+\+\s+\/dev\/null$/i.test(trimmed)) {
          currentFile = normalizePatchFilePath(plusMatch[1]);
        }
      }

      if (currentFile) {
        buffer.push(line);
      }
    }

    flush();
    return chunks;
  }

  function buildFileDiffBlocks(patchBlocks, maxFiles = 8) {
    const byFile = new Map();
    const chunkSeen = new Set();

    const hasMeaningfulDiffChange = (diffText) => String(diffText || '')
      .split(/\r?\n/)
      .some(line => /^[+-]/.test(String(line || '')) && !/^(---|\+\+\+)/.test(String(line || '')));

    for (const block of Array.isArray(patchBlocks) ? patchBlocks : []) {
      const pieces = splitPatchBlockByFile(block);
      for (const piece of pieces) {
        const file = normalizePatchFilePath(piece?.file || '');
        const diff = String(piece?.diff || '').trim();
        if (!file || !diff) continue;
        if (!hasMeaningfulDiffChange(diff)) continue;
        const fileKey = toCodeFileGroupKey(file) || file.toLowerCase();
        const displayFile = normalizeCodeFilePathForGrouping(file) || file;
        const chunkKey = `${fileKey}|${normalizeDetailLine(diff).slice(0, 520)}`;
        if (chunkSeen.has(chunkKey)) continue;
        chunkSeen.add(chunkKey);
        if (!byFile.has(fileKey)) {
          byFile.set(fileKey, { file: displayFile, chunks: [] });
        }
        const entry = byFile.get(fileKey);
        entry.file = choosePreferredCodeFilePath(entry.file, displayFile);
        entry.chunks.push(diff);
      }
    }

    const out = [];
    for (const item of byFile.values()) {
      const merged = item.chunks.join('\n');
      if (!hasMeaningfulDiffChange(merged)) continue;
      out.push({
        file: item.file,
        diff: merged.length > 20000 ? `${merged.slice(0, 20000)}\n...` : merged,
      });
      if (out.length >= Math.max(1, maxFiles)) break;
    }
    return out;
  }

  function buildCodexCodeTabMarkdown(sections, rawText = '') {
    const details = getCodeChangeDetails(sections, rawText);
    const sourcePatchText = [
      String(sections?.response?.raw || ''),
      String(sections?.thinking?.content || ''),
      ...collectJsonTextPayloads(rawText),
    ].filter(Boolean).join('\n');
    const patchBlocksRaw = extractPatchBlocksFromRaw(rawText, 4);
    const patchBlocksFromSource = extractPatchBlocksFromText(sourcePatchText, 4);
    const patchBlockSeen = new Set();
    const patchBlocks = [];
    for (const block of [...patchBlocksRaw, ...patchBlocksFromSource]) {
      const key = normalizeDetailLine(block).slice(0, 540);
      if (!key || patchBlockSeen.has(key)) continue;
      if (!isMeaningfulPatchBlock(block)) continue;
      patchBlockSeen.add(key);
      patchBlocks.push(block);
      if (patchBlocks.length >= 4) break;
    }
    const fileDiffBlocks = buildFileDiffBlocks(patchBlocks, 8);
    const patchFiles = summarizePatchFilesFromBlocks(patchBlocks);
    if ((!details || details.length === 0) && patchFiles.length === 0) {
      return '코드 변경 내용이 감지되지 않았습니다.';
    }

    const fileMap = new Map();
    const methodLines = [];

    for (const detail of details) {
      const line = normalizeDetailLine(detail);
      if (!line) continue;

      const fileOp = line.match(/^(수정 파일|추가 파일|삭제 파일|파일 이동|관련 파일)\s*:\s*(.+)$/i);
      if (fileOp) {
        const op = String(fileOp[1] || '').trim();
        const file = String(fileOp[2] || '').trim();
        const normalizedFile = normalizeCodeFilePathForGrouping(file) || normalizePatchFilePath(file) || file;
        const key = toCodeFileGroupKey(normalizedFile) || normalizedFile.toLowerCase();
        if (!fileMap.has(key)) {
          fileMap.set(key, { file: normalizedFile, ops: new Set(), added: 0, deleted: 0 });
        }
        const entry = fileMap.get(key);
        entry.file = choosePreferredCodeFilePath(entry.file, normalizedFile);
        entry.ops.add(op);
        continue;
      }

      methodLines.push(line);
    }

    for (const patchFile of patchFiles) {
      const file = String(patchFile?.file || '').trim();
      if (!file) continue;
      const normalizedFile = normalizeCodeFilePathForGrouping(file) || normalizePatchFilePath(file) || file;
      const key = toCodeFileGroupKey(normalizedFile) || normalizedFile.toLowerCase();
      if (!fileMap.has(key)) {
        fileMap.set(key, { file: normalizedFile, ops: new Set(), added: 0, deleted: 0 });
      }
      const item = fileMap.get(key);
      item.file = choosePreferredCodeFilePath(item.file, normalizedFile);
      const opList = patchFile?.ops instanceof Set
        ? [...patchFile.ops]
        : (Array.isArray(patchFile?.ops) ? patchFile.ops : []);
      for (const op of opList) {
        item.ops.add(op);
      }
      item.added += Number(patchFile.added) || 0;
      item.deleted += Number(patchFile.deleted) || 0;
    }

    const lines = [];
    lines.push('### 변경 파일');
    if (fileMap.size === 0) {
      lines.push('- 감지된 파일 경로가 없습니다.');
    } else {
      for (const { file, ops, added, deleted } of fileMap.values()) {
        const opText = [...ops].join(', ') || '변경 파일';
        const diffText = (Number(added) > 0 || Number(deleted) > 0)
          ? ` (+${Number(added) || 0} / -${Number(deleted) || 0})`
          : '';
        lines.push(`- ${escapeMarkdownText(`${opText}${diffText}`)}: ${toCodeFileMarkdownLink(file)}`);
      }
    }

    if (methodLines.length > 0) {
      lines.push('', '### 변경 방식');
      for (const line of methodLines) {
        lines.push(`- ${escapeMarkdownText(line)}`);
      }
    }

    if (fileDiffBlocks.length > 0) {
      lines.push('', '### 변경 Diff');
      fileDiffBlocks.forEach((entry) => {
        lines.push('', `#### ${toCodeFileMarkdownLink(entry.file)}`);
        lines.push(toSafeCodeFenceMarkdown(entry.diff, ''));
      });
    } else {
      lines.push('', '### 변경 Diff');
      lines.push('- Unified diff(`+`, `-`)를 찾지 못했습니다.');
    }

    return lines.join('\n');
  }

  function renderCodexCodeBrief(sections, rawText = '') {
    const markdown = buildCodexCodeTabMarkdown(sections, rawText);
    return `<div class="code-brief">${renderMarkdown(markdown, { skipPreprocess: true })}</div>`;
  }

  function getCodexProcessItems(sections, isStreaming, rawText = '') {
    const processSourceText = String(rawText || sections.thinking.content || '');
    const sampledProcessText = processSourceText.length > 180000
      ? processSourceText.slice(-180000)
      : processSourceText;
    const rawLines = sampledProcessText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    const processEntries = buildProcessEntriesFromRawLines(rawLines);

    const items = [];
    const seen = new Set();
    for (const entry of processEntries) {
      const item = toReadableProcessItem(entry.normalized);
      const key = `${item.kind}|${item.title}|${item.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }

    if (items.length === 0) {
      items.push({
        kind: 'plan',
        title: '요청 분석',
        detail: isStreaming ? '요청을 분석하고 실행 단계를 준비 중입니다.' : '중요한 추가 과정 없이 요청을 처리했습니다.',
      });
    }

    const codeChangeDetails = getCodeChangeDetails(sections, rawText);
    if (codeChangeDetails.length > 0) {
      items.push({
        kind: 'edit',
        title: '코드 변경 내용',
        detail: `${codeChangeDetails.length}개 항목을 반영했습니다.`,
        extra: codeChangeDetails,
      });
    }

    if (isStreaming) {
      const last = items[items.length - 1];
      const isProgressTail = last && (last.kind === 'progress' || last.title === '진행 상태');
      if (!isProgressTail) {
        items.push({
          kind: 'progress',
          title: '진행 상태',
          detail: '현재 단계 결과를 정리해 최종 응답으로 구성 중입니다.',
        });
      }
    }

    for (const item of items) {
      if (Array.isArray(item.extra) && item.extra.length > 0) continue;
      const command = getLatestProcessCommand(processEntries, item.kind) || getLatestProcessCommand(processEntries);
      if (command) item.command = command;
      item.extra = buildProcessSummaryLines(processEntries, item.kind);
    }

    return items;
  }

  function renderCodexProcessBrief(sections, isStreaming, rawText = '') {
    const items = getCodexProcessItems(sections, isStreaming, rawText);
    const title = isStreaming ? '과정 스택 (실시간)' : '과정 스택';
    return `<div class="process-brief">
      <div class="process-title-row">
        <div class="process-title">${title}</div>
        <div class="process-count">${items.length} 단계</div>
      </div>
      <div class="process-stack">
        ${items.map((item, idx) => `
          <details class="process-item process-${item.kind}"${isStreaming && idx === items.length - 1 ? ' open' : ''}>
            <summary class="process-item-summary">
              <span class="process-index">${String(idx + 1).padStart(2, '0')}</span>
              <span class="process-summary-main">
                <span class="process-kind">${escapeHtml(item.title)}</span>
                <span class="process-detail">${escapeHtml(item.command ? `진행 명령어: ${item.command}` : item.detail)}</span>
              </span>
            </summary>
            <div class="process-content">
              <div class="process-extra-title">${item.title === '코드 변경 내용' ? '코드 변경 내용' : '과정 상세 내용'}</div>
              <div class="process-extra-scroll">
              <ul class="process-extra">${(Array.isArray(item.extra) && item.extra.length > 0
                ? item.extra
                : [item.command ? `진행 명령어: ${item.command}` : item.detail]
              ).map(extra => `<li>${escapeHtml(extra)}</li>`).join('')}</ul>
              </div>
            </div>
          </details>
        `).join('')}
      </div>
    </div>`;
  }

  // opts: { activeTab, isStreaming }
  function renderCodexStructured(sections, opts) {
    const { activeTab = 'answer', isStreaming = false, rawText = '' } = opts || {};
    const currentTab = ['answer', 'process', 'code'].includes(activeTab) ? activeTab : 'answer';
    const finalAnswer = formatAnswerLineBreaks(sanitizeFinalAnswerText(sections.response.content || ''));
    const responseHtml = renderMarkdown(finalAnswer || '최종 답변을 정리했습니다.');
    const processHtml = renderCodexProcessBrief(sections, isStreaming, rawText);
    const codeHtml = renderCodexCodeBrief(sections, rawText);

    const answerActive = currentTab === 'answer' ? ' active' : '';
    const processActive = currentTab === 'process' ? ' active' : '';
    const codeActive = currentTab === 'code' ? ' active' : '';
    const answerHidden = currentTab !== 'answer' ? ' hidden' : '';
    const processHidden = currentTab !== 'process' ? ' hidden' : '';
    const codeHidden = currentTab !== 'code' ? ' hidden' : '';

    return `<div class="msg-tabs">
      <button class="msg-tab${answerActive}" data-tab="answer">답변</button>
      <button class="msg-tab${processActive}" data-tab="process">과정</button>
      <button class="msg-tab${codeActive}" data-tab="code">코드</button>
    </div>
    <div class="msg-tab-content${answerHidden}" data-tab-content="answer">${responseHtml}</div>
    <div class="msg-tab-content${processHidden}" data-tab-content="process">${processHtml}</div>
    <div class="msg-tab-content${codeHidden}" data-tab-content="code">${codeHtml}</div>`;
  }

  function updateCodexStatusbar(sections) {
    const streamingNow = isActiveConvStreaming();
    if (sections) {
      // 스트리밍 중에는 중간 파싱값으로 snapshot을 덮어쓰지 않는다.
      // (응답 도중 0%로 튀는 현상 방지)
      if (!streamingNow) {
        const stats = codexUsage.getStats();
        const remaining = resolveRemainingPercents(sections, stats);
        mergeCodexLimitSnapshot({
          h5: remaining.h5,
          weekly: remaining.weekly,
        });
      }
    } else {
      resolveSnapshotFromStoredLimits();
    }
    renderCodexStatusbar();
  }

  async function refreshCodexRateLimits(reason = 'auto') {
    try {
      const result = await window.electronAPI.codex.rateLimits();
      if (result?.success) {
        const h5ResetAt = normalizeResetTimestamp(result.h5ResetsAt);
        const weeklyResetAt = normalizeResetTimestamp(result.weeklyResetsAt);
        const h5WindowMin = Number(result.h5Window);
        const weeklyWindowMin = Number(result.weeklyWindow);
        mergeCodexLimitSnapshot({
          h5: normalizePercent(result.h5Remaining),
          weekly: normalizePercent(result.weeklyRemaining),
          h5ResetAt: h5ResetAt || (Number.isFinite(h5WindowMin) && h5WindowMin > 0 ? Date.now() + h5WindowMin * 60000 : null),
          weeklyResetAt: weeklyResetAt || (Number.isFinite(weeklyWindowMin) && weeklyWindowMin > 0 ? Date.now() + weeklyWindowMin * 60000 : null),
        });
        renderCodexStatusbar();
        return true;
      }
    } catch (err) {
      console.warn('[rateLimits]', reason, err);
    }
    renderCodexStatusbar();
    return false;
  }

  function getProfileById(id) {
    return PROFILES.find(p => p.id === id);
  }

  // 현재 탭 상태를 DOM에서 캡처
  function captureCodexUIState(container) {
    const activeTab = container.querySelector('.msg-tab.active');
    const currentTab = activeTab ? activeTab.dataset.tab : 'answer';
    return { currentTab };
  }

  function renderAIBody(msg, opts = {}) {
    if (msg.profileId === 'codex' && msg.content) {
      const sections = parseCodexOutput(msg.content);
      updateCodexRuntimeInfo(sections);
      if (sections.response.content || sections.thinking.content) {
        return renderCodexStructured(sections, {
          rawText: msg.content,
          activeTab: opts?.activeTab,
        });
      }
    }
    return renderMarkdown(msg.content);
  }

  function isMessagesNearBottom(threshold = MESSAGE_SCROLL_BOTTOM_THRESHOLD) {
    if (!$messages) return true;
    const remaining = $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight;
    return remaining <= threshold;
  }

  function scrollToBottom(options = {}) {
    const force = options === true || Boolean(options?.force);
    if (!force && !shouldAutoScrollMessages) return;
    requestAnimationFrame(() => {
      suppressMessagesScrollEvent = true;
      $messages.scrollTop = $messages.scrollHeight;
      requestAnimationFrame(() => {
        suppressMessagesScrollEvent = false;
        shouldAutoScrollMessages = true;
      });
    });
  }

  function stickProcessStackToBottom(container) {
    if (!container) return;
    const stacks = container.querySelectorAll('.process-stack');
    stacks.forEach((stack) => {
      stack.scrollTop = stack.scrollHeight;
    });
  }

  // === Codex 서브커맨드 실행 (review, version 등) ===
  async function runCodexSubcommand(subcommand, extraArgs, promptText) {
    if (isActiveConvStreaming()) return;

    if (!activeConvId || !getActiveConversation()) {
      newConversation();
    }
    const convId = activeConvId;
    const conv = getActiveConversation();

    // 사용자 메시지 추가
    const userMsg = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: promptText ? `/${subcommand} ${promptText}` : `/${subcommand}`,
      profileId: activeProfileId,
      timestamp: Date.now(),
    };
    conv.messages.push(userMsg);
    $welcome.style.display = 'none';
    appendMessageDOM(userMsg);
    scrollToBottom();

    // AI 응답 플레이스홀더
    const aiMsg = {
      id: `msg_${Date.now() + 1}`,
      role: 'ai',
      content: '',
      profileId: activeProfileId,
      timestamp: Date.now(),
    };
    conv.messages.push(aiMsg);
    const aiEl = appendMessageDOM(aiMsg);
    aiEl.classList.add('streaming');

    const bodyEl = aiEl.querySelector('.msg-body');
    bodyEl.innerHTML = '';
    scrollToBottom();

    const streamId = aiMsg.id;
    let fullOutput = '';
    let finished = false;
    let exitCode = null;

    // 대화별 스트리밍 상태 등록
    const streamState = { streamId };
    convStreams.set(convId, streamState);

    if (convId === activeConvId) {
      isStreaming = true;
      currentStreamId = streamId;
      $btnStop.classList.remove('hidden');
    }

    const unsubStream = window.electronAPI.cli.onStream(({ id, chunk }) => {
      if (id !== streamId || finished) return;
      fullOutput = appendStreamingChunk(fullOutput, chunk);
      aiMsg.content = fullOutput;
      autoSaveIfNeeded();
      if (convId !== activeConvId) return;
      bodyEl.innerHTML = renderMarkdown(fullOutput);
      scrollToBottom();
    });

    const unsubDone = window.electronAPI.cli.onDone(({ id, code }) => {
      if (id !== streamId) return;
      exitCode = Number.isFinite(Number(code)) ? Number(code) : null;
      finish();
    });

    streamState.unsubStream = unsubStream;
    streamState.unsubDone = unsubDone;

    function finish() {
      if (finished) return;
      finished = true;
      convStreams.delete(convId);
      unsubStream();
      unsubDone();
      void refreshCodexRateLimits('after-subcommand');

      if (!String(aiMsg.content || '').trim()) {
        if (exitCode != null && exitCode !== 0) {
          aiMsg.role = 'error';
          aiMsg.content = `실행이 실패했습니다 (code ${exitCode}). 네트워크/로그인 상태를 확인해 주세요.`;
        } else {
          aiMsg.content = '응답이 비어 있습니다. 다시 시도해 주세요.';
        }
      }

      if (convId === activeConvId) {
        aiEl.classList.remove('streaming');
        bodyEl.innerHTML = renderMarkdown(aiMsg.content);
        syncStreamingUI();
        $input.focus();
      }
      saveConversations();
    }

    // CLI 실행 — 서브커맨드 인자는 그대로 전달한다.
    const cliArgs = subcommand === '--version'
      ? ['--version']
      : [subcommand, ...extraArgs];

    try {
      const runResult = await window.electronAPI.cli.run({
        id: streamId,
        profile: {
          command: 'codex',
          args: cliArgs,
          mode: 'pipe',
          env: {},
        },
        prompt: promptText || '',
        cwd: currentCwd,
      });
      if (!runResult?.success) {
        aiMsg.content = `실행 실패: ${runResult?.error || 'unknown'}`;
        aiMsg.role = 'error';
        bodyEl.textContent = aiMsg.content;
        finish();
      }
    } catch (err) {
      aiMsg.content = `오류: ${err.message}`;
      aiMsg.role = 'error';
      bodyEl.textContent = aiMsg.content;
      finish();
    }
  }

  // === Codex exec + 추가 인자 (예: --search) ===
  async function runCodexWithExtraArgs(extraArgs, promptText) {
    if (isActiveConvStreaming() || !promptText.trim()) return;

    if (!activeConvId || !getActiveConversation()) {
      newConversation();
    }

    const convId = activeConvId;

    // buildCodexArgs에 추가 인자 병합
    const originalBuild = buildCodexArgs(getActiveConversation()?.codexSessionId);
    const mergedArgs = [...originalBuild, ...extraArgs];

    const conv = getActiveConversation();
    const profile = PROFILES.find(p => p.id === activeProfileId);
    const runPrompt = buildCodexPrompt(promptText);

    if (conv.messages.length === 0) {
      conv.title = promptText.slice(0, 50) + (promptText.length > 50 ? '...' : '');
      conv.profileId = activeProfileId;
      conv.cwd = currentCwd;
    }

    const userMsg = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: promptText,
      profileId: activeProfileId,
      timestamp: Date.now(),
    };
    conv.messages.push(userMsg);
    $welcome.style.display = 'none';
    appendMessageDOM(userMsg);
    scrollToBottom();

    const aiMsg = {
      id: `msg_${Date.now() + 1}`,
      role: 'ai',
      content: '',
      profileId: activeProfileId,
      timestamp: Date.now(),
    };
    conv.messages.push(aiMsg);
    const aiEl = appendMessageDOM(aiMsg);
    aiEl.classList.add('streaming');

    const bodyEl = aiEl.querySelector('.msg-body');
    bodyEl.innerHTML = SHOW_STREAMING_WORK_PANEL
      ? `<div class="thinking-indicator">
      <div class="thinking-header">
        <div class="thinking-dots"><span></span><span></span><span></span></div>
        <span class="thinking-text">${profile.name} 작업 중...</span>
        <span class="thinking-elapsed">0초</span>
      </div>
      <div class="thinking-log"></div>
    </div>`
      : '';
    scrollToBottom();

    const startTime = Date.now();
    const elapsedTimer = SHOW_STREAMING_WORK_PANEL
      ? setInterval(() => {
        const elapsedEl = bodyEl.querySelector('.thinking-elapsed');
        if (!elapsedEl) return;
        const sec = Math.floor((Date.now() - startTime) / 1000);
        elapsedEl.textContent = sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${sec % 60}초`;
      }, 1000)
      : null;

    const streamId = aiMsg.id;
    let fullOutput = '';
    let responseStarted = false;
    let finished = false;
    let exitCode = null;
    let latestSections = null;
    let lastSectionsParsedAt = 0;
    const previewState = createStreamingPreviewState(
      SHOW_STREAMING_WORK_PANEL ? 19 : STREAM_INLINE_PROGRESS_HISTORY_LIMIT
    );
    if (SHOW_STREAMING_WORK_PANEL) {
      renderThinkingLogLines(bodyEl.querySelector('.thinking-log'), updateStreamingPreviewLines(previewState, ''));
    }
    const scheduleStreamRender = createThrottledInvoker(STREAM_RENDER_THROTTLE_MS, () => {
      if (finished || convId !== activeConvId) return;
      const now = Date.now();
      if (!latestSections || now - lastSectionsParsedAt >= STREAM_SECTIONS_PARSE_INTERVAL_MS) {
        latestSections = parseCodexOutput(fullOutput);
        lastSectionsParsedAt = now;
        updateCodexRuntimeInfo(latestSections);
        updateCodexStatusbar(latestSections);
      }
      const sections = latestSections;
      const hasContent = !!sections && Object.values(sections).some(s => s.content);
      if (!responseStarted && hasContent) {
        responseStarted = true;
        if (elapsedTimer) clearInterval(elapsedTimer);
      }
      if (SHOW_STREAMING_WORK_PANEL) {
        const logEl = bodyEl.querySelector('.thinking-log');
        renderThinkingLogLines(logEl, updateStreamingPreviewLines(previewState, fullOutput, sections));
        scrollToBottom();
      } else {
        const progressLines = updateStreamingPreviewLines(previewState, fullOutput, sections);
        const previewResponse = String(sections?.response?.content || '').trim();
        renderStreamingResponsePreview(bodyEl, previewResponse, progressLines, STREAM_INLINE_PROGRESS_VISIBLE_LINES);
        scrollToBottom();
      }
    });

    // 대화별 스트리밍 상태 등록
    const streamState = { streamId, elapsedTimer };
    convStreams.set(convId, streamState);

    if (convId === activeConvId) {
      isStreaming = true;
      currentStreamId = streamId;
      $btnStop.classList.remove('hidden');
      $input.disabled = false;
      $input.placeholder = '실행 중인 프로세스에 입력 보내기... (Enter 전송)';
      $input.classList.add('process-input-mode');
      $btnSend.title = '입력 전송';
    }

    const unsubStream = window.electronAPI.cli.onStream(({ id, chunk }) => {
      if (id !== streamId || finished) return;
      fullOutput = appendStreamingChunk(fullOutput, chunk);
      aiMsg.content = fullOutput;
      autoSaveIfNeeded();

      // 스트리밍 중 세션 ID 조기 캡처
      if (!conv.codexSessionId) {
        const sid = extractCodexSessionIdFromText(fullOutput);
        if (sid) conv.codexSessionId = sid;
      }

      if (convId === activeConvId) {
        const fastLines = updateStreamingPreviewFromChunk(previewState, chunk);
        if (SHOW_STREAMING_WORK_PANEL) {
          const logEl = bodyEl.querySelector('.thinking-log');
          renderThinkingLogLines(logEl, fastLines);
          scrollToBottom();
        } else {
          const previewResponse = String(latestSections?.response?.content || '').trim();
          renderStreamingResponsePreview(bodyEl, previewResponse, fastLines, STREAM_INLINE_PROGRESS_VISIBLE_LINES);
          scrollToBottom();
        }
      }

      scheduleStreamRender();
    });

    const unsubDone = window.electronAPI.cli.onDone(({ id, code }) => {
      if (id !== streamId) return;
      exitCode = Number.isFinite(Number(code)) ? Number(code) : null;
      finishStream();
    });

    streamState.unsubStream = unsubStream;
    streamState.unsubDone = unsubDone;

    function finishStream() {
      if (finished) return;
      finished = true;
      scheduleStreamRender.cancel();

      if (elapsedTimer) clearInterval(elapsedTimer);
      convStreams.delete(convId);
      unsubStream();
      unsubDone();

      if (!String(aiMsg.content || '').trim()) {
        if (exitCode != null && exitCode !== 0) {
          aiMsg.role = 'error';
          aiMsg.content = `실행이 실패했습니다 (code ${exitCode}). 네트워크/로그인 상태를 확인해 주세요.`;
        } else {
          aiMsg.content = '응답이 비어 있습니다. 다시 시도해 주세요.';
        }
      }

      // 세션 ID 추출 후 대화에 저장
      const finalSections = parseCodexOutput(aiMsg.content || '');
      const sid = extractCodexSessionId(finalSections);
      if (sid) conv.codexSessionId = sid;

      void refreshCodexRateLimits('after-answer');

      if (convId === activeConvId) {
        aiEl.classList.remove('streaming');
        const finalBody = aiEl.querySelector('.msg-body');
        finalBody.innerHTML = renderAIBody(aiMsg);
        stickProcessStackToBottom(finalBody);
        syncStreamingUI();
        $input.focus();
      }

      saveConversations();
    }

    try {
      const runResult = await window.electronAPI.cli.run({
        id: streamId,
        profile: {
          command: profile.command,
          args: mergedArgs,
          mode: profile.mode,
          env: {},
        },
        prompt: runPrompt,
        cwd: currentCwd,
      });
      if (!runResult?.success) {
        aiMsg.content = `실행 실패: ${runResult?.error || 'unknown'}`;
        aiMsg.role = 'error';
        bodyEl.textContent = aiMsg.content;
        finishStream();
      }
    } catch (err) {
      aiMsg.content = `오류: ${err.message}`;
      aiMsg.role = 'error';
      bodyEl.textContent = aiMsg.content;
      finishStream();
    }
  }

  // 현재 활성 대화가 스트리밍 중인지 확인
  function isActiveConvStreaming() {
    return activeConvId && convStreams.has(activeConvId);
  }

  // UI를 현재 대화의 스트리밍 상태에 맞게 동기화
  function syncStreamingUI() {
    const streaming = isActiveConvStreaming();
    isStreaming = streaming;
    if (streaming) {
      const st = convStreams.get(activeConvId);
      currentStreamId = st.streamId;
      $btnStop.classList.remove('hidden');
      $input.disabled = false;
      $input.placeholder = '실행 중인 프로세스에 입력 보내기... (Enter 전송)';
      $input.classList.add('process-input-mode');
      $btnSend.title = '입력 전송';
    } else {
      currentStreamId = null;
      $btnStop.classList.add('hidden');
      $input.disabled = false;
      $input.placeholder = '메시지를 입력하세요...';
      $input.classList.remove('process-input-mode');
      $btnSend.title = '전송';
    }
  }

  // === 메시지 전송 ===
  async function sendMessage(promptText) {
    if (!promptText.trim()) return;
    // 현재 대화가 이미 스트리밍 중이면 차단
    if (isActiveConvStreaming()) return;

    // 대화가 없으면 생성
    if (!activeConvId || !getActiveConversation()) {
      newConversation();
    }

    const convId = activeConvId;
    const conv = getActiveConversation();
    const profile = PROFILES.find(p => p.id === activeProfileId);
    const runPrompt = buildCodexPrompt(promptText);
    // 첫 메시지 → 제목 설정 + 작업 폴더 저장
    if (conv.messages.length === 0) {
      conv.title = promptText.slice(0, 50) + (promptText.length > 50 ? '...' : '');
      conv.profileId = activeProfileId;
      conv.cwd = currentCwd;
    }

    // 사용자 메시지 추가
    const userMsg = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: promptText,
      profileId: activeProfileId,
      timestamp: Date.now(),
    };
    conv.messages.push(userMsg);

    // 웰컴 화면 숨기기
    $welcome.style.display = 'none';
    appendMessageDOM(userMsg);
    scrollToBottom();

    // AI 응답 플레이스홀더
    const aiMsg = {
      id: `msg_${Date.now() + 1}`,
      role: 'ai',
      content: '',
      profileId: activeProfileId,
      timestamp: Date.now(),
    };
    conv.messages.push(aiMsg);
    const aiEl = appendMessageDOM(aiMsg);
    aiEl.classList.add('streaming');

    const bodyEl = aiEl.querySelector('.msg-body');
    bodyEl.innerHTML = SHOW_STREAMING_WORK_PANEL
      ? `<div class="thinking-indicator">
      <div class="thinking-header">
        <div class="thinking-dots"><span></span><span></span><span></span></div>
        <span class="thinking-text">${profile.name} 작업 중...</span>
        <span class="thinking-elapsed">0초</span>
      </div>
      <div class="thinking-log"></div>
    </div>`
      : '';
    scrollToBottom();

    const startTime = Date.now();
    const elapsedTimer = SHOW_STREAMING_WORK_PANEL
      ? setInterval(() => {
        const elapsedEl = bodyEl.querySelector('.thinking-elapsed');
        if (!elapsedEl) return;
        const sec = Math.floor((Date.now() - startTime) / 1000);
        elapsedEl.textContent = sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${sec % 60}초`;
      }, 1000)
      : null;

    const streamId = aiMsg.id;

    // 대화별 스트리밍 상태 등록
    const streamState = { streamId, elapsedTimer };
    convStreams.set(convId, streamState);

    // 현재 대화면 UI 동기화
    if (convId === activeConvId) {
      isStreaming = true;
      currentStreamId = streamId;
      $btnStop.classList.remove('hidden');
      $input.disabled = false;
      $input.placeholder = '실행 중인 프로세스에 입력 보내기... (Enter 전송)';
      $input.classList.add('process-input-mode');
      $btnSend.title = '입력 전송';
    }

    let fullOutput = '';
    let responseStarted = false;
    let finished = false;
    let exitCode = null;
    let latestSections = null;
    let lastSectionsParsedAt = 0;
    const previewState = createStreamingPreviewState(
      SHOW_STREAMING_WORK_PANEL ? 19 : STREAM_INLINE_PROGRESS_HISTORY_LIMIT
    );
    if (SHOW_STREAMING_WORK_PANEL) {
      renderThinkingLogLines(bodyEl.querySelector('.thinking-log'), updateStreamingPreviewLines(previewState, ''));
    }
    const scheduleStreamRender = createThrottledInvoker(STREAM_RENDER_THROTTLE_MS, () => {
      if (finished || convId !== activeConvId) return;
      const now = Date.now();
      if (!latestSections || now - lastSectionsParsedAt >= STREAM_SECTIONS_PARSE_INTERVAL_MS) {
        latestSections = parseCodexOutput(fullOutput);
        lastSectionsParsedAt = now;
        updateCodexRuntimeInfo(latestSections);
        updateCodexStatusbar(latestSections);
      }
      const sections = latestSections;
      const hasContent = !!sections && Object.values(sections).some(s => s.content);

      if (!responseStarted && hasContent) {
        responseStarted = true;
        if (elapsedTimer) clearInterval(elapsedTimer);
      }
      if (SHOW_STREAMING_WORK_PANEL) {
        const logEl = bodyEl.querySelector('.thinking-log');
        renderThinkingLogLines(logEl, updateStreamingPreviewLines(previewState, fullOutput, sections));
        scrollToBottom();
      } else {
        const progressLines = updateStreamingPreviewLines(previewState, fullOutput, sections);
        const previewResponse = String(sections?.response?.content || '').trim();
        renderStreamingResponsePreview(bodyEl, previewResponse, progressLines, STREAM_INLINE_PROGRESS_VISIBLE_LINES);
        scrollToBottom();
      }
    });

    const unsubStream = window.electronAPI.cli.onStream(({ id, chunk }) => {
      if (id !== streamId || finished) return;
      fullOutput = appendStreamingChunk(fullOutput, chunk);
      aiMsg.content = fullOutput;
      autoSaveIfNeeded();

      // 스트리밍 중 세션 ID 조기 캡처
      if (!conv.codexSessionId) {
        const sid = extractCodexSessionIdFromText(fullOutput);
        if (sid) conv.codexSessionId = sid;
      }

      if (convId === activeConvId) {
        const fastLines = updateStreamingPreviewFromChunk(previewState, chunk);
        if (SHOW_STREAMING_WORK_PANEL) {
          const logEl = bodyEl.querySelector('.thinking-log');
          renderThinkingLogLines(logEl, fastLines);
          scrollToBottom();
        } else {
          const previewResponse = String(latestSections?.response?.content || '').trim();
          renderStreamingResponsePreview(bodyEl, previewResponse, fastLines, STREAM_INLINE_PROGRESS_VISIBLE_LINES);
          scrollToBottom();
        }
      }

      // 현재 보고있는 대화가 아니면 DOM 업데이트 스킵 (데이터만 저장)
      scheduleStreamRender();
    });

    const unsubDone = window.electronAPI.cli.onDone(({ id, code }) => {
      if (id !== streamId) return;
      exitCode = Number.isFinite(Number(code)) ? Number(code) : null;
      finishStream();
    });

    const unsubError = window.electronAPI.cli.onError(({ id, error }) => {
      if (id !== streamId) return;
      aiMsg.content = `오류가 발생했습니다: ${error}`;
      aiMsg.role = 'error';
      aiEl.className = 'message error';
      aiEl.querySelector('.msg-body').textContent = aiMsg.content;
      finishStream();
    });

    streamState.unsubStream = unsubStream;
    streamState.unsubDone = unsubDone;
    streamState.unsubError = unsubError;

    function finishStream() {
      if (finished) return;
      finished = true;
      scheduleStreamRender.cancel();

      if (elapsedTimer) clearInterval(elapsedTimer);
      convStreams.delete(convId);

      // 리스너 즉시 해제 (다른 프로세스 이벤트가 이 핸들러에 도달하지 않도록)
      unsubStream();
      unsubDone();
      unsubError();

      if (!String(aiMsg.content || '').trim()) {
        if (exitCode != null && exitCode !== 0) {
          aiMsg.role = 'error';
          aiMsg.content = `실행이 실패했습니다 (code ${exitCode}). 네트워크/로그인 상태를 확인해 주세요.`;
        } else {
          aiMsg.content = '응답이 비어 있습니다. 다시 시도해 주세요.';
        }
      }

      // 세션 ID 추출 후 대화에 저장
      const finalSections = parseCodexOutput(aiMsg.content || '');
      const sid = extractCodexSessionId(finalSections);
      if (sid) conv.codexSessionId = sid;

      // 토큰 사용량 기록
      const usage = resolveCodexTurnUsage(promptText, aiMsg.content || '');
      if (usage.total > 0) {
        codexUsage.record(usage.total, parseEffort(finalSections));
      }
      updateCodexStatusbar(finalSections);
      void refreshCodexRateLimits('after-answer');

      // 현재 보고있는 대화이면 DOM 직접 업데이트
      if (convId === activeConvId) {
        aiEl.classList.remove('streaming');
        const finalBody = aiEl.querySelector('.msg-body');
        finalBody.innerHTML = renderAIBody(aiMsg);
        stickProcessStackToBottom(finalBody);
        syncStreamingUI();
        $input.focus();
      }
      // 다른 대화로 전환된 경우: DOM은 건드리지 않음
      // (나중에 해당 대화로 돌아오면 renderMessages()에서 최종 내용 렌더링)

      saveConversations();
    }

    // CLI 실행
    try {
      const runResult = await window.electronAPI.cli.run({
        id: streamId,
        profile: {
          command: profile.command,
          args: buildCodexArgs(conv.codexSessionId),
          mode: profile.mode,
          env: {},
        },
        prompt: runPrompt,
        cwd: currentCwd,
      });

      if (!runResult?.success) {
        aiMsg.content = `CLI 실행 실패: ${runResult?.error || 'unknown error'}`;
        aiMsg.role = 'error';
        aiEl.className = 'message error';
        aiEl.querySelector('.msg-body').textContent = aiMsg.content;
        finishStream();
      }
    } catch (error) {
      aiMsg.content = `CLI 실행 오류: ${error?.message || String(error)}`;
      aiMsg.role = 'error';
      aiEl.className = 'message error';
      aiEl.querySelector('.msg-body').textContent = aiMsg.content;
      finishStream();
    }
  }

  // === 이벤트 바인딩 ===

  // 프로세스에 입력 전송
  function sendInputToProcess(text) {
    if (!currentStreamId) return;
    window.electronAPI.cli.write(currentStreamId, text + '\r');
  }

  async function submitInputText() {
    const text = $input.value.trim();
    if (!text) return;

    if (isStreaming && currentStreamId) {
      $input.value = '';
      autoResizeInput();
      hideSlashMenu();
      sendInputToProcess(text);
      return;
    }

    if (text.startsWith('@')) {
      const handled = await handleAtFileCommand(text);
      if (handled) {
        updateSlashCommandMenu();
        return;
      }
    }

    if (text.startsWith('/')) {
      const handled = await handleSlashCommand(text);
      if (handled) {
        updateSlashCommandMenu();
        return;
      }
    }

    $input.value = '';
    autoResizeInput();
    hideSlashMenu();
    sendMessage(text);
  }

  // 전송 / 프로세스 입력
  $btnSend.addEventListener('click', () => {
    void submitInputText();
  });

  // 사용자가 스크롤을 조작하면 자동 하단 고정 상태를 갱신
  $messages.addEventListener('scroll', () => {
    if (suppressMessagesScrollEvent) return;
    shouldAutoScrollMessages = isMessagesNearBottom();
  });

  if ($btnSidebarToggle) {
    $btnSidebarToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setSidebarCollapsed(!sidebarCollapsed);
    });
  }

  if ($sidebarResizer) {
    $sidebarResizer.addEventListener('mousedown', beginSidebarResize);
  }

  window.addEventListener('blur', () => {
    endSidebarResize();
  });

  // 중지
  $btnStop.addEventListener('click', () => {
    if (activeConvId && convStreams.has(activeConvId)) {
      const st = convStreams.get(activeConvId);
      window.electronAPI.cli.stop(st.streamId);
    } else if (currentStreamId) {
      window.electronAPI.cli.stop(currentStreamId);
    }
  });

  // Enter 전송 / Shift+Enter 줄바꿈
  $input.addEventListener('keydown', (e) => {
    // 세션 피커 키보드 네비게이션
    if (e.key === 'ArrowDown' && isSessionPickerOpen()) {
      e.preventDefault();
      moveSessionPickerSelection(1);
      return;
    }
    if (e.key === 'ArrowUp' && isSessionPickerOpen()) {
      e.preventDefault();
      moveSessionPickerSelection(-1);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && isSessionPickerOpen()) {
      e.preventDefault();
      applySessionPickerSelection();
      return;
    }

    if (e.key === 'ArrowDown' && isSlashMenuOpen()) {
      e.preventDefault();
      moveSlashSelection(1);
      return;
    }

    if (e.key === 'ArrowUp' && isSlashMenuOpen()) {
      e.preventDefault();
      moveSlashSelection(-1);
      return;
    }

    if (e.key === 'Tab' && isSlashMenuOpen()) {
      e.preventDefault();
      applySlashSelection();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitInputText();
      return;
    }

    if (e.key === 'Escape') {
      if (isSessionPickerOpen()) {
        e.preventDefault();
        hideSessionPicker();
        return;
      }
      if (runtimeMenuType) {
        e.preventDefault();
        closeRuntimeMenu();
        return;
      }
      if (isSlashMenuOpen()) {
        e.preventDefault();
        hideSlashMenu();
        return;
      }
      if (isStreaming && currentStreamId) {
        window.electronAPI.cli.stop(currentStreamId);
      }
    }
  });

  // 텍스트 영역 자동 높이 조절
  $input.addEventListener('input', () => {
    autoResizeInput();
    updateSlashCommandMenu();
  });

  $input.addEventListener('focus', () => {
    updateSlashCommandMenu();
  });

  function autoResizeInput() {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 150) + 'px';
  }

  // 새 대화
  document.getElementById('btn-new-chat').addEventListener('click', () => {
    newConversation();
  });

  // 기록 삭제
  document.getElementById('btn-clear-all').addEventListener('click', () => {
    if (conversations.length === 0) return;
    const confirmed = window.confirm(`대화 ${conversations.length}개를 모두 삭제할까요?\n이 작업은 되돌릴 수 없습니다.`);
    if (!confirmed) return;
    conversations = [];
    activeConvId = null;
    saveConversations();
    renderMessages();
    renderHistory();
    syncStreamingUI();
  });

  if ($btnUserManual) {
    $btnUserManual.addEventListener('click', async () => {
      try {
        const result = await window.electronAPI.help.openManual();
        if (!result?.success) {
          showSlashFeedback(result?.error || '사용 설명서를 열지 못했습니다.', true);
        }
      } catch (err) {
        showSlashFeedback(err?.message || '사용 설명서를 열지 못했습니다.', true);
      }
    });
  }

  // 힌트 칩 클릭
  document.querySelectorAll('.hint-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = chip.dataset.prompt;
      $input.value = prompt;
      autoResizeInput();
      $input.focus();
    });
  });

  // 윈도우 컨트롤
  document.getElementById('btn-min').addEventListener('click', () => window.electronAPI.window.minimize());
  document.getElementById('btn-max').addEventListener('click', () => window.electronAPI.window.maximize());
  document.getElementById('btn-close').addEventListener('click', () => window.electronAPI.window.close());

  window.electronAPI.window.onMaximized((isMax) => {
    document.body.style.borderRadius = isMax ? '0' : '12px';
  });

  // 전역 단축키
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'n') {
      e.preventDefault();
      newConversation();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      setSidebarCollapsed(!sidebarCollapsed);
    }
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      $input.focus();
    }
  });

  // === 유틸리티 ===
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  document.addEventListener('click', (e) => {
    const runtimeOption = e.target.closest('.runtime-option');
    if (runtimeOption) {
      setRuntimeOption(runtimeOption.dataset.runtimeType, runtimeOption.dataset.runtimeValue);
      return;
    }

    const cmdItem = e.target.closest('.slash-command-item');
    if (cmdItem) {
      const cmd = cmdItem.dataset.command;
      const idx = slashMenuItems.findIndex(item => item.command === cmd);
      slashSelectedIndex = idx >= 0 ? idx : 0;
      applySlashSelection();
      return;
    }

    if (!e.target.closest('#runtime-selector-menu') && !e.target.closest('.runtime-select-btn')) {
      closeRuntimeMenu();
    }

    if (!e.target.closest('#input-area')) {
      hideSlashMenu();
    }
  });

  // 로컬 파일 링크 열기 (검색 결과 표 + 일반 마크다운 링크)
  document.addEventListener('click', async (e) => {
    const link = e.target.closest('a[data-local-path]');
    if (!link) return;
    e.preventDefault();

    const encodedPath = String(link.dataset.localPath || '');
    if (!encodedPath) return;

    let localPath = encodedPath;
    try {
      localPath = decodeURIComponent(encodedPath);
    } catch {
      // malformed encoding은 raw 값 사용
    }

    const lineNum = Number(link.dataset.line || '');
    const target = Number.isFinite(lineNum) && lineNum > 0
      ? `${localPath}#L${lineNum}`
      : localPath;

    const result = await window.electronAPI.file.open(target);
    if (!result?.success) {
      showSlashFeedback(result?.error || '파일을 열지 못했습니다.', true);
      return;
    }

    const suffix = Number.isFinite(result.line) && result.line > 0 ? `:${result.line}` : '';
    showSlashFeedback(`파일을 열었습니다: ${result.path}${suffix}`, false);
  });

  // 코드 복사 (이벤트 위임)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="copy"]');
    if (!btn) return;
    const code = btn.closest('.code-block-wrapper').querySelector('code').textContent;
    navigator.clipboard.writeText(code).then(() => {
      btn.textContent = '복사됨!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '복사';
        btn.classList.remove('copied');
      }, 1500);
    });
  });

  // Codex 탭 전환 (이벤트 위임)
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.msg-tab');
    if (!tab) return;
    const body = tab.closest('.msg-body');
    if (!body) return;
    const target = tab.dataset.tab;
    body.querySelectorAll('.msg-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === target)
    );
    body.querySelectorAll('.msg-tab-content').forEach(c =>
      c.classList.toggle('hidden', c.dataset.tabContent !== target)
    );
    if (target === 'process') {
      requestAnimationFrame(() => stickProcessStackToBottom(body));
    }
  });

})();
