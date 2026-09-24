// ─────────────────────────────────────────────────────────────────────────────
// 来源：从 workbuddy-backup/geo-browser 复制（2026-09-19，来源 commit 6d10a38）。
// ⚠️ 复制后已正式分叉，不再自动同步：
//    · geo-browser   = 本地有头测试 / selector 校准工具（产物落盘、看 report.html）
//    · geo-ui-browser = 服务器生产版（无头、产物不落盘、账号入 MySQL）
// 同步规则见 doc/project-notes.md §3：
//    · 共享资产（platforms/**、tuning/delays.ts、types.ts）任一侧修改需双向同步
//    · 本文件与 server/** 各自演进，不要直接覆盖
// ─────────────────────────────────────────────────────────────────────────────
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolvePlatform, PlatformDef } from '../platforms/index.js';
import { windowPositionFor } from '../runtime/windowPos.js';
import { probeElements } from './elementProbe.js';
import { DiagnosticResult, ElementDiagnosisItem, SourceInfo, ScreenshotMode } from '../types.js';
import { config, paths } from '../config/index.js';
import { fingerprint, Fingerprint } from '../config/fingerprint.js';
import { trackContext, untrackContext, trackBrowser, untrackBrowser } from '../runtime/shutdown.js';

function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function writeReport(root: string, r: DiagnosticResult, label: string): Promise<void> {
  const elRows = r.elementDiagnosis
    .map(
      (e) =>
        `<tr><td>${e.name}</td><td class="${e.found ? 'ok' : 'miss'}">${e.found ? '✓' : '✗'}</td><td>${e.tag ?? ''}</td><td><code>${e.selector ?? ''}</code></td></tr>`
    )
    .join('');
  const srcRows = r.sources
    ? r.sources
        .map(
          (s) =>
            `<li><a href="${s.url ?? '#'}" target="_blank">${s.title ?? s.url ?? '(无标题)'}</a>${
              s.platform ? ` <span class="miss">· 平台：${s.platform}</span>` : ''
            }</li>`
        )
        .join('')
    : '<li class="miss">未定位到信源区</li>';
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>诊断报告 ${r.timestamp}</title>
  <style>body{font-family:system-ui;margin:24px;color:#222}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}code{color:#c00}.miss{color:#c00}.ok{color:#0a0}pre{background:#f6f6f6;padding:12px;border-radius:6px;white-space:pre-wrap}</style></head>
  <body><h1>${label}采集诊断报告</h1>
  <p>时间：${r.timestamp} ｜ 平台：${r.platform} ｜ 登录墙：${r.loginRequired ? '是' : '否'}</p>
  <p>问题：<b>${r.question}</b></p>
  <h2>页面元素诊断</h2><table><tr><th>元素</th><th>找到</th><th>标签</th><th>Selector</th></tr>${elRows}</table>
  <h2>回复信息</h2><pre>${r.answerText ?? '（未定位到回答区域）'}</pre>
  <h2>信源信息（sourceCount=${r.sourceCount === null ? 'NULL' : r.sourceCount}）</h2><ul>${srcRows}</ul>
  <h2>备注</h2><ul>${r.notes.map((n) => `<li>${n}</li>`).join('')}</ul>
  </body></html>`;
  fs.writeFileSync(path.join(root, 'report.html'), html);
}

export interface LaunchOpts {
  /** 使用本机已安装的 Chrome（channel:'chrome'），跳过 Playwright 自带 chromium 下载 */
  useSystemChrome?: boolean;
  /** 显式指定 Chrome 可执行文件路径（优先级高于 useSystemChrome） */
  executablePath?: string;
  /** 目标平台 id（默认 doubao），见 src/platforms/index.ts 的 PLATFORMS */
  platform?: string;
  /** 覆盖平台默认入口 URL（便于指向具体聊天页） */
  url?: string;
  /** 长屏截图策略（各平台可自选实现；未实现 stitch 的平台会回退并打印警告） */
  screenshotMode?: ScreenshotMode;
  /**
   * 持久用户目录（登录 profile）。有值 → launchPersistentContext 复用真实登录会话；
   * 无值 → 临时匿名上下文（豆包会触发风控，见下）。
   *
   * ⚠️ 2026-08-31 实测：豆包匿名会话**发送即触发风控**，不登录无法提问。
   *    故 V1 阶段的正确用法是「人工登录一次 → 复用 profile 跑诊断」，
   *    匿名路径仅对尚不限制的平台（如文心）保留。
   */
  userDataDir?: string;
  /**
   * 检测到未登录时，等待人工在可见窗口内完成登录的毫秒数（0 = 不等待，直接记结论）。
   * 只在 userDataDir 存在时才有意义——匿名上下文关掉就丢，等了也白等。
   */
  waitLoginMs?: number;
  /** 无头模式；缺省时由环境变量 GEO_HEADLESS 决定 */
  headless?: boolean;
  /** 代理（真实走代理出口，防风控）：server 形如 http://host:port 或 socks5://host:port */
  proxy?: { server: string; username?: string; password?: string };
}

export async function runDiagnostic(
  question: string,
  opts: LaunchOpts = {}
): Promise<DiagnosticResult> {
  const def: PlatformDef = resolvePlatform(opts.platform || 'doubao');
  const url = opts.url || def.defaultUrl;

  const fp = fingerprint();
  const headless = opts.headless ?? config.headless;
  const launchOpts: {
    headless: boolean;
    slowMo: number;
    channel?: string;
    executablePath?: string;
    args?: string[];
    ignoreDefaultArgs?: string[];
    proxy?: { server: string; username?: string; password?: string };
  } = {
    headless,
    slowMo: headless ? 0 : 20, // headless 模式下不刻意放慢；非 headless 用于人工可视监控
    // 去掉 navigator.webdriver 等明显的自动化特征，降低被风控误判的概率。
    // ⚠️ 仅消除"我是脚本"的标记，**不绕过**任何验证码/登录/风控——该登录的照样人工登录。
    args: [
      '--disable-blink-features=AutomationControlled',
      // 有头模式多个窗口默认堆叠 (0,0) 互相遮挡（noVNC 只看到最上层）→ 按 profile 错开摆放
      ...(headless ? [] : [windowPositionFor(opts.userDataDir ?? def.id)]),
    ],
    // 去掉 Playwright 默认注入的 --enable-automation（会留下 cdc_ 钩子与 webdriver 标记）
    ignoreDefaultArgs: ['--enable-automation'],
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
  };
  const exePath = opts.executablePath ?? config.chromePath;
  const useSystem = opts.useSystemChrome ?? config.useSystemChrome;
  if (exePath) {
    launchOpts.executablePath = exePath;
  } else if (useSystem) {
    launchOpts.channel = 'chrome';
  }
  const stamp = ts(); // YYYY-MM-DD_HH-MM-SS（报告内时间字段）
  // 产物模式：debug=落 diagnostics/ 供 selector 校准；none=完全不落盘（生产默认，只把长截图交给调用方）
  const debug = config.artifactMode === 'debug';
  const [day, time] = stamp.split('_');
  const queryName =
    question.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 50) || '未命名';
  let root = path.join(paths.diagnosticsRoot, `${def.id}/${day}/${time}-${queryName}`);
  let seq = 2; // 同秒同名去重
  while (debug && fs.existsSync(root)) {
    root = path.join(paths.diagnosticsRoot, `${def.id}/${day}/${time}-${queryName}-${seq}`);
    seq++;
  }
  const dirS = path.join(root, 'screenshot');
  const dirP = path.join(root, 'page');
  const dirN = path.join(root, 'network');
  if (debug) [dirS, dirP, dirN].forEach((d) => fs.mkdirSync(d, { recursive: true }));

  const contextOpts: Parameters<Browser['newContext']>[0] = {
    viewport: fp.viewport,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    deviceScaleFactor: fp.deviceScaleFactor,
    acceptDownloads: false, // 不触发任何下载行为，避免系统下载条/对话框
    // HAR 内存与体积开销大，仅 debug 模式记录
    ...(debug ? { recordHar: { path: path.join(dirN, 'network.har') } } : {}),
    // ⚠️ 不再硬编码 macOS UA（与 Linux 服务器矛盾 = 主动暴露），改为按实际 Chrome 版本动态拼接
    userAgent: fp.userAgent,
  };
  // 登录态：给了 profile 目录就走持久上下文（登录态落盘，下次复用）；否则仍是临时匿名上下文。
  // ⚠️ 两种模式共用的只有「上下文选项」，浏览器实例与关闭顺序不同，故分开建。
  let browser: Browser;
  let context: BrowserContext;
  if (opts.userDataDir) {
    // ⚠️ profile 占用检测：登录窗口的有头浏览器（launchPersistentContext）与收录检测
    //    用同一账号目录时，Chromium 单实例锁冲突 → 浏览器被关 → 报「Target page closed」
    //    （12-18/12-20 线上失败根因）。这里先查锁文件，占用则等待最多 12s 并明确提示。
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    const profileLocked = (): string | null => {
      try {
        for (const f of lockFiles) {
          const p2 = path.join(opts.userDataDir as string, f);
          if (fs.existsSync(p2)) return f;
        }
      } catch { /* 忽略 */ }
      return null;
    };
    const lockWaitDeadline = Date.now() + 12000;
    for (;;) {
      const lock = profileLocked();
      if (!lock) break;
      const remain = Math.max(1, Math.round((lockWaitDeadline - Date.now()) / 1000));
      console.warn(`⚠️ profile 被占用（${lock}）：登录窗口可能未关闭，等待 ${remain}s 释放后重试（${path.resolve(opts.userDataDir as string)}）`);
      await new Promise((r) => setTimeout(r, 3000));
      if (Date.now() >= lockWaitDeadline) {
        throw new Error(
          `PROFILE_LOCKED: 账号 profile 被占用（${lock}）——请先关闭该账号的登录窗口/测试窗口再重试（${path.resolve(opts.userDataDir as string)}）`
        );
      }
    }
    context = await chromium.launchPersistentContext(opts.userDataDir, {
      ...launchOpts,
      ...contextOpts,
    });
    browser = context.browser() as Browser; // 持久上下文自带浏览器实例，关闭时一起关
    console.log(`👤 持久登录 profile：${path.resolve(opts.userDataDir)}（首次使用需人工登录一次）`);
  } else {
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext(contextOpts);
  }
  // 注册到优雅退出表：容器停止时能被关掉，不留僵尸进程
  trackContext(context);
  trackBrowser(browser);
  // 反自动化指纹脚本：在每一个新文档（含跨域 iframe）最早时机注入，
  // 抹掉 webdriver 标记并补全几处真实桌面浏览器应有的字段，降低阿里等风控的环境判定。
  // ⚠️ 只是"看起来像真人浏览器"，**不破解/不绕过**任何验证码或登录。
  await context
    .addInitScript((f: Fingerprint) => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
      } catch {
        /* ignore */
      }
      try {
        Object.defineProperty(navigator, 'languages', {
          get: () => ['zh-CN', 'zh', 'en'],
          configurable: true,
        });
      } catch {
        /* ignore */
      }
      try {
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => f.hardwareConcurrency, configurable: true });
      } catch {
        /* ignore */
      }
      try {
        Object.defineProperty(navigator, 'deviceMemory', { get: () => f.deviceMemory, configurable: true });
      } catch {
        /* ignore */
      }
      try {
        // 预留滚动条槽位：滚动条出现/消失引起的布局宽度变化是「页面猛的一缩」抖动的根源
        const st = document.createElement('style');
        st.textContent = 'html{scrollbar-gutter:stable;}';
        (document.head || document.documentElement).appendChild(st);
      } catch {
        /* ignore */
      }
    }, fp)
    .catch(() => {});
  // 持久上下文（launchPersistentContext，走台账/登录 profile 时）自带一个初始空白标签页，
  // 直接复用它，避免出现「一个 blank + 一个业务页」两个标签。
  const page: Page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  // 打印目录，便于排查「发送后弹出访达窗口」现象：对比访达标题栏路径是否与下面一致
  console.log(`📂 工作目录：${process.cwd()}`);
  console.log(`📂 本次样本库目录：${root}`);
  const adapter = def.create(page, context);

  const notes: string[] = [];
  let result: DiagnosticResult | null = null;
  // 防御：注册 filechooser 处理器本身就会拦截原生文件选择对话框（不再弹出系统窗口，避免遮挡/卡死）。
  // 若页面意外触发（如误点附件入口），仅记录，不做任何 setFiles，对话框已被接管。
  page.on('filechooser', () => {
    notes.push('ℹ️ 检测到页面触发了文件选择对话框，已自动接管（疑似误触附件入口），未选择任何文件。');
  });
  const capturedShots: string[] = [];
  let loginRequired = false;
  let answerText: string | null = null;
  let sources: SourceInfo[] | null = null;
  let elementDiagnosis: ElementDiagnosisItem[] = [];
  let qaOk = false;
  let beforeHtml = '';
  let finishedHtml = '';
  let qaShotBuffer: Buffer | undefined;

  try {
    // 阶段1：打开页面 + 留 before 现场（尽早存盘，确保任何后续失败都有现场可查）
    try {
      // 聊天类网页持续保活连接(SSE/轮询/心跳)，networkidle 几乎永不触发，必须用 domcontentloaded
      // 导航容错：部分 SPA（如元宝门户）首屏资源持续加载会让 domcontentloaded 在 30s 内
      // 迟迟不触发，Playwright 报 net::ERR_TIMED_OUT，但正文往往已渲染。超时只要页面已离开
      // about:blank 空壳（已命中目标域），即视为已加载并继续，避免整轮卡在空白标签。
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (ge) {
        const curUrl = page.url();
        const isBlank = (await page.content().catch(() => '')).trim().length < 60;
        const targetHost = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
        if (isBlank && !(targetHost && curUrl.includes(targetHost))) {
          // 真·白屏/未命中目标域：可能是站点瞬时慢（首屏资源持续加载），重试一次再判失败，
          // 避免偶发网络慢导致整轮卡在 about:blank 空标签。
          console.log('⚠️ 导航超时且页面仍空白，等待 3s 重试一次…');
          await page.waitForTimeout(3000);
          await page
            .goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
            .catch(() => {});
          await page.waitForTimeout(2000);
          const curUrl2 = page.url();
          const blank2 = (await page.content().catch(() => '')).trim().length < 60;
          if (blank2 && !(targetHost && curUrl2.includes(targetHost))) {
            throw ge; // 重试仍白屏 → 保留「打开页面失败」语义
          }
          notes.push(`⚠️ 导航首超时但重试成功（${ (ge as Error).message }），页面已渲染，继续后续流程。`);
        } else {
          notes.push(`⚠️ 导航未在 30s 内稳定（${ (ge as Error).message }），但页面已渲染，继续后续流程。`);
        }
      }
      // 等首屏「就绪」再进 checkLogin：① 平台专属输入框（def.selectors.input，已校准平台精确匹配）；
      // ② 通用输入框兜底（textarea/input/contenteditable）——SPA 水合登录态后渲染出的真实输入框，
      //    不依赖平台候选选择器，避免未校准平台（元宝初版）因占位选择器匹配不到而漏等；
      // ③ 登录入口出现，才算页面加载到位。避免 SPA 壳页瞬间（输入框/登录钮都还没渲染）就误判为「需登录」。
      const readySel = [
        ...def.selectors.input,
        'textarea', 'input', '[contenteditable="true"]',
        'a:has-text("登录")', 'button:has-text("登录")',
      ].join(', ');
      await page
        .waitForSelector(readySel, { timeout: 20000 })
        .catch(() => {});

      // —— 登录态平台：等 SPA 从持久化 cookie 水合登录态 ——
      // 文心（及部分 SPA）首屏会闪现未登录遮罩 `.chat-aside-user-mask.unlogin`，需等其消失才算登录态。
      // 若不等待：首屏以未登录渲染，且 SPA 不会自动重新应用 cookie 登录态 → 整轮问答会话落在未登录态，
      // 已登录账号被白白浪费（实测「测试文心」全程 unlogin，前/后 HTML 均无昵称）。
      // 该缺陷此前藏在 openProbe（登录校验）里——它有 8s 水合等待，但 runDiagnostic（实际问答/信源分析
      // 路径）漏了。非文心平台无该选择器 → querySelector 返回 null → 瞬时通过，零成本。
      if (opts.userDataDir) {
        const waitHydrate = (tag: string): Promise<void> =>
          page
            .waitForFunction(
              () => {
                const m = document.querySelector('.chat-aside-user-mask.unlogin');
                return !m || !(m as HTMLElement).offsetParent;
              },
              { timeout: 8000 }
            )
            .then(() => console.log(`👤 [${tag}] 登录态水合完成`))
            .catch(() => console.log(`👤 [${tag}] 登录态水合超时（继续）`));
        await waitHydrate('登录态水合');
        // 超时仍处未登录遮罩 → 重新加载，强制 SPA 重新从 cookie 初始化登录态（首屏未登录加载后不会自动重 hydrate）
        const stillUnlogin = await page
          .evaluate(() => {
            const m = document.querySelector('.chat-aside-user-mask.unlogin');
            return !!m && !!(m as HTMLElement).offsetParent;
          })
          .catch(() => false);
        if (stillUnlogin) {
          console.log('👤 水合超时仍处未登录，重新加载页面以重新初始化登录态…');
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(1500);
          await waitHydrate('重载后水合');
        }
      }

      await page.waitForTimeout(1500);
      if (debug) {
        await page.screenshot({ path: path.join(dirS, '01-before.png') });
        capturedShots.push('01-before.png');
        beforeHtml = await page.content();
        fs.writeFileSync(path.join(dirP, 'before.html'), beforeHtml);
      }
    } catch (e) {
      notes.push(`❌ 打开页面失败：${(e as Error).message}`);
    }

    try {
      const _tStage = Date.now();
      loginRequired = await adapter.checkLogin();
      console.log(`[stage2] checkLogin 用时 ${((Date.now() - _tStage) / 1000).toFixed(1)}s（loginRequired=${loginRequired}）`);
      // 不再用账号昵称探测兜底（2026-09-23 按用户要求简化，不抽取昵称）。
      // 注意取舍：文心等无登录墙平台的 checkLogin 恒 false，无法区分「真登录」与「磁盘无登录态」；
      // 该场景由 confirmLogin 里的会话级 cookie 转持久兜底。

      // 未登录且允许等待 → 停在可见窗口等人工登录（浏览器不关，用户直接操作即可）。
      // 轮询「是否已出现输入框」作为登录成功的判定，与平台登录方式（短信/扫码/第三方）无关。
      if (loginRequired && opts.waitLoginMs && opts.waitLoginMs > 0 && opts.userDataDir) {
        const deadline = Date.now() + opts.waitLoginMs;
        console.log(
          `\n🔑 请在弹出的浏览器窗口中手动登录「${def.label}」（最多等待 ${Math.round(opts.waitLoginMs / 1000)}s）…\n` +
            `   登录完成后无需任何操作，本程序会自动继续。\n`
        );
        let loggedAt = 0;
        while (Date.now() < deadline) {
          await page.waitForTimeout(3000);
          if (!(await adapter.checkLogin().catch(() => true))) {
            loggedAt = Date.now();
            break;
          }
        }
        if (loggedAt) {
          loginRequired = false;
          console.log('✅ 登录已生效，等待页面稳定后继续诊断');
          // 登录后页面通常会跳转/刷新 → 回到目标聊天页，再补一份「已登录」的 before 现场
          await page.waitForTimeout(2000);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await page
            .waitForSelector('textarea, input, [contenteditable="true"]', { timeout: 20000 })
            .catch(() => {});
          await page.waitForTimeout(2500);
          if (debug) {
            await page.screenshot({ path: path.join(dirS, '01-before.png') });
            beforeHtml = await page.content();
            fs.writeFileSync(path.join(dirP, 'before.html'), beforeHtml);
          }
        } else {
          notes.push(
            `⚠️ 等待人工登录超时（${Math.round(opts.waitLoginMs / 1000)}s），本次按未登录继续。`
          );
        }
      }

      if (loginRequired)
        notes.push(
          opts.userDataDir
            ? '⚠️ 仍未检测到登录态（未找到输入框/出现登录入口）。请加 --wait-login 后重跑并在窗口内完成登录。'
            : '⚠️ 检测到可能需要登录（未找到输入框/出现登录入口）。匿名路径不可行，请加 --profile 走登录 profile。'
        );
    } catch (e) {
      notes.push(`登录检测异常：${(e as Error).message}`);
    }

    // 阶段1.5：关闭平台自带干扰弹层（首页引导/营销广告/活动浮层等）。
    // 由各平台私有实现 dismissAds()（页面结构私有，不假通用）。在定位输入框之前调用，
    // 避免弹层挡住后续交互。无实现（豆包等）则跳过。
    try {
      if (adapter.dismissAds) {
        const _tD = Date.now();
        const dismissed = await adapter.dismissAds();
        console.log(`[stage2] dismissAds 用时 ${((Date.now() - _tD) / 1000).toFixed(1)}s`);
        if (dismissed) notes.push('🛡️ 已自动关闭平台首页弹窗/广告。');
        await page.waitForTimeout(800); // 等关闭动画/重排稳定
      }
    } catch (e) {
      notes.push(`关闭弹窗异常（不影响后续）：${(e as Error).message}`);
    }

    // 阶段2：交互流程（独立容错，失败不中断，仍产出报告）
    let asked = false;
    try {
      await adapter.sendQuestion(question);
      asked = true;

      // 阶段2.5：滑动验证（千问等平台发送后可能弹风控滑块）。平台私有实现 solveCaptcha()，
      // 在等待回答之前处理，避免滑块挡住回答。自动不过则进入「等待人工滑动」模式（run 不卡死）。
      try {
        if (adapter.solveCaptcha) {
          // 「刷新重开」回调：用户 2026-09-02 实操经验——连滑失败后刷新页面重开，一次基本能过。
          // ⚠️ 刷新会丢掉已输入的问题，所以重开 = 重新导航 + 重发问题。
          //    重发是编排职责（只有 run.ts 知道目标 URL 与问题文本），故在此提供；
          //    适配器仍然只负责滑块本身（平台操作私有）。
          const restart = async (): Promise<void> => {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            const readySel = [
              ...def.selectors.input,
              'a:has-text("登录")',
              'button:has-text("登录")',
            ].join(', ');
            await page.waitForSelector(readySel, { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(1500);
            await adapter.sendQuestion(question);
          };
          const solved = await adapter.solveCaptcha(debug ? root : undefined, restart);
          if (solved) notes.push('🔓 已自动/人工通过滑动验证。');
        }
      } catch (e) {
        notes.push(`滑动验证处理异常（不影响后续）：${(e as Error).message}`);
      }

      if (debug) {
        await page.screenshot({ path: path.join(dirS, '02-question.png') });
        capturedShots.push('02-question.png');
      }
      // 03 截图前等「回答开始渲染」：元素驱动（回答容器/加载胶囊出现），替代固定 1.5s——
      // 不同问题思考时间不同，固定时间会不适配。最多轮询 15 次（整体保护）后仍没开始就截现状。
      for (let i = 0; i < 15; i++) {
        const started = await page
          .evaluate(() => {
            const cap = document.querySelector('[class*="capsule-loading"]');
            if (cap && (cap as HTMLElement).getBoundingClientRect().width > 0) return true;
            const core = document.querySelector('.chat-search-answer-generate, .answer-box');
            return core ? (core.textContent || '').length > 20 : false;
          })
          .catch(() => false);
        if (started) break;
        await page.waitForTimeout(1000);
      }
      if (debug) {
        await page.screenshot({ path: path.join(dirS, '03-answering.png') });
        capturedShots.push('03-answering.png');
      }

      // 豆包等无文字级"生成结束"标志的平台：生成中途落盘一份 DOM，用于定标结束标志
      await adapter.waitForAnswer(180000, debug ? path.join(root, 'page', 'answering.html') : undefined);
      if (debug) {
        await page.screenshot({ path: path.join(dirS, '04-finished.png') });
        capturedShots.push('04-finished.png');
      }
    } catch (e) {
      notes.push(`⚠️ 交互流程中断（多为元素未定位）：${(e as Error).message}`);
    }

    if (asked) {
      try {
        answerText = await adapter.getAnswer();
        if (answerText === null)
          notes.push('未定位到回答区域（answerContainer 候选均不匹配）→ 需人工在 finished.html 中确认结构。');
      } catch (e) {
        notes.push(`抽取回答异常：${(e as Error).message}`);
      }

      // 关键交付物：真实页面的「问题 + 完整问答」长屏截图。
      // 截图放在「展开信源」之前 → 信源保持折叠态即可，无需为截图特意展开。
      //
      // ⚠️ 截图实现**不共用**（2026-08-31 用户定）：各平台页面结构与渲染技巧差异极大，
      //    统一实现必然要引用平台专属元素名（气泡/内容根…）→ 与其假通用，不如各平台
      //    Adapter 自己实现 `captureQaScreenshot(outPath, mode)` 并自己演进；
      //    本层只做编排：何时截、输出到哪、失败兜底。诊断日志在实现内部打印。
      //    **2026-09-03 17:47 用户定：截图失败/未实现 → 不整页兜底（不许截当前屏），
      //    本轮无 Q&A 截图（留空）**。成功判定 = 文件存在且 >3KB。
      // none 模式不落盘：截到临时文件，读完 Buffer 立即删除（Adapter 签名不变，各平台零改动）
      const outPath = debug
        ? path.join(dirS, '05-qa-block.png')
        : path.join(os.tmpdir(), `geo-qa-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
      if (typeof adapter.captureQaScreenshot === 'function') {
        try {
          await adapter.captureQaScreenshot(outPath, opts.screenshotMode || 'expand');
        } catch (e) {
          notes.push(`Q&A 块截图异常：${(e as Error).message}（按要求不整页兜底）`);
        }
        try {
          const st = fs.statSync(outPath);
          if (st.size > 3000) {
            qaOk = true;
            qaShotBuffer = fs.readFileSync(outPath);
            if (debug) capturedShots.push('05-qa-block.png');
            else fs.rmSync(outPath, { force: true }); // 用完即删，磁盘不留痕
          } else {
            fs.rmSync(outPath, { force: true });
            notes.push('⚠️ Q&A 截图未产出有效图（按要求不整页兜底），本轮无 Q&A 截图');
          }
        } catch {
          notes.push('⚠️ Q&A 截图未产出文件（按要求不整页兜底），本轮无 Q&A 截图');
        }
      } else {
        notes.push(
          `⚠️ 平台「${def.label}」尚未实现 captureQaScreenshot（按要求不整页兜底），本轮无 Q&A 截图`
        );
      }

      try {
        await adapter.expandSources();
      } catch (e) {
        notes.push(`展开信源异常：${(e as Error).message}`);
      }
      try {
        sources = await adapter.getSources(debug ? root : undefined);
        if (sources === null)
          notes.push('未定位到信源区域（sourceArea 候选均不匹配）→ 匿名路径可能不展示信源，或需登录。');
      } catch (e) {
        notes.push(`抽取信源异常：${(e as Error).message}`);
      }
    } else {
      notes.push('未成功发送问题，跳过回答/信源抽取。请检查 sendButton 候选 selector。');
    }

    if (debug) {
      finishedHtml = (await page.content().catch(() => beforeHtml)) || beforeHtml;
      fs.writeFileSync(path.join(dirP, 'finished.html'), finishedHtml); // 现场留档（诊断用，非截图来源）
    }

    try {
      elementDiagnosis = await probeElements(page, def.selectors);
    } catch (e) {
      notes.push(`元素诊断异常：${(e as Error).message}`);
    }

    // 阶段3：始终产出报告（即使中途失败也留现场 + 元素诊断）
    result = {
      platform: def.id,
      url,
      question,
      timestamp: stamp,
      loginRequired,
      answerText,
      sources,
      sourceCount: sources === null ? null : sources.length,
      elementDiagnosis,
      sampleDir: debug ? root : '',
      qaScreenshotBuffer: qaShotBuffer,
      artifacts: {
        screenshots: capturedShots.map((f) => `screenshot/${f}`),
        qaScreenshot: qaOk ? 'screenshot/05-qa-block.png' : undefined,
        beforeHtml: 'page/before.html',
        finishedHtml: 'page/finished.html',
        har: 'network/network.har',
        reportHtml: 'report.html',
      },
      notes,
    };
    if (debug) {
      fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
      await writeReport(root, result, def.label);
      console.log(`✅ 诊断完成（部分失败也会留现场），样本库：${path.relative(process.cwd(), root)}`);
    } else {
      console.log(`✅ 采集完成（artifactMode=none，未落盘任何产物）`);
    }
  } catch (e) {
    notes.push(`❌ 诊断异常：${(e as Error).message}`);
    console.error('诊断异常：', (e as Error).message);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    untrackContext(context);
    untrackBrowser(browser);
  }

  notes.forEach((n) => console.log(n));
  if (!result) {
    throw new Error(notes.filter((n) => n.includes('❌')).join('；') || '诊断未完成');
  }
  return result;
}
