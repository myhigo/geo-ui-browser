// 拉模式（pull）：手动触发 → 分页拉关键词 → 逐个采集（平台轮询分配）→ 结果回推。
// 2026-09-03 用户定稿：不记执行进度、无调度器、无状态机；拉不到数据本轮即结束。
// 浏览器身份沿用 server.ts 的 execute()（千问撞墙重生 / 文心轮换 / profile 落盘）。
//
// 2026-09-22 代理 IP 调度（用户定稿流程）：
//   每个词 → 先挑 IP（启用 + 未占用 + 冷却已过，LRU 升序；冷却中休眠等待）
//        → 该 IP 下所有目标平台【并行】采集（同 IP 多浏览器，不再串行）
//        → 全部完成 → 更新该 IP 使用时间（开始 120s 冷却）→ 下一个词重新挑 IP。
//   词间冷却已去掉：节流由 IP 冷却承担（IP 足够多可不同断处理）。

import { withConcurrencyLimit } from './concurrency.js';
import { acquireIp } from '../runtime/ipScheduler.js';

/** 收录检测：同一关键词的多个平台并发采集时，同时打开浏览器的上限。
 *  2026-09-22 用户定稿：同 IP 下各平台【同时】提问（5 个平台 5 个浏览器），不再串行 */
const PULL_PARALLEL_LIMIT = 5;

export interface PullConfig {
  /** 对方服务根地址，如 http://127.0.0.1:8080（服务启动时经 GEO_PULL_HOST 注入） */
  host: string;
  /** 每页条数，默认 20 */
  pageSize: number;
  /** 可选：只拉该时间后创建的词（如 2026-09-01）；不传则不带上 */
  startTime?: string;
  /** 可选：只拉该时间前创建的词（如 2026-09-03）；不传则不带上 */
  endTime?: string;
}

/** 单个词的采集结果：skipped = 该词所用 IP 下该平台没有可用账号（跳过，不回推） */
export type CollectResult =
  | { skipped: true; reason?: string }
  | { screenshot: string; answer: string; sources: { title: string; url: string; siteName: string }[] };

/** 单个词的采集回调（复用 server.ts 的 execute：身份/超时/解析/截图；ipId = 该词已挑好的代理 IP） */
export interface PullCollect {
  (platform: string, keyword: string, ipId: number): Promise<CollectResult>;
}

export interface PullSummary {
  pages: number;
  fetched: number;
  success: number;
  failed: number;
  reportFailed: number;
  lastError?: string;
}

// 平台标识统一使用下层系统的 modeId（qwen / wenxiaoyan / hunyuan / doubao / deepseek），
// 不再做内部 id → modelId 的二次映射（2026-09-08 对齐：消除双命名导致的回推错位 bug）。
// 信源分析输出文件名、回推 modelId、前端展示 label 均直接使用该标识。
// 当前实际接入采集的平台（词不带 platform 时对这组全跑，各自回推）。
// ⚠️ 2026-09-04：doubao 开放——登录台账已就绪（/admin 多账号），execute 自动挑可用账号。
//    kimi 待适配后加进此列表即可自动生效。
// 2026-09-07：新增腾讯元宝（hunyuan，腾讯，登录制平台）。
export const ENABLED_PLATFORMS = ['qwen', 'wenxiaoyan', 'doubao', 'deepseek', 'hunyuan'];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(
  cfg: PullConfig,
  page: number
): Promise<{ id: string; keyword: string; raw: Record<string, unknown> }[]> {
  const qs = new URLSearchParams({ current: String(page), size: String(cfg.pageSize) });
  if (cfg.startTime) qs.set('startTime', cfg.startTime);
  if (cfg.endTime) qs.set('endTime', cfg.endTime);
  // 空格统一编码为 %20 而非 +：时间参数形如 "2026-09-01 00:00:00"，
  // 若用 + 则严格按 RFC 3986 解析的下层会拿到 "2026-09-01+00:00:00" 而解析失败。
  const query = qs.toString().replace(/\+/g, '%20');
  const res = await fetch(`${cfg.host}/geoWebCollect/page?${query}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`拉词接口 HTTP ${res.status}`);
  const body = (await res.json()) as {
    code: number;
    msg?: string;
    data?: { records?: { id: string; keyWord: string }[] };
  };
  if (body.code !== 0) throw new Error(`拉词接口返回 code=${body.code} msg=${body.msg ?? ''}`);
  return (body.data?.records ?? []).map((r) => ({
    id: r.id,
    keyword: r.keyWord,
    raw: r as unknown as Record<string, unknown>,
  }));
}

// 已收录平台列表：对方服务 /geoWebCollect/page 的 record 中由 `collectedModels` 字段给出，
// 值为已收录的模型 id（即本系统 modeId：qwen / wenxiaoyan / doubao / deepseek / hunyuan）。
// 用户 2026-09-12 确认字段名。空数组表示尚无收录 → 全部待检查。
// 只与本轮 targets 求差集，脏值 / 非本系统平台名自然被忽略。
function collectedPlatformsOf(raw: Record<string, unknown>): string[] {
  const v = raw['collectedModels'];
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

// 回推结果（对方接口收数组）；失败休眠 3 分钟后重试，最多重试 3 次（共 4 次尝试）
async function reportItems(
  cfg: PullConfig,
  items: unknown[],
  onLine?: (line: string) => void
): Promise<void> {
  const log = (l: string): void => (onLine ? onLine(l) : console.log(`[pull] ${l}`));
  let lastErr: unknown = null;
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 3 * 60 * 1000; // 休眠 3 分钟
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${cfg.host}/geoWebCollect/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(items),
      });
      if (!res.ok) throw new Error(`回推 HTTP ${res.status}`);
      return;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_RETRIES) {
        log(`⚠️ 回推失败（第 ${attempt + 1} 次尝试出错：${msg}）；休眠 3 分钟后重试（剩 ${MAX_RETRIES - attempt} 次）`);
        await sleep(RETRY_DELAY);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('回推失败');
}

function sourcesTextOf(sources: { title: string; url: string; siteName: string }[]): string {
  return sources.map((s) => [s.title, s.url].filter(Boolean).join(' ')).join('\n');
}

/**
 * 跑一整轮：从第 1 页起分页拉词，某页拉空即结束。
 * 每个词的目标平台：forcedPlatform > 词上自带 platform > 全部启用平台（ENABLED_PLATFORMS），
 * 每个目标平台独立采集、独立回推一条（modelId 用对方标识）。
 * @param forcedPlatform 平台 id 数组（下层 modeId）；指定且非空则整轮只用这些平台（忽略词上的 platform）；为空/不传则对全部启用平台采集
 * @param onLine 进度回调（打日志用）
 */
export async function runPullRound(
  cfg: PullConfig,
  collect: PullCollect,
  forcedPlatform?: string[],
  onLine?: (line: string) => void
): Promise<PullSummary> {
  const summary: PullSummary = { pages: 0, fetched: 0, success: 0, failed: 0, reportFailed: 0 };
  const log = (l: string): void => (onLine ? onLine(l) : console.log(`[pull] ${l}`));
  for (let page = 1; page <= 1000; page++) {
    let records: { id: string; keyword: string; raw: Record<string, unknown> }[] = [];
    try {
      records = await fetchPage(cfg, page);
    } catch (e) {
      summary.lastError = `第 ${page} 页拉词失败：${(e as Error).message}`;
      log(`⚠️ ${summary.lastError}`);
      break;
    }
    if (records.length === 0) {
      log(`第 ${page} 页为空，本轮结束`);
      break;
    }
    summary.pages = page;
    summary.fetched += records.length;
    log(`第 ${page} 页拉取 ${records.length} 词（累计 ${summary.fetched}）`);
    let recIdx = 0;
    let loggedRaw = false;
    for (const rec of records) {
      recIdx++;
      if (!loggedRaw) {
        loggedRaw = true;
        log(`[debug] 首条 record 字段名：${Object.keys(rec.raw).join(', ')}`);
      }
      // 目标平台集合：forcedPlatform（勾选平台）优先；否则对全部启用平台各采集一遍
      const picked = forcedPlatform && forcedPlatform.length ? forcedPlatform.filter((p) => ENABLED_PLATFORMS.includes(p)) : [];
      const targets: string[] = picked.length ? picked : [...ENABLED_PLATFORMS];
      // 已收录的平台跳过（用户 2026-09-12：已收录过的模型平台不再检查）
      const collected = collectedPlatformsOf(rec.raw);
      const checkTargets = targets.filter((p) => !collected.includes(p));
      if (checkTargets.length === 0) {
        log(`#${rec.id} ${rec.keyword} 全部平台已收录（${collected.join('/') || '无'}），跳过检查`);
        continue;
      }
      log(`#${rec.id} ${rec.keyword} 已收录：${collected.join('/') || '无'}；本次检查：${checkTargets.join('/')}`);
      // —— 词级代理 IP 调度（2026-09-22 用户定稿流程）——
      // 每个词先挑一个可用 IP（LRU 升序 + 120s 冷却，冷却中休眠等待）；拿到 IP 后，
      // 该 IP 下所有目标平台【并行】采集（同 IP 多浏览器），全部完成 → 更新 IP 使用时间（进入冷却）。
      const alloc = await acquireIp();
      if (!alloc) {
        summary.failed += checkTargets.length;
        summary.lastError = `没有可用代理 IP（未配置 / 全部被占用），词 #${rec.id} 跳过`;
        log(`✗ #${rec.id} ${rec.keyword} 无可用代理 IP，该词跳过（请先在「代理管理」添加并启用代理）`);
        continue;
      }
      try {
        // 同一关键词的多个平台并发采集（最多 PULL_PARALLEL_LIMIT 个浏览器同时跑），全部完成后才算该词结束
        await withConcurrencyLimit(checkTargets, PULL_PARALLEL_LIMIT, async (platform) => {
          const modelId = platform; // platform 已是下层 modeId，回推直接使用
          const base = { keywordId: rec.id, modelId };
          try {
            const r = await collect(platform, rec.keyword, alloc.ip.id);
            if ('skipped' in r) {
              log(`#${rec.id} ${modelId} 跳过：${r.reason ?? '该 IP 下无可用账号'}`);
              return;
            }
            const item = {
              ...base,
              success: true,
              answer: r.answer,
              sourcesText: sourcesTextOf(r.sources),
              references: r.sources,
              screenshot: r.screenshot || null, // 截图失败/未产出时留空（用户 2026-09-03 定）
              msg: null,
            };
            await reportItems(cfg, [item], onLine);
            summary.success += 1;
            log(`#${rec.id} ${modelId} 成功（answer ${r.answer.length} 字 / sources ${r.sources.length}）`);
          } catch (e) {
            const errMsg = (e as Error).message || '采集失败';
            summary.failed += 1;
            try {
              await reportItems(cfg, [{ ...base, success: false, answer: null, sourcesText: null, references: [], screenshot: null, msg: errMsg }], onLine);
              log(`#${rec.id} ${modelId} 失败已回推：${errMsg}`);
            } catch (pe) {
              summary.reportFailed += 1;
              summary.lastError = `#${rec.id} ${modelId} 回推失败：${(pe as Error).message}`;
              log(`✗ ${summary.lastError}`);
            }
          }
        });
      } finally {
        // 该词所有平台处理完 → 归还 IP（清占用 + 更新 last_used_at，进入 120s 冷却）
        await alloc.release(); // 必须 await：等 last_used_at 落库，否则下一词挑 IP 读不到冷却时间
      }
      // 词间冷却已去掉（2026-09-22 用户定稿）：节流由 IP 120s 冷却承担
    }
  }
  log(`本轮结束：${summary.fetched} 词 / 采集结果 成功 ${summary.success} 失败 ${summary.failed} / 回推失败 ${summary.reportFailed}`);
  return summary;
}
