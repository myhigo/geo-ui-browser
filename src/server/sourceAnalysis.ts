// 信源分析：按关键词顺序 × 平台顺序逐个采集，信源按域名聚合，每个平台单独输出一个 JSON 文件。
//
// 用户 2026-09-04 定的三条口径（别改）：
//   ① citeCount = **总出现次数**：同一次回答内同一域名出现多次就计多次，跨关键词累计（不去重）。
//   ② **默认串行，可选并行**：关键词始终串行；同一个词内多个平台可并行（同时开多个浏览器，
//      等全部平台完成该词后再进下一词），由任务提交时的 mode 决定。并行需机器内存足够支撑多浏览器。
//   ③ 聚合**严格按平台各自独立成桶**，绝不跨平台合并；明细另存 _details.json 供追溯/换口径重算。
//
// 产物目录：analysis/<任务时间戳>/
//   <modelId>.json   每个平台一个，纯 JSON 数组，按 citeCount 降序，元素仅 siteName/domain/citeCount
//   _details.json    每个关键词在每个平台抓到的原始信源明细（追溯用，不影响主文件契约）
//   _meta.json       任务配置、成败统计、起止时间

import fs from 'fs';
import path from 'path';
import { withConcurrencyLimit } from './concurrency.js';

/** 主 JSON 文件的元素结构（严格三字段，契约不要随意加字段） */
export interface SourceStat {
  siteName: string;
  domain: string;
  citeCount: number;
}

/** 单条原始信源（明细用） */
export interface SourceRecord {
  title: string;
  url: string;
  siteName: string;
  domain: string;
}

export interface KeywordDetail {
  keyword: string;
  ok: boolean;
  error?: string;
  sources: SourceRecord[];
}

export interface PlatformDetail {
  platform: string;
  modelId: string;
  keywords: KeywordDetail[];
}

export interface AnalysisPlatformStat {
  platform: string;
  modelId: string;
  ok: number;
  fail: number; // 采集失败（登录失效/超时/无回答）
  hits: number; // 累计抓到的信源条数（含重复，等于该文件 citeCount 之和）
  domains: number; // 去重域名数
}

export interface AnalysisProgress {
  taskId: string;
  /** 用户命名的任务名（作为文件夹名与历史显示）；留空则仅用时间戳 */
  name?: string;
  running: boolean;
  startedAt: number;
  finishedAt: number;
  totalKeywords: number;
  doneKeywords: number;
  currentKeyword: string;
  currentPlatform: string;
  /** 执行模式：serial=词内平台串行（默认）；parallel=词内多平台同时开浏览器 */
  mode: 'serial' | 'parallel';
  /** 并行模式逐平台运行态（平台 id → 是否正在跑）；串行模式始终为空对象 */
  perPlatform?: Record<string, { running: boolean }>;
  platforms: AnalysisPlatformStat[];
  files: string[];
  lastError: string;
  dir: string;
}

export interface AnalysisCollect {
  (platform: string, keyword: string): Promise<{
    sources: { title: string; url: string; siteName: string }[];
  }>;
}

export const ANALYSIS_ROOT = path.resolve('analysis');

// 域名 → 中文站名兜底（平台没返回媒体名时用）。常见中文站点为主，不够就加。
const BUILTIN_SITE_NAMES: Record<string, string> = {
  'zhihu.com': '知乎',
  'baidu.com': '百度',
  'baike.baidu.com': '百度百科',
  'baijiahao.baidu.com': '百家号',
  'csdn.net': 'CSDN',
  'juejin.cn': '稀土掘金',
  'jianshu.com': '简书',
  'toutiao.com': '今日头条',
  'sina.com.cn': '新浪',
  '163.com': '网易',
  'qq.com': '腾讯网',
  'sohu.com': '搜狐',
  'bilibili.com': '哔哩哔哩',
  'xiaohongshu.com': '小红书',
  'douyin.com': '抖音',
  'weixin.qq.com': '微信公众号',
  'mp.weixin.qq.com': '微信公众号',
  'zhihuishu.com': '智慧树',
  'xueqiu.com': '雪球',
  '36kr.com': '36氪',
  'huxiu.com': '虎嗅',
  'ithome.com': 'IT之家',
  'cnbeta.com.tw': 'cnBeta',
  'oschina.net': '开源中国',
};

// 外部可覆盖/补充：项目根 site-names.json（{ "域名": "站名" }），服务启动后改动需重启
// （不放 analysis/ 下，因为产物目录整体被 gitignore，映射表需要能提交进仓库）
function loadSiteNames(): Record<string, string> {
  const map: Record<string, string> = { ...BUILTIN_SITE_NAMES };
  try {
    const f = path.resolve('site-names.json');
    if (fs.existsSync(f)) Object.assign(map, JSON.parse(fs.readFileSync(f, 'utf-8')));
  } catch {
    /* 外部映射表缺失/格式错 → 只用内置表 */
  }
  return map;
}

const SITE_NAMES = loadSiteNames();

/** 从信源 URL 取域名（去 www）；取不到返回空串 */
export function domainOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** 站名优先级：平台返回的媒体名 > 域名映射表 > 域名本身 */
function siteNameOf(rawName: string | undefined, domain: string): string {
  const n = (rawName ?? '').trim();
  if (n) return n;
  if (domain && SITE_NAMES[domain]) return SITE_NAMES[domain];
  return domain || '未知来源';
}

/** 生成产物文件夹名：优先用任务名（过滤非法字符），空则回退时间戳；重名加 -2/-3 后缀 */
function dirNameOf(name?: string): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  const clean = (name || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  const base = clean || ts;
  let id = base;
  let seq = 2;
  while (fs.existsSync(path.join(ANALYSIS_ROOT, id))) {
    id = `${base}-${seq}`;
    seq++;
  }
  return id;
}

export function createAnalysisStatus(
  keywords: string[],
  platforms: { platform: string; modelId: string }[],
  name?: string,
  mode: 'serial' | 'parallel' = 'serial'
): AnalysisProgress {
  const taskId = dirNameOf(name);
  return {
    taskId,
    name: name?.trim() || undefined,
    running: false,
    startedAt: 0,
    finishedAt: 0,
    totalKeywords: keywords.length,
    doneKeywords: 0,
    currentKeyword: '',
    currentPlatform: '',
    mode,
    perPlatform: {},
    platforms: platforms.map((p) => ({ ...p, ok: 0, fail: 0, hits: 0, domains: 0 })),
    files: [],
    lastError: '',
    dir: path.join(ANALYSIS_ROOT, taskId),
  };
}

/** 并发护栏抽到 ./concurrency.ts（`withConcurrencyLimit`），信源分析并行模式与收录检测共用。 */

interface Bucket {
  siteName: string;
  domain: string;
  count: number;
}

/**
 * 跑一轮信源分析（全程串行）。status 由调用方持有，函数就地更新进度，供轮询接口读取。
 * @param collect 采集回调（传 server.execute：自带身份策略/超时/解析）
 * @param modelIdOf 内部平台 id → 对方 modelId（文件名与回推标识用）
 */
export async function runSourceAnalysis(
  status: AnalysisProgress,
  keywords: string[],
  collect: AnalysisCollect,
  modelIdOf: (platform: string) => string,
  onLog?: (line: string) => void
): Promise<void> {
  const log = (l: string): void => (onLog ? onLog(l) : console.log(`[信源分析] ${l}`));
  status.running = true;
  status.startedAt = Date.now();
  status.finishedAt = 0;
  status.lastError = '';
  status.files = [];

  // 每个平台一个独立桶：Map<platform, Map<domain, Bucket>>，平台之间绝不合并
  const buckets = new Map<string, Map<string, Bucket>>();
  const details = new Map<string, PlatformDetail>();
  for (const p of status.platforms) {
    buckets.set(p.platform, new Map());
    details.set(p.platform, { platform: p.platform, modelId: p.modelId, keywords: [] });
  }

  // 词内单平台的一次采集（含报错隔离 + 桶写入 + 进度信令）；串行/并行共用
  async function runOne(ps: AnalysisPlatformStat, kw: string): Promise<void> {
    status.currentPlatform = ps.platform;
    if (status.perPlatform) status.perPlatform[ps.platform] = { running: true };
    const bucket = buckets.get(ps.platform)!;
    const detail = details.get(ps.platform)!;
    try {
      const r = await collect(ps.platform, kw);
      const list = r.sources ?? [];
      const records: SourceRecord[] = [];
      let used = 0;
      for (const s of list) {
        const domain = domainOf(s.url);
        // 归因键：优先用域名；元宝等「引用仅来源名、无文章 URL」的平台回退到来源名，使其可被计入统计。
        // ⚠️ 三条锁定口径不变：citeCount=总出现次数 / 串行·并行 / 按平台独立成桶。
        const key = domain || (s.siteName || '').trim();
        if (!key) continue; // 既无 URL 又无来源名 → 无法归因，跳过
        const name = siteNameOf(s.siteName, domain);
        records.push({ title: s.title ?? '', url: s.url ?? '', siteName: name, domain: key });
        const old = bucket.get(key);
        if (old) {
          old.count += 1; // 口径①：不去重，出现一次计一次
          // 站名只升不降：先前只拿到域名兜底、后来拿到真名则用真名
          if (old.siteName === old.domain && name !== domain) old.siteName = name;
        } else {
          bucket.set(key, { siteName: name, domain: key, count: 1 });
        }
        used++;
      }
      ps.ok += 1;
      ps.hits += used;
      detail.keywords.push({ keyword: kw, ok: true, sources: records });
      log(`[${ps.modelId}] 「${kw}」完成：信源 ${list.length} 条（有效 ${used}）`);
    } catch (e) {
      const msg = (e as Error).message || '采集失败';
      ps.fail += 1;
      status.lastError = `[${ps.modelId}] 「${kw}」失败：${msg}`;
      detail.keywords.push({ keyword: kw, ok: false, error: msg, sources: [] });
      log(`✗ ${status.lastError}`);
    } finally {
      if (status.perPlatform) status.perPlatform[ps.platform] = { running: false };
    }
  }

  const PARALLEL_LIMIT = 4; // 并行模式同时开浏览器上限（用户偏好：全平台同开）
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    status.currentKeyword = kw;
    if (status.mode === 'parallel') {
      // 词内多平台并行：同时开最多 PARALLEL_LIMIT 个浏览器，全部完成后进下一词
      await withConcurrencyLimit(status.platforms, PARALLEL_LIMIT, (ps) => runOne(ps, kw));
    } else {
      // 串行：逐平台顺序执行
      for (const ps of status.platforms) {
        await runOne(ps, kw);
      }
    }
    status.doneKeywords = i + 1;
    // 词与词之间随机冷却 45-90s
    if (i < keywords.length - 1) {
      const wait = 45000 + Math.random() * 45000; // 45-90 秒
      status.currentKeyword = '';
      status.currentPlatform = '';
      log(`⏳ 已完成 ${i + 1}/${keywords.length} 词，词间冷却 ${Math.round(wait / 1000)}s 后进入下一词…`);
      await new Promise<void>((res) => setTimeout(res, wait));
    }
  }

  // 落盘
  fs.mkdirSync(status.dir, { recursive: true });
  for (const ps of status.platforms) {
    const bucket = buckets.get(ps.platform)!;
    const arr: SourceStat[] = [...bucket.values()]
      .map((b) => ({ siteName: b.siteName, domain: b.domain, citeCount: b.count }))
      .sort((a, b) => b.citeCount - a.citeCount || a.domain.localeCompare(b.domain));
    ps.domains = arr.length;
    const file = `${ps.modelId}.json`;
    fs.writeFileSync(path.join(status.dir, file), JSON.stringify(arr, null, 2));
    status.files.push(file);
    log(`[${ps.modelId}] 输出 ${file}：${arr.length} 个站点 / 累计引用 ${ps.hits} 次`);
  }
  fs.writeFileSync(
    path.join(status.dir, '_details.json'),
    JSON.stringify([...details.values()], null, 2)
  );
  status.files.push('_details.json');
  const meta = {
    taskId: status.taskId,
    name: status.name,
    startedAt: status.startedAt,
    finishedAt: Date.now(),
    keywords,
    platforms: status.platforms.map((p) => ({
      platform: p.platform,
      modelId: p.modelId,
      ok: p.ok,
      fail: p.fail,
      hits: p.hits,
      domains: p.domains,
    })),
  };
  fs.writeFileSync(path.join(status.dir, '_meta.json'), JSON.stringify(meta, null, 2));
  status.files.push('_meta.json');

  status.currentKeyword = '';
  status.currentPlatform = '';
  status.finishedAt = meta.finishedAt;
  status.running = false;
  log(
    `本轮结束：${keywords.length} 词 × ${status.platforms.length} 平台，产物目录 ${status.dir}`
  );
}

/** 历史任务列表（倒序），供页面回看/下载 */
export function listTasks(): { taskId: string; name?: string; finishedAt: number; keywords: number; files: string[] }[] {
  if (!fs.existsSync(ANALYSIS_ROOT)) return [];
  const out: { taskId: string; name?: string; finishedAt: number; keywords: number; files: string[] }[] = [];
  for (const name of fs.readdirSync(ANALYSIS_ROOT)) {
    const dir = path.join(ANALYSIS_ROOT, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    let keywords = 0;
    let finishedAt = 0;
    let taskName: string | undefined;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, '_meta.json'), 'utf-8')) as {
        keywords?: unknown[];
        finishedAt?: number;
        name?: string;
      };
      keywords = meta.keywords?.length ?? 0;
      finishedAt = meta.finishedAt ?? 0;
      taskName = meta.name;
    } catch {
      /* 没有 meta（跑崩了）也照样列出来，只是信息少 */
    }
    out.push({
      taskId: name,
      name: taskName,
      finishedAt,
      keywords,
      files: fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json') && !f.startsWith('_')),
    });
  }
  return out.sort((a, b) => b.finishedAt - a.finishedAt || b.taskId.localeCompare(a.taskId));
}

/** 读取产物文件（带目录穿越防护） */
export function readTaskFile(taskId: string, file: string): string | null {
  // taskId 即产物目录名（dirNameOf 生成，允许中文/常见字符），仅拦截路径穿越
  if (!taskId || taskId.includes('/') || taskId.includes('\\') || taskId.includes('..')) return null;
  if (!/^[A-Za-z0-9._-]+\.json$/.test(file)) return null;
  const p = path.join(ANALYSIS_ROOT, taskId, file);
  if (!p.startsWith(ANALYSIS_ROOT)) return null;
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}
