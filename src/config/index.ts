// 集中配置：所有环境变量在此读取与校验，业务代码不再散落 process.env。
// 约定：带默认值的都不必配；无默认且缺失的，在启动日志里明确告警。

import fs from 'fs';
import path from 'path';

// 本地开发用：加载项目根目录的 .env（零依赖，避免引入 dotenv）。
// 生产/Docker 直接注入真实环境变量，这里只补充「缺失项」，绝不覆盖已存在的 env；
// 找不到 .env（如容器里）就静默跳过。必须在下方的 config 读取 process.env 之前执行。
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === '' ? undefined : v.trim();
};

const num = (k: string, d: number): number => {
  const v = env(k);
  if (v === undefined) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const bool = (k: string, d: boolean): boolean => {
  const v = env(k);
  if (v === undefined) return d;
  return v === '1' || v.toLowerCase() === 'true';
};

/** 产物模式：none=不落盘（生产默认）；debug=落 diagnostics/ 供选择器校准 */
export type ArtifactMode = 'none' | 'debug';

/** 存储后端：file=本地 json（开发用）；mysql=数据库（生产用） */
export type StorageBackend = 'file' | 'mysql';

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface AppConfig {
  /** 本节点标识：账号归属哪台机器（多机时挑号只挑本节点的账号） */
  nodeId: string;
  /** 账号台账等结构化状态存哪 */
  storage: StorageBackend;
  db: DbConfig;
  /** API 端口 */
  port: number;
  /** 挂载前缀：单域名多服务时由 nginx 用前缀区分（如 /geoui）。留空 = 根路径部署；路由与前端链接都会拼上 */
  basePath: string;
  /** 单次采集超时（毫秒） */
  timeoutMs: number;
  /** 对方服务地址（拉词/回推） */
  pullHost: string;
  /** 产物是否落盘 */
  artifactMode: ArtifactMode;
  /** 采集是否无头（登录窗口恒为有头） */
  headless: boolean;
  /** 同时打开浏览器的上限 */
  maxBrowsers: number;
  /** 同一出口 IP 上同时跑的任务上限（1=同一 IP 串行，最安全；调大提速但风控风险上升） */
  maxPerEgress: number;
  /** 有状态数据的根目录；默认当前工作目录（保持与重构前一致） */
  dataRoot: string;
  /** 显式指定 Chrome 可执行文件路径（不指定则用 Playwright 自带 chromium） */
  chromePath?: string;
  /** 是否调用系统安装的 Chrome（本机开发用；容器里应保持 false 走自带 chromium） */
  useSystemChrome: boolean;
  /** noVNC 页面地址，/admin 内嵌用（建议走反向代理保持同源）；留空则不显示登录窗口面板 */
  novncUrl: string;
  /**
   * 测试结果落盘目录（留空 = 不落盘）。
   * 仅用于人工验证：每次采集把截图 / 回答 / 信源写到该目录下，便于在宿主机挂载卷里直接查看。
   * 与 artifactMode 无关（none 模式下 diagnostics 产物依然不落盘，这里只额外写这一份验证结果）。
   */
  testOutDir: string;
  shot: {
    /** 输出格式：webp 体积远小于 png，文字边缘优于 jpeg */
    format: 'webp' | 'jpeg' | 'png';
    /** 起始质量，压缩后仍超限会逐步下调 */
    quality: number;
    /** 宽度上限，超出等比缩小 */
    maxWidth: number;
    /** 目标字节上限 */
    maxBytes: number;
  };
}

/** 归一化挂载前缀：确保有且只有一个前导斜杠、无尾斜杠；空值返回 ''（根部署） */
function normalizeBasePath(v?: string): string {
  if (!v) return '';
  let p = v.trim();
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * noVNC 页面默认地址（经 nginx 同源反代时）。
 * websockify 只在根路径提供服务，nginx 需「剥离前缀」转给容器 6080；
 * 而 noVNC 的 WebSocket 默认连 /websockify（页面所在子路径），子路径部署时必须用
 * ?path= 显式指定为 <前缀>/novnc/websockify，否则 WS 握手 404 → 登录窗口黑屏。
 * 直连 6080（无 nginx）时请显式设 GEO_NOVNC_URL=http://host:6080/vnc.html?...（path 用默认）。
 */
function defaultNovncUrl(base: string): string {
  const sub = base ? `${base.replace(/^\//, '')}/novnc/websockify` : 'novnc/websockify';
  return `${base}/novnc/vnc.html?autoconnect=1&resize=scale&path=${sub}`;
}

const basePath = normalizeBasePath(env('GEO_BASE_PATH'));

export const config: AppConfig = {
  nodeId: env('GEO_NODE_ID') ?? 'default',
  basePath,
  storage: env('GEO_STORAGE') === 'file' ? 'file' : 'mysql',
  db: {
    host: env('DB_HOST') ?? '',
    port: num('DB_PORT', 3306),
    user: env('DB_USER') ?? '',
    password: env('DB_PASSWORD') ?? '',
    database: env('DB_NAME') ?? '',
  },
  port: num('PORT', 8787),
  timeoutMs: num('GEO_TIMEOUT_MS', 3 * 60 * 1000),
  pullHost: env('GEO_PULL_HOST') ?? '',
  artifactMode: env('GEO_ARTIFACT_MODE') === 'debug' ? 'debug' : 'none',
  headless: bool('GEO_HEADLESS', true),
  maxBrowsers: num('GEO_MAX_BROWSERS', 4),
  maxPerEgress: num('GEO_MAX_PER_EGRESS', 1),
  dataRoot: env('GEO_DATA_ROOT') ?? '.',
  chromePath: env('GEO_CHROME_PATH'),
  useSystemChrome: bool('GEO_USE_SYSTEM_CHROME', false),
  novncUrl: env('GEO_NOVNC_URL') ?? defaultNovncUrl(basePath),
  testOutDir: env('GEO_TEST_OUT_DIR') ?? '',
  shot: {
    format: (env('GEO_SHOT_FORMAT') === 'jpeg' ? 'jpeg' : env('GEO_SHOT_FORMAT') === 'png' ? 'png' : 'webp') as
      | 'webp'
      | 'jpeg'
      | 'png',
    quality: num('GEO_SHOT_QUALITY', 80),
    maxWidth: num('GEO_SHOT_MAX_WIDTH', 900),
    maxBytes: num('GEO_SHOT_MAX_BYTES', 300 * 1024),
  },
};

/** 有状态数据的落地路径；dataRoot 默认为 '.' 时与重构前完全一致 */
export const paths = {
  get profilesRoot(): string {
    return path.resolve(config.dataRoot, '.profiles');
  },
  get diagnosticsRoot(): string {
    return path.resolve(config.dataRoot, 'diagnostics');
  },
  get analysisRoot(): string {
    return path.resolve(config.dataRoot, 'analysis');
  },
  get siteNamesFile(): string {
    return path.resolve(config.dataRoot, 'site-names.json');
  },
};

/** 启动日志：只打印非默认的关键项，避免刷屏 */
export function describeConfig(): string {
  const bits = [
    `node=${config.nodeId}`,
    `storage=${config.storage}`,
    `basePath=${config.basePath || '/'}`,
    `port=${config.port}`,
    `artifactMode=${config.artifactMode}`,
    `headless=${config.headless}`,
    `maxBrowsers=${config.maxBrowsers}`,
    `dataRoot=${path.resolve(config.dataRoot)}`,
  ];
  if (config.pullHost) bits.push(`pullHost=${config.pullHost}`);
  return bits.join(' ');
}
