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
import { proxyRepo, isDirectIp } from '../storage/proxyRepo.js';
import { config, paths } from '../config/index.js';
import { fingerprint } from '../config/fingerprint.js';
import { egressKeyOf, egressAvailable, acquireEgress, releaseEgress } from '../runtime/egress.js';

export type { Account, AccountStatus };

export interface PlatformLoginDriver {
  platformId: string;
  label: string;
  loginRequired: true;
  loginWaitMs?: number;
  hint?: string;
}

export const LOGIN_DRIVERS: Record<string, PlatformLoginDriver> = {
  doubao: {
    platformId: 'doubao',
    label: '豆包',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '请在自动打开的浏览器窗口完成登录（抖音扫码 / 手机验证码均可），完成后回到本页点击「我已登录完成，验证」。',
  },
  deepseek: {
    platformId: 'deepseek',
    label: 'DeepSeek',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '请在自动打开的浏览器窗口完成登录（手机验证码 / 微信扫码均可），完成后回到本页点击「我已登录完成，验证」。',
  },
  qwen: {
    platformId: 'qwen',
    label: '千问',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '请在自动打开的浏览器窗口完成登录（千问扫码 / 手机验证码均可），完成后回到本页点击「我已登录完成，验证」。',
  },
  wenxiaoyan: {
    platformId: 'wenxiaoyan',
    label: '百度文心',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '请在自动打开的浏览器窗口完成登录（百度账号扫码 / 手机号均可），完成后回到本页点击「我已登录完成，验证」。',
  },
  hunyuan: {
    platformId: 'hunyuan',
    label: '腾讯元宝',
    loginRequired: true,
    loginWaitMs: 6 * 60 * 1000,
    hint: '请在自动打开的浏览器窗口完成登录（微信扫码 / 手机号均可），完成后回到本页点击「我已登录完成，验证」。',
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
      accounts: (await accountRepo().list(d.platformId)).map((a) => ({
        ...a,
        todayQueries: a.queryDate === today ? (a.todayQueries ?? 0) : 0,
      })),
    });
  }
  return out;
}

export async function updateRemark(platformId: string, accountId: string, remark: string): Promise<{ ok: boolean; msg: string }> {
  if (!(await accountRepo().patch(platformId, accountId, { remark }))) return { ok: false, msg: '账号不存在' };
  return { ok: true, msg: '备注已更新' };
}

/** 启停账号：停用后不参与挑号（已占用的任务跑完为止） */
export async function setAccountEnabled(
  platformId: string,
  accountId: string,
  enabled: boolean
): Promise<{ ok: boolean; msg: string }> {
  const acc = await accountRepo().get(platformId, accountId);
  if (!acc) return { ok: false, msg: '账号不存在' };
  await accountRepo().patch(platformId, accountId, { enabled, note: undefined });
  return { ok: true, msg: `${accountId} 已${enabled ? '启用' : '停用'}` };
}

/** 删除整个账号（清目录 + 台账移除） */
export async function deleteAccount(platformId: string, accountId: string): Promise<{ ok: boolean; msg: string }> {
  const acc = await accountRepo().get(platformId, accountId);
  if (!acc) return { ok: false, msg: '账号不存在' };
  if (isAccountBusy(accountId) || testSessions.has(testKey(platformId, accountId)))
    return { ok: false, msg: '该账号正在使用中，请先关闭测试窗口后再删' };
  fs.rmSync(acc.dir, { recursive: true, force: true });
  await accountRepo().remove(platformId, accountId);
  return { ok: true, msg: `已删除账号 ${accountId}` };
}

/** 退出登录（清掉磁盘会话 + 关闭仍打开的登录窗口；台账保留、其他账号不受影响） */
export async function logoutAccount(platformId: string, accountId: string): Promise<{ ok: boolean; msg: string }> {
  const acc = await accountRepo().get(platformId, accountId);
  if (!acc) return { ok: false, msg: '账号不存在' };
  if (isAccountBusy(accountId) || testSessions.has(testKey(platformId, accountId)))
    return { ok: false, msg: '该账号正在使用中，请先关闭测试窗口后再退出' };
  // ⚠️ 登录制平台用持久上下文：仅改台账状态不够——
  //   · 若登录窗口仍开着（status=waiting：用户点了「登录」却还没点「验证」），必须取消登录并关窗，
  //     否则窗口内内存会话会继续显示「已登录对话界面 + 用户信息」，看起来像没退出。
  if (activeLogin && activeLogin.platformId === platformId && activeLogin.accountId === accountId) {
    activeLogin.confirm(false);                       // 解除 startLogin 的等待，使其走 finally 收尾
    activeLogin.context.close().catch(() => {});
    activeLogin = null;
  }
  fs.rmSync(acc.dir, { recursive: true, force: true });
  await accountRepo().patch(platformId, accountId, { status: 'none', note: undefined, nickname: undefined, lastUsedAt: undefined });
  return { ok: true, msg: `已退出 ${accountId}，登录态已清除` };
}

// ---------- 问答侧：挑号与回写 ----------
const inFlight = new Set<string>(); // 正在使用的账号（防同号并发）

/** 本实例标识，写入 leased_by；重启清理脏占用时用 */
export const instanceId = `${config.nodeId}:${process.pid}`;

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
  const accounts = await accountRepo().list(platformId);
  // 出口闸门：同一出口（未配代理即服务器默认出口）并发达上限的账号先排除
  const usable = accounts.filter(
    (a) =>
      a.status === 'active' &&
      a.enabled !== false &&
      !isAccountBusy(a.id) &&
      egressAvailable(egressKeyOf(a))
  );
  if (usable.length === 0) {
    const any = accounts.some((a) => ['failed', 'cooling', 'none'].includes(a.status) || a.enabled === false);
    const busyEgress =
      !any && accounts.some((a) => a.status === 'active' && a.enabled !== false && !egressAvailable(egressKeyOf(a)));
    const label = LOGIN_DRIVERS[platformId]?.label ?? platformId;
    return {
      ok: false,
      reason: busyEgress
        ? `「${label}」当前出口并发已满（GEO_MAX_PER_EGRESS=${config.maxPerEgress}），请稍后重试`
        : any
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
  acquireEgress(egressKeyOf(pick));
  // 占用落库（跨重启/多机可见）；失败不阻断，内存 inFlight 已保证本进程内互斥
  await accountRepo().patch(platformId, pick.id, { leasedBy: instanceId }).catch(() => {});
  return { ok: true, accountId: pick.id, dir: pick.dir };
}

/** 手动指定账号：状态/启用/占用全部校验，任一不满足即给明确原因（不静默换号） */
export async function allocateSpecificAccount(platformId: string, accountId: string): Promise<ReadyCheck> {
  const acc = await accountRepo().get(platformId, accountId);
  if (!acc) return { ok: false, reason: `账号不存在：${accountId}` };
  if (acc.enabled === false) return { ok: false, reason: `账号 ${accountId} 已停用，请先启用` };
  if (acc.status !== 'active') return { ok: false, reason: `账号 ${accountId} 当前状态为 ${acc.status}，不可用` };
  if (isAccountBusy(accountId)) return { ok: false, reason: `账号 ${accountId} 正在使用中` };
  if (!egressAvailable(egressKeyOf(acc)))
    return { ok: false, reason: `账号 ${accountId} 所属出口并发已满（GEO_MAX_PER_EGRESS=${config.maxPerEgress}），请稍后重试` };
  inFlight.add(accountId);
  acquireEgress(egressKeyOf(acc));
  await accountRepo().patch(platformId, accountId, { leasedBy: instanceId }).catch(() => {});
  return { ok: true, accountId, dir: acc.dir };
}

export async function releaseAccount(platformId: string, accountId: string, success: boolean, loginRequired: boolean): Promise<void> {
  inFlight.delete(accountId);
  const relAcc = await accountRepo().get(platformId, accountId);
  if (relAcc) releaseEgress(egressKeyOf(relAcc));
  await accountRepo().patch(platformId, accountId, { leasedBy: null }).catch(() => {});
  const acc = await accountRepo().get(platformId, accountId);
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
  await accountRepo().patch(platformId, accountId, patch);
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

function launchOpts(proxy?: { server: string; username?: string; password?: string }): Parameters<typeof chromium.launchPersistentContext>[1] {
  const fp = fingerprint();
  const o: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--lang=zh-CN'],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: fp.viewport,
    userAgent: fp.userAgent,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    ...(proxy ? { proxy } : {}),
  };
  if (config.chromePath) o.executablePath = config.chromePath;
  else if (config.useSystemChrome) o.channel = 'chrome';
  return o;
}

/** 账号的代理（从绑定的 geo_ui_proxy_ip 取协议/凭据；proxyId 为 null、代理已停用、
 *  或绑定的是宿主机直连行（127.0.0.1:0）→ 无代理走宿主机出口） */
export async function proxyOf(acc: Account): Promise<{ server: string; username?: string; password?: string } | undefined> {
  if (!acc.proxyId) return undefined;
  try {
    const ip = await proxyRepo().get(acc.proxyId);
    if (!ip || ip.enabled === false) return undefined;
    // 宿主机直连行：不传代理（与普通代理 IP 一样参与调度/冷却，只是浏览器不设 proxy）
    if (isDirectIp(ip)) return undefined;
    return {
      server: `${ip.protocol}://${ip.host}:${ip.port}`,
      ...(ip.username ? { username: ip.username } : {}),
      ...(ip.password ? { password: ip.password } : {}),
    };
  } catch {
    return undefined;
  }
}

/** launchPersistentContext 容错包装：profile 残留 Chromium 锁（浏览器被 kill/容器重启后
 *  SingletonLock/Socket/Cookie 未清除）会让 Chrome 误以为目录被占用而立即退出，表现为
 *  「测试/登录窗口打不开、noVNC 黑屏」。启动失败时自动清锁重试一次。 */
async function launchPersistentRetry(
  dir: string,
  opts: Parameters<typeof chromium.launchPersistentContext>[1]
): Promise<BrowserContext> {
  try {
    return await chromium.launchPersistentContext(dir, opts);
  } catch (e) {
    try {
      for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        fs.rmSync(path.join(dir, f), { force: true });
      }
      return await chromium.launchPersistentContext(dir, opts);
    } catch (e2) {
      throw e2;
    }
  }
}

/** 一次性打开目录探测：登录墙？proxy = 账号绑定代理（探测必须走同一出口，否则登录态判定失真） */
async function openProbe(
  platformId: string,
  dir: string,
  proxy?: { server: string; username?: string; password?: string }
): Promise<{ ok: boolean; loginRequired?: boolean; error?: string }> {
  let context: BrowserContext;
  try {
    context = await launchPersistentRetry(dir, { ...launchOpts(proxy), headless: true });
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
      return { ok: true, loginRequired };
    }
    return { ok: true, loginRequired };
  } catch (e) {
    return { ok: false, error: `登录态探测异常：${(e as Error).message}` };
  } finally {
    await context.close().catch(() => {});
  }
}

/** 登录后校验：无头重开同一目录，未撞登录墙且可提问 → ok（不抽昵称；2026-09-23 按用户要求简化） */
async function verifySession(
  platformId: string,
  dir: string,
  proxy?: { server: string; username?: string; password?: string }
): Promise<{ ok: boolean; note?: string }> {
  const p = await openProbe(platformId, dir, proxy);
  if (!p.ok) return { ok: false, note: p.error };
  if (p.loginRequired) return { ok: false, note: '登录态校验未通过：仍检测到登录墙/无输入框' };
  return { ok: true };
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
  let accounts = await accountRepo().list(platformId);
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
      remark: `账号${seq}`,
      status: 'none',
    };
    await accountRepo().add(platformId, acc);
  }
  await accountRepo().patch(platformId, acc.id, { status: 'waiting', note: undefined });
  const waitMs = driver.loginWaitMs ?? 6 * 60 * 1000;

  const task = (async () => {
    let context: BrowserContext;
    try {
      context = await launchPersistentRetry(acc.dir, launchOpts(await proxyOf(acc)));
    } catch (e) {
      await accountRepo().patch(platformId, acc.id, { status: 'failed', note: `打开登录窗口失败：${(e as Error).message}` });
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
      await accountRepo().patch(platformId, acc.id, { status: 'failed', note: `登录窗口异常：${(e as Error).message}` });
    } finally {
      activeLogin = null;
      await context.close().catch(() => {});
    }
    // 登录进行中账号被主动退出（logoutAccount 已把状态置 none、删目录）——不再回写登录结果，避免覆盖成 failed
    if ((await accountRepo().get(platformId, acc.id))?.status === 'none') {
      return;
    }
    if (done) {
      // active 以「磁盘登录态可还原」为准（verifySession = 无头重开同一目录验证登录墙/输入框）。
      // 不再抽昵称（2026-09-23 按用户要求简化）；文心等无登录墙平台的"磁盘未持久化"兜底
      // 由 confirmLogin 里的会话级 cookie 转持久（重种 365 天）承担。
      const v = await verifySession(platformId, acc.dir, await proxyOf(acc));
      if (v.ok) {
        await accountRepo().patch(platformId, acc.id, {
          status: 'active',
          note: undefined,
          createdAt: acc.createdAt ?? Date.now(),
          lastUsedAt: Date.now(),
          todayQueries: 0,
          consecutiveFails: 0,
        });
      } else {
        // 磁盘还原失败 → 登录态未真正持久化，明确标 failed，绝不凭窗口画面标 active
        await accountRepo().patch(platformId, acc.id, {
          status: 'failed',
          note: '登录态未持久化，请重新登录',
        });
      }
    } else {
      await accountRepo().patch(platformId, acc.id, { status: 'failed', note: '登录等待超时' });
    }
  })();
  // 收尾是异步 fire-and-forget：任意 DB 写入失败都收敛为日志，绝不变成 unhandledRejection 拖垮进程
  task.catch((e) => console.error('[startLogin] 登录异步收尾异常（已忽略，不影响服务进程）：', e));
  return { ok: true, msg: `登录窗口已打开（${acc.id}），请在窗口内完成登录后回到管理页点击「我已登录完成，验证」`, accountId: acc.id };
}

// 用户在可见登录窗口点「验证」→ confirmLogin 确认，随后 startLogin 异步收尾 verifySession 校验磁盘。
export async function confirmLogin(platformId: string, accountId: string): Promise<{ ok: boolean; msg: string }> {
  if (!activeLogin || activeLogin.platformId !== platformId || activeLogin.accountId !== accountId) {
    return { ok: false, msg: '当前没有进行中的该账号登录会话' };
  }
  // 直接在用户刚登录完成的可见窗口上操作：等 SPA 水合登录态 + 诊断落盘 + 会话级 cookie 转持久。
  // 不再抽昵称（2026-09-23 按用户要求简化）。
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
    /* 窗口操作失败不影响确认 */
  }
  activeLogin.confirm(true);
  return { ok: true, msg: '收到确认，正在校验登录态…' };
}

/** 取消某账号的进行中登录：释放活动会话（若有）+ 把状态重置回 none（服务重启后的 waiting 残留也适用）。 */
export async function cancelLogin(platformId: string, accountId: string): Promise<{ ok: boolean; msg: string }> {
  const acc = await accountRepo().get(platformId, accountId);
  if (!acc) return { ok: false, msg: `账号不存在：${accountId}` };
  // 1) 若该账号正占着登录会话：resolve(false) 让 startLogin 异步收尾走完并关窗；
  //    随后把状态置 none——startLogin 收尾看到 status==='none' 的守卫（第 494 行）不会回写 failed。
  //    先后顺序无所谓（resolve→收尾→patch，或 patch→收尾检查），最终都收敛到 none。
  if (activeLogin && activeLogin.platformId === platformId && activeLogin.accountId === accountId) {
    const lg = activeLogin;
    activeLogin = null;
    try { lg.confirm(false); } catch { /* 已 settle */ }
    try { await lg.context.close(); } catch { /* 窗口已关 */ }
  }
  // 2) 状态重置（无活动会话时同样生效：重启残留在此清理）
  await accountRepo().patch(platformId, accountId, { status: 'none', note: undefined });
  return { ok: true, msg: `已取消 ${accountId} 的登录` };
}

/** 服务启动时清理 waiting 残留：内存登录会话随进程重启必然丢失，waiting 账号无法再「验证登录」，统一重置为 none。 */
export async function resetStaleWaiting(): Promise<void> {
  try {
    for (const pid of Object.keys(LOGIN_DRIVERS)) {
      const accounts = await accountRepo().list(pid);
      for (const a of accounts) {
        if (a.status === 'waiting') {
          await accountRepo().patch(pid, a.id, { status: 'none', note: undefined });
          console.warn(`[login] 清理等待残留：${pid}/${a.id} -> none（服务重启）`);
        }
      }
    }
  } catch (e) {
    console.error('[login] 启动清理 waiting 残留失败（不阻断启动）：', e);
  }
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
  const acc = await accountRepo().get(platformId, accountId);
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
    context = await chromium.launchPersistentContext(acc.dir, launchOpts(await proxyOf(acc)));
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
    msg: `已为 ${accountId} 打开测试窗口（${driver.label}）`,
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
  // 浏览器可能已被 kill（崩溃/残留），close() 可能长时间挂起 → 最多等 8s，宁可放进程稍后回收
  await Promise.race([
    ctx.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  return { ok: true, msg: `已关闭 ${accountId} 的测试窗口` };
}
