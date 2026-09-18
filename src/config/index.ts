// 集中配置：所有环境变量在此读取与校验，业务代码不再散落 process.env。
// 约定：带默认值的都不必配；无默认且缺失的，在启动日志里明确告警。

import path from 'path';

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
  /** 有状态数据的根目录；默认当前工作目录（保持与重构前一致） */
  dataRoot: string;
  /** 显式指定 Chrome 可执行文件路径（不指定则用 Playwright 自带 chromium） */
  chromePath?: string;
  /** 是否调用系统安装的 Chrome（本机开发用；容器里应保持 false 走自带 chromium） */
  useSystemChrome: boolean;
}

export const config: AppConfig = {
  nodeId: env('GEO_NODE_ID') ?? 'default',
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
  dataRoot: env('GEO_DATA_ROOT') ?? '.',
  chromePath: env('GEO_CHROME_PATH'),
  useSystemChrome: bool('GEO_USE_SYSTEM_CHROME', false),
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
    `port=${config.port}`,
    `artifactMode=${config.artifactMode}`,
    `headless=${config.headless}`,
    `maxBrowsers=${config.maxBrowsers}`,
    `dataRoot=${path.resolve(config.dataRoot)}`,
  ];
  if (config.pullHost) bits.push(`pullHost=${config.pullHost}`);
  return bits.join(' ');
}
