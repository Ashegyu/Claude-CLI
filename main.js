const { app, BrowserWindow, ipcMain, screen, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const pty = require('node-pty');

let mainWindow = null;
let manualWindow = null;
const runningProcesses = new Map();
const processBuffers = new Map(); // id → { ansiFragment: string } — ANSI 분할 방지 버퍼
let resolvedCliPaths = {}; // command name → resolved absolute path 캐시
const MAX_FILE_IMPORT_BYTES = 180 * 1024;
const MAX_IMAGE_IMPORT_BYTES = 20 * 1024 * 1024; // 이미지는 20MB까지
const MAX_PDF_IMPORT_BYTES = 10 * 1024 * 1024; // PDF는 10MB까지
const CODEX_MODEL_CATALOG_TIMEOUT_MS = 8000;
const CODEX_COMMAND_CATALOG_TIMEOUT_MS = 8000;
const FALLBACK_CODEX_MODELS = [
  {
    id: 'gpt-5.4',
    cliModel: 'gpt-5.4',
    label: 'gpt-5.4',
    description: 'Latest frontier agentic coding model.',
    defaultReasoning: 'medium',
    supportedReasoning: ['low', 'medium', 'high', 'extra high'],
    source: 'fallback',
  },
  {
    id: 'gpt-5.4-mini',
    cliModel: 'gpt-5.4-mini',
    label: 'GPT-5.4-Mini',
    description: 'Smaller frontier agentic coding model.',
    defaultReasoning: 'medium',
    supportedReasoning: ['low', 'medium', 'high', 'extra high'],
    source: 'fallback',
  },
  {
    id: 'gpt-5.3-codex',
    cliModel: 'gpt-5.3-codex',
    label: 'gpt-5.3-codex',
    description: 'Frontier Codex-optimized agentic coding model.',
    defaultReasoning: 'medium',
    supportedReasoning: ['low', 'medium', 'high', 'extra high'],
    source: 'fallback',
  },
  {
    id: 'gpt-5.2',
    cliModel: 'gpt-5.2',
    label: 'gpt-5.2',
    description: 'Optimized for professional work and long-running agents.',
    defaultReasoning: 'medium',
    supportedReasoning: ['low', 'medium', 'high', 'extra high'],
    source: 'fallback',
  },
];
const CODEX_CONFIG_FIELDS = {
  model: { type: 'string', maxLength: 160 },
  model_provider: { type: 'string', maxLength: 80 },
  approval_policy: { type: 'enum', values: ['untrusted', 'on-request', 'on-failure', 'never'] },
  sandbox_mode: { type: 'enum', values: ['read-only', 'workspace-write', 'danger-full-access'] },
  model_reasoning_effort: { type: 'enum', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  model_reasoning_summary: { type: 'enum', values: ['auto', 'concise', 'detailed', 'none'] },
  model_verbosity: { type: 'enum', values: ['low', 'medium', 'high'] },
  web_search: { type: 'enum', values: ['cached', 'live', 'disabled'] },
  personality: { type: 'enum', values: ['friendly', 'pragmatic', 'none'] },
  openai_base_url: { type: 'string', maxLength: 2048 },
  log_dir: { type: 'string', maxLength: 4096 },
  'windows.sandbox': { type: 'enum', values: ['elevated', 'unelevated'] },
  'features.apps': { type: 'boolean' },
  'features.fast_mode': { type: 'boolean' },
  'features.memories': { type: 'boolean' },
  'features.multi_agent': { type: 'boolean' },
  'features.personality': { type: 'boolean' },
  'features.shell_snapshot': { type: 'boolean' },
  'features.shell_tool': { type: 'boolean' },
  'features.unified_exec': { type: 'boolean' },
  'features.undo': { type: 'boolean' },
};
const CODEX_CONFIG_FIELD_KEYS = Object.freeze(Object.keys(CODEX_CONFIG_FIELDS));

// 파일 확장자별 분류
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif']);
const PDF_EXTENSIONS = new Set(['.pdf']);
const BINARY_DOC_EXTENSIONS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.7z', '.rar', '.bz2']);

let codexRateLimitCache = {
  ts: 0,
  filePath: '',
  fileMtime: 0,
  result: null,
};

// ANSI 이스케이프 시퀀스 + 터미널 제어문자 제거
function stripAnsi(text) {
  return text
    // CSI sequences: ESC[...X
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    // OSC sequences: ESC]...BEL or ESC]...ST
    .replace(/\x1B\].*?(?:\x07|\x1B\\)/g, '')
    // DEC private modes: ESC[?...h/l
    .replace(/\x1B\[\?[0-9;]*[hl]/g, '')
    // Character set: ESC(X
    .replace(/\x1B\([A-Z0-9]/g, '')
    // Other ESC sequences
    .replace(/\x1B[=>MNOP78]/g, '')
    // Remaining control chars (except \n, \r, \t)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    // UTF-8 디코딩 실패 replacement 문자 제거
    .replace(/\uFFFD/g, '');
}

// ── 가상 터미널 스크린 버퍼 ──
// PTY의 커서 위치 지정 출력을 올바르게 처리하여 깨끗한 텍스트 추출
class VTermBuffer {
  constructor(cols = 120, rows = 30) {
    this.cols = cols;
    this.rows = rows;
    this.lines = Array.from({ length: rows }, () => ' '.repeat(cols));
    this.crow = 0;  // cursor row
    this.ccol = 0;  // cursor col
    this.prevSnap = '';
  }

  // raw ANSI 데이터를 스크린 버퍼에 기록
  feed(data) {
    let i = 0;
    while (i < data.length) {
      // ESC 시퀀스 처리
      if (data[i] === '\x1B') {
        const consumed = this._consumeEsc(data, i);
        if (consumed > 0) { i += consumed; continue; }
        i++; continue;
      }
      // 일반 제어 문자
      if (data[i] === '\r') { this.ccol = 0; i++; continue; }
      if (data[i] === '\n') { this._linefeed(); i++; continue; }
      if (data[i] === '\t') {
        this.ccol = Math.min(this.cols - 1, (Math.floor(this.ccol / 8) + 1) * 8);
        i++; continue;
      }
      if (data.charCodeAt(i) < 0x20) { i++; continue; } // 기타 제어문자 무시

      // 표시 가능한 문자 → 버퍼에 쓰기
      if (this.crow < this.rows && this.ccol < this.cols) {
        const row = this.lines[this.crow];
        this.lines[this.crow] = row.substring(0, this.ccol) + data[i] + row.substring(this.ccol + 1);
      }
      this.ccol++;
      if (this.ccol >= this.cols) {
        this.ccol = 0;
        this._linefeed();
      }
      i++;
    }
  }

  _linefeed() {
    this.crow++;
    if (this.crow >= this.rows) {
      // 스크롤: 첫 줄 버리고 새 빈 줄 추가
      this.lines.shift();
      this.lines.push(' '.repeat(this.cols));
      this.crow = this.rows - 1;
    }
  }

  _consumeEsc(data, start) {
    if (start + 1 >= data.length) return 1;
    const next = data[start + 1];

    // CSI 시퀀스: ESC [ ...
    if (next === '[') {
      let j = start + 2;
      let params = '';
      while (j < data.length && ((data[j] >= '0' && data[j] <= '9') || data[j] === ';' || data[j] === '?')) {
        params += data[j]; j++;
      }
      if (j >= data.length) return data.length - start; // 불완전
      const code = data[j];
      const len = j - start + 1;
      this._handleCSI(code, params);
      return len;
    }

    // OSC 시퀀스: ESC ] ... (BEL 또는 ST로 종료)
    if (next === ']') {
      let j = start + 2;
      while (j < data.length) {
        if (data[j] === '\x07') return j - start + 1;
        if (data[j] === '\x1B' && j + 1 < data.length && data[j + 1] === '\\') return j - start + 2;
        j++;
      }
      return data.length - start;
    }

    // 기타 짧은 ESC 시퀀스 (ESC (, ESC ), ESC =, ESC > 등)
    return 2;
  }

  _handleCSI(code, params) {
    const nums = params.replace('?', '').split(';').map(n => parseInt(n, 10));
    const n1 = isNaN(nums[0]) ? 1 : nums[0];
    const n2 = isNaN(nums[1]) ? 1 : nums[1];

    switch (code) {
      case 'A': this.crow = Math.max(0, this.crow - (n1 || 1)); break;
      case 'B': this.crow = Math.min(this.rows - 1, this.crow + (n1 || 1)); break;
      case 'C': this.ccol = Math.min(this.cols - 1, this.ccol + (n1 || 1)); break;
      case 'D': this.ccol = Math.max(0, this.ccol - (n1 || 1)); break;
      case 'H': case 'f':
        this.crow = Math.min(this.rows - 1, Math.max(0, (n1 || 1) - 1));
        this.ccol = Math.min(this.cols - 1, Math.max(0, (n2 || 1) - 1));
        break;
      case 'G':
        this.ccol = Math.min(this.cols - 1, Math.max(0, (n1 || 1) - 1));
        break;
      case 'J': {
        const p = nums[0] || 0;
        if (p === 2 || p === 3) {
          // 전체 화면 지움
          for (let r = 0; r < this.rows; r++) this.lines[r] = ' '.repeat(this.cols);
          this.crow = 0; this.ccol = 0;
        } else if (p === 0) {
          // 커서부터 화면 끝까지 지움
          const row = this.lines[this.crow];
          this.lines[this.crow] = row.substring(0, this.ccol) + ' '.repeat(this.cols - this.ccol);
          for (let r = this.crow + 1; r < this.rows; r++) this.lines[r] = ' '.repeat(this.cols);
        } else if (p === 1) {
          // 화면 처음부터 커서까지 지움
          for (let r = 0; r < this.crow; r++) this.lines[r] = ' '.repeat(this.cols);
          const row = this.lines[this.crow];
          this.lines[this.crow] = ' '.repeat(this.ccol + 1) + row.substring(this.ccol + 1);
        }
        break;
      }
      case 'K': {
        const p = nums[0] || 0;
        const row = this.lines[this.crow] || ' '.repeat(this.cols);
        if (p === 0) {
          this.lines[this.crow] = row.substring(0, this.ccol) + ' '.repeat(this.cols - this.ccol);
        } else if (p === 1) {
          this.lines[this.crow] = ' '.repeat(this.ccol + 1) + row.substring(this.ccol + 1);
        } else if (p === 2) {
          this.lines[this.crow] = ' '.repeat(this.cols);
        }
        break;
      }
      case 'L': {
        // 줄 삽입
        const count = n1 || 1;
        for (let c = 0; c < count && this.crow < this.rows; c++) {
          this.lines.splice(this.crow, 0, ' '.repeat(this.cols));
          this.lines.length = this.rows;
        }
        break;
      }
      case 'M': {
        // 줄 삭제
        const count = n1 || 1;
        for (let c = 0; c < count && this.crow < this.rows; c++) {
          this.lines.splice(this.crow, 1);
          this.lines.push(' '.repeat(this.cols));
        }
        break;
      }
      // m(SGR), h/l(모드), s/u(커서저장/복원), r(스크롤영역) 등은 무시
    }
  }

  // 현재 스크린 스냅샷을 줄 단위 텍스트로 반환
  snapshot() {
    return this.lines.map(l => l.trimEnd()).join('\n');
  }

  // 이전 스냅샷과 비교하여 변경된 줄만 반환
  diff() {
    const current = this.snapshot();
    const prev = this.prevSnap;
    this.prevSnap = current;

    if (!prev) return '';

    const curLines = current.split('\n');
    const prevLines = prev.split('\n');
    const changed = [];
    for (let i = 0; i < curLines.length; i++) {
      if (curLines[i] !== (prevLines[i] || '')) {
        const trimmed = curLines[i].trim();
        if (trimmed) changed.push(trimmed);
      }
    }
    return changed.join('\n');
  }
}

// statusline / TUI 노이즈 필터링
function isNoisyLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  // 모델명 + 승인정책 패턴 (예: "o4-mini suggest workspace-write")
  if (/^[a-z0-9][\w.-]*\s+(suggest|auto-edit|full-auto|ask-every-time)\s/.test(trimmed)) return true;
  // 상태줄 구분자 (middle dot ·) 2개 이상
  if ((trimmed.match(/·/g) || []).length >= 2) return true;
  // 진행 바 문자 (블록 유니코드)
  if (/[█▓▒░]{3,}/.test(trimmed)) return true;
  // 구분선만으로 이루어진 줄
  if (/^[─━═╌╍┄┅─]{5,}$/.test(trimmed)) return true;
  // "esc to interrupt" 힌트
  if (/esc to interrupt/i.test(trimmed)) return true;
  // 스피너 문자로 시작
  if (/^[◦•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏►▶▷]/.test(trimmed)) return true;
  // MCP 서버 진행 상황
  if (/MCP\s*servers?\s*\(/i.test(trimmed)) return true;
  // 진행 분수
  if (/^\(\d+\/\d+\)/.test(trimmed)) return true;
  // 연결/작업 상태 메시지
  if (/^(Reconnect|Work|Connect|Start)ing\.{0,3}\s*$/i.test(trimmed)) return true;
  // 퍼센트 컨텍스트 표시
  if (/\d+%\s*(left|used|context)/i.test(trimmed)) return true;
  // 프롬프트 제안 마커
  if (/^›/.test(trimmed)) return true;
  return false;
}

// PTY transient 라인 정규화 (spinner 문자 제거, 공백 정리)
function normalizeTransientPtyLine(line) {
  return String(line || '')
    .replace(/^[◦•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏►▶▷]+\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// PTY 라인을 content/progress/status/ignore로 분류
function classifyPtyLine(rawLine) {
  const raw = String(rawLine || '');
  const line = normalizeTransientPtyLine(raw);
  if (!line) return { kind: 'ignore', text: '' };

  // 항상 하단에 고정해서 보여줄 상태선
  if (
    (line.match(/·/g) || []).length >= 2 ||
    /\d+%\s*(left|used|context)/i.test(line) ||
    /esc to interrupt/i.test(line) ||
    /MCP\s*servers?\s*\(/i.test(line) ||
    /^[a-z0-9][\w.-]*\s+(suggest|auto-edit|full-auto|ask-every-time)\s/i.test(line)
  ) {
    return { kind: 'status', text: line };
  }

  // 한 줄에서 갱신해야 하는 진행 문구
  if (
    /^\(\d+\/\d+\)/.test(line) ||
    /^(Reconnect|Work|Connect|Start|Search|Read|Analyze|Plan|Run|Apply|Review)(?:ing)?\.{0,3}\b/i.test(line) ||
    /^[◦•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏►▶▷]/u.test(raw)
  ) {
    return { kind: 'progress', text: line };
  }

  // 완전 노이즈만 버림
  if (/^[─━═╌╍┄┅─]{5,}$/u.test(line) || /[█▓▒░]{3,}/u.test(line)) {
    return { kind: 'ignore', text: '' };
  }
  // 배너 프레임 (유니코드 박스 문자로만 구성)
  if (/^[╭╮╰╯┌┐└┘─│┃┄┈═╔╗╚╝║\s]+$/u.test(line)) {
    return { kind: 'ignore', text: '' };
  }
  // 프롬프트 대기 마커
  if (/^>\s*$/.test(line)) {
    return { kind: 'ignore', text: '' };
  }

  return { kind: 'content', text: raw.trimEnd() };
}

// cli:stream 이벤트 헬퍼
function emitCliStream(id, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('cli:stream', { id, ...payload });
  }
}

// 턴 완료 감지: 충분한 콘텐츠 출력 후 idle이면 턴 완료로 판정
function detectTurnCompletion(buf, mainWindow, id) {
  if (!buf.hasContentOutput) return;

  if (buf.turnEndTimeout) clearTimeout(buf.turnEndTimeout);
  buf.turnEndTimeout = setTimeout(() => {
    const now = Date.now();
    if (now - buf.lastTurnEndAt < 800) return;
    // 충분한 콘텐츠(50자 이상)가 쌓여야 턴 완료로 인정
    // 배너/노이즈만 있는 경우 턴 완료를 발생시키지 않음
    if ((buf.contentLength || 0) < 50) {
      buf.hasContentOutput = false;
      return;
    }
    buf.lastTurnEndAt = now;
    buf.hasContentOutput = false;
    buf.contentLength = 0;
    buf.turnDetectBuffer = '';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cli:turnDone', { id });
    }
  }, 800);
}

// 미완성 ANSI 시퀀스 감지: 문자열 끝에 잘린 ESC 시퀀스가 있으면 분리
function splitAnsiSafe(text) {
  // 끝에서 ESC(\x1B) 이후 완성되지 않은 시퀀스 찾기
  const lastEsc = text.lastIndexOf('\x1B');
  if (lastEsc === -1) return { clean: text, fragment: '' };

  const after = text.substring(lastEsc);
  // 완성된 ANSI 시퀀스인지 확인
  if (/^\x1B\[[0-9;]*[A-Za-z]/.test(after)) return { clean: text, fragment: '' };
  if (/^\x1B\].*?(?:\x07|\x1B\\)/.test(after)) return { clean: text, fragment: '' };
  if (/^\x1B\[\?[0-9;]*[hl]/.test(after)) return { clean: text, fragment: '' };
  if (/^\x1B\([A-Z0-9]/.test(after)) return { clean: text, fragment: '' };
  if (/^\x1B[=>MNOP78]/.test(after)) return { clean: text, fragment: '' };

  // 미완성 → 분리
  return { clean: text.substring(0, lastEsc), fragment: after };
}

function resolveFilePath(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/^['"]|['"]$/g, '');
  return path.normalize(path.isAbsolute(cleaned) ? cleaned : path.join(workingDirectory, cleaned));
}

function resolveOpenFileTarget(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return { resolvedPath: '', line: null };

  let value = raw.replace(/^['"]|['"]$/g, '');
  let line = null;

  const lineMatch = /#L(\d+)$/i.exec(value);
  if (lineMatch) {
    const parsedLine = Number(lineMatch[1]);
    line = Number.isFinite(parsedLine) && parsedLine > 0 ? parsedLine : null;
    value = value.slice(0, lineMatch.index);
  }

  if (/^file:\/\//i.test(value)) {
    try {
      const fileUrl = new URL(value);
      value = decodeURIComponent(fileUrl.pathname || '');
    } catch {
      // invalid file url - fallback to raw path parsing
    }
  } else {
    try {
      value = decodeURIComponent(value);
    } catch {
      // ignore malformed percent encoding
    }
  }

  // renderer에서 /C:/... 형식으로 전달하는 Windows 절대경로 보정
  if (/^\/[A-Za-z]:\//.test(value)) {
    value = value.slice(1);
  }

  // URL 형태로 전달된 경로를 OS 경로 형태로 복원
  if (value.includes('/')) {
    value = value.replace(/\//g, path.sep);
  }

  return {
    resolvedPath: resolveFilePath(value),
    line,
  };
}

function runGitCommandAsync(args, cwd) {
  return new Promise((resolve) => {
    try {
      const child = spawn('git', args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      child.stdout?.on('data', (data) => {
        stdout += typeof data === 'string' ? data : data.toString('utf8');
      });
      child.stderr?.on('data', (data) => {
        stderr += typeof data === 'string' ? data : data.toString('utf8');
      });
      child.on('error', (error) => {
        finish({
          ok: false,
          status: 1,
          stdout,
          stderr,
          error: String(error?.message || error),
        });
      });
      child.on('close', (status) => {
        finish({
          ok: Number(status) === 0,
          status: Number.isFinite(Number(status)) ? Number(status) : 1,
          stdout,
          stderr,
          error: '',
        });
      });
    } catch (error) {
      resolve({
        ok: false,
        status: 1,
        stdout: '',
        stderr: '',
        error: String(error?.message || error),
      });
    }
  });
}

function normalizeRepoFilePath(inputPath, repoRoot, fallbackCwd) {
  const raw = String(inputPath || '').trim();
  if (!raw) return '';

  const { resolvedPath } = resolveOpenFileTarget(raw);
  let absolutePath = resolvedPath;
  if (!absolutePath) {
    const candidate = raw.replace(/^['"]|['"]$/g, '').replace(/^\/([A-Za-z]:[\\/])/, '$1');
    absolutePath = path.isAbsolute(candidate) ? candidate : path.join(fallbackCwd, candidate);
  }
  if (!absolutePath) return '';

  const normalizedAbs = path.normalize(absolutePath);
  const normalizedRoot = path.normalize(repoRoot);
  const rel = path.relative(normalizedRoot, normalizedAbs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.replace(/\\/g, '/');
}

function classifyFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (BINARY_DOC_EXTENSIONS.has(ext)) return 'document';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
  return 'text';
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.tiff': 'image/tiff', '.tif': 'image/tiff',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

function readTextFilePreview(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) {
      return { success: false, error: '파일을 찾을 수 없습니다.' };
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      return { success: false, error: '파일 경로가 올바르지 않습니다.' };
    }

    const readBytes = Math.min(stat.size, MAX_FILE_IMPORT_BYTES);
    const fd = fs.openSync(targetPath, 'r');
    const buffer = Buffer.alloc(readBytes);

    try {
      fs.readSync(fd, buffer, 0, readBytes, 0);
    } finally {
      fs.closeSync(fd);
    }

    if (buffer.includes(0)) {
      return { success: false, error: '텍스트 파일만 불러올 수 있습니다.' };
    }

    return {
      success: true,
      path: targetPath,
      fileType: 'text',
      content: buffer.toString('utf8'),
      size: stat.size,
      truncated: stat.size > MAX_FILE_IMPORT_BYTES,
      maxBytes: MAX_FILE_IMPORT_BYTES,
    };
  } catch (error) {
    return { success: false, error: error.message || '파일을 읽는 중 오류가 발생했습니다.' };
  }
}

function readFileGeneric(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) {
      return { success: false, error: '파일을 찾을 수 없습니다.' };
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      return { success: false, error: '파일 경로가 올바르지 않습니다.' };
    }

    const fileType = classifyFileType(targetPath);
    const mimeType = getMimeType(targetPath);
    const fileName = path.basename(targetPath);

    if (fileType === 'image') {
      if (stat.size > MAX_IMAGE_IMPORT_BYTES) {
        return { success: false, error: `이미지 파일이 너무 큽니다. (최대 ${Math.round(MAX_IMAGE_IMPORT_BYTES / 1024 / 1024)}MB)` };
      }
      const raw = fs.readFileSync(targetPath);
      const base64 = raw.toString('base64');
      const dataUrl = `data:${mimeType};base64,${base64}`;
      return {
        success: true,
        path: targetPath,
        fileName,
        fileType: 'image',
        mimeType,
        base64,
        dataUrl,
        size: stat.size,
        truncated: false,
      };
    }

    if (fileType === 'pdf') {
      if (stat.size > MAX_PDF_IMPORT_BYTES) {
        return { success: false, error: `PDF 파일이 너무 큽니다. (최대 ${Math.round(MAX_PDF_IMPORT_BYTES / 1024 / 1024)}MB)` };
      }
      const raw = fs.readFileSync(targetPath);
      const base64 = raw.toString('base64');
      return {
        success: true,
        path: targetPath,
        fileName,
        fileType: 'pdf',
        mimeType,
        base64,
        size: stat.size,
        truncated: false,
      };
    }

    if (fileType === 'document' || fileType === 'archive') {
      return {
        success: true,
        path: targetPath,
        fileName,
        fileType,
        mimeType,
        size: stat.size,
        truncated: false,
        content: `[${fileType === 'archive' ? '압축' : '문서'} 파일] ${fileName} (${formatFileSizeLabel(stat.size)})`,
      };
    }

    // 텍스트 파일 (기본)
    return readTextFilePreview(targetPath);
  } catch (error) {
    return { success: false, error: error.message || '파일을 읽는 중 오류가 발생했습니다.' };
  }
}

function readFilesGeneric(filePaths, limit = 10) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { success: false, error: '파일 경로가 없습니다.', files: [] };
  }

  const results = [];
  for (const fp of filePaths.slice(0, limit)) {
    const resolved = resolveFilePath(fp) || fp;
    results.push(readFileGeneric(resolved));
  }

  const successCount = results.filter(item => item?.success).length;
  return {
    success: successCount > 0,
    error: successCount > 0 ? '' : (results[0]?.error || '파일을 불러오지 못했습니다.'),
    files: results,
    limit,
    selectionLimited: filePaths.length > limit,
  };
}

function formatFileSizeLabel(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// --- 작업 디렉토리 관리 ---
let workingDirectory = os.homedir();

function resolveInitialCwd() {
  // 1순위: --cwd 명령줄 인자
  const args = process.argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd' && args[i + 1]) {
      const dir = args[i + 1];
      try {
        if (fs.statSync(dir).isDirectory()) return dir;
      } catch { /* ignore */ }
    }
    if (args[i].startsWith('--cwd=')) {
      const dir = args[i].slice(6);
      try {
        if (fs.statSync(dir).isDirectory()) return dir;
      } catch { /* ignore */ }
    }
  }

  // 2순위: 마지막 인자가 존재하는 폴더 경로이면 사용
  const lastArg = args[args.length - 1];
  if (lastArg && !lastArg.startsWith('-')) {
    try {
      const stat = fs.statSync(lastArg);
      if (stat.isDirectory()) return lastArg;
    } catch { /* ignore */ }
  }

  return os.homedir();
}

function createWindow() {
  workingDirectory = resolveInitialCwd();

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1100, Math.floor(width * 0.7)),
    height: Math.min(850, Math.floor(height * 0.85)),
    minWidth: 500,
    minHeight: 400,
    frame: false,
    transparent: false,
    backgroundColor: '#0C0C1E',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 렌더러 로그 캡처
  mainWindow.webContents.on('console-message', (e, level, msg, line, src) => {
    const tag = ['LOG', 'WARN', 'ERR'][level] || 'LOG';
    console.log(`[R:${tag}] ${msg}`);
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximized', false);
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') mainWindow.webContents.toggleDevTools();
    if (input.key === 'F11') mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('closed', () => {
    if (manualWindow && !manualWindow.isDestroyed()) {
      manualWindow.close();
    }
    manualWindow = null;
    for (const [, handle] of runningProcesses) {
      try { handle.kill(); } catch (e) { /* ignore */ }
    }
    runningProcesses.clear();
    processBuffers.clear();
    mainWindow = null;
  });
}

function openManualWindow() {
  if (manualWindow && !manualWindow.isDestroyed()) {
    if (manualWindow.isMinimized()) manualWindow.restore();
    manualWindow.focus();
    return { success: true };
  }

  manualWindow = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 680,
    minHeight: 500,
    parent: mainWindow || undefined,
    autoHideMenuBar: true,
    backgroundColor: '#101122',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  manualWindow.loadFile(path.join(__dirname, 'renderer', 'manual.html'));
  manualWindow.once('ready-to-show', () => manualWindow?.show());
  manualWindow.on('closed', () => {
    manualWindow = null;
  });

  return { success: true };
}

// --- CLI 경로 자동 탐색 ---
function resolveCliPath(command) {
  // 이미 절대 경로면 그대로
  if (command.includes('\\') || command.includes('/')) {
    if (fs.existsSync(command)) return command;
    if (fs.existsSync(command + '.cmd')) return command + '.cmd';
    if (fs.existsSync(command + '.exe')) return command + '.exe';
    return command;
  }

  // 캐시 확인
  if (resolvedCliPaths[command]) {
    if (fs.existsSync(resolvedCliPaths[command])) return resolvedCliPaths[command];
    delete resolvedCliPaths[command];
  }

  const isWin = process.platform === 'win32';
  const extensions = isWin ? ['.cmd', '.exe', ''] : [''];
  const candidates = [];

  // 1. npm global 경로 (npm prefix -g)
  try {
    const npmGlobal = execSync('npm prefix -g', { encoding: 'utf8', timeout: 5000 }).trim();
    if (npmGlobal) {
      for (const ext of extensions) {
        candidates.push(path.join(npmGlobal, command + ext));
        if (isWin) candidates.push(path.join(npmGlobal, 'node_modules', '.bin', command + ext));
      }
    }
  } catch { /* ignore */ }

  // 2. %APPDATA%\npm (Windows npm global 기본 경로)
  if (isWin) {
    const appData = process.env.APPDATA;
    if (appData) {
      for (const ext of extensions) {
        candidates.push(path.join(appData, 'npm', command + ext));
      }
    }
  }

  // 3. nvm / fnm / volta 등 버전 관리자 경로
  const homedir = os.homedir();
  const extraDirs = isWin
    ? [
        path.join(homedir, '.nvm', 'versions'),
        path.join(homedir, 'scoop', 'shims'),
        path.join(homedir, 'scoop', 'apps', 'nodejs', 'current'),
        path.join(homedir, '.volta', 'bin'),
        path.join(homedir, '.fnm', 'node-versions'),
      ]
    : [
        path.join(homedir, '.nvm', 'versions'),
        path.join(homedir, '.volta', 'bin'),
        path.join(homedir, '.fnm', 'node-versions'),
        '/usr/local/bin',
        '/usr/bin',
      ];

  for (const dir of extraDirs) {
    for (const ext of extensions) {
      candidates.push(path.join(dir, command + ext));
    }
  }

  // 4. PATH 환경변수에서 직접 탐색
  const pathDirs = (process.env.PATH || '').split(isWin ? ';' : ':');
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      candidates.push(path.join(dir, command + ext));
    }
  }

  // 후보 중 실제 존재하는 첫 번째 반환
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        console.log(`[CLI] resolved '${command}' → ${candidate}`);
        resolvedCliPaths[command] = candidate;
        return candidate;
      }
    } catch { /* ignore */ }
  }

  // 못 찾으면 원래 이름 + .cmd (기존 동작)
  console.log(`[CLI] could not resolve '${command}', falling back to '${command}.cmd'`);
  return isWin ? `${command}.cmd` : command;
}

function createProcessHandle(kind, proc) {
  if (kind === 'spawn') {
    return {
      kind,
      proc,
      write(data) {
        if (!proc || !proc.stdin || proc.stdin.destroyed) return;
        try { proc.stdin.write(String(data || '')); } catch { /* ignore */ }
      },
      kill() {
        if (!proc) return;
        try {
          if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
        } catch { /* ignore */ }
        try { proc.kill(); } catch { /* ignore */ }
      },
    };
  }

  return {
    kind: 'pty',
    proc,
    write(data) {
      if (!proc) return;
      try { proc.write(String(data || '')); } catch { /* ignore */ }
    },
    kill() {
      if (!proc) return;
      try { proc.kill(); } catch { /* ignore */ }
    },
  };
}

function sanitizeCliEnv(rawEnv) {
  const source = { ...(rawEnv || {}) };
  const env = {};
  const allow = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'WINDIR',
    'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
    'OS', 'USERNAME', 'USERDOMAIN',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
    'TERM', 'WT_SESSION', 'LANG', 'LC_ALL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
  ]);

  for (const [key, value] of Object.entries(source)) {
    const upper = String(key || '').toUpperCase();
    if (!allow.has(upper)) continue;
    env[key] = value;
  }
  return env;
}

function resolveCodexDirectInvocation(commandName, resolvedShell) {
  const command = String(commandName || '').trim().toLowerCase();
  if (command !== 'codex') return null;

  const shellPath = String(resolvedShell || '').trim();
  if (!shellPath) return null;

  const baseDir = path.dirname(shellPath);
  const codexJsPath = path.join(baseDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!fs.existsSync(codexJsPath)) return null;

  const localNodeExe = path.join(baseDir, 'node.exe');
  const nodeCommand = fs.existsSync(localNodeExe) ? localNodeExe : 'node';
  return {
    command: nodeCommand,
    argsPrefix: [codexJsPath],
  };
}

function shouldUseCodexStdinPrompt(commandName, args, useSpawnMode, promptText) {
  if (!useSpawnMode || !promptText) return false;

  const rawCommand = String(commandName || '').trim();
  const normalized = rawCommand.toLowerCase();
  const isCodexCommand = normalized === 'codex'
    || /(?:^|[\\/])codex(?:\.(?:cmd|ps1|exe))?$/i.test(rawCommand);
  if (!isCodexCommand) return false;

  return (Array.isArray(args) ? args : [])
    .some((arg) => String(arg || '').trim().toLowerCase() === 'exec');
}

function isAllowedCliCommand(commandName) {
  const rawCommand = String(commandName || '').trim();
  if (!rawCommand) return false;
  const normalized = rawCommand.toLowerCase();
  return normalized === 'codex'
    || /(?:^|[\\/])codex(?:\.(?:cmd|ps1|exe))?$/i.test(rawCommand);
}

function normalizeCliArgs(args) {
  if (!Array.isArray(args)) return [];
  return args
    .slice(0, 120)
    .map(arg => String(arg ?? ''))
    .filter(arg => arg.length <= 4096);
}

function resolveExistingDirectory(inputDir, fallbackDir = workingDirectory) {
  const raw = String(inputDir || '').trim();
  const candidate = raw || fallbackDir || os.homedir();
  try {
    const stat = fs.statSync(candidate);
    if (stat.isDirectory()) return candidate;
  } catch {
    // fall through to fallback
  }
  try {
    const stat = fs.statSync(fallbackDir);
    if (stat.isDirectory()) return fallbackDir;
  } catch {
    // fall through to homedir
  }
  return os.homedir();
}

function formatCliArgsForLog(args, maxLen = 160) {
  return (Array.isArray(args) ? args : []).map((arg) => {
    const value = String(arg ?? '');
    return value.length > maxLen
      ? `${value.slice(0, maxLen)}... (${value.length} chars)`
      : value;
  });
}

function normalizeCodexReasoningEffort(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (normalized === 'xhigh') return 'extra high';
  if (normalized === 'extra high' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return '';
}

function normalizeCodexModelCatalog(rawCatalog, source) {
  const models = Array.isArray(rawCatalog?.models) ? rawCatalog.models : [];
  const normalized = [];
  const seen = new Set();

  for (const model of models) {
    const slug = String(model?.slug || model?.id || '').trim();
    if (!slug) continue;
    if (model?.visibility && String(model.visibility).toLowerCase() !== 'list') continue;
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const supportedReasoning = Array.isArray(model?.supported_reasoning_levels)
      ? model.supported_reasoning_levels
          .map(item => normalizeCodexReasoningEffort(item?.effort || item))
          .filter(Boolean)
      : [];

    normalized.push({
      id: slug,
      cliModel: slug,
      label: String(model?.display_name || slug).trim(),
      description: String(model?.description || '').trim(),
      defaultReasoning: normalizeCodexReasoningEffort(model?.default_reasoning_level),
      supportedReasoning,
      source,
      priority: Number.isFinite(Number(model?.priority)) ? Number(model.priority) : 999,
    });
  }

  return normalized;
}

function runCodexModelCatalogCommand(args, timeoutMs = CODEX_MODEL_CATALOG_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child = null;
    let timer = null;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      const codexPath = resolveCliPath('codex');
      const directInvocation = resolveCodexDirectInvocation('codex', codexPath);
      const spawnCmd = directInvocation ? directInvocation.command : codexPath;
      const spawnArgs = directInvocation ? [...directInvocation.argsPrefix, ...args] : args;
      const isWindowsCmdShim = process.platform === 'win32' && /\.cmd$/i.test(codexPath);

      child = spawn(spawnCmd, spawnArgs, {
        cwd: workingDirectory,
        env: sanitizeCliEnv({ ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }),
        windowsHide: true,
        shell: isWindowsCmdShim && !directInvocation,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (data) => { stdout += data.toString('utf8'); });
      child.stderr?.on('data', (data) => { stderr += data.toString('utf8'); });
      child.on('error', (error) => finish({ ok: false, stdout, stderr, error: error.message || String(error) }));
      child.on('close', (code) => finish({
        ok: Number(code) === 0,
        stdout,
        stderr,
        error: Number(code) === 0 ? '' : (stderr.trim() || `codex debug models exited with code ${code}`),
      }));

      timer = setTimeout(() => {
        try { child?.kill(); } catch { /* ignore */ }
        finish({ ok: false, stdout, stderr, error: 'codex model catalog timed out' });
      }, timeoutMs);
    } catch (error) {
      finish({ ok: false, stdout: '', stderr: '', error: error.message || String(error) });
    }
  });
}

function runCodexInfoCommand(args, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || CODEX_COMMAND_CATALOG_TIMEOUT_MS;
  const runCwd = resolveExistingDirectory(options.cwd, workingDirectory);
  return new Promise((resolve) => {
    let child = null;
    let timer = null;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      const codexPath = resolveCliPath('codex');
      const directInvocation = resolveCodexDirectInvocation('codex', codexPath);
      const spawnCmd = directInvocation ? directInvocation.command : codexPath;
      const spawnArgs = directInvocation ? [...directInvocation.argsPrefix, ...args] : args;
      const isWindowsCmdShim = process.platform === 'win32' && /\.cmd$/i.test(codexPath);

      child = spawn(spawnCmd, spawnArgs, {
        cwd: runCwd,
        env: sanitizeCliEnv({ ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }),
        windowsHide: true,
        shell: isWindowsCmdShim && !directInvocation,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (data) => { stdout += data.toString('utf8'); });
      child.stderr?.on('data', (data) => { stderr += data.toString('utf8'); });
      child.on('error', (error) => finish({ ok: false, stdout, stderr, error: error.message || String(error), cwd: runCwd }));
      child.on('close', (code) => finish({
        ok: Number(code) === 0,
        stdout,
        stderr,
        error: Number(code) === 0 ? '' : (stderr.trim() || `codex info command exited with code ${code}`),
        cwd: runCwd,
      }));

      timer = setTimeout(() => {
        try { child?.kill(); } catch { /* ignore */ }
        finish({ ok: false, stdout, stderr, error: 'codex info command timed out', cwd: runCwd });
      }, timeoutMs);
    } catch (error) {
      finish({ ok: false, stdout: '', stderr: '', error: error.message || String(error), cwd: runCwd });
    }
  });
}

function parseCodexHelpCommands(helpText) {
  const lines = String(helpText || '').split(/\r?\n/);
  const commands = [];
  let inCommands = false;
  let current = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (/^Commands:\s*$/.test(trimmed)) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (/^(Arguments|Options):\s*$/.test(trimmed)) break;
    if (!trimmed.trim()) {
      current = null;
      continue;
    }

    const commandMatch = trimmed.match(/^\s{2,}([a-z][a-z0-9-]*)(?:\s{2,}|\t+)(.+)$/i);
    if (commandMatch) {
      const name = commandMatch[1].trim();
      let description = commandMatch[2].trim();
      const aliases = [];
      description = description.replace(/\[aliases?:\s*([^\]]+)\]/ig, (_, rawAliases) => {
        rawAliases.split(',').map(item => item.trim()).filter(Boolean).forEach(alias => aliases.push(alias));
        return '';
      }).trim();
      current = { name, description, aliases };
      commands.push(current);
      continue;
    }

    if (current && /^\s{12,}\S/.test(trimmed)) {
      current.description = `${current.description} ${trimmed.trim()}`.trim();
    }
  }

  const seen = new Set();
  return commands.filter((command) => {
    if (!command.name || seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
}

async function fetchCodexCommandCatalog(cwd) {
  const result = await runCodexInfoCommand(['--help'], { cwd, timeoutMs: CODEX_COMMAND_CATALOG_TIMEOUT_MS });
  if (!result.ok || !result.stdout.trim()) {
    return {
      success: false,
      source: 'codex-help',
      cwd: result.cwd || resolveExistingDirectory(cwd, workingDirectory),
      error: result.error || 'codex --help produced no output',
      commands: [],
    };
  }
  return {
    success: true,
    source: 'codex-help',
    cwd: result.cwd || resolveExistingDirectory(cwd, workingDirectory),
    commands: parseCodexHelpCommands(result.stdout),
  };
}

async function fetchCodexModelCatalog() {
  const attempts = [
    { args: ['debug', 'models'], source: 'codex-debug' },
    { args: ['debug', 'models', '--bundled'], source: 'codex-bundled' },
  ];

  for (const attempt of attempts) {
    const result = await runCodexModelCatalogCommand(attempt.args);
    if (!result.ok || !result.stdout.trim()) continue;
    try {
      const parsed = JSON.parse(result.stdout.trim());
      const models = normalizeCodexModelCatalog(parsed, attempt.source);
      if (models.length > 0) {
        return { success: true, source: attempt.source, models };
      }
    } catch {
      // Try the next source if Codex emitted non-JSON output.
    }
  }

  return {
    success: true,
    source: 'fallback',
    models: FALLBACK_CODEX_MODELS.map(model => ({ ...model })),
  };
}

function getCodexConfigPath() {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function stripTomlComment(rawValue) {
  const text = String(rawValue || '');
  let quote = '';
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && ch === '\\') {
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (quote && ch === quote) {
      quote = '';
      continue;
    }
    if (!quote && ch === '#') {
      return text.slice(0, i).trim();
    }
  }
  return text.trim();
}

function parseTomlPrimitive(rawValue) {
  const value = stripTomlComment(rawValue);
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const body = value.slice(1, -1);
    return value.startsWith('"')
      ? body.replace(/\\(["\\btnfr])/g, (match, ch) => {
          const map = { '"': '"', '\\': '\\', b: '\b', t: '\t', n: '\n', f: '\f', r: '\r' };
          return Object.prototype.hasOwnProperty.call(map, ch) ? map[ch] : match;
        })
      : body;
  }
  if (/^(true|false)$/i.test(value)) return /^true$/i.test(value);
  if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseCodexConfigValues(raw) {
  const values = {};
  let section = '';
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const settingMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!settingMatch) continue;
    const localKey = settingMatch[1].trim();
    const dottedKey = section ? `${section}.${localKey}` : localKey;
    if (!Object.prototype.hasOwnProperty.call(CODEX_CONFIG_FIELDS, dottedKey)) continue;
    values[dottedKey] = parseTomlPrimitive(settingMatch[2]);
  }
  return values;
}

function encodeTomlString(value) {
  return `"${String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

function formatTomlPrimitive(value, def) {
  if (def.type === 'boolean') return value ? 'true' : 'false';
  if (def.type === 'number') return String(Number(value));
  return encodeTomlString(value);
}

function normalizeCodexConfigInput(key, value) {
  const def = CODEX_CONFIG_FIELDS[key];
  if (!def) return { ok: false, error: `unsupported setting: ${key}` };
  if (value === null || value === undefined || value === '') {
    return { ok: true, unset: true };
  }
  if (def.type === 'boolean') {
    if (value === true || value === false) return { ok: true, value };
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'true') return { ok: true, value: true };
    if (normalized === 'false') return { ok: true, value: false };
    return { ok: false, error: `${key} must be boolean` };
  }
  if (def.type === 'enum') {
    const normalized = String(value).trim().toLowerCase();
    if (def.values.includes(normalized)) return { ok: true, value: normalized };
    return { ok: false, error: `${key} must be one of: ${def.values.join(', ')}` };
  }
  const text = String(value).trim();
  if (text.length > (def.maxLength || 4096)) {
    return { ok: false, error: `${key} is too long` };
  }
  return { ok: true, value: text };
}

function splitCodexConfigKey(dottedKey) {
  const parts = String(dottedKey || '').split('.');
  if (parts.length === 1) return { section: '', localKey: parts[0] };
  return { section: parts.slice(0, -1).join('.'), localKey: parts[parts.length - 1] };
}

function upsertTomlValue(raw, dottedKey, normalized) {
  const { section, localKey } = splitCodexConfigKey(dottedKey);
  const def = CODEX_CONFIG_FIELDS[dottedKey];
  const lines = String(raw || '').split(/\r?\n/);
  let currentSection = '';
  let sectionStart = section ? -1 : 0;
  let sectionEnd = lines.length;
  let keyLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      if (sectionStart >= 0 && sectionEnd === lines.length) sectionEnd = i;
      currentSection = sectionMatch[1].trim();
      if (currentSection === section) {
        sectionStart = i;
        sectionEnd = lines.length;
      }
      continue;
    }
    if (currentSection !== section) continue;
    const settingMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (settingMatch && settingMatch[1].trim() === localKey) {
      keyLine = i;
      break;
    }
  }

  if (normalized.unset) {
    if (keyLine >= 0) lines.splice(keyLine, 1);
    return lines.join('\n').replace(/\s+$/g, '') + '\n';
  }

  const nextLine = `${localKey} = ${formatTomlPrimitive(normalized.value, def)}`;
  if (keyLine >= 0) {
    lines[keyLine] = nextLine;
    return lines.join('\n').replace(/\s+$/g, '') + '\n';
  }

  if (!section) {
    let insertAt = 0;
    while (insertAt < lines.length && lines[insertAt].trim().startsWith('#')) insertAt++;
    lines.splice(insertAt, 0, nextLine);
    return lines.join('\n').replace(/\s+$/g, '') + '\n';
  }

  if (sectionStart >= 0) {
    lines.splice(sectionEnd, 0, nextLine);
  } else {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('');
    lines.push(`[${section}]`, nextLine);
  }
  return lines.join('\n').replace(/\s+$/g, '') + '\n';
}

function readCodexConfigFile() {
  const filePath = getCodexConfigPath();
  if (!fs.existsSync(filePath)) {
    return { filePath, exists: false, raw: '' };
  }
  return {
    filePath,
    exists: true,
    raw: fs.readFileSync(filePath, 'utf8'),
  };
}

function parseSkillFrontMatter(raw) {
  const text = String(raw || '');
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = text.slice(3, end).trim();
  const meta = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[match[1].trim()] = value;
  }
  return meta;
}

function readSkillFile(skillPath, scope) {
  const raw = fs.readFileSync(skillPath, 'utf8');
  const meta = parseSkillFrontMatter(raw);
  const dir = path.dirname(skillPath);
  const fallbackName = path.basename(dir);
  const name = String(meta.name || fallbackName).trim();
  if (!name) return null;
  return {
    name,
    description: String(meta.description || '').trim(),
    scope,
    path: skillPath,
  };
}

function collectSkillFiles(rootDir, scope) {
  const skills = [];
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) return skills;
  const maxDepth = 5;
  const stack = [{ dir: root, depth: 0 }];
  const seenDirs = new Set();

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || seenDirs.has(item.dir) || item.depth > maxDepth) continue;
    seenDirs.add(item.dir);

    let entries = [];
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const skillFile = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === 'skill.md');
    if (skillFile) {
      try {
        const skill = readSkillFile(path.join(item.dir, skillFile.name), scope);
        if (skill) skills.push(skill);
      } catch {
        // Ignore unreadable skill files.
      }
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      stack.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 });
    }
  }

  return skills;
}

function listCodexSkills(cwd) {
  const runCwd = resolveExistingDirectory(cwd, workingDirectory);
  const candidates = [
    { root: path.join(os.homedir(), '.codex', 'skills'), scope: 'user' },
    { root: path.join(runCwd, '.codex', 'skills'), scope: 'project' },
    { root: path.join(runCwd, '.agents', 'skills'), scope: 'project' },
  ];
  const merged = [];
  const seen = new Set();

  for (const candidate of candidates) {
    for (const skill of collectSkillFiles(candidate.root, candidate.scope)) {
      const key = `${skill.scope}:${skill.name.toLowerCase()}:${skill.path.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(skill);
    }
  }

  merged.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { cwd: runCwd, skills: merged };
}

// --- CLI 실행 (node-pty 기반 PTY) ---
ipcMain.handle('cli:run', (event, request = {}) => {
  const { id, profile = {}, prompt, cwd } = request || {};
  const shell = profile.command;
  if (!id || typeof id !== 'string') {
    return { success: false, error: 'stream id required' };
  }
  if (runningProcesses.has(id)) {
    return { success: false, error: 'stream id is already running' };
  }
  if (!isAllowedCliCommand(shell)) {
    return { success: false, error: 'unsupported CLI command' };
  }
  const promptText = typeof prompt === 'string' ? prompt : '';
  const baseArgs = normalizeCliArgs(profile.args);
  const runCwd = resolveExistingDirectory(cwd, workingDirectory);
  const requestedMode = String(profile?.mode || '').trim().toLowerCase();
  const requestedPtyMode = requestedMode === 'pty' || requestedMode === 'interactive';
  const isJsonMode = baseArgs.some((arg) => String(arg).trim().toLowerCase() === '--json');
  const forceSpawnMode = process.platform === 'win32'
    && String(shell || '').toLowerCase() === 'codex'
    && !requestedPtyMode;
  const useSpawnMode = requestedPtyMode ? false : (isJsonMode || forceSpawnMode || requestedMode === 'pipe');
  const useStdinPrompt = shouldUseCodexStdinPrompt(shell, baseArgs, useSpawnMode, promptText);
  const args = promptText
    ? [...baseArgs, '--', useStdinPrompt ? '-' : promptText]
    : [...baseArgs];

  const promptLog = promptText
    ? `${promptText.length} chars/${promptText.split(/\r?\n/).length} lines via ${useStdinPrompt ? 'stdin' : 'argv'}`
    : 'none';
  console.log(`[CLI] run id=${id} shell=${shell} prompt=${promptLog} args=${JSON.stringify(formatCliArgsForLog(args))} cwd=${runCwd}`);

  try {
    const env = sanitizeCliEnv({ ...process.env, ...(profile.env || {}), FORCE_COLOR: '0' });

    // CLI 경로 자동 탐색 (npm global, PATH 등)
    const resolvedShell = resolveCliPath(shell);

    if (useSpawnMode) {
      // exec/pipe 모드는 PTY 대신 spawn으로 실행해 줄바꿈/폭 래핑 손상을 줄인다.
      const isWindowsCmdShim = process.platform === 'win32' && /\.cmd$/i.test(resolvedShell);
      let spawnCommand = resolvedShell;
      let spawnArgs = args;
      const spawnOptions = {
        cwd: runCwd,
        env,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      };

      const directCodexInvocation = resolveCodexDirectInvocation(shell, resolvedShell);
      if (directCodexInvocation) {
        spawnCommand = directCodexInvocation.command;
        spawnArgs = [...directCodexInvocation.argsPrefix, ...args];
      } else if (isWindowsCmdShim) {
        const ps1Path = resolvedShell.replace(/\.cmd$/i, '.ps1');
        if (fs.existsSync(ps1Path)) {
          // npm 전역 codex.cmd shim은 shell 경유 시 인자 쪼개짐이 발생할 수 있어 ps1 직접 실행
          const powerShellExe = path.join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe'
          );
          spawnCommand = powerShellExe;
          spawnArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, ...args];
        } else {
          throw new Error('codex .cmd shim cannot be launched safely without a .ps1 shim');
        }
      }

      const child = spawn(spawnCommand, spawnArgs, spawnOptions);

      runningProcesses.set(id, createProcessHandle('spawn', child));

      if (useStdinPrompt && child.stdin && !child.stdin.destroyed) {
        try {
          const stdinPayload = /\r?\n$/.test(promptText) ? promptText : `${promptText}\n`;
          child.stdin.end(stdinPayload);
        } catch (err) {
          console.warn(`[CLI] stdin prompt write failed id=${id}: ${err.message}`);
        }
      }

      child.stdout?.on('data', (data) => {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        if (!text || !mainWindow || mainWindow.isDestroyed()) return;
        const chunk = isJsonMode ? text : stripAnsi(text);
        if (!chunk) return;
        mainWindow.webContents.send('cli:stream', { id, chunk, type: 'stdout' });
      });

      child.stderr?.on('data', (data) => {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        if (!text || !mainWindow || mainWindow.isDestroyed()) return;
        const chunk = isJsonMode ? text : stripAnsi(text);
        if (!chunk) return;
        mainWindow.webContents.send('cli:stream', { id, chunk, type: 'stderr' });
      });

      child.on('error', (err) => {
        console.log(`[CLI] error id=${id} err=${err.message}`);
        runningProcesses.delete(id);
        processBuffers.delete(id);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cli:error', { id, error: err.message });
        }
      });

      child.on('close', (code) => {
        const exitCode = Number.isFinite(code) ? code : 0;
        console.log(`[CLI] exit id=${id} code=${exitCode}`);
        runningProcesses.delete(id);
        processBuffers.delete(id);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cli:done', { id, code: exitCode });
        }
      });
    } else {
      const proc = pty.spawn(resolvedShell, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: runCwd,
        env,
      });

      runningProcesses.set(id, createProcessHandle('pty', proc));
      const vterm = new VTermBuffer(120, 30);
      processBuffers.set(id, {
        vterm,
        turnDetectBuffer: '',
        hasContentOutput: false,
        contentLength: 0,
        lastTurnEndAt: 0,
        turnEndTimeout: null,
        diffTimer: null,       // 디바운스 타이머
        lastContentChunk: '',  // 연속 중복 콘텐츠 방지
        lastStatusLine: '',    // status 중복 방지
        lastProgressLine: '',  // progress 중복 방지
      });

      proc.onData((data) => {
        const buf = processBuffers.get(id);
        if (!buf) return;

        // raw ANSI 데이터를 가상 터미널에 기록 (커서 위치 지정 올바르게 처리)
        buf.vterm.feed(data);

        // 디바운스: PTY가 여러 작은 청크를 빠르게 보내므로 모아서 처리
        if (buf.diffTimer) clearTimeout(buf.diffTimer);
        buf.diffTimer = setTimeout(() => {
          buf.diffTimer = null;
          const changed = buf.vterm.diff();
          if (!changed) return;

          // 변경된 줄을 분류 후 채널별 전송
          const contentLines = [];
          for (const rawLine of changed.split('\n')) {
            const item = classifyPtyLine(rawLine);

            if (item.kind === 'ignore') continue;

            if (item.kind === 'status') {
              if (item.text !== buf.lastStatusLine) {
                buf.lastStatusLine = item.text;
                emitCliStream(id, { type: 'status', chunk: item.text, replace: true });
              }
              continue;
            }

            if (item.kind === 'progress') {
              if (item.text !== buf.lastProgressLine) {
                buf.lastProgressLine = item.text;
                emitCliStream(id, { type: 'progress', chunk: item.text, replace: true });
              }
              continue;
            }

            contentLines.push(item.text);
          }

          if (contentLines.length > 0) {
            const contentChunk = contentLines.join('\n') + '\n';
            // 연속 중복 콘텐츠 필터링 (CLI 화면 재그리기로 같은 텍스트 반복 방지)
            if (contentChunk !== buf.lastContentChunk) {
              buf.lastContentChunk = contentChunk;
              emitCliStream(id, { type: 'stdout', chunk: contentChunk });
              buf.contentLength = (buf.contentLength || 0) + contentChunk.length;
              buf.hasContentOutput = true;
            }
            // 턴 완료 감지: 실제 콘텐츠가 있을 때만 타이머 시작/리셋
            // (status/progress만 있는 diff에서 타이머 리셋하면 turnDone이 영원히 안 옴)
            buf.turnDetectBuffer = (buf.turnDetectBuffer + changed).slice(-500);
            detectTurnCompletion(buf, mainWindow, id);
          }
        }, 16);
      });

      proc.onExit(({ exitCode }) => {
        console.log(`[CLI] exit id=${id} code=${exitCode}`);

        const buf = processBuffers.get(id);
        if (buf) {
          if (buf.turnEndTimeout) clearTimeout(buf.turnEndTimeout);
          if (buf.diffTimer) clearTimeout(buf.diffTimer);

          // 최종 스크린 변경분 플러시 (분류 기반)
          const changed = buf.vterm.diff();
          if (changed) {
            const contentLines = [];
            for (const rawLine of changed.split('\n')) {
              const item = classifyPtyLine(rawLine);
              if (item.kind === 'content') contentLines.push(item.text);
            }
            if (contentLines.length > 0) {
              emitCliStream(id, { type: 'stdout', chunk: contentLines.join('\n') + '\n' });
            }
          }
        }

        // dock 비우기 이벤트
        emitCliStream(id, { type: 'status', chunk: '', replace: true, done: true });
        emitCliStream(id, { type: 'progress', chunk: '', replace: true, done: true });

        processBuffers.delete(id);
        runningProcesses.delete(id);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cli:done', { id, code: exitCode });
        }
      });
    }

    // 즉시 반환 - 스트리밍은 이벤트로 처리
    return { success: true, id };

  } catch (err) {
    console.log(`[CLI] error id=${id} err=${err.message}`);
    return { success: false, error: err.message };
  }
});

// CLI 프로세스에 입력 전송
ipcMain.handle('cli:write', (event, { id, data }) => {
  const handle = runningProcesses.get(id);
  if (handle) {
    // 사용자 입력 시 이전 턴의 turn detection 타이머 취소
    // (새 입력 = 새 턴이므로 이전 idle 감지는 무효)
    const buf = processBuffers.get(id);
    if (buf) {
      if (buf.turnEndTimeout) {
        clearTimeout(buf.turnEndTimeout);
        buf.turnEndTimeout = null;
      }
      buf.hasContentOutput = false;
      buf.contentLength = 0;
      buf.turnDetectBuffer = '';
      buf.lastContentChunk = '';
      // 디바운스 버퍼 즉시 플러시하여 stale 데이터가 새 턴에 섞이지 않게
      if (buf.diffTimer) {
        clearTimeout(buf.diffTimer);
        buf.diffTimer = null;
      }
      // 현재 스크린 스냅샷을 리셋하여 다음 diff가 깨끗하게 시작
      buf.vterm.prevSnap = buf.vterm.snapshot();
    }
    handle.write(data);
    return { success: true };
  }
  return { success: false };
});

// CLI 프로세스 중지
ipcMain.handle('cli:stop', (event, { id }) => {
  const handle = runningProcesses.get(id);
  if (handle) {
    try {
      handle.write('\x03'); // Ctrl+C 시그널
      handle.kill();
    } catch (e) { /* ignore */ }
    processBuffers.delete(id);
    runningProcesses.delete(id);
    return { success: true };
  }
  return { success: false };
});

// --- 작업 디렉토리 ---
ipcMain.handle('cwd:get', () => workingDirectory);

ipcMain.handle('cwd:set', (event, dir) => {
  const requested = String(dir || '').trim();
  if (requested && fs.existsSync(requested)) {
    try {
      const stat = fs.statSync(requested);
      if (stat.isDirectory()) {
        workingDirectory = requested;
        return { success: true, cwd: requested };
      }
    } catch {
      // fall through
    }
  }
  return { success: false, error: 'Directory not found' };
});

ipcMain.handle('cwd:select', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '작업 폴더 선택',
    defaultPath: workingDirectory,
    properties: ['openDirectory'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    workingDirectory = result.filePaths[0];
    return { success: true, cwd: workingDirectory };
  }
  return { success: false };
});

ipcMain.handle('file:pickAndRead', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '불러올 파일 선택',
    defaultPath: workingDirectory,
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '모든 지원 파일', extensions: ['txt', 'md', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'css', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'sh', 'bat', 'ps1', 'sql', 'r', 'swift', 'kt', 'scala', 'lua', 'pl', 'pm', 'vue', 'svelte', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'log', 'env'] },
      { name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff', 'tif'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: '문서', extensions: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'] },
      { name: '텍스트/코드', extensions: ['txt', 'md', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'json', 'xml', 'yaml', 'yml', 'html', 'css', 'sql', 'sh', 'bat', 'csv', 'log'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true, error: '파일 선택이 취소되었습니다.' };
  }

  return readFilesGeneric(result.filePaths);
});

ipcMain.handle('file:read', (event, { filePath }) => {
  const resolvedPath = resolveFilePath(filePath);
  if (!resolvedPath) {
    return { success: false, error: '파일 경로를 입력하세요.' };
  }
  return readFileGeneric(resolvedPath);
});

// 드래그 앤 드롭으로 받은 파일 경로 배열을 일괄 읽기
ipcMain.handle('file:readMultiple', (event, { filePaths }) => {
  return readFilesGeneric(filePaths);
});

ipcMain.handle('file:open', async (event, { filePath }) => {
  const { resolvedPath, line } = resolveOpenFileTarget(filePath);
  if (!resolvedPath) {
    return { success: false, error: '파일 경로를 입력하세요.' };
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: '파일을 찾을 수 없습니다.' };
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return { success: false, error: '파일 경로가 올바르지 않습니다.' };
    }

    const openError = await shell.openPath(resolvedPath);
    if (openError) {
      return { success: false, error: openError };
    }

    return { success: true, path: resolvedPath, line };
  } catch (error) {
    return { success: false, error: error.message || '파일을 여는 중 오류가 발생했습니다.' };
  }
});

// --- 커밋 메시지 자동 생성 (codex exec 활용) ---
ipcMain.handle('repo:generateCommitMessage', async (event, arg) => {
  try {
    const cwd = (typeof arg?.cwd === 'string' && arg.cwd.trim()) ? arg.cwd.trim() : workingDirectory;
    const rootResult = await runGitCommandAsync(['rev-parse', '--show-toplevel'], cwd);
    if (!rootResult.ok) return { success: false, error: 'git repository not found' };
    const repoRoot = rootResult.stdout.trim();

    // diff 수집 (staged + unstaged + untracked)
    const [stagedDiff, unstagedDiff, untrackedFiles] = await Promise.all([
      runGitCommandAsync(['diff', '--cached', '--no-color', '--stat'], repoRoot),
      runGitCommandAsync(['diff', '--no-color', '--stat'], repoRoot),
      runGitCommandAsync(['ls-files', '--others', '--exclude-standard'], repoRoot),
    ]);
    const [stagedDetail, unstagedDetail] = await Promise.all([
      runGitCommandAsync(['diff', '--cached', '--no-color'], repoRoot),
      runGitCommandAsync(['diff', '--no-color'], repoRoot),
    ]);

    let diffSummary = '';
    if (stagedDiff.ok && stagedDiff.stdout.trim()) diffSummary += `[Staged]\n${stagedDiff.stdout.trim()}\n`;
    if (unstagedDiff.ok && unstagedDiff.stdout.trim()) diffSummary += `[Unstaged]\n${unstagedDiff.stdout.trim()}\n`;
    if (untrackedFiles.ok && untrackedFiles.stdout.trim()) diffSummary += `[New files]\n${untrackedFiles.stdout.trim()}\n`;

    // 상세 diff (최대 4000자)
    let detailDiff = '';
    if (stagedDetail.ok && stagedDetail.stdout.trim()) detailDiff += stagedDetail.stdout.trim() + '\n';
    if (unstagedDetail.ok && unstagedDetail.stdout.trim()) detailDiff += unstagedDetail.stdout.trim() + '\n';
    if (detailDiff.length > 4000) detailDiff = detailDiff.slice(0, 4000) + '\n...(truncated)';

    if (!diffSummary.trim() && !detailDiff.trim()) {
      return { success: false, error: 'no changes to commit' };
    }

    // codex exec로 커밋 메시지 생성
    const prompt = `Based on the following git diff, generate a concise git commit message in Korean.
Rules:
- First line: short summary (max 72 chars)
- If needed, add a blank line then bullet points for details
- Focus on WHAT changed and WHY, not HOW
- Do NOT include any explanation or prefix, output ONLY the commit message itself

Diff summary:
${diffSummary}

Diff detail:
${detailDiff}`;

    const codexPath = resolveCliPath('codex');
    if (!codexPath) return { success: false, error: 'codex CLI not found' };

    return new Promise((resolve) => {
      const directInvocation = resolveCodexDirectInvocation('codex', codexPath);
      const execArgs = ['-a', 'never', '-s', 'workspace-write', 'exec', '--json', '--full-auto', '--', prompt];

      let spawnCmd, spawnArgs;
      if (directInvocation) {
        spawnCmd = directInvocation.command;
        spawnArgs = [...directInvocation.argsPrefix, ...execArgs];
      } else {
        const isWindowsCmdShim = process.platform === 'win32' && /\.cmd$/i.test(codexPath);
        const ps1Path = isWindowsCmdShim ? codexPath.replace(/\.cmd$/i, '.ps1') : '';
        if (ps1Path && fs.existsSync(ps1Path)) {
          spawnCmd = path.join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe'
          );
          spawnArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1Path, ...execArgs];
        } else {
          spawnCmd = codexPath;
          spawnArgs = execArgs;
        }
      }

      const spawnOptions = {
        cwd: repoRoot,
        env: sanitizeCliEnv({ ...process.env, FORCE_COLOR: '0' }),
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      };

      const child = spawn(spawnCmd, spawnArgs, spawnOptions);
      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });

      child.on('close', () => {
        // JSONL 파싱 → agent_message 추출
        let message = '';
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj?.type === 'item.completed' && obj?.item?.type === 'agent_message') {
              message += (message ? '\n' : '') + obj.item.text;
            }
          } catch {}
        }
        message = message.trim();
        if (!message) {
          resolve({ success: false, error: stderr.trim() || 'no message generated' });
        } else {
          resolve({ success: true, message });
        }
      });

      child.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Git 상태 조회 ---
ipcMain.handle('repo:getStatus', async (event, arg) => {
  try {
    const cwd = (typeof arg?.cwd === 'string' && arg.cwd.trim()) ? arg.cwd.trim() : workingDirectory;
    const rootResult = await runGitCommandAsync(['rev-parse', '--show-toplevel'], cwd);
    if (!rootResult.ok) return { success: false, error: 'git repository not found' };
    const repoRoot = rootResult.stdout.trim();

    // 변경 파일 목록
    const statusResult = await runGitCommandAsync(['status', '--porcelain'], repoRoot);
    if (!statusResult.ok) return { success: false, error: statusResult.stderr || 'git status failed' };

    const files = [];
    for (const line of statusResult.stdout.split(/\r?\n/)) {
      if (!line || line.length < 4) continue;
      const status = line.slice(0, 2).trim();
      const filePath = line.slice(3).trim();
      if (filePath) files.push({ status, file: filePath });
    }

    // 최근 커밋 메시지 (스타일 참고용)
    const logResult = await runGitCommandAsync(['log', '--oneline', '-5'], repoRoot);
    const recentCommits = logResult.ok
      ? logResult.stdout.trim().split(/\r?\n/).filter(l => l.trim()).map(l => l.trim())
      : [];

    // diff 요약 (staged + unstaged)
    const diffStatResult = await runGitCommandAsync(['diff', '--stat', '--no-color'], repoRoot);
    const stagedStatResult = await runGitCommandAsync(['diff', '--cached', '--stat', '--no-color'], repoRoot);

    return {
      success: true,
      repoRoot,
      files,
      recentCommits,
      diffStat: (stagedStatResult.ok ? stagedStatResult.stdout.trim() : '') + '\n' + (diffStatResult.ok ? diffStatResult.stdout.trim() : ''),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Git 커밋 ---
ipcMain.handle('repo:commit', async (event, arg) => {
  try {
    const cwd = (typeof arg?.cwd === 'string' && arg.cwd.trim()) ? arg.cwd.trim() : workingDirectory;
    const message = typeof arg?.message === 'string' ? arg.message.trim() : '';
    if (!message) return { success: false, error: '커밋 메시지가 비어있습니다.' };

    const rootResult = await runGitCommandAsync(['rev-parse', '--show-toplevel'], cwd);
    if (!rootResult.ok) return { success: false, error: 'git repository not found' };
    const repoRoot = rootResult.stdout.trim();

    // 모든 변경 사항 stage
    const addResult = await runGitCommandAsync(['add', '-A'], repoRoot);
    if (!addResult.ok) return { success: false, error: `git add failed: ${addResult.stderr}` };

    // staged 파일 확인
    const stagedResult = await runGitCommandAsync(['diff', '--cached', '--name-only'], repoRoot);
    if (!stagedResult.ok || !stagedResult.stdout.trim()) {
      return { success: false, error: '커밋할 변경 사항이 없습니다.' };
    }

    // 커밋 실행
    const commitResult = await runGitCommandAsync(['commit', '-m', message], repoRoot);
    if (!commitResult.ok) return { success: false, error: commitResult.stderr || 'git commit failed' };

    // 커밋 해시
    const hashResult = await runGitCommandAsync(['rev-parse', '--short', 'HEAD'], repoRoot);
    const hash = hashResult.ok ? hashResult.stdout.trim() : '';

    return {
      success: true,
      hash,
      message,
      output: commitResult.stdout.trim(),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('repo:getFileDiffs', async (event, arg) => {
  try {
    const requestedCwd = typeof arg?.cwd === 'string' && arg.cwd.trim()
      ? arg.cwd.trim()
      : workingDirectory;
    const files = Array.isArray(arg?.files) ? arg.files : [];

    const cwd = fs.existsSync(requestedCwd) ? requestedCwd : workingDirectory;
    const rootResult = await runGitCommandAsync(['rev-parse', '--show-toplevel'], cwd);
    if (!rootResult.ok) {
      return { success: false, error: 'git repository not found', data: [] };
    }
    const repoRoot = rootResult.stdout.trim();
    if (!repoRoot) {
      return { success: false, error: 'git repository root not resolved', data: [] };
    }

    const normalizedFiles = [];
    const seen = new Set();
    const pushRelativePath = (relPath) => {
      const rel = String(relPath || '').trim().replace(/\\/g, '/');
      if (!rel || seen.has(rel)) return;
      seen.add(rel);
      normalizedFiles.push(rel);
    };

    if (files.length > 0) {
      for (const file of files) {
        const rel = normalizeRepoFilePath(file, repoRoot, cwd);
        if (!rel) continue;
        pushRelativePath(rel);
      }
    } else {
      const changedCommands = [
        ['diff', '--no-color', '--name-only', '--cached'],
        ['diff', '--no-color', '--name-only'],
        ['ls-files', '--others', '--exclude-standard'],
      ];
      for (const command of changedCommands) {
        const result = await runGitCommandAsync(command, repoRoot);
        if (!result.ok || !result.stdout) continue;
        for (const line of result.stdout.split(/\r?\n/)) {
          const rel = String(line || '').trim();
          if (!rel) continue;
          pushRelativePath(rel);
        }
      }
    }

    const data = [];
    for (const rel of normalizedFiles) {
      const [staged, unstaged] = await Promise.all([
        runGitCommandAsync(['diff', '--no-color', '--cached', '--', rel], repoRoot),
        runGitCommandAsync(['diff', '--no-color', '--', rel], repoRoot),
      ]);
      let diffText = '';
      if (staged.ok && staged.stdout.trim()) diffText += `${staged.stdout.trim()}\n`;
      if (unstaged.ok && unstaged.stdout.trim()) diffText += `${unstaged.stdout.trim()}\n`;

      if (!diffText.trim()) {
        const untracked = await runGitCommandAsync(['ls-files', '--others', '--exclude-standard', '--', rel], repoRoot);
        const isUntracked = untracked.ok && untracked.stdout
          .split(/\r?\n/)
          .map(line => line.trim().replace(/\\/g, '/'))
          .some(line => line === rel);
        if (isUntracked) {
          const abs = path.join(repoRoot, rel);
          let stat = null;
          try {
            stat = await fs.promises.stat(abs);
          } catch {
            stat = null;
          }
          if (stat?.isFile()) {
            let content = '';
            try {
              content = await fs.promises.readFile(abs, 'utf8');
            } catch {
              content = '';
            }
            if (!content) continue;
            const bodyLines = content.split(/\r?\n/);
            const plusLines = bodyLines.map(line => `+${line}`).join('\n');
            diffText = [
              `diff --git a/${rel} b/${rel}`,
              'new file mode 100644',
              '--- /dev/null',
              `+++ b/${rel}`,
              `@@ -0,0 +1,${bodyLines.length} @@`,
              plusLines,
            ].join('\n');
          }
        }
      }

      const trimmed = diffText.trim();
      if (!trimmed) continue;
      data.push({ file: rel, diff: trimmed });
    }

    return { success: true, data };
  } catch (error) {
    return { success: false, error: error.message || 'diff collection failed', data: [] };
  }
});

// --- Codex 세션 파일에서 apply_patch diff 추출 (턴별 그룹핑) ---
function parsePatchInput(patchInput) {
  const patchContent = patchInput.trim();
  const fileBlocks = [];
  const fileRegex = /\*{3}\s*(Update|Add|Delete)\s+File:\s*(.+)/gi;
  let match;
  const positions = [];

  while ((match = fileRegex.exec(patchContent)) !== null) {
    positions.push({
      op: match[1].toLowerCase(),
      file: match[2].trim().replace(/^['"]|['"]$/g, ''),
      start: match.index + match[0].length,
    });
  }

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const nextStart = i + 1 < positions.length ? positions[i + 1].start - positions[i + 1].file.length - 30 : patchContent.length;
    const blockEnd = i + 1 < positions.length
      ? patchContent.lastIndexOf('***', positions[i + 1].start)
      : patchContent.length;
    const rawBlock = patchContent.slice(pos.start, blockEnd > pos.start ? blockEnd : nextStart).trim();

    const diffLines = [];
    let hasChanges = false;
    for (const bLine of rawBlock.split(/\r?\n/)) {
      if (bLine.startsWith('*** End Patch')) break;
      if (bLine.startsWith('*** ')) continue;
      if (bLine.startsWith('+') || bLine.startsWith('-')) hasChanges = true;
      diffLines.push(bLine);
    }

    if (hasChanges || pos.op === 'add' || pos.op === 'delete') {
      const fp = pos.file;
      const header = pos.op === 'add'
        ? `diff --apply_patch a/${fp} b/${fp}\nnew file\n--- /dev/null\n+++ b/${fp}`
        : pos.op === 'delete'
          ? `diff --apply_patch a/${fp} b/${fp}\ndeleted file\n--- a/${fp}\n+++ /dev/null`
          : `diff --apply_patch a/${fp} b/${fp}\n--- a/${fp}\n+++ b/${fp}`;
      fileBlocks.push({ file: fp, diff: `${header}\n${diffLines.join('\n')}`.trim() });
    }
  }

  if (fileBlocks.length === 0 && patchContent.includes('***')) {
    return [{ file: '(patch)', diff: patchContent }];
  }
  return fileBlocks;
}

ipcMain.handle('codex:getSessionDiffs', async (event, arg) => {
  try {
    const sessionId = typeof arg === 'string'
      ? arg.trim()
      : typeof arg?.sessionId === 'string'
        ? arg.sessionId.trim()
        : '';
    if (!sessionId) return { success: false, error: 'session id required', data: [] };

    const turnIndex = typeof arg?.turnIndex === 'number' ? arg.turnIndex : -1;

    const filePath = resolveCodexSessionFilePath(sessionId, arg?.filePath || '');
    if (!filePath) return { success: false, error: 'session file not found', data: [] };

    const raw = fs.readFileSync(filePath, 'utf8');
    const jsonlLines = raw.split('\n');

    // 턴별로 apply_patch 그룹핑
    // 턴 = 유저 메시지 하나에 대한 AI 응답 (user message → assistant response + tool calls)
    const turns = []; // turns[i] = [{file, diff}, ...]
    let currentTurn = -1;

    for (const line of jsonlLines) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      const payload = obj?.payload;
      if (!payload) continue;

      // 유저 메시지 → 새 턴 시작
      if (obj?.type === 'response_item' && payload?.type === 'message' && payload?.role === 'user') {
        currentTurn++;
        if (!turns[currentTurn]) turns[currentTurn] = [];
        continue;
      }

      // apply_patch 이벤트
      const isApplyPatch =
        obj?.type === 'response_item' &&
        (payload?.name === 'apply_patch' ||
         (payload?.type === 'custom_tool_call' && payload?.name === 'apply_patch'));
      if (!isApplyPatch) continue;
      if (currentTurn < 0) { currentTurn = 0; turns[0] = []; }

      const patchInput = typeof payload.input === 'string'
        ? payload.input
        : typeof payload.arguments === 'string'
          ? payload.arguments
          : '';
      if (!patchInput.trim()) continue;

      const blocks = parsePatchInput(patchInput);
      turns[currentTurn].push(...blocks);
    }

    // turnIndex 지정 시 해당 턴만 반환, 아니면 전체
    if (turnIndex >= 0) {
      const turnData = turns[turnIndex] || [];
      return { success: true, data: turnData, turnIndex, totalTurns: turns.length };
    }

    // 전체 턴 반환 (turns 배열 포함)
    const allPatches = turns.flat();
    return { success: true, data: allPatches, turns, totalTurns: turns.length };
  } catch (error) {
    return { success: false, error: error.message || 'session diff extraction failed', data: [] };
  }
});

// 윈도우 컨트롤
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  }
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);
ipcMain.handle('help:openManual', () => {
  try {
    return openManualWindow();
  } catch (error) {
    return { success: false, error: error.message || '사용 설명서를 열지 못했습니다.' };
  }
});

// --- Codex rate_limits 읽기 (세션 JSONL에서) ---
function normalizeRateLimitMeta(value) {
  return String(value || '').trim().toLowerCase();
}

function classifyRateLimitScope(rateLimits) {
  const limitId = normalizeRateLimitMeta(rateLimits?.limit_id);
  const limitName = normalizeRateLimitMeta(rateLimits?.limit_name);
  const meta = `${limitId} ${limitName}`.trim();

  if (
    limitId === 'codex'
    || limitId === 'context_window'
    || limitName === 'context window'
    || meta.includes('context window')
  ) {
    return 'context-window';
  }
  return 'unknown';
}

function toRateLimitSnapshot(rateLimits) {
  if (!rateLimits || !rateLimits.primary || !rateLimits.secondary) return null;
  const h5Used = Number(rateLimits.primary.used_percent);
  const weeklyUsed = Number(rateLimits.secondary.used_percent);
  if (!Number.isFinite(h5Used) || !Number.isFinite(weeklyUsed)) return null;

  return {
    success: true,
    h5Used,
    weeklyUsed,
    h5Remaining: Math.max(0, 100 - h5Used),
    weeklyRemaining: Math.max(0, 100 - weeklyUsed),
    h5Window: rateLimits.primary.window_minutes,
    weeklyWindow: rateLimits.secondary.window_minutes,
    h5ResetsAt: rateLimits.primary.resets_at,
    weeklyResetsAt: rateLimits.secondary.resets_at,
    limitId: rateLimits.limit_id || null,
    limitName: rateLimits.limit_name || null,
  };
}

function parseCodexRateLimitsFromSessionFile(filePath, fileSize) {
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) return null;

  // 최신 로그 기준 fallback 후보를 유지하되,
  // Context Window(codex) 항목을 찾으면 즉시 우선 반환한다.
  let fallback = null;

  // 파일 전체를 읽으면 UI가 멈출 수 있으므로, tail만 단계적으로 읽어 마지막 rate_limits를 찾는다.
  const chunkSizes = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]; // 256KB -> 1MB -> 4MB
  for (const chunkSize of chunkSizes) {
    const bytesToRead = Math.min(size, chunkSize);
    const start = Math.max(0, size - bytesToRead);
    let content = '';
    let fd = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, start);
      content = buffer.toString('utf8');
    } catch {
      continue;
    } finally {
      if (typeof fd === 'number') {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }

    const lines = content.split('\n').reverse();
    for (const line of lines) {
      if (!line || (!line.includes('rate_limits') && !line.includes('rateLimits'))) continue;
      try {
        const obj = JSON.parse(line);
        const rl = obj?.payload?.rate_limits
          || obj?.payload?.info?.rate_limits
          || obj?.rate_limits
          || null;
        const snapshot = toRateLimitSnapshot(rl);
        if (!snapshot) continue;

        if (!fallback) fallback = snapshot;
        const scope = classifyRateLimitScope(rl);
        if (scope === 'context-window') {
          return snapshot;
        }
      } catch {
        // malformed json line
      }
    }
  }

  return fallback || null;
}

// --- 상주형 백그라운드 codex 프로세스로 /status 파싱 ---
const statusDaemon = {
  proc: null,       // PTY 프로세스
  ready: false,     // 프롬프트 준비 완료
  output: '',       // 누적 출력
  lastResult: null, // 마지막 파싱 결과
  lastTs: 0,        // 마지막 갱신 시각
  pending: [],      // 대기 중인 resolve 콜백
  spawning: false,
};

function ensureStatusDaemon() {
  if (statusDaemon.proc && !statusDaemon.proc.killed) return;
  if (statusDaemon.spawning) return;
  statusDaemon.spawning = true;
  statusDaemon.ready = false;
  statusDaemon.output = '';

  const codexPath = resolveCliPath('codex');
  if (!codexPath) { statusDaemon.spawning = false; return; }

  const env = sanitizeCliEnv({ ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' });
  try {
    statusDaemon.proc = pty.spawn(codexPath, [], {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd: workingDirectory,
      env,
    });
  } catch (err) {
    console.warn('[statusDaemon] spawn failed:', err.message);
    statusDaemon.spawning = false;
    return;
  }

  statusDaemon.proc.onData((data) => {
    statusDaemon.output += data;
    // 프롬프트 준비 감지
    if (!statusDaemon.ready) {
      const clean = statusDaemon.output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      if (/[>❯›]\s*$/m.test(clean) || clean.length > 500) {
        statusDaemon.ready = true;
        statusDaemon.spawning = false;
        // 준비되자마자 첫 /status 전송
        try { statusDaemon.proc.write('/status\r'); } catch {}
      }
    }
  });

  statusDaemon.proc.onExit(() => {
    statusDaemon.proc = null;
    statusDaemon.ready = false;
    statusDaemon.spawning = false;
    // 대기 중인 콜백 해소
    for (const cb of statusDaemon.pending) cb(statusDaemon.lastResult);
    statusDaemon.pending = [];
  });

  // 프롬프트 대기 후 초기 /status 전송
  setTimeout(() => {
    if (statusDaemon.proc && !statusDaemon.proc.killed) {
      statusDaemon.ready = true;
      statusDaemon.spawning = false;
    }
  }, 4000);
}

function fetchRateLimitsViaStatus() {
  return new Promise((resolve) => {
    // 10초 캐시
    if (statusDaemon.lastResult && Date.now() - statusDaemon.lastTs < 10000) {
      return resolve(statusDaemon.lastResult);
    }

    ensureStatusDaemon();

    // 프로세스가 없거나 죽었으면 null
    if (!statusDaemon.proc || statusDaemon.proc.killed) {
      return resolve(statusDaemon.lastResult || null);
    }

    // 준비 안 됐으면 잠시 후 시도
    if (!statusDaemon.ready) {
      statusDaemon.pending.push(resolve);
      setTimeout(() => {
        // 5초 후에도 응답 없으면 기존 결과 반환
        const idx = statusDaemon.pending.indexOf(resolve);
        if (idx >= 0) {
          statusDaemon.pending.splice(idx, 1);
          resolve(statusDaemon.lastResult || null);
        }
      }, 5000);
      return;
    }

    // /status 전송 후 출력 대기
    statusDaemon.output = ''; // 이전 출력 클리어
    try {
      statusDaemon.proc.write('/status\r');
    } catch {
      return resolve(statusDaemon.lastResult || null);
    }

    // 2초 후 파싱
    setTimeout(() => {
      const parsed = parseStatusOutput(statusDaemon.output);
      if (parsed) {
        statusDaemon.lastResult = parsed;
        statusDaemon.lastTs = Date.now();
      }
      resolve(parsed || statusDaemon.lastResult || null);
    }, 2000);
  });
}

// 앱 종료 시 데몬 정리
function killStatusDaemon() {
  if (statusDaemon.proc && !statusDaemon.proc.killed) {
    try { statusDaemon.proc.write('/exit\r'); } catch {}
    setTimeout(() => {
      try { if (statusDaemon.proc) statusDaemon.proc.kill(); } catch {}
    }, 1000);
  }
}

function parseStatusOutput(raw) {
  // ANSI 이스케이프 + 제어문자 + box drawing 문자 제거
  const text = String(raw || '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/g, ' ')
    .replace(/[│┃║]/g, ' ');

  // /status 패널 형식:
  // "5h limit:  ... XX% left (resets HH:MM)"
  // "Weekly limit: ... XX% left (resets HH:MM on DD Mon)"
  const h5PanelMatch = text.match(/5h\s+limit\s*:.*?(\d+(?:\.\d+)?)\s*%\s*left(?:\s*\(resets?\s+([^)]+)\))?/i);
  const weeklyPanelMatch = text.match(/weekly\s+limit\s*:.*?(\d+(?:\.\d+)?)\s*%\s*left(?:\s*\(resets?\s+([^)]+)\))?/i);

  let h5Remaining = null;
  let weeklyRemaining = null;
  let h5ResetText = null;
  let weeklyResetText = null;

  if (h5PanelMatch) {
    h5Remaining = parseFloat(h5PanelMatch[1]);
    h5ResetText = h5PanelMatch[2] || null;
  }
  if (weeklyPanelMatch) {
    weeklyRemaining = parseFloat(weeklyPanelMatch[1]);
    weeklyResetText = weeklyPanelMatch[2] || null;
  }

  // 패널 형식 못 찾으면 상태바 형식 시도:
  // "100% left · 0% used · 5h 66%"
  if (h5Remaining === null) {
    const h5BarMatch = text.match(/5[\s-]*h\s+(\d+(?:\.\d+)?)\s*%/i);
    if (h5BarMatch) {
      // 상태바의 "5h XX%"는 used %
      h5Remaining = Math.max(0, 100 - parseFloat(h5BarMatch[1]));
    }
  }
  if (weeklyRemaining === null) {
    const leftMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*left/i);
    if (leftMatch) weeklyRemaining = parseFloat(leftMatch[1]);
  }

  if (h5Remaining === null && weeklyRemaining === null) return null;

  const h5Used = h5Remaining !== null ? Math.max(0, 100 - h5Remaining) : null;
  const weeklyUsed = weeklyRemaining !== null ? Math.max(0, 100 - weeklyRemaining) : null;

  // reset 시각 파싱 ("19:06" 또는 "20:55 on 20 Mar")
  const parseResetText = (resetText) => {
    if (!resetText) return null;
    const timeMatch = resetText.match(/(\d{1,2}):(\d{2})/);
    if (!timeMatch) return null;
    const now = new Date();
    const resetDate = new Date(now);
    resetDate.setHours(parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10), 0, 0);
    // "on DD Mon" 부분이 있으면 날짜도 설정
    const dateMatch = resetText.match(/on\s+(\d{1,2})\s+(\w+)/i);
    if (dateMatch) {
      const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      const monthIdx = months.indexOf(dateMatch[2].toLowerCase().slice(0, 3));
      if (monthIdx >= 0) {
        resetDate.setMonth(monthIdx, parseInt(dateMatch[1], 10));
      }
    }
    // 이미 지난 시각이면 다음날로
    if (resetDate.getTime() < now.getTime() && !dateMatch) {
      resetDate.setDate(resetDate.getDate() + 1);
    }
    return Math.floor(resetDate.getTime() / 1000);
  };

  return {
    success: true,
    h5Used,
    weeklyUsed,
    h5Remaining,
    weeklyRemaining,
    h5ResetsAt: parseResetText(h5ResetText),
    weeklyResetsAt: parseResetText(weeklyResetText),
    source: 'pty-status',
  };
}

ipcMain.handle('codex:rateLimits', async () => {
  try {
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(sessionsDir)) return { success: false, error: 'no sessions dir' };

    const now = Date.now();
    const files = listCodexSessionFiles().slice(0, 40); // 최근 파일 우선 탐색

    // 캐시 대상 파일이 아직 최신 후보군에 있고 mtime이 유지되면 캐시 반환
    if (
      codexRateLimitCache.result &&
      now - codexRateLimitCache.ts < 15000 &&
      files.length > 0
    ) {
      const cachedFile = files.find(file => file.filePath === codexRateLimitCache.filePath);
      if (cachedFile && cachedFile.mtimeMs === codexRateLimitCache.fileMtime) {
        return codexRateLimitCache.result;
      }
    }

    // 1) 가장 최신 세션 파일의 rate_limits 확인
    //    최신 파일이 null이면 Codex CLI가 더 이상 rate_limits를 안 보내는 것 → PTY 폴백
    const maxAge = 6 * 60 * 60 * 1000;
    const recentFiles = files.filter(f => now - f.mtimeMs <= maxAge);

    // 최신 파일(30분 이내)에서만 rate_limits 탐색
    const freshMaxAge = 30 * 60 * 1000;
    for (const file of recentFiles) {
      if (now - file.mtimeMs > freshMaxAge) break;
      const resolved = parseCodexRateLimitsFromSessionFile(file.filePath, file.size);
      if (!resolved) continue;

      // found in fresh session file
      codexRateLimitCache = {
        ts: now,
        filePath: file.filePath,
        fileMtime: file.mtimeMs,
        result: resolved,
      };
      return resolved;
    }
    // no fresh rate_limits → trying PTY /status

    // 2) 폴백: interactive PTY로 /status 실행하여 파싱
    const ptyResult = await fetchRateLimitsViaStatus();
    if (ptyResult) return ptyResult;

    return { success: false, error: 'no rate_limits found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('codex:listModels', async () => {
  try {
    return await fetchCodexModelCatalog();
  } catch (err) {
    return {
      success: true,
      source: 'fallback',
      error: err.message || String(err),
      models: FALLBACK_CODEX_MODELS.map(model => ({ ...model })),
    };
  }
});

ipcMain.handle('codex:listCommands', async (event, arg = {}) => {
  try {
    const cwd = typeof arg?.cwd === 'string' ? arg.cwd : workingDirectory;
    return await fetchCodexCommandCatalog(cwd);
  } catch (err) {
    return {
      success: false,
      source: 'codex-help',
      cwd: resolveExistingDirectory(arg?.cwd, workingDirectory),
      error: err.message || String(err),
      commands: [],
    };
  }
});

ipcMain.handle('codex:listSkills', (event, arg = {}) => {
  try {
    const cwd = typeof arg?.cwd === 'string' ? arg.cwd : workingDirectory;
    const result = listCodexSkills(cwd);
    return {
      success: true,
      source: 'codex-skills',
      cwd: result.cwd,
      skills: result.skills,
    };
  } catch (err) {
    return {
      success: false,
      source: 'codex-skills',
      cwd: resolveExistingDirectory(arg?.cwd, workingDirectory),
      error: err.message || String(err),
      skills: [],
    };
  }
});

ipcMain.handle('codex:readConfig', () => {
  try {
    const { filePath, exists, raw } = readCodexConfigFile();
    return {
      success: true,
      path: filePath,
      exists,
      values: parseCodexConfigValues(raw),
      fields: CODEX_CONFIG_FIELD_KEYS,
    };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});

ipcMain.handle('codex:saveConfig', (event, payload = {}) => {
  try {
    const incoming = payload && typeof payload === 'object' && payload.values && typeof payload.values === 'object'
      ? payload.values
      : {};
    let { filePath, raw } = readCodexConfigFile();
    for (const key of CODEX_CONFIG_FIELD_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
      const normalized = normalizeCodexConfigInput(key, incoming[key]);
      if (!normalized.ok) {
        return { success: false, error: normalized.error };
      }
      raw = upsertTomlValue(raw, key, normalized);
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, raw, 'utf8');
    const saved = readCodexConfigFile();
    return {
      success: true,
      path: filePath,
      exists: true,
      values: parseCodexConfigValues(saved.raw),
      fields: CODEX_CONFIG_FIELD_KEYS,
    };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});

ipcMain.handle('codex:openConfig', async () => {
  try {
    const filePath = getCodexConfigPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
    const openError = await shell.openPath(filePath);
    if (openError) return { success: false, error: openError, path: filePath };
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});

function getCodexSessionsDir() {
  return path.join(os.homedir(), '.codex', 'sessions');
}

function listCodexSessionFiles() {
  const sessionsDir = getCodexSessionsDir();
  if (!fs.existsSync(sessionsDir)) return [];

  const files = [];
  let years = [];
  try {
    years = fs.readdirSync(sessionsDir).sort().reverse();
  } catch {
    return [];
  }
  for (const year of years) {
    const yearDir = path.join(sessionsDir, year);
    let yearStat;
    try {
      if (!fs.existsSync(yearDir)) continue;
      yearStat = fs.statSync(yearDir);
    } catch {
      continue;
    }
    if (!yearStat.isDirectory()) continue;

    let months = [];
    try {
      months = fs.readdirSync(yearDir).sort().reverse();
    } catch {
      continue;
    }
    for (const month of months) {
      const monthDir = path.join(yearDir, month);
      let monthStat;
      try {
        if (!fs.existsSync(monthDir)) continue;
        monthStat = fs.statSync(monthDir);
      } catch {
        continue;
      }
      if (!monthStat.isDirectory()) continue;

      let days = [];
      try {
        days = fs.readdirSync(monthDir).sort().reverse();
      } catch {
        continue;
      }
      for (const day of days) {
        const dayDir = path.join(monthDir, day);
        let dayStat;
        try {
          if (!fs.existsSync(dayDir)) continue;
          dayStat = fs.statSync(dayDir);
        } catch {
          continue;
        }
        if (!dayStat.isDirectory()) continue;

        let names = [];
        try {
          names = fs.readdirSync(dayDir);
        } catch {
          continue;
        }

        const dayFiles = [];
        for (const name of names) {
          if (!name.endsWith('.jsonl')) continue;
          const filePath = path.join(dayDir, name);
          try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) continue;
            dayFiles.push({ filePath, name, mtimeMs: stat.mtimeMs, size: stat.size });
          } catch {
            // 접근 불가/경합 파일은 건너뛴다.
          }
        }
        files.push(...dayFiles);
      }
    }
  }

  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function normalizePreviewText(text, maxLen = 140) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > maxLen ? `${compact.slice(0, maxLen - 3)}...` : compact;
}

function normalizeSessionCwd(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return path.resolve(raw).replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    return raw.replace(/\//g, '\\').replace(/[\\]+$/, '').toLowerCase();
  }
}

function extractSessionIdFromFileName(fileName) {
  const base = path.basename(String(fileName || ''), '.jsonl');
  if (!base) return '';

  // rollout-YYYY-MM-DDTHH-mm-ss-<session-id>.jsonl
  const rolloutMatch = base.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/i);
  if (rolloutMatch && rolloutMatch[1]) return rolloutMatch[1];

  const uuidMatch = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (uuidMatch) return uuidMatch[1];

  const genericTail = base.match(/-([a-z0-9][a-z0-9-]{7,})$/i);
  if (genericTail) return genericTail[1];

  return '';
}

function isIgnorableSessionUserText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  if (/^#\s*AGENTS\.md instructions\b/i.test(trimmed)) return true;
  if (/^<environment_context>/i.test(trimmed)) return true;
  if (/^<collaboration_mode>/i.test(trimmed)) return true;
  if (/^<permissions instructions>/i.test(trimmed)) return true;
  return false;
}

function extractMessageTextFromContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.text === 'string'
      ? item.text
      : typeof item.output_text === 'string'
        ? item.output_text
        : typeof item.input_text === 'string'
          ? item.input_text
          : '';
    if (text && text.trim()) parts.push(text);
  }
  return parts.join('\n').trim();
}

function parseSessionPreview(filePath, fileSize, fileName) {
  let sessionId = '';
  let cwd = '';
  let startedAt = '';
  let description = '';

  try {
    const bytes = Math.min(fileSize, 192 * 1024);
    if (bytes > 0) {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        fs.readSync(fd, buffer, 0, bytes, 0);
        const lines = buffer.toString('utf8').split('\n');
        for (const line of lines) {
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj?.type === 'session_meta') {
              const payload = obj?.payload || {};
              if (typeof payload.id === 'string' && payload.id) sessionId = payload.id;
              if (typeof payload.cwd === 'string' && payload.cwd) cwd = payload.cwd;
              if (typeof payload.timestamp === 'string' && payload.timestamp) startedAt = payload.timestamp;
              continue;
            }
            if (!description && obj?.type === 'response_item' && obj?.payload?.type === 'message' && obj?.payload?.role === 'user') {
              const text = extractMessageTextFromContent(obj?.payload?.content);
              if (!isIgnorableSessionUserText(text)) {
                description = normalizePreviewText(text, 140);
              }
            }
          } catch { /* malformed json line */ }
          if (sessionId && description) break;
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // ignore preview parsing errors
  }

  if (!sessionId) {
    sessionId = extractSessionIdFromFileName(fileName);
  }

  return { sessionId, cwd, startedAt, description };
}

function resolveCodexSessionFilePath(sessionId, preferredPath) {
  const wanted = String(sessionId || '').trim().toLowerCase();
  if (!wanted) return '';

  if (preferredPath && typeof preferredPath === 'string' && fs.existsSync(preferredPath)) {
    const lowerName = path.basename(preferredPath).toLowerCase();
    if (lowerName.includes(wanted)) return preferredPath;
  }

  const files = listCodexSessionFiles();
  for (const file of files) {
    if (file.name.toLowerCase().includes(wanted)) return file.filePath;
  }

  for (const file of files) {
    const preview = parseSessionPreview(file.filePath, file.size, file.name);
    if (preview.sessionId && preview.sessionId.toLowerCase() === wanted) {
      return file.filePath;
    }
  }
  return '';
}

function isSubPath(parentDir, targetPath) {
  const parent = path.resolve(parentDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  if (!relative) return false;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function parseCodexSessionConversation(filePath, options = {}) {
  const includeCommentary = options.includeCommentary === true;
  const includeIgnorablePrompts = options.includeIgnorablePrompts === true;
  const result = {
    id: '',
    cwd: '',
    startedAt: '',
    description: '',
    messages: [],
  };

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');

  for (const line of lines) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj?.type === 'session_meta') {
      const payload = obj?.payload || {};
      if (typeof payload.id === 'string' && payload.id) result.id = payload.id;
      if (typeof payload.cwd === 'string' && payload.cwd) result.cwd = payload.cwd;
      if (typeof payload.timestamp === 'string' && payload.timestamp) result.startedAt = payload.timestamp;
      continue;
    }

    if (obj?.type !== 'response_item' || obj?.payload?.type !== 'message') continue;

    const role = obj?.payload?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = extractMessageTextFromContent(obj?.payload?.content);
    if (!text) continue;

    if (role === 'user' && !includeIgnorablePrompts && isIgnorableSessionUserText(text)) continue;
    if (role === 'assistant') {
      const phase = String(obj?.payload?.phase || '').toLowerCase();
      if (!includeCommentary && phase === 'commentary') continue;
    }

    if (!result.description && role === 'user') {
      if (!isIgnorableSessionUserText(text)) {
        result.description = normalizePreviewText(text, 140);
      }
    }

    const tsRaw = Date.parse(String(obj?.timestamp || ''));
    result.messages.push({
      role: role === 'user' ? 'user' : 'ai',
      content: text,
      timestamp: Number.isFinite(tsRaw) ? tsRaw : Date.now(),
    });
  }

  if (!result.id) {
    const name = path.basename(filePath);
    result.id = extractSessionIdFromFileName(name);
  }

  return result;
}

// --- 서브에이전트: .codex/agents/*.toml 파일 읽기 ---
function parseSimpleToml(text) {
  const result = {};
  let currentKey = null;
  let multiLineKey = null;
  let multiLineValue = '';
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (multiLineKey !== null) {
      if (line.trimEnd() === '"""') {
        result[multiLineKey] = multiLineValue;
        multiLineKey = null;
        multiLineValue = '';
      } else {
        multiLineValue += (multiLineValue ? '\n' : '') + line;
      }
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // [section] — 무시 (flat 구조 사용)
    if (/^\[/.test(trimmed)) continue;
    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    let val = kvMatch[2].trim();
    if (val === '"""') {
      multiLineKey = key;
      multiLineValue = '';
    } else if (/^"(.*)"$/.test(val)) {
      result[key] = val.slice(1, -1);
    } else if (/^'(.*)'$/.test(val)) {
      result[key] = val.slice(1, -1);
    } else if (/^\[.*\]$/.test(val)) {
      try { result[key] = JSON.parse(val.replace(/'/g, '"')); } catch { result[key] = val; }
    } else if (val === 'true') {
      result[key] = true;
    } else if (val === 'false') {
      result[key] = false;
    } else if (/^[\d.]+$/.test(val)) {
      result[key] = Number(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

ipcMain.handle('codex:listAgents', (event, arg) => {
  try {
    const rawCwd = typeof arg === 'string' ? arg : (typeof arg?.cwd === 'string' ? arg.cwd : '');
    const projectCwd = rawCwd && rawCwd.trim() ? rawCwd.trim() : workingDirectory;
    const agents = [];

    // 1순위: 현재 대화 프로젝트 폴더의 .codex/agents/
    // 2순위: 글로벌 ~/.codex/agents/
    const projectAgentsDir = path.join(projectCwd, '.codex', 'agents');
    const globalAgentsDir = path.join(os.homedir(), '.codex', 'agents');
    const searchDirs = [projectAgentsDir, globalAgentsDir];

    const seenNames = new Set();
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.toml'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dir, file), 'utf8');
          const parsed = parseSimpleToml(content);
          const agentName = parsed.name || file.replace(/\.toml$/i, '');
          if (seenNames.has(agentName)) continue;
          seenNames.add(agentName);
          agents.push({
            name: agentName,
            description: parsed.description || '',
            developer_instructions: parsed.developer_instructions || '',
            model: parsed.model || '',
            sandbox_mode: parsed.sandbox_mode || '',
            source: dir === projectAgentsDir ? 'project' : 'global',
            fileName: file,
          });
        } catch { /* skip malformed files */ }
      }
    }
    return { success: true, data: agents };
  } catch (err) {
    return { success: false, error: err.message, data: [] };
  }
});

// --- Codex 세션 목록 읽기 (~/.codex/sessions) ---
ipcMain.handle('codex:listSessions', (event, limitArg) => {
  try {
    const request = (limitArg && typeof limitArg === 'object')
      ? limitArg
      : { limit: limitArg };

    const limitNum = Number(request.limit);
    const limit = Number.isFinite(limitNum)
      ? Math.min(1000, Math.max(1, Math.floor(limitNum)))
      : 60;
    const requestCwd = typeof request.cwd === 'string' ? request.cwd : '';
    const includeAll = request.includeAll === true;
    const normalizedRequestCwd = includeAll ? '' : normalizeSessionCwd(requestCwd);

    const files = listCodexSessionFiles();
    const limitedFiles = files.slice(0, limit * 3);
    const dedup = new Map();

    for (const file of limitedFiles) {
      const preview = parseSessionPreview(file.filePath, file.size, file.name);
      const sessionId = preview.sessionId;
      if (!sessionId || dedup.has(sessionId)) continue;
      if (normalizedRequestCwd) {
        const sessionCwd = normalizeSessionCwd(preview.cwd || '');
        if (!sessionCwd || sessionCwd !== normalizedRequestCwd) continue;
      }

      const title = `세션 ${sessionId.slice(0, 8)}`;
      dedup.set(sessionId, {
        id: sessionId,
        title,
        description: preview.description || '',
        cwd: preview.cwd || '',
        startedAt: preview.startedAt || '',
        updatedAt: file.mtimeMs,
        filePath: file.filePath,
      });

      if (dedup.size >= limit) break;
    }

    return { success: true, data: Array.from(dedup.values()) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Codex 세션 대화 복원 ---
ipcMain.handle('codex:loadSession', (event, arg) => {
  try {
    const sessionId = typeof arg === 'string'
      ? arg.trim()
      : typeof arg?.sessionId === 'string'
        ? arg.sessionId.trim()
        : '';
    const preferredPath = typeof arg?.filePath === 'string' ? arg.filePath : '';
    const modeRaw = typeof arg?.mode === 'string' && arg.mode.toLowerCase() === 'raw';

    if (!sessionId) return { success: false, error: 'session id required' };

    const filePath = resolveCodexSessionFilePath(sessionId, preferredPath);
    if (!filePath) return { success: false, error: 'session file not found' };

    const parsed = parseCodexSessionConversation(filePath, {
      includeCommentary: modeRaw,
      includeIgnorablePrompts: modeRaw,
    });
    const resolvedId = parsed.id || sessionId;
    return {
      success: true,
      data: {
        id: resolvedId,
        title: parsed.description ? normalizePreviewText(parsed.description, 70) : `세션 ${resolvedId.slice(0, 8)}`,
        description: parsed.description || '',
        cwd: parsed.cwd || '',
        startedAt: parsed.startedAt || '',
        updatedAt: fs.statSync(filePath).mtimeMs,
        filePath,
        mode: modeRaw ? 'raw' : 'default',
        messages: parsed.messages,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('codex:deleteSession', (event, arg) => {
  try {
    const sessionId = typeof arg === 'string'
      ? arg.trim()
      : typeof arg?.sessionId === 'string'
        ? arg.sessionId.trim()
        : '';
    const preferredPath = typeof arg?.filePath === 'string' ? arg.filePath : '';

    if (!sessionId) return { success: false, error: 'session id required' };

    const filePath = resolveCodexSessionFilePath(sessionId, preferredPath);
    if (!filePath) return { success: false, error: 'session file not found' };
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return { success: false, error: 'session file not found' };
    }

    const sessionsDir = getCodexSessionsDir();
    if (!isSubPath(sessionsDir, filePath)) {
      return { success: false, error: 'invalid session file path' };
    }
    if (path.extname(filePath).toLowerCase() !== '.jsonl') {
      return { success: false, error: 'invalid session file type' };
    }

    fs.unlinkSync(filePath);
    return {
      success: true,
      data: {
        id: sessionId,
        filePath,
      },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 시스템 정보
ipcMain.handle('system:info', () => ({
  platform: process.platform,
  username: os.userInfo().username,
  homedir: os.homedir(),
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron,
}));

ipcMain.handle('system:openExternal', async (event, rawUrl) => {
  try {
    const url = new URL(String(rawUrl || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { success: false, error: 'unsupported URL protocol' };
    }
    await shell.openExternal(url.toString());
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
});

// --- 대화 데이터 파일 기반 저장/로드 ---
function getConversationsPath() {
  return path.join(app.getPath('userData'), 'conversations.json');
}

ipcMain.handle('store:loadConversations', () => {
  try {
    const filePath = getConversationsPath();
    if (!fs.existsSync(filePath)) return { success: true, data: [] };
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { success: true, data: Array.isArray(parsed) ? parsed : [] };
  } catch (err) {
    console.error('[store] loadConversations error:', err.message);
    return { success: false, data: [], error: err.message };
  }
});

ipcMain.handle('store:saveConversations', (event, data) => {
  try {
    const filePath = getConversationsPath();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 0), 'utf8');
    return { success: true };
  } catch (err) {
    console.error('[store] saveConversations error:', err.message);
    return { success: false, error: err.message };
  }
});

// 동기 저장 — beforeunload에서 호출 (앱 종료 시 스트리밍 중 데이터 보존)
ipcMain.on('store:saveConversationsSync', (event, data) => {
  try {
    const filePath = getConversationsPath();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 0), 'utf8');
    event.returnValue = { success: true };
  } catch (err) {
    console.error('[store] saveConversationsSync error:', err.message);
    event.returnValue = { success: false, error: err.message };
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  killStatusDaemon();
  app.quit();
});
