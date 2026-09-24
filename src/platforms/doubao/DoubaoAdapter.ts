import { Page, BrowserContext } from 'playwright';
import fs from 'fs';
import sharp from 'sharp';
import { DOUBAO_CANDIDATE_SELECTORS } from './selectors.js';
import { firstFound } from '../../diagnostics/elementProbe.js';
import { CandidateSelectors, PlatformAdapter, ScreenshotMode, SourceInfo } from '../../types.js';
import {
  DOUBAO_INPUT_FOCUS_AFTER,
  DOUBAO_INPUT_FOCUS_SETTLE,
  DOUBAO_INPUT_PRE_ENTER,
  DOUBAO_INPUT_PRE_TYPE,
  randWaitMs,
} from '../../tuning/delays.js';

// 豆包适配器（V1 诊断用）。统一接口的一部分在此实现；
// 登录态检查因匿名路径而简化：有输入框即认为匿名可用，否则判为需登录。
export class DoubaoAdapter implements PlatformAdapter {
  constructor(
    private page: Page,
    private context: BrowserContext,
    private selectors: CandidateSelectors = DOUBAO_CANDIDATE_SELECTORS
  ) {}

  // 判断是否出现登录墙（豆包为登录制，匿名无法使用）。
  // ⚠️ 登录墙**优先于**输入框判定：登录-required 平台常在「输入框之上」覆盖登录弹层/遮罩，
  // 登录墙检测（2026-09-08 修正）：
  //  ⚠️ 旧逻辑「先查登录墙 a:has-text("登录")」会被历史会话里含「登录」二字的 <a> 链接误判为登录入口
  //    （如用户消息「微信授权登录实现」）→ 已登录被当成登录墙。改为**正向判定已登录**：
  //    先检测可见的聊天输入框（textarea / contenteditable）是否存在，存在即已登录；
  //    仅在确认无聊天界面时才查登录墙入口（此时历史消息不存在，不会误命中）。
  //    水合未完成（白屏）时既无可见聊天框也无登录墙 → 返回未登录，交由 openProbe 轮询重试。
  async checkLogin(): Promise<boolean> {
    const hasChatInput = await this.page
      .evaluate(() => {
        const els = Array.from(
          document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')
        );
        return els.some((e) => {
          const r = (e as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
      })
      .catch(() => false);
    if (hasChatInput) return false; // 有可见聊天输入框 → 已登录
    const loginEntry = this.page.locator(
      'a:has-text("登录"), button:has-text("登录"), [class*="login-modal"], [class*="login-mask"]'
    );
    if ((await loginEntry.count()) > 0) return true; // 无输入框且有登录墙 → 未登录
    return true; // 兜底：既无聊天输入框也无登录墙 → 保守视为未登录
  }

  // 关闭平台干扰弹层（营销广告/活动弹窗等）。豆包弹层为 radix dialog 风格：
  // 优先 Esc，再找关闭按钮（×），最后点全屏遮罩兜底。尽力而为，未关闭不抛错。
  async dismissAds(): Promise<boolean> {
    const visibleDialogCount = (): Promise<number> =>
      this.page
        .evaluate(() => {
          const sel = '[role="dialog"], [role="alertdialog"], [class*="modal" i], [class*="popup" i]';
          return Array.from(document.querySelectorAll(sel)).filter((el) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            const s = getComputedStyle(el as HTMLElement);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          }).length;
        })
        .catch(() => 0);
    // 1) Esc（radix dialog 通常支持 Esc 关闭）
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(400);
    if ((await visibleDialogCount()) === 0) return true;
    // 2) 关闭按钮（×）：dialog 内优先，再全局
    const closeSelectors = [
      '[role="dialog"] button[aria-label*="关闭"], [role="dialog"] button[aria-label*="close" i]',
      '[role="dialog"] [data-slot="dialog-close"]',
      'button[aria-label*="关闭"], button[aria-label*="close" i]',
      '[data-slot="dialog-close"]',
      '[class*="CloseButton" i], [class*="close-btn" i], [class*="close-icon" i]',
    ];
    for (const sel of closeSelectors) {
      const btn = this.page.locator(sel).first();
      // 关键：locator.evaluate 默认会等待元素出现（30s 超时）——5 个选择器都不匹配时
      // 会静默空等 150s（页面就绪后迟迟不输入的根因）。先 count() 立即返回匹配数，
      // 无匹配直接跳过，绝不进入 30s auto-wait。
      if ((await btn.count().catch(() => 0)) === 0) continue;
      const visible = await btn
        .evaluate(
          (el) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            const s = getComputedStyle(el as HTMLElement);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          },
          null,
          { timeout: 1500 }
        )
        .catch(() => false);
      if (visible) {
        await btn.click({ timeout: 1500 }).catch(() => {});
        await this.page.waitForTimeout(500);
        if ((await visibleDialogCount()) === 0) return true;
      }
    }
    // 3) 不再做遮罩坐标点击兜底：豆包输入区/操作区存在 class 含 overlay 的容器，
    //    点击中心极易误触输入栏 + 按钮（弹出附件菜单）→ 干扰输入发送与回答渲染。
    //    关不掉就不关（键盘输入/Enter 发送不检查遮挡，弹窗不影响主流程）。
    return false;
  }

  // 输入并发送问题。
  // 豆包输入区是「textarea + Tiptap contenteditable」双控件：真实编辑器为
  // <div contenteditable="true" class="tiptap ProseMirror">。务必先把焦点真正落到可编辑区，
  // 否则 keyboard.type 会落空（点击可能被拦截 / 光标进了 textarea 镜像）。
  async sendQuestion(question: string): Promise<void> {
    const _t0 = Date.now();
    const _step = (tag: string): void => {
      console.log(`[sendQuestion] ${tag} 用时 ${((Date.now() - _t0) / 1000).toFixed(1)}s`);
    };
    const input = await firstFound(this.page, this.selectors.input);
    if (!input) throw new Error('ELEMENT_NOT_FOUND: input');
    _step('定位输入框');

    // 聚焦可编辑区：先点击，再用 .focus() 强制兜底（避免点击被拦截导致失焦）
    // 显式 8s 超时：慢代理/遮挡下快速失败走兜底，不累积 Playwright 默认 30s 静默超时
    await input.locator.click({ timeout: 8000 }).catch(() => {});
    _step('点击输入框');
    await this.page.waitForTimeout(randWaitMs(DOUBAO_INPUT_FOCUS_SETTLE));
    await input.locator.focus().catch(() => {});
    await this.page.waitForTimeout(randWaitMs(DOUBAO_INPUT_FOCUS_AFTER));
    _step('聚焦完成');

    // 校验是否真的聚焦到可编辑区；没聚焦则尝试 textarea 兜底
    const focusedEditable = (): Promise<boolean> =>
      this.page
        .evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return (
            !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
          );
        })
        .catch(() => false);
    if (!(await focusedEditable())) {
      console.warn('⚠️ 编辑器未获焦点，尝试 textarea 兜底聚焦');
      const ta = this.page.locator('textarea').first();
      await ta.click({ timeout: 8000 }).catch(() => {});
      await ta.focus().catch(() => {});
    }

    // 逐字真人打字（先确保已聚焦，否则重聚焦再打）
    if (!(await focusedEditable())) {
      await input.locator.focus().catch(() => {});
    }
    // 打字前随机停顿 500–2000ms（模拟真人准备输入）
    await this.page.waitForTimeout(randWaitMs(DOUBAO_INPUT_PRE_TYPE));
    _step('开始打字前');
    await this.humanType(question);
    _step('打字完成');

    // 校验问题文本是否真的进入输入框（contenteditable 或 textarea 任一含即可）。
    // ⚠️ 必须用单个 page.evaluate 一次读完，绝不能用 locator.innerText()/inputValue()：
    // locator 在元素不存在时默认等 30s 超时才抛错（实测两处各卡 30s）。
    const enteredText = async (): Promise<string> =>
      this.page
        .evaluate(() => {
          const ce = document.querySelector('[contenteditable="true"]');
          const ta = document.querySelector('textarea');
          return ((ce && ce.textContent) || '') + ((ta && (ta as HTMLTextAreaElement).value) || '');
        })
        .catch(() => '');
    const probe = question.slice(0, Math.max(1, Math.floor(question.length / 2)));
    const ok = async (): Promise<boolean> => (await enteredText()).includes(probe);
    if (!(await ok())) {
      // 输入被打断（常见：营销弹窗/浮层中途弹出清空或遮挡输入框）→ 等待并关闭后重输一次
      console.warn('⚠️ 输入校验失败：疑似被弹窗/浮层打断，等待并尝试关闭后重输…');
      await this.page.waitForTimeout(2000);
      await this.dismissAds().catch(() => false);
      await this.page.waitForTimeout(500);
      await input.locator.click({ timeout: 8000 }).catch(() => {});
      await input.locator.focus().catch(() => {});
      await this.page.waitForTimeout(randWaitMs(DOUBAO_INPUT_PRE_TYPE));
      await this.humanType(question);
    }
    if (!(await ok())) {
      console.warn('⚠️ 输入校验失败：问题文本未进入输入框，请人工检查（见 02-question.png）');
      return; // 未输入成功就不假装已发送，交由调用方判失败
    }

    // 是否真的发出去：输入框是否已被清空（不再含原问题）。此时输入框必含原问题，
    // 清空 = 真发送；不会再把「输入失败的空输入框」误判为已发送。
    const isSent = async (): Promise<boolean> => !(await enteredText()).includes(probe);
    // 发送后轮询确认输入框清空（慢代理/带宽下页面清空有延迟，实测可 >15s），最多等 30s
    const waitSent = async (): Promise<boolean> => {
      const deadline = Date.now() + 30000;
      for (;;) {
        if (await isSent()) return true;
        if (Date.now() >= deadline) return false;
        await this.page.waitForTimeout(500);
      }
    };

    // 1) 优先 Enter（贴合用户习惯）。发送前随机停顿 500–1000ms（模拟真人检查后发送）
    await this.page.waitForTimeout(randWaitMs(DOUBAO_INPUT_PRE_ENTER));
    await this.page.keyboard.press('Enter');
    _step('Enter 已按');
    if (await waitSent()) {
      _step('waitSent 通过');
      return;
    }
    _step('waitSent 超时');

    // 2) 兜底前先确认：Enter 其实已发送成功、只是清空延迟未确认到 → 直接视为成功。
    //    否则在已发送状态再点发送钮会重复发送/白等 30s 静默超时（输入阶段 2 分半的根因）。
    if (await isSent()) return;

    // 3) 兜底：点输入区内圆钮（显式 8s 超时快速失败，不累积默认 30s）
    await input.locator.click({ timeout: 8000 }).catch(() => {});
    _step('兜底点输入框');
    const send = await firstFound(this.page, this.selectors.sendButton);
    if (send) await send.locator.click({ timeout: 8000 }).catch(() => {});
    _step('兜底点发送钮');
    if (await waitSent()) {
      _step('兜底 waitSent 通过');
      return;
    }

    console.warn('⚠️ 发送未能确认（输入框仍含原问题），请人工检查发送交互');
  }

  // 模拟真人逐字输入：单字录入，随机间隔 180–450ms（用户反馈更快速度仍"太快"）；
  // 标点后断句长停顿；约 8% 概率随机「思考停顿」，降低被自动化识别的概率。
  private async humanType(text: string): Promise<void> {
    const punctuations = '，。、；：？！,.!?;:';
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      let d = 180 + Math.floor(Math.random() * 270); // 180–450ms 随机间隔
      if (punctuations.includes(ch)) d += 200 + Math.floor(Math.random() * 300); // 断句
      if (Math.random() < 0.08) d += 400 + Math.floor(Math.random() * 500); // 思考停顿
      await this.page.waitForTimeout(d);
    }
  }

  // 取「整页可见文本」长度，作为回答生长的采样值。
  // ⚠️ 不能减 contenteditable：豆包的回答也可能渲染在富文本/contenteditable 容器里，
  // 减法会把回答文本一并减掉 → 相对基线永不增长 → 误判"回答未开始"。基线在发送后采集，
  // 此时输入框已清空，直接用 body.innerText.length 即可。
  private async getPageTextLen(): Promise<number> {
    return this.page.evaluate(() => document.body.innerText.length).catch(() => 0);
  }

  // 等待流式回答完整输出（关键，稳定窗口 30s 硬下限为用户要求）：
  // 生长信号用「回答容器」自身文本（page.evaluate 采样，零自动等待），并输出可见进度日志。
  // 豆包真实回答容器结构待定标，先用 .answer-content/.message-content 等候选作信号。
  // 等待流式回答完整输出。
  // ⚠️ 全元素驱动，不用固定分段时间（换问题页面会变）：单一循环轮询「回答容器文本 + 结束信号」。
  //   - 生长确认：回答容器文本出现并增长（容器选择器平台相关，见 growthSel）；
  //   - 结束信号：加载胶囊 [class*="capsule-loading"] 消失 或 [class*="answer-finished"] 出现，
  //     信号连续 3 次采样（≈3s）且见过增长 → 判定完成；
  //   - 无信号平台（页面没有胶囊/完成态元素，如豆包）→ 退回「容器文本连续 30 次采样无增长」兜底；
  //   - timeoutMs 仅作整体硬上限防失控。
  // 等待流式回答完整输出（全元素驱动，无固定分段时间）。
  // 状态机（基于「加载胶囊」的可见性，这是实测最可靠的流式指示）：
  //   检索/思考阶段：胶囊存在但 width=0（隐藏）→ **不能**当作完成（实测踩过坑：检索阶段就误判完成）
  //   流式输出阶段：胶囊可见（"智能体回答中，请等待"）
  //   完成：先观察到胶囊可见（进入流式），之后胶囊消失 + 容器文本连续 5 次采样无增长
  // 无胶囊平台（如豆包）：退回「容器文本连续 30 次采样无增长」兜底。
  // timeoutMs 仅作整体防失控硬上限。
  async waitForAnswer(timeoutMs = 180000, midDumpPath?: string): Promise<void> {
    const start = Date.now();
    let midDumped = false;

    const growthSel = '.answer-content, .message-content, [class*="answer"], [class*="response"]';
    const getAnswerLen = async (): Promise<number | null> =>
      this.page
        .evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) return (el.textContent || '').length;
          // 兜底：豆包 DOM 迭代快（hash 类名），专属容器可能不匹配。
          // 用整页文本长度做「增长信号」——回答流式输出时整页文本必然增长。
          const body = document.body;
          return body ? (body.innerText || '').length : null;
        }, growthSel)
        .catch(() => null);

    // 「流式输出中」= 加载胶囊可见（存在且宽度 > 0）
    const isStreaming = (): Promise<boolean> =>
      this.page
        .evaluate(() => {
          const cap = document.querySelector('[class*="capsule-loading"]');
          return !!cap && (cap as HTMLElement).getBoundingClientRect().width > 0;
        })
        .catch(() => false);

    // 「回答已完成」标志（2026-09-04 用户提议 + 实测定标）：回答完成后动作栏
    // （复制/朗读/点赞/点踩/分享/重新生成/更多）才出现。豆包动作按钮为纯 SVG，
    // 其中「朗读」「更多」带 aria-label → 以其可见数量为完成信号。
    // 多轮对话时旧回答也有动作栏 → 用基线计数：数量超过发送前基线 = 本轮完成。
    const countActionBar = async (): Promise<number> =>
      this.page
        .evaluate(() => {
          return Array.from(
            document.querySelectorAll('button[aria-label="朗读"], button[aria-label="更多"]')
          ).filter((b) => (b as HTMLElement).getBoundingClientRect().width > 0).length;
        })
        .catch(() => 0);
    const actionBaseline = await countActionBar();

    // 「验证码在场」检测（字节系验证码变体多：选图/拖拽/滑块，签名从宽）。
    // 仅用作「暂停超时倒计时」的依据，不参与完成判定——误报最多多等几秒，不会误判成功。
    const isCaptchaUp = (): Promise<boolean> =>
      this.page
        .evaluate(() => {
          const sels = [
            'iframe[src*="captcha"]',
            'iframe[id*="captcha"]',
            'iframe[src*="verify"]',
            '[class*="captcha"]',
            '[id*="captcha"]',
            '[class*="secsdk"]',
            '[id*="secsdk"]',
          ];
          for (const s of sels) {
            for (const el of Array.from(document.querySelectorAll(s))) {
              const r = (el as HTMLElement).getBoundingClientRect();
              if (r.width > 120 && r.height > 60) return true;
            }
          }
          const txt = (document.body && document.body.innerText) || '';
          return /拖动滑块|拖动下方滑块|完成验证|向右拖动|拖动到指定位置|选出.{0,10}符合|点击下方.{0,8}图片/.test(
            txt
          );
        })
        .catch(() => false);

    let lastLen: number | null = null; // 最近一次容器文本长度
    let streamingSeen = 0;             // 观察到「流式输出中」的采样次数
    let noGrowthStreak = 0;            // 连续无增长采样次数
    let lastProgressLog = Date.now();
    let captchaWaitMs = 0;             // 验证码在场累计等待（有上限，防无头模式挂死）
    let lastCaptchaLog = 0;
    let captchaSeen = false;
    let deadline = start + timeoutMs; // 验证码等待会顺延 deadline（人工处理时间不计入回答预算）

    while (Date.now() < deadline) {
      const len = await getAnswerLen();
      const streaming = await isStreaming();

      if (streaming) {
        streamingSeen += 1; // 进入过流式输出（后续胶囊消失才代表结束）
        noGrowthStreak = 0;
      }

      // 文本增长统计（元素驱动）
      if (len !== null) {
        if (lastLen === null) lastLen = len;
        else if (len > lastLen + 2) {
          lastLen = len;
          noGrowthStreak = 0;
        } else {
          noGrowthStreak += 1;
        }
      } else {
        noGrowthStreak += 1;
      }

      // —— 验证码闸门：卡住且疑似验证码在场 → 暂停倒计时等人工（有头）/ 等 it 自行消失 ——
      // ⚠️ 用户实测（2026-09-03）：豆包提交后可能弹「选图拖拽」验证码，人工处理期间
      //    旧逻辑 30s 无增长就收车关浏览器，把正在生成的回答掐死。现在：验证码在场时
      //    每秒顺延 deadline、清零无增长计数，最多累计等 3 分钟。
      if (streamingSeen === 0 && noGrowthStreak >= 8) {
        const captcha = await isCaptchaUp();
        if (captcha) {
          captchaSeen = true;
          noGrowthStreak = 0;
          captchaWaitMs += 1000;
          deadline += 1000; // 人工处理时间不挤占回答预算
          if (Date.now() - lastCaptchaLog > 10000) {
            console.log(
              `[${((Date.now() - start) / 1000).toFixed(1)}s] 🔒 检测到验证码，暂停超时倒计时等待处理（已等 ${Math.round(captchaWaitMs / 1000)}s）…`
            );
            lastCaptchaLog = Date.now();
          }
          if (captchaWaitMs >= 180000) {
            console.log(
              `[${((Date.now() - start) / 1000).toFixed(1)}s] ⚠️ 验证码等待超过 3 分钟，按本轮失败继续（现场已保留）`
            );
            break;
          }
          await this.page.waitForTimeout(1000);
          continue;
        }
      }

      // —— 结束判定 ⓪ 动作栏出现 = 明确完成（优先级最高，元素驱动；用户 2026-09-04 提议）——
      const bars = await countActionBar();
      if (bars > actionBaseline) {
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(1)}s] 🏁 检测到回答动作栏（复制/朗读/…/更多），回答已完成（当前 ${lastLen ?? 0} 字）`
        );
        break;
      }

      // —— 结束判定 ——
      // ① 见过流式输出 → 胶囊消失 + 连续 5 次无增长 = 完成
      if (streamingSeen >= 1 && !streaming && noGrowthStreak >= 5) {
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(1)}s] 🏁 流式胶囊消失且文本稳定，当前 ${lastLen ?? 0} 字`
        );
        break;
      }
      // ② 该平台无胶囊（从未见过流式信号）→ 连续 30 次无增长兜底
      if (streamingSeen === 0 && noGrowthStreak >= 30) {
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(1)}s] 🏁 无流式信号，文本连续 30s 无增长（兜底），当前 ${lastLen ?? 0} 字`
        );
        break;
      }

      // —— 进度日志 ——
      if (Date.now() - lastProgressLog > 10000) {
        const phase = streaming
          ? '📝 回答流式输出中…'
          : streamingSeen >= 1
            ? '⏳ 收尾中…'
            : '⏳ 检索/思考中…';
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(1)}s] ${phase}（容器 ${len === null ? '未出现' : len + ' 字'}）`
        );
        lastProgressLog = Date.now();
      }

      await this.page.waitForTimeout(1000);

      // 生成态 DOM 采样（约 20s 处，一次）：落盘当时页面，供定标「生成中→已结束」
      // 的真实标志（豆包动作图标为纯 SVG、无文字/aria 特征，静态样本拿不到生成态）。
      if (midDumpPath && !midDumped && Date.now() - start > 20000) {
        midDumped = true;
        try {
          fs.writeFileSync(midDumpPath, await this.page.content());
          console.log(`💾 生成态 DOM 已落盘：${midDumpPath}（用于定标回答结束标志）`);
        } catch {
          /* ignore */
        }
      }
    }
    if (captchaSeen) {
      console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s] ℹ️ 本轮出现过验证码（累计等待 ${Math.round(captchaWaitMs / 1000)}s）`);
    }
    console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s] ✅ 回答输出完成，开始抽取`);
    await this.page.waitForTimeout(500); // 收尾缓冲
  }

  // 抽取回答正文；定位不到 → null。
  // ⚠️ 用 page.evaluate 一次读 textContent，绝不用 locator.innerText()（live 页面上
  // locator 有 actionability 等待，抽取流程会卡很久）。
  async getAnswer(): Promise<string | null> {
    const sel = this.selectors.answerContainer.join(', ');
    const primary = await this.page
      .evaluate((s) => {
        const el = document.querySelector(s);
        return el ? (el.textContent || '').trim() || null : null;
      }, sel)
      .catch(() => null);
    if (primary) return primary;
    // 兜底（豆包 DOM 未定标前的临时策略）：取最后一个 ≥50 字的 markdown 渲染块。
    // 豆包回答走 markdown 渲染且位于问题之后 → 文档序最后一个即回答。
    // ⚠️ 拿到真实回答 DOM 样本（finished.html）定标 answerContainer 后应删除这段。
    return this.page
      .evaluate(() => {
        const blocks = Array.from(document.querySelectorAll('[class*="markdown"]')) as HTMLElement[];
        for (let i = blocks.length - 1; i >= 0; i--) {
          const t = (blocks[i].textContent || '').trim();
          if (t.length >= 50) return t;
        }
        return null;
      })
      .catch(() => null);
  }

  // 展开信源：只对带「展开/查看来源/查看引用/信源」文案的按钮点击（最多 5 个），
  // 用 evaluate 派发 click，零自动等待。绝不对全部候选元素逐个 locator.click()。
  // 豆包特有（2026-09-04 实测定标）：信源收在「搜索 N 个关键词，参考 N 篇资料」chip 里，
  // 初始 DOM 无任何外链，点开抽屉才渲染 → 用受信任鼠标点击 chip 父容器打开抽屉。
  async expandSources(): Promise<void> {
    // 1) 通用文案按钮兜底
    await this.page
      .evaluate(() => {
        const btns = Array.from(
          document.querySelectorAll('button, [role="button"], [class*="expand"]')
        ).filter((b) => /展开|查看来源|查看引用|查看信源|信源/.test(b.textContent || ''));
        btns.slice(0, 5).forEach((b) => (b as HTMLElement).click());
      })
      .catch(() => {});
    await this.page.waitForTimeout(300);

    // 2) 豆包「搜索 N 个关键词，参考 M 篇资料」chip
    // 已经展开（资料卡片已渲染）→ 直接返回，避免再点一次又折叠回去。
    const alreadyExpanded = await this.page
      .evaluate(() => document.querySelectorAll('a[data-thinking-box-tool-call="true"]').length > 0)
      .catch(() => false);
    if (alreadyExpanded) {
      console.log('📂 豆包资料抽屉已展开，跳过');
      return;
    }

    // 找到 chip 文本节点，向上走到包含 chevron svg 的可点击父容器。
    const chip = await this.page.evaluateHandle(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent || '';
        if (!/搜索\s*\d+\s*个关键词，参考\s*\d+\s*篇(资料|网页)/.test(text)) continue;
        let el: HTMLElement | null = node.parentElement;
        while (el && el !== document.body) {
          // chip 父容器必有 chevron svg；一旦找到即返回。
          if (el.querySelector('svg')) return el;
          el = el.parentElement;
        }
        return node.parentElement;
      }
      return null;
    });

    const chipEl = chip.asElement();
    if (chipEl) {
      try {
        await chipEl.click({ timeout: 5000 });
        console.log('📂 已点击豆包「参考 N 篇资料」chip');
      } catch {
        // 兜底：按 boundingBox 中心点做真实鼠标点击
        const box = await chipEl.boundingBox().catch(() => null);
        if (box) {
          await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 1 });
          await this.page.mouse.down();
          await this.page.mouse.up();
        }
      }
      // 等抽屉渲染
      await this.page.waitForTimeout(1200);
      // 若仍未展开，再试一次（首次点击可能因框架异步未响应）
      const hasCards = await this.page
        .evaluate(() => document.querySelectorAll('a[data-thinking-box-tool-call="true"]').length > 0)
        .catch(() => false);
      if (!hasCards) {
        console.log('📂 抽屉未展开，再次点击 chip');
        await chipEl.click({ timeout: 3000 }).catch(() => {});
        await this.page.waitForTimeout(1200);
      }
    }

    await this.page.waitForTimeout(800);
  }

  // 抽取信源列表（URL + 标题 + 平台）；定位不到信源区 → null。
  // 单次 evaluate 读完信源区内所有 <a>，零 locator 逐项等待。
  async getSources(): Promise<SourceInfo[] | null> {
    // 1) 豆包「参考 N 篇资料」展开后的资料卡片（最稳、最优先）。
    //    每张卡片是 <a data-thinking-box-tool-call="true" href="...">，内部 <span>1.</span> + <div>标题</div>。
    //    2026-09-07 实测：折叠态 chip 在截图里看似有信源，实则必须展开抽屉才有这些 <a>。
    const thinkingCards = await this.page
      .evaluate(() => {
        const cards = Array.from(document.querySelectorAll('a[data-thinking-box-tool-call="true"]'));
        if (cards.length === 0) return null;
        return cards.map((a) => {
          const title = (a.textContent || '').trim();
          return {
            title: title.replace(/^\s*\d+[\.\、]\s*/, '').trim() || undefined,
            url: a.getAttribute('href') || undefined,
          };
        });
      })
      .catch(() => null);
    if (thinkingCards && thinkingCards.length > 0) {
      return thinkingCards.map((s) => ({
        title: s.title,
        url: s.url,
        platform: this.derivePlatform(s.title, s.url || ''),
      }));
    }

    // 2) 通用 sourceArea 选择器兜底
    const raw = await this.page
      .evaluate((sel) => {
        const area = document.querySelector(sel);
        if (!area) return null;
        const anchors = Array.from(area.querySelectorAll('a'));
        if (anchors.length === 0) return null;
        return anchors.map((a) => ({
          title: (a.textContent || '').trim() || undefined,
          url: a.getAttribute('href') || undefined,
        }));
      }, this.selectors.sourceArea.join(', '))
      .catch(() => null);
    if (raw && raw.length > 0) {
      return raw.map((s) => ({ title: s.title, url: s.url, platform: this.derivePlatform(s.title, s.url) }));
    }

    // 3) 兜底：收集全页外链（排除豆包/字节自身域，保留 citation 跳转包装链接），按 URL 去重。
    const links = await this.page
      .evaluate(() => {
        const out: { title?: string; url?: string }[] = [];
        const seen = new Set<string>();
        for (const a of Array.from(document.querySelectorAll('a[href^="http"]'))) {
          const url = a.getAttribute('href') || '';
          if (/doubao\.com|bytedance|douyin\.com/.test(url) && !/citation|reference|source|url=/.test(url)) continue;
          if (seen.has(url)) continue;
          seen.add(url);
          out.push({ title: (a.textContent || '').trim() || undefined, url });
        }
        return out;
      })
      .catch(() => []);
    if (!links.length) return null;
    return links
      .slice(0, 30)
      .map((s) => ({ title: s.title, url: s.url, platform: this.derivePlatform(s.title, s.url) }));
  }

  // 长屏截图（**平台私有实现**，2026-09-03 定稿为策略 B = 滚动分片拼接）。
  // 豆包消息是虚拟列表：.v_list_row 为 absolute + transform(translateY) 摆放、.scroller 带
  // contain:strict + 由库维护高度——live 页面 React/虚拟库会持续重写行样式/重挂节点，
  // 「去虚拟化 + 元素截图」（策略 A）在实机永远过不了 actionability（18:09 仍失败；
  // 离线回放成功是因为静态 DOM 没有框架在跑）。
  // 策略 B：完全不碰框架——按 .scroller.clientHeight 步进 scrollTop，每步对滚动区可视框
  // 做一次普通 viewport 截图（无稳定/可见性检查），sharp 纵向拼接。步骤切片=步进无重叠。
  async captureQaScreenshot(outPath: string, _mode: ScreenshotMode = 'expand'): Promise<void> {
    const page = this.page;
    try {
      // 动态定位真正可滚动的容器（虚拟列表的滚动可能挂在 .scroller 或 message-list 等祖先）
      await page
        .evaluate(() => {
          const cands = Array.from(
            document.querySelectorAll(
              '.scroller, [class*="v_list_scroller"], [class*="message-list"], .scroller_content, [class*="list_items"]'
            )
          ) as HTMLElement[];
          const pick =
            cands.find((el) => el.scrollHeight - el.clientHeight > 40) ||
            cands.find((el) => el.scrollHeight > 0 && el.clientHeight > 10) ||
            null;
          document.querySelectorAll('[data-db-scroller]').forEach((el) => el.removeAttribute('data-db-scroller'));
          if (pick) pick.setAttribute('data-db-scroller', '1');
        })
        .catch(() => {});
      const scroller = page.locator('[data-db-scroller]').first();
      if (!(await scroller.count().catch(() => 0))) {
        console.log('豆包截图跳过：未定位到滚动容器（本轮无 Q&A 截图）');
        return;
      }
      const info = (await scroller.evaluate((el) => ({
        sh: el.scrollHeight,
        ch: el.clientHeight,
        vh: window.innerHeight,
      }))) as { sh: number; ch: number; vh: number };
      const box = await scroller.boundingBox().catch(() => null);
      if (!box || info.sh <= 0 || info.ch <= 10) {
        console.log(`豆包截图跳过：滚动区异常（sh=${info.sh} ch=${info.ch}，本轮无 Q&A 截图）`);
        return;
      }
      // 分片高度：不能超视口剩余（clip 出视口会报错），也不超过滚动区可视高
      const sliceH = Math.max(60, Math.min(info.ch, info.vh - Math.max(0, Math.round(box.y)) - 12));
      // 冻结动画，避免滚动/截图期间内容跳动
      await page.evaluate(() => {
        const st = document.createElement('style');
        st.textContent = '*{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
        document.head.appendChild(st);
      }).catch(() => {});
      // 分片推进（修复底部重复，2026-09-04 用户实测）：以「已覆盖内容量」为准绳，而不是
      // 预想偏移 i*sliceH——浏览器会把 scrollTop 钳制到 sh-ch，分片高 < 容器可视高时，
      // 末尾几片按预想偏移算片高会拍到同一段内容 → 拼接图底部重复。
      // 算法：目标 scrollTop = 已覆盖量（钳到 maxScroll）；读回实际值与最新 scrollHeight
      // （虚拟列表边滚边挂载，sh 会变）；从「已覆盖处相对可视框的偏移」继续拍，直到覆盖到底。
      // 拍完还原原始滚动位（页面不再跳回顶部，减少视觉干扰）。
      const maxScroll = Math.max(0, info.sh - info.ch);
      const originTop = (await scroller.evaluate((el) => el.scrollTop).catch(() => 0)) as number;
      const tiles: Buffer[] = [];
      let covered = 0; // 已覆盖的内容高度（相对滚动区顶部）
      for (let i = 0; i < 80; i++) {
        if (covered >= info.sh) break;
        const target = Math.min(covered, maxScroll);
        await scroller.evaluate((el, t) => { el.scrollTop = t; }, target).catch(() => {});
        await page.waitForTimeout(90);
        const st = (await scroller
          .evaluate((el) => ({ top: el.scrollTop, sh: el.scrollHeight }))
          .catch(() => null)) as { top: number; sh: number } | null;
        if (!st || st.top < 0) break;
        const sh = Math.max(info.sh, st.sh); // 虚拟列表挂载后 sh 可能增长
        const offset = Math.max(0, covered - st.top); // 被 clamp 时，从可视框中部起拍
        const remain = sh - covered;
        const h = Math.round(Math.min(sliceH, remain, info.ch - offset));
        if (h <= 0) break;
        const buf = await page.screenshot({
          clip: {
            x: Math.round(box.x),
            y: Math.round(box.y + offset),
            width: Math.round(box.width),
            height: h,
          },
          animations: 'disabled',
        });
        tiles.push(buf);
        covered += h;
      }
      await scroller.evaluate((el, t) => { el.scrollTop = t; }, originTop).catch(() => {});
      await page
        .evaluate(() =>
          document.querySelectorAll('[data-db-scroller]').forEach((el) => el.removeAttribute('data-db-scroller'))
        )
        .catch(() => {});
      if (!tiles.length) {
        console.log('豆包截图跳过：未拍到任何分片（本轮无 Q&A 截图）');
        return;
      }
      // 纵向拼接：逐片量高 → 空白画布 composite 摆放（sharp 无图片 join，用 create+composite）
      const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
      const width = metas[0].width ?? Math.round(box.width);
      let acc = 0;
      const parts = tiles.map((t, i) => {
        const part = { input: t, top: acc, left: 0 };
        acc += metas[i].height ?? 0;
        return part;
      });
      await sharp({
        create: { width, height: acc, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
      })
        .composite(parts)
        .png()
        .toFile(outPath);
      console.log(`✂️ 豆包 Q&A 长屏截图完成（策略B 滚动拼接：${tiles.length} 片 → ${acc}px）`);
    } catch (e) {
      // 2026-09-03 17:47 用户定：截图失败不整页/当前屏兜底，本轮无 Q&A 截图
      console.log(`豆包截图失败（按要求不整页兜底，本轮无 Q&A 截图）：${(e as Error).message}`);
    }
  }

  // 派生媒体平台名称：优先以 linkTitle 最后分隔符切出短后缀；否则回退 URL 域名
  private derivePlatform(title?: string, url?: string): string | undefined {
    if (title) {
      const idx = Math.max(title.lastIndexOf('—'), title.lastIndexOf('–'), title.lastIndexOf('-'));
      if (idx > 0 && idx < title.length - 1) {
        const suffix = title.slice(idx + 1).trim();
        if (suffix.length > 0 && suffix.length <= 10) return suffix;
      }
    }
    if (url) {
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch {
        /* ignore */
      }
    }
    return undefined;
  }
}
