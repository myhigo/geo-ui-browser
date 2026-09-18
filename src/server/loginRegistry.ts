// 平台登录账号管理（2026-09-03 用户定稿）：
//  - 不同平台登录各自驱动，互不混用；纯人工扫码/验证码，不导入 cookie。
//  - 每个账号 = 固定 id + 专属目录（.profiles/<platform>-<n>）+ 台账记录，id→dir 唯一映射，
//    登录/退出/问答全程按 accountId 操作，绝不猜默认目录 → 多账号信息不串。
//  - 台账：.profiles/<platform>.accounts.json；旧单身份文件自动迁移成账号 1，登录态不丢。
//  - 问答侧：allocateAccount() 挑号（只挑 active、冷却/禁用排除）→ 执行 → releaseAccount() 回写。

import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { DoubaoAdapter } from '../platforms/doubao/DoubaoAdapter.js';
import { resolvePlatform } from '../platforms/index.js';
import { firstFound } from '../diagnostics/elementProbe.js';
import { accountRepo, profileDirOf, Account, AccountStatus } from '../storage/accountRepo.js';
import { config, paths } from '../config/index.js';
import { fingerprint } from '../config/fingerprint.js';

export type { Account, AccountStatus };

export interface PlatformLoginDriver {
  platformId: string;
  label: string;
  loginRequired: true;
  loginWaitMs?: number;
  hint?: string;
  /** 登录态页面中唯一命中「账号昵称」文本的 selector（2026-09-03 豆包侦察定标） */
  markerSelector?: string;
  /**
   * 昵称抓不到的兜底钩子：平台页面上压根不显示昵称时（如 DeepSeek），由驱动自己
   * 从页面上下文取账号标识（调站内接口 / 读 storage）。优先于 markerSelector。
   */
  fetchMarker?(page: Page): Promise<string>;
}

export const LOGIN_DRIVERS: Record<string, PlatformLoginDriver> = {
  doubao: {
    platformId: 'doubao',
    label: '豆包',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '请在自动打开的浏览器窗口完成登录（抖音扫码 / 手机验证码均可），完成后回到本页点击「我已登录完成，验证」。窗口标题对应左侧所选账号，别登错号。',
    // 侦察定标：侧边栏左下角「头像+昵称」，昵称叶子 SPAN 的稳定标识（text-dbx-text-primary 为豆包主题类）
    markerSelector: 'span[class*="text-dbx-text-primary"][class*="text-ellipsis"]',
  },
  deepseek: {
    platformId: 'deepseek',
    label: 'DeepSeek',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '请在自动打开的浏览器窗口完成登录（手机验证码 / 微信扫码均可），完成后回到本页点击「我已登录完成，验证」。窗口标题对应左侧所选账号，别登错号。',
    // ⚠️ DeepSeek 页面上没有昵称元素（侦察 2026-09-04：首页侧栏只有历史对话，左下/右上均无账号区，
    //    /settings 会重定向回首页）→ 只能走站内接口：localStorage.userToken → /api/v0/users/current，
    //    返回 data.biz_data.id_profile.name（微信昵称，如 ssdyy），回退 mobile_number（脱敏手机号）。
    fetchMarker: async (page) =>
      page.evaluate(async () => {
        try {
          const raw = localStorage.getItem('userToken') || '';
          let token = raw;
          try {
            const o = JSON.parse(raw) as { value?: unknown };
            token = typeof o?.value === 'string' ? o.value : raw;
          } catch {
            /* 不是 JSON 就当纯字符串用 */
          }
          if (!token) return '';
          const res = await fetch('/api/v0/users/current', {
            headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          });
          const j = (await res.json()) as {
            data?: { biz_data?: { id_profile?: { name?: string }; mobile_number?: string } };
          };
          const u = j?.data?.biz_data;
          if (!u) return '';
          return (u.id_profile?.name || '').trim() || (u.mobile_number || '').trim() || '';
        } catch {
          return '';
        }
      }),
  },
  qwen: {
    platformId: 'qwen',
    label: '千问',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '请在自动打开的浏览器窗口完成登录（千问扫码 / 手机验证码均可），完成后回到本页点击「我已登录完成，验证」。窗口标题对应左侧所选账号，别登错号。',
    // 侦察定标(2026-09-07 登录页落盘)：侧边栏底部「头像+昵称」按钮内的昵称 span 即账号昵称。
    // 结构：<button aria-haspopup="menu"><img.rounded-full><span><span class="truncate text-sm font-600 leading-6">昵称</span></span></button>
    // 注：window._USER_.showName 为空，昵称只存在于该 DOM 文本，故走 markerSelector（非接口）。
    markerSelector: 'button[aria-haspopup="menu"] span[class*="truncate"]',
  },
  wenxiaoyan: {
    platformId: 'wenxiaoyan',
    label: '百度文心',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '请在自动打开的浏览器窗口完成登录（百度账号扫码 / 手机号均可），完成后回到本页点击「我已登录完成，验证」。窗口标题对应左侧所选账号，别登错号。',
    // 昵称：已登录后侧边栏用户信息区 `<span class="cos-line-clamp-1">HiXiangHiGo</span>`（位于
    //   `.chat-aside-user-info` 内，紧挨真实头像 img.chat-aside-avatar-content）。该 span 是叶子节点，
    //   直接取 textContent 即得昵称。未配 selector 时启发式兜底会误抓侧边栏「添加桌面快捷方式」img 的 alt。
    markerSelector: '.chat-aside-user-info .cos-line-clamp-1',
  },
  hunyuan: {
    platformId: 'hunyuan',
    label: '腾讯元宝',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '请在自动打开的浏览器窗口完成登录（微信扫码 / 手机号均可），完成后回到本页点击「我已登录完成，验证」。窗口标题对应左侧所选账号，别登错号。',
    // 昵称选择器（2026-09-07 落盘 login-yuanbao-*.html 实测定标）：
    //   登录后顶栏头像旁 <div class="nick-info-container"><p class="nick-info-name">昵称</p></div>，
    //   叶子节点 <p> 直取 textContent 即得昵称（如 ssdyy）。未配前启发式兜底误抓下载推广图 alt。
    markerSelector: '.nick-info-name',
  },
};

const nextSeqOf = (platformId: string, accounts: Account[]): number => {
  let max = 0;
  for (const a of accounts) {
    const m = /-(\d+)$/.exec(a.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
};

/** 本地日期 YYYY-MM-DD（按用户所在时区，不是 UTC） */
const todayStr = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export interface PlatformView {
  platformId: string;
  label: string;
  hint?: string;
  accounts: Account[];
}

export async function listViews(): Promise<PlatformView[]> {
  const today = todayStr();
  const out: PlatformView[] = [];
  for (const d of Object.values(LOGIN_DRIVERS)) {
    out.push({
      platformId: d.platformId,
      label: d.label,
      hint: d.hint,
      // 跨天惰性归零：queryDate 不是今天 → 显示 0（今天还没查过，昨天的次数作废）
      accounts: (await accountRepo.list(d.platformId)).map((a) => ({
        ...a,
        todayQueries: a.queryDate === today ? (a.todayQueries ?? 0) : 0,
      })),
    });
  }
  return out;
}

export async function updateAlias(platformId: string, accountId: string, alias: string): Promise<{ ok: boolean; msg: string }> {
  if (!await accountRepo.patch(platformId, accountId, { alias })) return { ok: false, msg: '账号不存在' };
  return { ok: true, msg: '备注已更新' };
}

/** 删除整个账号（清目录 + 台账移除） */
export async function deleteAccount(platformId: string, accountId: string): Promise<{ ok: boolean; msg: string }> {
  const acc = await accountRepo.get(platformId, accountId);
  if (!acc) return { ok: false, msg: '账号不存在' };
  if (isAccountBusy(accountId) || testSessions.has(testKey(platformId, accountId)))
    return { ok: false, msg: '该账号正在使用中（采集中或测试窗口打开），请先关闭测试窗口后再删' };
  fs.rmSync(acc.dir, { recursive: true, force: true });
  await accountRepo.save(
    platformId,
    (await accountRepo.list(platformId)).filter((a) => a.id !== accountId)
  );
  return { ok: true, msg: `已删除账号 ${accountId}` };
}

/** 退出登录（清掉磁盘会话 + 关闭仍打开的登录窗口；台账保留、其他账号不受影响） */
export async function logoutAccount(platformId: string, accountId: string): Promise<{ ok: boolean; msg: string }> {
  const acc = await accountRepo.get(platformId, accountId);
  if (!acc) return { ok: false, msg: '账号不存在' };
  if (isAccountBusy(accountId) || testSessions.has(testKey(platformId, accountId)))
    return { ok: false, msg: '该账号正在使用中（采集中或测试窗口打开），请先关闭测试窗口后再退出' };
  // ⚠️ 登录制平台用持久上下文：仅改台账状态不够——
  //   · 若登录窗口仍开着（status=waiting：用户点了「登录」却还没点「验证」），必须取消登录并关窗，
  //     否则窗口内内存会话会继续显示「已登录对话界面 + 用户信息」，看起来像没退出。
  if (activeLogin && activeLogin.platformId === platformId && activeLogin.accountId === accountId) {
    activeLogin.confirm(false);                       // 解除 startLogin 的等待，使其走 finally 收尾
    activeLogin.context.close().catch(() => {});
    activeLogin = null;
  }
  fs.rmSync(acc.dir, { recursive: true, force: true });
  await accountRepo.patch(platformId, accountId, { status: 'none', note: '已退出登录', marker: undefined, lastUsedAt: undefined });
  return { ok: true, msg: `已退出 ${accountId}，登录态已清除` };
}

// ---------- 问答侧：挑号与回写 ----------
const inFlight = new Set<string>(); // 正在使用的账号（防同号并发）

function isAccountBusy(accountId: string): boolean {
  return inFlight.has(accountId);
}

export interface ReadyCheck {
  ok: boolean;
  reason?: string;
  accountId?: string;
  dir?: string;
}

/** 分配一个可用的已登录账号（只挑 active 且空闲；无可用 → 返回原因） */
export async function allocateAccount(platformId: string): Promise<ReadyCheck> {
  const accounts = await accountRepo.list(platformId);
  const usable = accounts.filter((a) => a.status === 'active' && !isAccountBusy(a.id));
  if (usable.length === 0) {
    const any = accounts.some((a) => ['failed', 'cooling', 'none'].includes(a.status));
    const label = LOGIN_DRIVERS[platformId]?.label ?? platformId;
    return {
      ok: false,
      reason: any
        ? `「${label}」没有可用账号（active 缺失），请到 /admin 查看各账号状态并补登`
        : `「${label}」未登录任何账号，请先到 /admin 登录`,
    };
  }
  const now = Date.now();
  const today = todayStr();
  // score：最近使用越久越优先、今日查询越少越优先、连续失败惩罚、加抖动
  const scored = usable
    .map((a) => ({
      a,
      score:
        (now - (a.lastUsedAt ?? 0)) / 60000
        - (a.queryDate === today ? (a.todayQueries ?? 0) : 0) * 100
        - (a.consecutiveFails ?? 0) * 2000
        + Math.random() * 30,
    }))
    .sort((x, y) => y.score - x.score);
  const pick = scored[0].a;
  inFlight.add(pick.id);
  return { ok: true, accountId: pick.id, dir: pick.dir };
}

export async function releaseAccount(platformId: string, accountId: string, success: boolean, loginRequired: boolean): Promise<void> {
  inFlight.delete(accountId);
  const acc = await accountRepo.get(platformId, accountId);
  if (!acc) return;
  const patch: Partial<Account> = { lastUsedAt: Date.now() };
  if (loginRequired) {
    patch.status = 'failed';
    patch.note = '问答时检测到登录墙/会话失效，需重新登录';
    patch.consecutiveFails = (acc.consecutiveFails ?? 0) + 1;
  } else {
    patch.consecutiveFails = success ? 0 : (acc.consecutiveFails ?? 0) + 1;
    // 跨天归零：queryDate 不是今天则从 0 起算，并记下今天日期
    const today = todayStr();
    const base = acc.queryDate === today ? (acc.todayQueries ?? 0) : 0;
    patch.todayQueries = base + 1;
    patch.queryDate = today;
  }
  await accountRepo.patch(platformId, accountId, patch);
}

// ---------- 登录会话（同一时刻只允许一个平台的一个账号在登） ----------
interface ActiveLogin {
  platformId: string;
  accountId: string;
  dir: string;
  context: BrowserContext;
  confirm: (v: boolean) => void;
}

let activeLogin: ActiveLogin | null = null;

export function loginBusy(): { platformId?: string; accountId?: string } {
  return activeLogin ? { platformId: activeLogin.platformId, accountId: activeLogin.accountId } : {};
}

function launchOpts(): Parameters<typeof chromium.launchPersistentContext>[1] {
  const fp = fingerprint();
  const o: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: fp.viewport,
    userAgent: fp.userAgent,
  };
  if (config.chromePath) o.executablePath = config.chromePath;
  else if (config.useSystemChrome) o.channel = 'chrome';
  return o;
}

/** 抓取账号昵称：①驱动自带 fetchMarker（页面无昵称元素时走接口）②markerSelector。
 *  fetchMarker 首次为空会等 2s 重试一次（登录刚完成时 token 可能还没落盘）。
 *  两者都未配置或都取空 → 返回空串，UI 统一显示「--」。任何平台都不做启发式兜底，取不到就是 --。 */
export async function extractAccountMarker(page: Page, driver: PlatformLoginDriver): Promise<string> {
  if (driver.fetchMarker) {
    try {
      let m = (await driver.fetchMarker(page)) || '';
      if (!m) {
        await page.waitForTimeout(2000).catch(() => {});
        m = (await driver.fetchMarker(page)) || '';
      }
      if (m) return m;
    } catch {
      /* 接口失败 → 继续走 selector 兜底 */
    }
  }
  const sel = driver.markerSelector;
  if (sel) {
    try {
      return await page.evaluate((s) => {
        for (const el of Array.from(document.querySelectorAll(s))) {
          if (el.children.length === 0) {
            const t = (el.textContent || '').trim();
            if (t && t.length <= 40) return t;
          }
        }
        return '';
      }, sel);
    } catch {
      return '';
    }
  }
  // 无 fetchMarker 且无 markerSelector（或两者都取空）→ 返回空串，由 UI 统一显示「--」。
  // ⚠️ 不再做任何启发式兜底（如抓取 img[alt]），曾误抓元宝下载推广图 alt="下载元宝电脑版…"。
  //    所有平台一致：取不到昵称就是取不到，必须显示 --，绝不乱猜。
  return '';
}

/** 一次性打开目录探测：登录墙？昵称？ */
async function openProbe(
  platformId: string,
  dir: string
): Promise<{ ok: boolean; loginRequired?: boolean; marker?: string; error?: string }> {
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(dir, { ...launchOpts(), headless: true });
  } catch (e) {
    return { ok: false, error: `打开会话失败：${(e as Error).message}` };
  }
  try {
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
      } catch {
        /* ignore */
      }
    });
    const page = await context.newPage();
    const def = resolvePlatform(platformId);
    await page.goto(def.defaultUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const readySel = [...def.selectors.input, 'a:has-text("登录")', 'button:has-text("登录")'].join(', ');
    await page.waitForSelector(readySel, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    // ⚠️ 等登录态真正生效：各平台 SPA 从持久化 cookie/localStorage 水合登录态需要时间，
    //   初始会闪现「未登录」态（登录墙/遮罩）。若不等待，下面 checkLogin 会误判为未登录
    //   （典型现象：可见窗口内已登录、无头重开却仍撞登录墙）。
    //   文心：未登录遮罩 .chat-aside-user-mask.unlogin 消失。
    //   有登录墙平台(DeepSeek/豆包/元宝)：登录墙元素(「登录」入口)消失、输入框出现 → checkLogin() 收敛为 false。
    const adapter = def.create(page, context);
    try {
      await page.waitForFunction(
        () => {
          const m = document.querySelector('.chat-aside-user-mask.unlogin');
          return !m || !(m as HTMLElement).offsetParent;
        },
        { timeout: 8000 },
      );
    } catch {
      /* 非文心或超时 → 下面用 checkLogin 轮询兜底 */
    }
    // 通用水合轮询：等到 checkLogin() 返回 false（已登录/登录态水合完成），最多 HYDRATE_MS。
    // 真未登录时 checkLogin 恒 true，轮询超时后继续，下面仍会按登录墙兜底失败（正确行为）。
    const HYDRATE_MS = 12000;
    const t0 = Date.now();
    while (Date.now() - t0 < HYDRATE_MS) {
      let loggedIn = false;
      try {
        loggedIn = !(await adapter.checkLogin());
      } catch {
        loggedIn = false;
      }
      if (loggedIn) break;
      await page.waitForTimeout(500);
    }
    const loginRequired = await adapter.checkLogin();
    if (loginRequired) {
      // 诊断落盘：窗口内已登录但无头重开仍撞墙时，据此排查水合/持久化问题
      try {
        fs.mkdirSync(path.resolve('diagnostics'), { recursive: true });
        const ts = Date.now();
        const html = await page.content();
        fs.writeFileSync(path.resolve('diagnostics', `login-${platformId}-probe-fail-${ts}.html`), html, 'utf8');
        const ls = await page.evaluate(() => {
          const o: Record<string, string> = {};
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k) o[k] = localStorage.getItem(k) || '';
          }
          return o;
        });
        fs.writeFileSync(path.resolve('diagnostics', `login-${platformId}-probe-fail-${ts}.ls.json`), JSON.stringify(ls, null, 2), 'utf8');
        const cookies = await context.cookies();
        fs.writeFileSync(
          path.resolve('diagnostics', `login-${platformId}-probe-fail-${ts}.cookies.json`),
          JSON.stringify(
            cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, expires: c.expires, secure: c.secure })),
            null,
            2,
          ),
          'utf8',
        );
      } catch {
        /* ignore */
      }
      return { ok: true, loginRequired, marker: '' };
    }
    const marker = await extractAccountMarker(page, LOGIN_DRIVERS[platformId]);
    return { ok: true, loginRequired, marker };
  } catch (e) {
    return { ok: false, error: `登录态探测异常：${(e as Error).message}` };
  } finally {
    await context.close().catch(() => {});
  }
}

/** 登录后校验：未撞墙且可提问 → ok；同时带回页面昵称（marker） */
async function verifySession(platformId: string, dir: string): Promise<{ ok: boolean; note?: string; marker?: string }> {
  const p = await openProbe(platformId, dir);
  if (!p.ok) return { ok: false, note: p.error };
  if (p.loginRequired) return { ok: false, note: '登录态校验未通过：仍检测到登录墙/无输入框' };
  // ⚠️ 无登录墙平台（如文心：匿名也可用、首页有输入框）checkLogin 恒 false，上面拦不住"磁盘无登录态"。
  //   对配了昵称选择器/接口的平台，进一步要求无头重开能抽到账号昵称：抽不到 = 磁盘没有真实登录会话
  //   （2026-09-07 文心实测：BDUSS 是 session cookie 未落盘 → 重开未登录 → 昵称元素不存在 → 此检查能抓到）。
  const driver = LOGIN_DRIVERS[platformId];
  if (driver && (driver.markerSelector || driver.fetchMarker)) {
    if (!p.marker) {
      return { ok: false, note: '登录态校验未通过：磁盘上无真实登录会话（重开后页面未显示账号昵称）' };
    }
  }
  return { ok: true, marker: p.marker };
}

/** 发起某平台某账号（或新账号）的登录：有头窗口等人工。幂等：一次只允许一个登录会话 */
export async function startLogin(
  platformId: string,
  accountId?: string
): Promise<{ ok: boolean; msg: string; accountId?: string }> {
  const driver = LOGIN_DRIVERS[platformId];
  if (!driver) return { ok: false, msg: `未注册的登录平台：${platformId}` };
  if (activeLogin) {
    return { ok: false, msg: `已有登录会话进行中（${activeLogin.platformId}/${activeLogin.accountId}），请先完成或等待超时` };
  }
  let accounts = await accountRepo.list(platformId);
  let acc: Account;
  if (accountId) {
    acc = accounts.find((a) => a.id === accountId)!;
    if (!acc) return { ok: false, msg: `账号不存在：${accountId}` };
    if (acc.status === 'waiting') return { ok: false, msg: '该账号已在登录中' };
  } else {
    // 未指定 → 新开一个账号槽
    const seq = nextSeqOf(platformId, accounts);
    acc = {
      id: `${platformId}-${seq}`,
      dir: profileDirOf(platformId, seq),
      alias: `账号${seq}`,
      status: 'none',
    };
    accounts.push(acc);
    await accountRepo.save(platformId, accounts);
  }
  await accountRepo.patch(platformId, acc.id, { status: 'waiting', note: `登录窗口已打开，等待人工操作（${acc.id}）` });
  const waitMs = driver.loginWaitMs ?? 6 * 60 * 1000;

  const task = (async () => {
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(acc.dir, launchOpts());
    } catch (e) {
      await accountRepo.patch(platformId, acc.id, { status: 'failed', note: `打开登录窗口失败：${(e as Error).message}` });
      return;
    }
    let confirmResolve: (v: boolean) => void = () => {};
    const confirm = new Promise<boolean>((r) => (confirmResolve = r));
    activeLogin = { platformId, accountId: acc.id, dir: acc.dir, context, confirm: confirmResolve };
    let done = false;
    try {
      const page = context.pages()[0];
      const def = resolvePlatform(platformId);
      await page.goto(def.defaultUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      const waited = await Promise.race([
        confirm.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), waitMs)),
      ]);
      done = waited;
    } catch (e) {
      await accountRepo.patch(platformId, acc.id, { status: 'failed', note: `登录窗口异常：${(e as Error).message}` });
    } finally {
      activeLogin = null;
      await context.close().catch(() => {});
    }
    // 登录进行中账号被主动退出（logoutAccount 已把状态置 none、删目录）——不再回写登录结果，避免覆盖成 failed
    if ((await accountRepo.get(platformId, acc.id))?.status === 'none') {
      return;
    }
    if (done) {
      // ⚠️ active 必须以「磁盘登录态可还原」为准（verifySession = 无头重开同一目录读 cookie/localStorage），
      // 不能只信窗口 DOM 昵称。曾踩坑（文心 2026-09-07）：可见窗口显示已登录、confirmLogin 抽到昵称
      // HiXiangHiGo → 直接标 active；但 BDUSS 从未落盘 .profiles/wenxiaoyan-1 → execute 打开该目录仍是未登录，
      // 整轮匿名问答（用户报"没用登录信息"）。故统一走 verifySession 验证磁盘，昵称仅以窗口抽的优先。
      const v = await verifySession(platformId, acc.dir);
      const domMarker = pendingMarker !== null ? pendingMarker : null;
      pendingMarker = null;
      if (v.ok) {
        const marker = (domMarker ?? v.marker ?? '').trim();
        // 昵称串号护栏：本次昵称与历史不一致（且历史有值）→ 明确警示
        const changed = !!(acc.marker && marker && acc.marker !== marker);
        await accountRepo.patch(platformId, acc.id, {
          status: 'active',
          note: changed
            ? `昵称变化：${acc.marker} → ${marker}（确认是否登成了别的号）`
            : marker
              ? undefined
              : '未抓到昵称（页面结构可能变化），可在备注中手动标注',
          marker: marker || acc.marker,
          createdAt: acc.createdAt ?? Date.now(),
          lastUsedAt: Date.now(),
          todayQueries: 0,
          consecutiveFails: 0,
        });
      } else {
        // 磁盘还原失败 → 登录态未真正持久化，明确标 failed，绝不凭窗口 DOM 昵称标 active
        await accountRepo.patch(platformId, acc.id, {
          status: 'failed',
          note: `登录态未持久化到磁盘（窗口内已登录但无头重开仍是登录墙）：${v.note ?? ''}`,
        });
      }
    } else {
      await accountRepo.patch(platformId, acc.id, { status: 'failed', note: '登录等待超时，未完成登录' });
    }
  })();
  void task;
  return { ok: true, msg: `登录窗口已打开（${acc.id}），请在窗口内完成登录后回到管理页点击「我已登录完成，验证」`, accountId: acc.id };
}

// 用户在可见登录窗口点「验证」时，已在窗口上抽好的昵称。
// 避免在 startLogin 的异步收尾里用 openProbe 无头 context 重开目录——文心等平台 SPA 从 cookie
// 水合登录态慢，无头重开会落在未登录首页，导致昵称抽取失败（如抓到「添加桌面快捷方式」）。
let pendingMarker: string | null = null;

export async function confirmLogin(platformId: string, accountId: string): Promise<{ ok: boolean; msg: string }> {
  if (!activeLogin || activeLogin.platformId !== platformId || activeLogin.accountId !== accountId) {
    return { ok: false, msg: '当前没有进行中的该账号登录会话（可能已结束或超时）' };
  }
  // 直接在用户刚登录完成的可见窗口上抽昵称 + 落盘：用户看到的就是这个窗口，页面确定已登录。
  let marker = '';
  try {
    const pg = activeLogin.context.pages()[0];
    if (pg) {
      // 等 SPA 水合登录态（文心初始会闪未登录遮罩 chat-aside-user-mask.unlogin）
      await pg
        .waitForFunction(
          () => {
            const m = document.querySelector('.chat-aside-user-mask.unlogin');
            return !m || !(m as HTMLElement).offsetParent;
          },
          { timeout: 15000 },
        )
        .catch(() => {});
      const html = await pg.content().catch(() => '');
      if (html) {
        try {
          fs.mkdirSync(path.resolve('diagnostics'), { recursive: true });
          fs.writeFileSync(path.resolve('diagnostics', `login-${platformId}-${Date.now()}.html`), html, 'utf8');
        } catch {
          /* ignore */
        }
      }
      // ⚠️ 登录态落盘自证：dump 当前窗口 context 的 cookies，确认登录态载体与可持久化性。
      // 曾踩坑（文心 2026-09-07）：窗口 DOM 显示已登录（抽到昵称 HiXiangHiGo）→ 台账标 active，
      // 但 BDUSS 等登录 cookie 从未落盘 .profiles/wenxiaoyan-1 → execute 打开仍是未登录、整轮匿名问答。
      try {
        const cookies = await pg.context().cookies().catch(() => []);
        const loginish = cookies
          .filter((c) => /bduss|stoken|passid|ubid|login_ticket/i.test(c.name))
          .map((c) => ({ name: c.name, domain: c.domain, expires: c.expires, httpOnly: c.httpOnly, len: (c.value || '').length }));
        fs.writeFileSync(
          path.resolve('diagnostics', `login-${platformId}-cookies-${Date.now()}.json`),
          JSON.stringify(
            { url: pg.url().slice(0, 200), cookieTotal: cookies.length, loginish, all: cookies.map((c) => `${c.domain} ${c.name}`) },
            null,
            2
          ),
          'utf8'
        );
      } catch {
        /* 诊断落盘失败不影响登录 */
      }
      marker = await extractAccountMarker(pg, LOGIN_DRIVERS[platformId]);
      // 🍪 会话级登录 cookie 转持久（2026-09-07 文心微信登录实测：BDUSS/STOKEN/PTOKEN 全为
      // expires=-1 的 session cookie）。session cookie 在 context.close()（浏览器关闭）后被 Chrome
      // 丢弃 → 磁盘目录永无登录态 → 后续 execute 打开该目录永远未登录（"登录了却没用上"）。
      // 必须在窗口关闭前重种带 expires 的版本，让其真正落盘。
      try {
        const ctx = pg.context();
        const sess = (await ctx.cookies().catch(() => []))
          // 泛化：所有 expires<=0 的会话级 cookie 都重种为持久，不只文心 BDUSS 系。
          // DeepSeek 的 ds_session_id / HWWAFSESID 等同样是 session cookie，关窗即丢；
          // 不持久化会导致无头重开时 fetchMarker 调 /api/v0/users/current 因会话失效而抽不到昵称
          // （verifySession 第 502 行报「磁盘上无真实登录会话」）。豆包/千问/元宝等同理。
          .filter((c) => c.expires <= 0)
          .map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite as 'Strict' | 'Lax' | 'None',
            expires: Math.floor(Date.now() / 1000) + 365 * 24 * 3600, // 365 天
          }));
        if (sess.length > 0) {
          await ctx.addCookies(sess).catch(() => {});
          console.log(`🍪 已把 ${sess.length} 个会话级登录 cookie（${sess.map((c) => c.name).join('/')}）转为 365 天持久，防止关闭窗口后丢失`);
        }
      } catch {
        /* 持久化失败：登录仍完成，但下次打开可能未登录 */
      }
    }
  } catch {
    marker = '';
  }
  pendingMarker = marker;
  activeLogin.confirm(true);
  return { ok: true, msg: '收到确认，正在校验登录态…' };
}

// ---------- 测试窗口：手动打开该账号的大模型聊天页，全程人工操作 ----------
// 设计：用账号专属 profile 目录起一个「有头 + 人类化」持久上下文，打开 defaultUrl（聊天页），
// 不跑任何自动化，窗口常驻供用户手动提问 / 管理历史对话。
// 窗口打开期间把账号加入 inFlight：① 阻止采集挑到该号（两个上下文不能共用一个 userDataDir，否则报
//   "already in use"）；② 阻止重复开测试窗口。用户手动关窗或点「关闭测试」→ 从 inFlight 与 testSessions 移除。
const testSessions = new Map<string, BrowserContext>();

function testKey(platformId: string, accountId: string): string {
  return `${platformId}/${accountId}`;
}

/** 当前所有打开的测试窗口 key（platformId/accountId） */
export function listTestSessions(): string[] {
  return Array.from(testSessions.keys());
}

/** 打开某账号的测试窗口（手动聊天）。已开 / 采集中 / 登录中 / 目录不存在 → 返回明确错误 */
export async function testAccount(
  platformId: string,
  accountId: string
): Promise<{ ok: boolean; msg: string }> {
  const driver = LOGIN_DRIVERS[platformId];
  if (!driver) return { ok: false, msg: `未注册的登录平台：${platformId}` };
  const acc = await accountRepo.get(platformId, accountId);
  if (!acc) return { ok: false, msg: `账号不存在：${accountId}` };
  // 只有处于登录态的账号才能测试（none=未登录 / waiting=登录中 / failed=不可用 一律禁止）
  if (acc.status !== 'active' && acc.status !== 'cooling') {
    return { ok: false, msg: `账号 ${accountId} 未处于登录态（当前：${acc.status}），无法测试` };
  }
  // 目录必须存在（至少登录过一次才会创建；纯未登录槽位无 profile 目录）
  if (!fs.existsSync(acc.dir)) {
    return { ok: false, msg: `账号 ${accountId} 还没有 profile 目录（请先登录一次）` };
  }
  // 采集中（inFlight）或被占用 → 不开，避免抢同一 userDataDir
  if (isAccountBusy(accountId)) {
    return { ok: false, msg: `账号 ${accountId} 正在采集中或被占用，暂不能开测试窗口` };
  }
  // 该账号正在走登录流程 → 等完成
  if (loginBusy().accountId === accountId) {
    return { ok: false, msg: `账号 ${accountId} 正在登录中，请先完成登录` };
  }
  const key = testKey(platformId, accountId);
  if (testSessions.has(key)) {
    return { ok: false, msg: `账号 ${accountId} 的测试窗口已打开` };
  }
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(acc.dir, launchOpts());
  } catch (e) {
    return { ok: false, msg: `打开测试窗口失败：${(e as Error).message}` };
  }
  // 隐藏自动化特征，免得平台把手动窗口当成脚本
  void context
    .addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
      } catch {
        /* ignore */
      }
    })
    .catch(() => {});
  const def = resolvePlatform(platformId);
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(def.defaultUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  testSessions.set(key, context);
  // 标记占用：阻止采集挑到它（两个上下文不能共用一个 userDataDir）
  inFlight.add(accountId);
  // 用户手动点 X 关窗 → 清理
  context.on('close', () => {
    testSessions.delete(key);
    inFlight.delete(accountId);
  });
  return {
    ok: true,
    msg: `已为 ${accountId} 打开测试窗口（${driver.label}），可手动提问 / 管理历史对话；关窗即结束。`,
  };
}

/** 关闭某账号的测试窗口 */
export async function closeTestAccount(
  platformId: string,
  accountId: string
): Promise<{ ok: boolean; msg: string }> {
  const key = testKey(platformId, accountId);
  const ctx = testSessions.get(key);
  if (!ctx) return { ok: false, msg: `账号 ${accountId} 没有打开的测试窗口` };
  testSessions.delete(key);
  inFlight.delete(accountId);
  await ctx.close().catch(() => {});
  return { ok: true, msg: `已关闭 ${accountId} 的测试窗口` };
}
