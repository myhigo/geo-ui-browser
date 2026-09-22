import express from 'express';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { runDiagnostic } from '../diagnostics/run.js';
import { SourceInfo } from '../types.js';
import { PLATFORMS } from '../platforms/index.js';
import { ENABLED_PLATFORMS, PullConfig, runPullRound } from './pull.js';
import {
  AnalysisProgress,
  ANALYSIS_ROOT,
  createAnalysisStatus,
  listTasks,
  readTaskFile,
  runSourceAnalysis,
} from './sourceAnalysis.js';
import {
  LOGIN_DRIVERS,
  allocateAccount,
  allocateSpecificAccount,
  setAccountEnabled,
  setAccountPriority,
  confirmLogin,
  deleteAccount,
  listViews,
  loginBusy,
  logoutAccount,
  releaseAccount,
  startLogin,
  testAccount,
  closeTestAccount,
  listTestSessions,
  updateAlias,
} from './loginRegistry.js';
import { adminPageHtml } from './loginUI.js';
import { config, paths, describeConfig } from '../config/index.js';
import { accountRepo } from '../storage/accountRepo.js';
import { pingDb, releaseStaleLeases } from '../db/pool.js';
import { identityRepo } from '../storage/identityRepo.js';
import { compressScreenshot } from '../storage/shotCompressor.js';
import { installShutdownHandlers, isShuttingDown } from '../runtime/shutdown.js';

const PORT = config.port;
const TIMEOUT_MS = config.timeoutMs;

// 平台标识统一为下层 modeId（qwen/wenxiaoyan/hunyuan/doubao/deepseek），对外接口直接透传，
// 不再做别名映射（2026-09-08 对齐：消除双命名导致的回推错位 bug）。

// 失败原因摘要（取错误/警告类备注）
function summarize(notes: string[]): string {
  const hits = notes.filter((n) => n.includes('❌') || n.includes('⚠️'));
  const picked = hits.length ? hits : notes;
  return picked.join('；').slice(0, 500) || '未知原因';
}

function siteFromUrl(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

class ApiError extends Error {
  constructor(
    public status: number,
    public msg: string
  ) {
    super(msg);
  }
}

// 身份策略（2026-09-03 定稿，用户 12:43 拍板）：
//  - 文心：匿名身份轮换 .profiles/wenxiaoyan-rotating（quota 4）。匿名仍可用（loginRequired=false、
//    sources 22~30），保留计数轮换。
//  - 千问：**单一匿名持久身份** .profiles/qwen。两种重生：①撞登录墙清空重生并自动重试一次；
//    ②**按对话数主动重生**（每 QIANWEN_CONVERSATION_LIMIT 个成功对话清空一次），在平台"约 5 新对话后弹登录提示"
//    的软阈值出现前就刷新，避免被标记。⚠️ 教训：不做多身份轮换——同 IP 快速轮换触发风控短限
//    （12:34 实测连新身份都要登录；12:40 冷却后单个干净匿名身份直接可用）。单身份低频清 cookie 最像真人。
const ROTATIONS: Record<string, { dir: string; quota: number }> = {
  wenxiaoyan: { dir: path.join(paths.profilesRoot, 'wenxiaoyan-rotating'), quota: 4 },
};
// 撞墙才重生的平台（不预清空，撞登录墙时清空 + 自动重试一次）
const REACTIVE_RESET_PLATFORMS = new Set(['qwen']);
const QWEN_PROFILE_DIR = path.join(paths.profilesRoot, 'qwen');
// 千问匿名身份阈值：约 5 个新对话后平台弹登录提示（软阈值，不一定阻断回答），达到即主动清空重生，
// 避免提示出现——也契合「约 5 问一次清 cookie」的设计意图（非多身份轮换，单身份低频清 cookie 不触发风控）。
const QIANWEN_CONVERSATION_LIMIT = 5;
const QWEN_COUNT_KEY = 'qwen-conv-count';

async function readQwenCount(): Promise<number> {
  const st = await identityRepo().get(QWEN_COUNT_KEY);
  return (st?.count as number) ?? 0;
}

async function writeQwenCount(n: number): Promise<void> {
  await identityRepo().set(QWEN_COUNT_KEY, { count: n });
}

async function resetQwenIdentity(reason: string): Promise<void> {
  fs.rmSync(QWEN_PROFILE_DIR, { recursive: true, force: true });
  await writeQwenCount(0);
  console.log(`[qwen身份] ${reason}`);
}

type RotationState = { count: number };

const rotationKeyOf = (dir: string): string => `rotation:${dir}`;

async function readRotationState(dir: string): Promise<RotationState> {
  const st = await identityRepo().get(rotationKeyOf(dir));
  return (st as RotationState | null) ?? { count: 0 };
}

async function writeRotationState(dir: string, s: RotationState): Promise<void> {
  await identityRepo().set(rotationKeyOf(dir), s as unknown as Record<string, unknown>);
}

// 取身份：计数到额度 → 清空 profile 目录（新身份）并归零
async function acquireIdentity(platform: string): Promise<void> {
  const cfg = ROTATIONS[platform];
  const st = await readRotationState(cfg.dir);
  if (st.count >= cfg.quota) {
    fs.rmSync(cfg.dir, { recursive: true, force: true });
    await writeRotationState(cfg.dir, { count: 0 });
    console.log(`[${platform}身份] 已用满 ${cfg.quota} 次，清空 storage 重生匿名身份`);
  }
}

// 归还身份：计数 +1；撞到登录墙（异常消耗/口径变化）→ 立即清空重生，不等计数
async function releaseIdentity(platform: string, loginRequired: boolean): Promise<void> {
  const cfg = ROTATIONS[platform];
  if (loginRequired) {
    fs.rmSync(cfg.dir, { recursive: true, force: true });
    await writeRotationState(cfg.dir, { count: 0 });
    console.log(`[${platform}身份] 检测到登录墙，提前清空 storage 重生匿名身份`);
    return;
  }
  const st = await readRotationState(cfg.dir);
  await writeRotationState(cfg.dir, { count: st.count + 1 });
}

// 测试结果落盘（仅供人工验证）。写到 GEO_TEST_OUT_DIR 下：
//   <dir>/<时间>_<平台>_<账号>_<关键词>/{screenshot.webp, answer.txt, sources.json, meta.json}
// 与 artifactMode 无关：none 模式下 diagnostics 产物依然不落盘，这里只额外写这一份验证结果。
function saveRunResult(opts: {
  dir: string;
  platform: string;
  keyword: string;
  accountId?: string;
  shot: { mime: string; buffer: Buffer };
  answer: string;
  sources: { title: string; url: string; siteName: string }[];
}): string | undefined {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeKw = (opts.keyword || 'kw').replace(/[^\w一-龥-]+/g, '_').slice(0, 30);
    const outDir = path.join(opts.dir, `${stamp}_${opts.platform}_${opts.accountId || 'auto'}_${safeKw}`);
    fs.mkdirSync(outDir, { recursive: true });
    const ext = opts.shot.mime === 'image/jpeg' ? 'jpg' : opts.shot.mime === 'image/png' ? 'png' : 'webp';
    fs.writeFileSync(path.join(outDir, `screenshot.${ext}`), opts.shot.buffer);
    fs.writeFileSync(path.join(outDir, 'answer.txt'), opts.answer || '', 'utf8');
    fs.writeFileSync(path.join(outDir, 'sources.json'), JSON.stringify(opts.sources || [], null, 2), 'utf8');
    fs.writeFileSync(
      path.join(outDir, 'meta.json'),
      JSON.stringify(
        {
          platform: opts.platform,
          keyword: opts.keyword,
          accountId: opts.accountId ?? null,
          finishedAt: new Date().toISOString(),
          screenshotMime: opts.shot.mime,
          screenshotBytes: opts.shot.buffer.length,
          answerChars: (opts.answer || '').length,
          sourceCount: (opts.sources || []).length,
        },
        null,
        2
      ),
      'utf8'
    );
    return outDir;
  } catch (e) {
    console.log(`[saveRunResult] 测试结果落盘失败：${(e as Error).message}`);
    return undefined;
  }
}

// 组装响应：截图 base64 + 回答 + 信源
export async function execute(
  platform: string,
  keyword: string,
  headed: boolean,
  accountId?: string
): Promise<{ screenshot: string; answer: string; sources: { title: string; url: string; siteName: string }[] }> {
  let userDataDir: string | undefined = path.join(paths.profilesRoot, platform);
  let waitLoginMs = 0;
  let ledgerAccountId: string | undefined;
  // 登录制平台统一走 /admin 账号台账（与 cli.ts:56 同一套逻辑，避免"CLI 能跑、服务端拿不到账号"）。
  // 判定用 LOGIN_DRIVERS 而非硬编码平台名：新增台账平台（DeepSeek 等）自动生效。
  const loginDriver = LOGIN_DRIVERS[platform];
  // 全平台登录制（2026-09-07：千问/文心由匿名切换为登录，所有大模型走登录台账）。
  // 登录制平台不参与任何匿名身份机制（轮换/重生），以下两标志对其强制失效。
  const isLoginPlatform = !!loginDriver?.loginRequired;
  const rotation = isLoginPlatform ? undefined : ROTATIONS[platform];
  const reactive = isLoginPlatform ? false : REACTIVE_RESET_PLATFORMS.has(platform);
  if (loginDriver?.loginRequired) {
    // 指定账号优先（手动切换）；校验失败直接返回原因，绝不静默换号
    const ready = accountId
      ? await allocateSpecificAccount(platform, accountId)
      : await allocateAccount(platform);
    if (!ready.ok) throw new ApiError(409, ready.reason ?? `${platform} 没有可用登录账号`);
    ledgerAccountId = ready.accountId;
    userDataDir = ready.dir;
    waitLoginMs = 0;
  } else if (rotation) {
    await acquireIdentity(platform);
    userDataDir = rotation.dir;
  } else if (reactive) {
    userDataDir = QWEN_PROFILE_DIR;
  } else {
    waitLoginMs = headed ? 120_000 : 0; // 登录态平台：有头窗口内等人工登录
  }
  let result = await runDiagnostic(keyword, {
    platform,
    useSystemChrome: config.useSystemChrome,
    executablePath: config.chromePath,
    userDataDir,
    headless: !headed,
    waitLoginMs,
  });
  if (rotation) await releaseIdentity(platform, result.loginRequired);
  if (ledgerAccountId) {
    await releaseAccount(platform, ledgerAccountId, !!result.answerText && !result.loginRequired, result.loginRequired);
    // ⚠️ 登录平台：打开登录账号目录后仍检测到登录墙（磁盘登录态失效/从未落盘）→ 明确失败并提示重登，
    // 绝不默默以匿名/未登录态跑完冒充成功（2026-09-07 文心实测：登录目录无 BDUSS，整轮匿名问答还报 ok）。
    // 上面 releaseAccount 的 loginRequired=true 分支已把该账号标 failed，此处抛错终止本轮。
    if (result.loginRequired) {
      throw new ApiError(
        401,
        `「${LOGIN_DRIVERS[platform]?.label ?? platform}」${ledgerAccountId} 登录态失效或未持久化（磁盘上无有效登录会话），本轮已按失败处理。请到 /admin 对该账号点「退出登录」后重新登录，再重试。`
      );
    }
  }
  // 千问：单一匿名持久身份。①撞登录墙 → 清空重生并自动重试；②成功对话累计到阈值 → 主动清空重生，避免触发登录提示
  if (reactive) {
    if (result.loginRequired) {
      await resetQwenIdentity('撞登录墙，重置匿名身份并自动重试一次');
      result = await runDiagnostic(keyword, {
        platform,
        useSystemChrome: config.useSystemChrome,
        executablePath: config.chromePath,
        userDataDir: QWEN_PROFILE_DIR,
        headless: !headed,
        waitLoginMs: 0,
      });
    } else if (result.answerText) {
      const c = (await readQwenCount()) + 1;
      if (c >= QIANWEN_CONVERSATION_LIMIT) {
        await resetQwenIdentity(`已用满 ${QIANWEN_CONVERSATION_LIMIT} 个匿名对话，提前清空重生（避免触发登录提示）`);
      } else {
        await writeQwenCount(c);
      }
    }
  }

  if (!result.answerText) {
    throw new ApiError(500, summarize(result.notes));
  }
  const toSource = (s: SourceInfo) => ({
    title: s.title ?? '',
    url: s.url ?? '',
    siteName: s.platform ?? siteFromUrl(s.url),
  });
  const sources = (result.sources ?? []).map(toSource);

  // 2026-09-03 17:47 用户定：截图失败/未产出 → 不整页兜底，screenshot 留空（不因缺截图判失败）
  // ⚠️ artifactMode=none（生产默认）时，截图临时文件读完 Buffer 就被删了、sampleDir 也是空字符串，
  //    所以不能从文件读 —— 必须优先用 run.ts 返回的内存 Buffer（qaScreenshotBuffer）；
  //    再统一压缩（回推对方服务要的就是压缩后的 base64）。
  let screenshot = '';
  try {
    let shotBuf: Buffer | undefined = result.qaScreenshotBuffer;
    if ((!shotBuf || shotBuf.length === 0) && result.artifacts.qaScreenshot && result.sampleDir) {
      const p = path.join(result.sampleDir, result.artifacts.qaScreenshot);
      if (fs.existsSync(p)) shotBuf = fs.readFileSync(p);
    }
    if (shotBuf && shotBuf.length > 0) {
      const cr = await compressScreenshot(shotBuf);
      screenshot = `data:${cr.mime};base64,${cr.buffer.toString('base64')}`;
      // 验证用落盘（GEO_TEST_OUT_DIR 留空则不写），方便在宿主机挂载卷里直接看截图/回答/信源
      if (config.testOutDir) {
        const dir = saveRunResult({
          dir: config.testOutDir,
          platform,
          keyword,
          accountId,
          shot: { mime: cr.mime, buffer: cr.buffer },
          answer: result.answerText ?? '',
          sources,
        });
        if (dir) console.log(`[${platform}] 测试结果已落盘：${dir}`);
      }
    }
  } catch (e) {
    console.log(`[${platform}] 截图压缩失败，screenshot 留空：${(e as Error).message}`);
  }
  return { screenshot, answer: result.answerText, sources };
}

// 同平台串行、跨平台并行
const queues = new Map<string, Promise<void>>();
function enqueue(key: string, task: () => Promise<void>): Promise<void> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(key, next);
  return next;
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ApiError(504, '超时：3分钟内未完成抓取')), TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

const app = express();
const router = express.Router();
app.use(express.json({ limit: '1mb' }));

// 健康检查（容器 HEALTHCHECK 用）：正在关闭时返回 503，便于编排层摘流量。
// ⚠️ 必须挂在 app（根路径）上、不随 GEO_BASE_PATH 加前缀：
// Dockerfile HEALTHCHECK 固定请求容器内 127.0.0.1:8787/healthz（不经 nginx），
// 若挪到前缀路由下，带前缀部署时健康检查恒 404，容器会被判 unhealthy。
app.get('/healthz', (_req, res) => {
  res.status(isShuttingDown() ? 503 : 200).json({
    ok: !isShuttingDown(),
    node: config.nodeId,
    storage: config.storage,
  });
});

// 根路径便捷重定向到管理台（无前缀部署时访问 / 直接进 /admin）
app.get('/', (_req, res) => {
  res.redirect(`${config.basePath}/admin`);
});

// 采集问答
router.post('/api/web-collect', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawPlatform = typeof body.platform === 'string' ? body.platform.toLowerCase().trim() : '';
  const platform = rawPlatform;
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
  const headed = body.headed === true;
  // 手动切换账号：指定 accountId（不传则按策略自动挑号）
  const accountId =
    typeof body.accountId === 'string' && body.accountId.trim() ? body.accountId.trim() : undefined;

  if (!platform || !PLATFORMS[platform]) {
    res
      .status(400)
      .json({ msg: `不支持的平台 "${rawPlatform || '(空)'}"，支持：qwen（千问）、wenxiaoyan（百度文心）、hunyuan（腾讯元宝）、doubao（豆包）、deepseek` });
    return;
  }
  if (!keyword) {
    res.status(400).json({ msg: 'keyword 不能为空' });
    return;
  }

  enqueue(platform, async () => {
    const data = await withTimeout(execute(platform, keyword, headed, accountId));
    res.status(200).json(data);
  }).catch((e: unknown) => {
    if (res.headersSent) return;
    if (e instanceof ApiError) {
      res.status(e.status).json({ msg: e.msg });
    } else {
      res.status(500).json({ msg: (e as Error).message || '抓取失败' });
    }
  });
});

// 拉模式（pull）：手动触发，分页拉词逐个采集，结果回推。
// 对方服务地址优先级：/api/pull/run 请求体 pullHost（admin 页可填，默认 http://127.0.0.1:8101）
//                  > 环境变量 GEO_PULL_HOST（服务启动时注入，作默认兜底）。
// 时间范围 startTime/endTime 由请求体透传（可选），不带则拉全部。
const envPullHost = config.pullHost;

const pullStatus = {
  running: false,
  startedAt: 0,
  finishedAt: 0,
  pages: 0,
  fetched: 0,
  success: 0,
  failed: 0,
  reportFailed: 0,
  lastError: '',
  host: '',
};

// 手动触发一轮 pull：后台跑，202 立即返回；进度看 GET /api/pull/status 与服务日志
router.post('/api/pull/run', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // 对方服务地址：请求体 pullHost 优先，其次环境变量 GEO_PULL_HOST；允许省略 http:// 前缀
  const bodyHost = typeof body.pullHost === 'string' ? body.pullHost.trim() : '';
  let host = bodyHost || envPullHost;
  if (host && !/^https?:\/\//i.test(host)) host = `http://${host}`;
  if (host) {
    try {
      if (!new URL(host).hostname) throw new Error('empty hostname');
    } catch {
      res.status(400).json({ msg: `pullHost 无效：${host}` });
      return;
    }
  }
  if (!host) {
    res
      .status(400)
      .json({ msg: '缺少对方服务地址：请在请求体传 pullHost（admin 页可填），或启动时注入 GEO_PULL_HOST' });
    return;
  }
  if (pullStatus.running) {
    res.status(409).json({ msg: '已有一轮 pull 在运行，请等待其结束（可看 GET /api/pull/status）' });
    return;
  }
  // 平台：默认全部启用平台；勾选哪些就只跑哪些（body.platforms 数组，下层 modeId）。兼容旧的 body.platform 单值。
  const rawPlats = (
    (Array.isArray(body.platforms) ? body.platforms.map(String) : [])
      .concat(typeof body.platform === 'string' && body.platform.trim() ? [body.platform] : [])
      .map((s) => s.toLowerCase().trim())
      .filter(Boolean) as string[]
  ).filter((p) => ENABLED_PLATFORMS.includes(p));
  const forced: string[] | undefined = rawPlats.length ? rawPlats : undefined;
  // 时间范围透传：调用方可带 startTime/endTime（yyyy-MM-dd 或 yyyy-MM-dd HH:mm:ss），不带则拉全部
  const startTime = typeof body.startTime === 'string' && body.startTime.trim() ? body.startTime.trim() : undefined;
  const endTime = typeof body.endTime === 'string' && body.endTime.trim() ? body.endTime.trim() : undefined;
  // 格式校验：只放行 yyyy-MM-dd 或 yyyy-MM-dd HH:mm:ss（T 分隔也认），避免格式写错被静默透传、下层按空处理而拉到全量
  const TIME_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?$/;
  const badTime: [string, string] | undefined =
    startTime && !TIME_RE.test(startTime)
      ? ['startTime', startTime]
      : endTime && !TIME_RE.test(endTime)
        ? ['endTime', endTime]
        : undefined;
  if (badTime) {
    res.status(400).json({ msg: `${badTime[0]} 格式不正确：应为 yyyy-MM-dd 或 yyyy-MM-dd HH:mm:ss，当前「${badTime[1]}」` });
    return;
  }
  const headed = body.headed === true; // 默认无头；需要人工盯/首次登录等场景传 true
  pullStatus.running = true;
  pullStatus.startedAt = Date.now();
  pullStatus.finishedAt = 0;
  pullStatus.pages = 0;
  pullStatus.fetched = 0;
  pullStatus.success = 0;
  pullStatus.failed = 0;
  pullStatus.reportFailed = 0;
  pullStatus.lastError = '';
  pullStatus.host = host;
  res.status(202).json({ msg: 'pull 轮次已开始，进度见 GET /api/pull/status 与服务日志' });
  const cfg: PullConfig = { host, pageSize: 20, startTime, endTime };
  console.log(`[pull] 触发：host=${host} headless=${!headed} platform=${forced ? forced.join(',') : 'auto(全部启用)'} startTime=${startTime ?? '-'} endTime=${endTime ?? '-'}`);
  // execute 自带平台身份策略（千问撞墙重生 / 文心轮换）；headed 由本轮请求决定
  runPullRound(cfg, (platform, keyword) => execute(platform, keyword, headed), forced, (line) => console.log(`[pull] ${line}`))
    .then((s) => {
      pullStatus.running = false;
      pullStatus.finishedAt = Date.now();
      Object.assign(pullStatus, s);
      console.log(`[pull] 轮次结束：${JSON.stringify(s)}`);
    })
    .catch((e: unknown) => {
      pullStatus.running = false;
      pullStatus.finishedAt = Date.now();
      pullStatus.lastError = (e as Error).message || 'pull 轮次异常';
      console.error('[pull] 轮次异常：', pullStatus.lastError);
    });
});

// pull 轮次进度（内存态，仅当轮）
router.get('/api/pull/status', (_req, res) => {
  res.status(200).json(pullStatus);
});

// ---------- 信源分析（页面输入多关键词 → 全部平台顺序采集 → 每平台一个 JSON 文件） ----------
// 口径见 sourceAnalysis.ts 顶部注释（citeCount 不去重 / 全程串行 / 按平台各自独立聚合）。
let analysisStatus: AnalysisProgress | null = null;

router.post('/api/source-analysis/run', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // 关键词：可接受数组，也可直接把 textarea 整段文本丢进来（按行切、去空行）
  const rawKw = body.keywords;
  const keywords = (Array.isArray(rawKw) ? rawKw.map(String) : String(rawKw ?? '').split('\n'))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!keywords.length) {
    res.status(400).json({ msg: '请至少填一个关键词（每行一个）' });
    return;
  }
  if (analysisStatus?.running) {
    res.status(409).json({ msg: '已有一轮信源分析在运行，请等待其结束（可看 GET /api/source-analysis/status）' });
    return;
  }
  // 平台：默认全部启用平台；可传数组或逗号分隔串（直接传下层 modeId：qwen/wenxiaoyan/hunyuan/doubao/deepseek）
  const rawPlat = body.platforms;
  const wanted = (Array.isArray(rawPlat) ? rawPlat.map(String) : String(rawPlat ?? '').split(','))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const platforms = (wanted.length
    ? ENABLED_PLATFORMS.filter((p) => wanted.includes(p))
    : [...ENABLED_PLATFORMS]
  ).map((p) => ({ platform: p, modelId: p }));
  if (!platforms.length) {
    res.status(400).json({ msg: `没有匹配的平台，可选：${ENABLED_PLATFORMS.join(', ')}` });
    return;
  }
  const headed = body.headed === true; // 默认无头
  const name = typeof body.name === 'string' ? body.name : undefined;
  const mode: 'serial' | 'parallel' = body.mode === 'parallel' ? 'parallel' : 'serial';
  const status = createAnalysisStatus(keywords, platforms, name, mode);
  analysisStatus = status;
  res.status(202).json({ msg: '信源分析已开始，进度见 GET /api/source-analysis/status', taskId: status.taskId });
  console.log(
    `[信源分析] 触发：taskId=${status.taskId} 模式=${mode} 词数=${keywords.length} 平台=${platforms.map((p) => p.modelId).join(',')} headless=${!headed}`
  );
  runSourceAnalysis(status, keywords, (p, kw) => execute(p, kw, headed), (p) => p, (l) =>
    console.log(`[信源分析] ${l}`)
  ).catch((e: unknown) => {
    status.running = false;
    status.finishedAt = Date.now();
    status.lastError = (e as Error).message || '信源分析异常';
    console.error('[信源分析] 异常：', status.lastError);
  });
});

router.get('/api/source-analysis/status', (_req, res) => {
  res.status(200).json(analysisStatus ?? { running: false });
});

// 历史任务（倒序），页面回看/下载用
router.get('/api/source-analysis/tasks', (_req, res) => {
  res.status(200).json({ tasks: listTasks() });
});

// 产物文件；加 ?download=1 走附件下载
router.get('/api/source-analysis/file/:taskId/:file', (req, res) => {
  const content = readTaskFile(req.params.taskId, req.params.file);
  if (content === null) {
    res.status(404).json({ msg: '文件不存在' });
    return;
  }
  if (req.query.download === '1') {
    res.setHeader('content-disposition', `attachment; filename="${req.params.taskId}-${req.params.file}"`);
  }
  res.type('json').send(content);
});

// 打开产物目录（点击历史任务名称时调用）：macOS 用 open 唤起 Finder 选中目录，其余平台仅返回路径
router.post('/api/source-analysis/open', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const taskId = String(body.taskId ?? '').trim();
  // taskId 即产物目录名（允许中文/常见字符）；仅拦截路径穿越
  if (!taskId || taskId.includes('/') || taskId.includes('\\') || taskId.includes('..')) {
    res.status(400).json({ msg: '非法任务 ID' });
    return;
  }
  const dir = path.join(ANALYSIS_ROOT, taskId);
  if (!dir.startsWith(ANALYSIS_ROOT) || !fs.existsSync(dir)) {
    res.status(404).json({ msg: '目录不存在' });
    return;
  }
  const target = JSON.stringify(dir); // 引号包裹，目录含空格也安全
  if (process.platform === 'darwin') {
    exec(`open ${target}`, (e) => {
      if (e) console.error('[信源分析] 打开目录失败：', e.message);
    });
  }
  res.status(200).json({ ok: true, msg: '已尝试打开目录', dir });
});

// ---------- 平台登录管理（页面 + 接口；账号级操作，id→dir 台账唯一映射防串） ----------
// 带前缀部署时访问前缀根（如 /geoui/）→ 管理台
router.get('/', (_req, res) => {
  res.redirect(`${config.basePath}/admin`);
});

router.get('/admin', (_req, res) => {
  res.type('html').send(adminPageHtml());
});

router.get('/api/login/platforms', async (_req, res) => {
  const busy = loginBusy();
  const testing = new Set(listTestSessions());
  res.status(200).json({
    platforms: (await listViews()).map((p) => ({
      platformId: p.platformId,
      label: p.label,
      hint: p.hint,
      accounts: p.accounts.map((a) => ({
        ...a,
        busy: busy.accountId === a.id,
        testing: testing.has(`${p.platformId}/${a.id}`),
      })),
    })),
  });
});

// 已打开的测试窗口列表（platformId/accountId），前端轮询回显按钮状态
router.get('/api/login/test/sessions', (_req, res) => {
  res.status(200).json({ sessions: listTestSessions() });
});

// 采集平台清单（信源分析页勾选用）：平台 modeId / 中文名 / 是否登录制
router.get('/api/platforms', (_req, res) => {
  res.status(200).json({
    platforms: ENABLED_PLATFORMS.map((id) => ({
      platformId: id,
      label: PLATFORMS[id]?.label ?? id,
      modelId: id,
      loginRequired: !!LOGIN_DRIVERS[id]?.loginRequired,
    })),
  });
});

function bodyAccountId(req: { body?: unknown }): string | undefined {
  const b = (req.body ?? {}) as Record<string, unknown>;
  return typeof b.accountId === 'string' && b.accountId.trim() ? b.accountId.trim() : undefined;
}

router.post('/api/login/:platform/start', (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  if (!(id in LOGIN_DRIVERS)) {
    res.status(404).json({ msg: `未注册的登录平台：${id}` });
    return;
  }
  // 不带 accountId → 新开账号槽；带 → 指定账号（重新）登录
  startLogin(id, bodyAccountId(req))
    .then((r) => res.status(r.ok ? 200 : 409).json({ msg: r.msg, accountId: r.accountId }))
    .catch((e: unknown) => res.status(500).json({ msg: (e as Error).message }));
});

router.post('/api/login/:platform/verify', async (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  const accountId = bodyAccountId(req);
  if (!accountId) {
    res.status(400).json({ msg: '缺少 accountId' });
    return;
  }
  const r = await confirmLogin(id, accountId);
  res.status(r.ok ? 200 : 400).json({ msg: r.msg });
});

router.post('/api/login/:platform/logout', async (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  const accountId = bodyAccountId(req);
  if (!accountId) {
    res.status(400).json({ msg: '缺少 accountId' });
    return;
  }
  const r = await logoutAccount(id, accountId);
  res.status(r.ok ? 200 : 400).json({ msg: r.msg });
});

router.post('/api/login/:platform/delete', async (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  const accountId = bodyAccountId(req);
  if (!accountId) {
    res.status(400).json({ msg: '缺少 accountId' });
    return;
  }
  const r = await deleteAccount(id, accountId);
  res.status(r.ok ? 200 : 400).json({ msg: r.msg });
});

router.post('/api/login/:platform/alias', async (req, res) => {  const id = String(req.params.platform).toLowerCase();
  const accountId = bodyAccountId(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const alias = typeof b.alias === 'string' ? b.alias.trim().slice(0, 30) : '';
  if (!accountId || !alias) {
    res.status(400).json({ msg: '缺少 accountId/alias' });
    return;
  }
  const r = await updateAlias(id, accountId, alias);
  res.status(r.ok ? 200 : 400).json({ msg: r.msg });
});

// 打开某账号的测试窗口（手动聊天，不跑自动化）
// 启停账号：停用后不参与挑号
router.post('/api/accounts/:platform/:accountId/toggle', async (req, res) => {
  const platform = String(req.params.platform).toLowerCase();
  const accountId = String(req.params.accountId);
  const want = (req.body ?? {}) as { enabled?: unknown };
  const acc = await accountRepo().get(platform, accountId);
  if (!acc) { res.status(404).json({ msg: '账号不存在' }); return; }
  const enabled = want.enabled === undefined ? acc.enabled === false : want.enabled === true;
  const r = await setAccountEnabled(platform, accountId, enabled);
  res.status(r.ok ? 200 : 400).json({ msg: r.msg, enabled });
});

// 置顶 / 取消置顶：priority 越大越优先被挑中
router.post('/api/accounts/:platform/:accountId/priority', async (req, res) => {
  const platform = String(req.params.platform).toLowerCase();
  const accountId = String(req.params.accountId);
  const b = (req.body ?? {}) as { priority?: unknown };
  const priority = typeof b.priority === 'number' ? b.priority : 1;
  const r = await setAccountPriority(platform, accountId, priority);
  res.status(r.ok ? 200 : 400).json({ msg: r.msg, priority });
});

router.post('/api/login/:platform/test', (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  if (!(id in LOGIN_DRIVERS)) {
    res.status(404).json({ msg: `未注册的登录平台：${id}` });
    return;
  }
  const accountId = bodyAccountId(req);
  if (!accountId) {
    res.status(400).json({ msg: '缺少 accountId' });
    return;
  }
  testAccount(id, accountId)
    .then((r) => res.status(r.ok ? 200 : 409).json({ msg: r.msg }))
    .catch((e: unknown) => res.status(500).json({ msg: (e as Error).message }));
});

// 关闭某账号的测试窗口
router.post('/api/login/:platform/test-close', (req, res) => {
  const id = String(req.params.platform).toLowerCase();
  const accountId = bodyAccountId(req);
  if (!accountId) {
    res.status(400).json({ msg: '缺少 accountId' });
    return;
  }
  closeTestAccount(id, accountId)
    .then((r) => res.status(r.ok ? 200 : 400).json({ msg: r.msg }))
    .catch((e: unknown) => res.status(500).json({ msg: (e as Error).message }));
});

// 启动 API 服务（按用户要求：启动时不打印日志）
export async function startServer(): Promise<void> {
  installShutdownHandlers();
  console.log(`[config] ${describeConfig()}`);
  if (config.storage === 'mysql') {
    // 连不上就在这里炸掉：绝不静默降级到文件存储（会导致"以为写库了其实写文件"）
    await pingDb();
    const recycled = await releaseStaleLeases(config.nodeId);
    console.log(`[db] 连接正常 (${config.db.host}:${config.db.port}/${config.db.database})${recycled ? `，回收脏占用 ${recycled} 条` : ''}`);
  }
  if (config.basePath) app.use(config.basePath, router);
  else app.use(router);
  app.listen(PORT);
}
