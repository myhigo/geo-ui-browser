import { Page, BrowserContext } from 'playwright';
import fs from 'fs';
import { WENXIN_CANDIDATE_SELECTORS } from './selectors.js';
import { firstFound } from '../../diagnostics/elementProbe.js';
import { humanDelay } from '../../diagnostics/human.js';
import { CandidateSelectors, PlatformAdapter, ScreenshotMode, SourceInfo } from '../../types.js';
import {
  WENXIN_AD_AFTER,
  WENXIN_AD_DETECT_PAUSE,
  WENXIN_AD_ESC_RECHECK,
  WENXIN_AD_HOLD,
  WENXIN_AD_MOVE_DOWN,
  WENXIN_INPUT_FOCUS_AFTER,
  WENXIN_INPUT_FOCUS_SETTLE,
  WENXIN_INPUT_PRE_ENTER,
  WENXIN_INPUT_PRE_TYPE,
  randWaitMs,
} from '../../tuning/delays.js';

// 文心适配器（V1 诊断用）。交互逻辑为文心**独立实现**（不引用豆包/千问任何代码）；
// 真实 DOM 尚未探明时第一批 selector 为通用聊天 UI 的合理猜测，待首次抓回 before.html 后精确锁定。
// 文心输入区多为 textarea（与豆包的 Tiptap contenteditable 不同），故聚焦/输入逻辑以 textarea 优先。
// ⚠️ 遵循"平台操作全部私有"原则：即使与别家写法相似，也禁止抽成共享基类/通用函数，各自独立演进。
export class WenxinAdapter implements PlatformAdapter {
  constructor(
    private page: Page,
    private context: BrowserContext,
    private selectors: CandidateSelectors = WENXIN_CANDIDATE_SELECTORS
  ) {}

  // 判断是否出现登录墙：无输入框 / 出现登录入口 → 需登录
  async checkLogin(): Promise<boolean> {
    const input = await firstFound(this.page, this.selectors.input);
    if (input) return false; // 有输入框 → 匿名可用
    const loginBtn = this.page.locator('a:has-text("登录"), button:has-text("登录")');
    if ((await loginBtn.count()) > 0) return true;
    return true; // 兜底：没输入框就没法问答
  }

  // 关闭文心首页干扰弹层（如「全新上线任务模式」引导弹窗）。
  // 真实 DOM 定标（2026-09-02 before.html）：百度 cos-dialog 组件，结构为
  //   <div class="cos-dialog _task-mode-guide-dialog_k91ea_1">
  //     <div class="cos-dialog-mask"></div>
  //     <div class="cos-dialog-container">
  //       <div class="cos-dialog-header">
  //         <div class="cos-dialog-title">全新上线任务模式</div>
  //         <div name="close" class="cos-dialog-close"><i class="cos-icon cos-icon-close"></i></div>
  //       </div> … </div></div>
  // ⚠️ 类名含构建哈希（_task-mode-guide-dialog_k91ea_1），哈希随发版变化 → 只用语义前缀
  //    `[class*="task-mode-guide-dialog"]` 定位，绝不全类名硬编码。
  // ⚠️ 与千问 dismissAds 同构但独立实现（平台操作私有，不抽共享基类）。
  async dismissAds(): Promise<boolean> {
    // 形态 A：「任务模式引导」弹窗（语义前缀定位）
    if (await this.closeDialogBy('[class*="task-mode-guide-dialog"] .cos-dialog-close', '任务模式引导弹窗')) {
      return true;
    }
    // 形态 B：其它百度 cos-dialog 弹层兜底（取可见的第一个）
    if (await this.closeDialogBy('.cos-dialog .cos-dialog-close', 'cos-dialog 弹层')) {
      return true;
    }
    return false;
  }

  // 用「受信任鼠标」点击弹窗关闭钮并确认其消失：
  //   - 点击前先停顿（真人看见弹窗不会瞬关），与千问同构；
  //   - steps:1 直接落点，避免横跨页面滑移途经 hover 元素触发整页"闪"；
  //   - 关掉后等 detached 确认真的关了；未消失再按 Esc 兜底。
  private async closeDialogBy(closeSel: string, label: string): Promise<boolean> {
    const btn = this.page.locator(closeSel).first();
    if ((await btn.count().catch(() => 0)) === 0) return false;
    if (!(await btn.isVisible().catch(() => false))) return false;

    console.log(`🛡️ 检测到文心${label}，稍作停顿后仿人类点击关闭…`);
    await humanDelay(...WENXIN_AD_DETECT_PAUSE);
    const box = await btn.boundingBox().catch(() => null);
    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await this.page.mouse.move(cx, cy, { steps: 1 });
      await humanDelay(...WENXIN_AD_MOVE_DOWN);
      await this.page.mouse.down();
      await humanDelay(...WENXIN_AD_HOLD);
      await this.page.mouse.up();
      await humanDelay(...WENXIN_AD_AFTER);
    } else {
      await btn.click().catch(() => {}); // 拿不到坐标才退回普通点击
    }

    const gone = await this.page
      .locator(closeSel)
      .first()
      .waitFor({ state: 'detached', timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (gone) {
      console.log(`✅ 文心${label}已关闭`);
      return true;
    }

    // Esc 兜底（部分 dialog 支持键盘关闭）
    await this.page.keyboard.press('Escape').catch(() => {});
    await humanDelay(...WENXIN_AD_ESC_RECHECK);
    const still = await this.page
      .locator(closeSel)
      .first()
      .isVisible()
      .catch(() => false);
    if (!still) {
      console.log(`✅ 文心${label}已关闭（Esc 兜底）`);
      return true;
    }
    console.log(`⚠️ 文心${label}关闭钮已点，弹窗仍未消失（不影响后续，继续诊断）`);
    return false;
  }

  // 输入并发送问题。聚焦可编辑区 → 逐字真人打字 → Enter 主发送键 → 圆钮/发送钮兜底 → 校验是否真发出。
  async sendQuestion(question: string): Promise<void> {
    const input = await firstFound(this.page, this.selectors.input);
    if (!input) throw new Error('ELEMENT_NOT_FOUND: input');

    const t0 = Date.now();
    const sec = (t: number) => `${((t - t0) / 1000).toFixed(1)}s`;

    // 聚焦可编辑区：先点击，再用 .focus() 强制兜底（避免点击被拦截导致失焦）
    await input.locator.click().catch(() => {});
    await this.page.waitForTimeout(randWaitMs(WENXIN_INPUT_FOCUS_SETTLE));
    await input.locator.focus().catch(() => {});
    await this.page.waitForTimeout(randWaitMs(WENXIN_INPUT_FOCUS_AFTER));

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
      await ta.click().catch(() => {});
      await ta.focus().catch(() => {});
    }

    // 逐字真人打字（先确保已聚焦，否则重聚焦再打）
    if (!(await focusedEditable())) {
      await input.locator.focus().catch(() => {});
    }
    // 打字前随机停顿 500–2000ms（模拟真人准备输入，避免一加载完就立刻打字）
    await this.page.waitForTimeout(randWaitMs(WENXIN_INPUT_PRE_TYPE));
    console.log(`[${sec(Date.now())}] ⌨️ 开始逐字输入`);
    await this.humanType(question);
    console.log(`[${sec(Date.now())}] ⌨️ 输入完成`);

    // 校验问题文本是否真的进入输入框（contenteditable 或 textarea 任一含即可）。
    // ⚠️ 必须用单个 page.evaluate 一次读完，绝不能用 locator.innerText()/inputValue()：
    // 文心页面没有 [contenteditable="true"] 元素，locator 会默认等 30s 超时才抛错（实测两处各卡 30s）。
    const enteredText = async (): Promise<string> =>
      this.page
        .evaluate(() => {
          const ce = document.querySelector('[contenteditable="true"]');
          const ta = document.querySelector('textarea');
          return ((ce && ce.textContent) || '') + ((ta && (ta as HTMLTextAreaElement).value) || '');
        })
        .catch(() => '');
    const probe = question.slice(0, Math.max(1, Math.floor(question.length / 2)));
    if (!(await enteredText()).includes(probe)) {
      console.warn('⚠️ 输入校验失败：问题文本未进入输入框，请人工检查（见 02-question.png）');
    }

    // 是否真的发出去：输入框是否已被清空（不再含原问题）
    const isSent = async (): Promise<boolean> => !(await enteredText()).includes(probe);
    // 发送后轮询确认输入框清空（慢代理/带宽下页面清空有延迟），最多等 15s，避免一次性检查误报
    const waitSent = async (): Promise<boolean> => {
      const deadline = Date.now() + 15000;
      for (;;) {
        if (await isSent()) return true;
        if (Date.now() >= deadline) return false;
        await this.page.waitForTimeout(500);
      }
    };

    // 1) 优先 Enter（贴合用户习惯）。发送前随机停顿 500–1000ms（模拟真人检查后发送）
    await this.page.waitForTimeout(randWaitMs(WENXIN_INPUT_PRE_ENTER));
    console.log(`[${sec(Date.now())}] ⏎ 按 Enter 发送`);
    await this.page.keyboard.press('Enter');
    if (await waitSent()) {
      console.log(`[${sec(Date.now())}] ✅ 发送已确认（输入框已清空）`);
      return;
    }

    // 2) 兜底：点发送钮候选
    const send = await firstFound(this.page, this.selectors.sendButton);
    if (send) await send.locator.click().catch(() => {});
    if (await waitSent()) {
      console.log(`[${sec(Date.now())}] ✅ 发送已确认（点发送钮兜底成功）`);
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
  // ⚠️ 不能用「整页 - 所有 textarea - 所有 contenteditable」：文心把回答渲染在
  // contenteditable/富文本容器里，减法会把回答文本一并减掉 → 相对基线永不增长 →
  // 误判"回答未开始"(60s 报警) + 稳定等待永不提前结束(空转到超时)。
  // 正确做法：基线在「发送后」采集（此时输入框已被清空），直接用 body.innerText.length，
  // 输入框文本是常量，不会污染增量判断。
  private async getPageTextLen(): Promise<number> {
    return this.page.evaluate(() => document.body.innerText.length).catch(() => 0);
  }

  // 等待流式回答完整输出（关键，稳定窗口 30s 硬下限为 用户要求）：
  // ⚠️ 生长信号不用 body.innerText（活页面上不可靠，曾空等 180s）。
  // 也用「精确的回答容器」而不用宽泛的 [class*="content-area"] 等——后者命中整页大容器，
  // 基线直接几千字，监控失真。文心发送后才会创建 .chat-search-answer-generate（核心回答，
  // 含参考列表+正文，从 0 随流式增长）与 .answer-box。
  // 所有采样用 page.evaluate（零 Playwright 自动等待，杜绝 locator 隐式 30s 超时）。
  // 等待流式回答完整输出。
  // ⚠️ 全元素驱动，不用固定分段时间（换问题页面会变）：单一循环轮询「回答容器文本 + 结束信号」。
  //   - 生长确认：回答容器文本出现并增长（容器选择器平台相关，见 growthSel）；
  //   - 结束信号：加载胶囊 [class*="capsule-loading"] 消失 或 [class*="answer-finished"] 出现，
  //     信号连续 3 次采样（≈3s）且见过增长 → 判定完成；
  //   - 无信号平台（页面没有胶囊/完成态元素，如豆包）→ 退回「容器文本连续 30 次采样无增长」兜底；
  //   - timeoutMs 仅作整体硬上限防失控。
  // 等待流式回答完整输出（全元素驱动，无固定分段时间）。
  // 完成判定的「明确元素」= 回答容器（.chat-search-answer-generate/.answer-box）自身文本：
  //   - 流式阶段：容器文本持续生长（everGrew 计数）→ 确证"正在输出"；
  //   - 完成：曾明显生长 + 流式胶囊已消失 + 连续 ~6s 无新增 → 判定完成（不再空等 30s）。
  // 兜底：若文本始终未增长（检索/风控/未返回），连续 30s 无变化才判定完成（用户认可的安全兜底）。
  // ⚠️ 不再依赖 [class*="answer-finished"]：实测该 class 仅存在于 CSS 定义，未挂到任何真实元素，
  //    不可作运行时完成信号（这正是此前总走 30s 兜底的根因）。
  async waitForAnswer(timeoutMs = 180000): Promise<void> {
    const start = Date.now();

    const growthSel = '.chat-search-answer-generate, .answer-box';
    const getAnswerLen = async (): Promise<number | null> =>
      this.page
        .evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? (el.textContent || '').length : null;
        }, growthSel)
        .catch(() => null);

    // 流式指示：加载胶囊「存在 + 有布局尺寸 + 非隐藏」才算可见（仅作辅助确认，非主判定）。
    const isStreaming = (): Promise<boolean> =>
      this.page
        .evaluate(() => {
          const cap = document.querySelector('[class*="capsule-loading"]');
          if (!cap) return false;
          const r = (cap as HTMLElement).getBoundingClientRect();
          const cs = getComputedStyle(cap);
          return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
        })
        .catch(() => false);

    let lastLen: number | null = null; // 最近一次容器文本长度
    let everGrew = 0;                  // 见过文本增长（>=2 次确证确实在流式输出）
    let noGrowthStreak = 0;            // 连续无增长采样次数
    let lastProgressLog = Date.now();

    // 「回答已完成」标志（2026-09-04 用户提议，与豆包同思路）：回答完成后动作栏才出现，
    // 复制图标用语义稳定的 `cos-icon cos-icon-copy`。多轮对话旧回答也有动作栏 →
    // 基线计数：发送前数一遍，可见数量超过基线 = 本轮新回答完成。
    const countActionBar = async (): Promise<number> =>
      this.page
        .evaluate(() => {
          return Array.from(document.querySelectorAll('[class*="cos-icon-copy"]')).filter(
            (b) => (b as HTMLElement).getBoundingClientRect().width > 0
          ).length;
        })
        .catch(() => 0);
    const actionBaseline = await countActionBar();

    while (Date.now() - start < timeoutMs) {
      const len = await getAnswerLen();
      const streaming = await isStreaming();

      // 文本增长统计（元素驱动，核心完成信号）
      if (len !== null) {
        if (lastLen === null) lastLen = len;
        else if (len > lastLen + 2) {
          lastLen = len;
          everGrew += 1;
          noGrowthStreak = 0;
        } else {
          noGrowthStreak += 1;
        }
      } else {
        noGrowthStreak += 1;
      }

      // —— 结束判定 ⓪ 动作栏出现 = 明确完成（优先级最高，用户 2026-09-04 提议）——
      const bars = await countActionBar();
      if (bars > actionBaseline) {
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(0)}s] 🏁 检测到回答动作栏（复制/朗读/…），回答已完成（当前 ${lastLen ?? 0} 字）`
        );
        break;
      }

      // —— 结束判定 ——
      // ① 主判定（明确元素驱动）：文本曾明显生长 + 流式胶囊已消失 + 连续 6s 无新增 → 完成
      if (everGrew >= 2 && !streaming && noGrowthStreak >= 6) {
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(0)}s] 🏁 回答文本已稳定（峰值 ${lastLen ?? 0} 字，胶囊消失，连续 6s 无新增）→ 完成`
        );
        break;
      }
      // ③ 安全网：文本已生长但胶囊异常长期不消失 → 连续 20s 无新增强制结束（防胶囊卡死导致空等超时）
      if (everGrew >= 2 && noGrowthStreak >= 20) {
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(0)}s] 🏁 文本已稳定 20s（胶囊状态异常但内容无变化）→ 完成`
        );
        break;
      }
      // ② 兜底（无增长信号：可能检索/风控/未返回）：连续 30s 无变化
      if (everGrew === 0 && noGrowthStreak >= 30) {
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(0)}s] 🏁 未见文本增长，连续 30s 无变化（兜底）→ 完成`
        );
        break;
      }

      // —— 进度日志 ——
      if (Date.now() - lastProgressLog > 10000) {
        const phase = streaming ? '📝 回答流式输出中…' : everGrew >= 2 ? '⏳ 收尾中…' : '⏳ 检索/思考中…';
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(0)}s] ${phase}（容器 ${len === null ? '未出现' : len + ' 字'}）`
        );
        lastProgressLog = Date.now();
      }

      await this.page.waitForTimeout(1000);
    }
    console.log(`[${((Date.now() - start) / 1000).toFixed(0)}s] ✅ 回答输出完成，开始抽取`);
    await this.page.waitForTimeout(800); // 收尾缓冲，确保末字渲染完整
  }

  // 抽取回答正文；定位不到 → null。
  // ⚠️ 用 page.evaluate 一次读 textContent，绝不用 locator.innerText()（live 页面上
  // locator 有 actionability 等待，抽取流程会卡很久）。
  // 只取「回答正文」：克隆容器后剔除信源列表 / 商品卡 / 继续问推荐 / 思考步骤 / 反馈按钮等
  // 噪音块，保留 .marklang-paragraph 等正文段落，避免 answerText 被信源标题+商品卡+追问污染。
  // 2026-09-02 补：回答容器 live 时刻混有百度注入的 <script>（广告/推荐数据 JSON，约 3 万字符）
  // 会整体进入 textContent → 剔除清单加上 script/style 等非渲染标签。
  async getAnswer(): Promise<string | null> {
    const sel = '.chat-search-answer-generate, .answer-box';
    return this.page
      .evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const clone = el.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll(
            'script, style, noscript, template, iframe, [class*="reference-list"], [class*="reference-item"], [class*="shop-list"], [class*="shop-card"], [class*="question-closely"], [class*="thinking"], [class*="capsule"], [class*="footer"], [class*="feedback"]'
          )
          .forEach((n) => n.remove());
        const txt = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        return txt || null;
      }, sel)
      .catch(() => null);
  }

  // 展开信源：只对带「展开/查看来源/查看引用/信源」文案的按钮点击（最多 5 个），
  // 用 evaluate 派发 click，零自动等待。
  // ⚠️ 绝不能再对所有 [class*="reference"] 元素逐个 locator.click()——live 页面上
  // 每个 click 等 actionability（默认最长 30s），几十个元素会让抽取流程卡死数分钟。
  async expandSources(): Promise<void> {
    await this.page
      .evaluate(() => {
        const btns = Array.from(
          document.querySelectorAll('button, [role="button"], [class*="expand"]')
        ).filter((b) => /展开|查看来源|查看引用|查看信源|信源/.test(b.textContent || ''));
        btns.slice(0, 5).forEach((b) => (b as HTMLElement).click());
      })
      .catch(() => {});
    await this.page.waitForTimeout(500);
  }

  // 抽取信源列表。文心信源不在 <a href> 里，而是写在每个 reference-item 的
  // data-long-press-ext-info JSON（link / linkTitle 字段）；可见标题在 _text_... span。
  // 媒体平台名称：文心数据无独立字段，从 linkTitle 以最后的分隔符（—/–/-）切出后缀，
  // 或回退为 URL 域名。单次 evaluate 读完所有项，零 locator 逐项等待。
  async getSources(): Promise<SourceInfo[] | null> {
    const raw = await this.page
      .evaluate(() => {
        const items = Array.from(document.querySelectorAll('[class*="reference-item"]'));
        if (items.length === 0) return null;
        const out: { title?: string; url?: string }[] = [];
        for (const it of items) {
          let url: string | undefined;
          let title: string | undefined;
          const attr = it.getAttribute('data-long-press-ext-info');
          if (attr) {
            try {
              const o = JSON.parse(attr);
              url = o.link || undefined;
              title = o.linkTitle || undefined;
            } catch {
              /* JSON 解析失败则走文本兜底 */
            }
          }
          if (!title) {
            const t = it.querySelector('[class*="_text_"]');
            title = (t && t.textContent ? t.textContent.trim() : '') || undefined;
          }
          if (!url) {
            const a = it.querySelector('a');
            url = (a && a.getAttribute('href')) || undefined;
          }
          out.push({ title, url });
        }
        return out;
      })
      .catch(() => null);
    if (!raw || raw.length === 0) return null;
    return raw.map((s) => ({ title: s.title, url: s.url, platform: this.derivePlatform(s.title, s.url) }));
  }

  // 派生媒体平台名称：优先以 linkTitle 最后分隔符（— / – / -）切出短后缀；否则回退 URL 域名
  private derivePlatform(title?: string, url?: string): string | undefined {
    if (title) {
      const idx = Math.max(title.lastIndexOf('—'), title.lastIndexOf('–'), title.lastIndexOf('-'));
      if (idx > 0 && idx < title.length - 1) {
        const suffix = title.slice(idx + 1).trim();
        // 后缀偏短（≤10 字）更可能是平台名而非标题的一部分
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

  // 长屏截图（**平台私有实现**；2026-08-31 从共享的 run.ts 下沉到 Adapter）。
  //
  // ⚠️ 为什么下沉：截图逻辑必然引用平台专属元素名（气泡/内容根/容器），放在共享层就是
  //    "假的通用"。此处所有锚点都来自 this.selectors（文心私有配置），本方法只对文心负责。
  //
  // 策略 A（expand，默认，2026-08-31 跑通）：
  //   ① 展开所有「有界且内容溢出」的祖先容器（height=scrollHeight + overflow:visible，迭代到稳定）
  //      —— 文心聊天内容在多层滚动容器里，document 只有一屏高，不展开就不是长截图；
  //   ② 「问题元素 → qa 容器」祖先链上 fixed/absolute 改 relative（**非 static**）
  //      —— fixed 在超视口截图里被焊死在画布顶部脱离 qa box；static 又会废掉气泡内部
  //         absolute 背景层的包含块，导致背景塌陷、只剩白字白底（13-43-53 踩过）；
  //   ③ 隐藏非 qa 后代的 fixed/absolute/sticky 浮层 + qa 后代干扰浮层（问题元素子树豁免）
  //      —— locator.screenshot 是 region-based，会截到覆盖在 qa box 上的外部浮层；
  //   ④ 清除渲染抑制属性（mask-image / clip-path / content-visibility / contain / opacity:0 /
  //      visibility:hidden）—— 容器撑高后这些"滚动优化"技巧会错位，把顶部内容罩透明/裁掉/跳过渲染；
  //   ⑤ 清 selection（去高亮 + selection 触发的 AI 工具条）；
  //   ⑥ locator.screenshot() 元素级截图，边界 = qa 容器本身（问题开始 → 回答结束）。
  // 策略 B（stitch）：⚠️ 尚未实现，传入时回退 A 并打印警告。
  async captureQaScreenshot(outPath: string, mode: ScreenshotMode = 'expand'): Promise<void> {
    if (mode === 'stitch') {
      // TODO(策略B)：页面原样不动 + 滚动容器 scrollTop 步进 + 每段普通视口截图 + sharp 纵向拼接。
      // ⚠️ fixed 元素（顶部导航/输入框）会逐段重复出现，拼接前需按段裁剪。
      console.log('⚠️ 文心策略 B（滚动分段拼接）尚未实现，本次回退到策略 A（expand）');
    }
    const page = this.page;
    const qaSel =
      this.selectors.qaBlock && this.selectors.qaBlock.length
        ? this.selectors.qaBlock.join(', ')
        : '.chat-qa-container';
    const rootSel =
      this.selectors.expandRoot && this.selectors.expandRoot.length
        ? this.selectors.expandRoot.join(', ')
        : '';
    const qSel =
      this.selectors.questionBlock && this.selectors.questionBlock.length
        ? this.selectors.questionBlock.join(', ')
        : '';

    // ①②③④⑤ 全部在一个 evaluate 内完成（避免多次 CDP 往返之间页面自行纠偏）
    // ⚠️ evaluate 内一律内联，禁止具名/变量赋值函数（esbuild keepNames 注入 __name → 页面报错）
    await page
      .evaluate((args: { sel: string; root: string; qsel: string }) => {
        const { sel, root, qsel } = args;
        const st = document.createElement('style');
        st.textContent = '*{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
        document.head.appendChild(st);

        // ① 从内容根往上逐层撑开所有「有界且内容溢出」的容器（迭代到稳定）
        const rootEl = (root ? document.querySelector(root) : null) || document.querySelector(sel);
        if (rootEl) {
          let guard = 0;
          let changed = true;
          while (changed && guard++ < 40) {
            changed = false;
            let n: HTMLElement | null = rootEl as HTMLElement;
            while (n && n !== document.documentElement) {
              const h = n as HTMLElement;
              if (h.scrollHeight > h.clientHeight + 1) {
                const sh = h.scrollHeight;
                h.style.height = sh + 'px';
                h.style.overflow = 'visible';
                h.style.maxHeight = 'none';
                changed = true;
              }
              n = n.parentElement;
            }
          }
        }

        const qa = document.querySelector(sel) as HTMLElement | null;

        if (qa) {
          // ② 问题元素 → qa 容器 之间祖先链：fixed/absolute 改 relative（保留包含块 + 清偏移）
          const bubEl = qsel ? qa.querySelector(qsel) : null;
          if (bubEl) {
            let n: HTMLElement | null = bubEl as HTMLElement;
            while (n && n !== qa) {
              const cs = getComputedStyle(n);
              if (cs.position === 'fixed' || cs.position === 'absolute') {
                n.style.position = 'relative';
                n.style.top = 'auto';
                n.style.left = 'auto';
                n.style.right = 'auto';
                n.style.bottom = 'auto';
              }
              n = n.parentElement;
            }
          }
          // ③ 非 qa 后代的 fixed/absolute/sticky 浮层全隐藏（region-based 截图会截到它们）
          document.querySelectorAll('*').forEach((el) => {
            if (qa.contains(el)) return;
            const cs = getComputedStyle(el as HTMLElement);
            if (cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky') {
              (el as HTMLElement).style.display = 'none';
            }
          });
          //    qa 后代的干扰浮层也隐藏，但**问题元素内部整棵子树豁免**（背景层常是 absolute）
          const bubInner = qsel ? qa.querySelector(qsel) : null;
          qa.querySelectorAll('*').forEach((el) => {
            const cs = getComputedStyle(el as HTMLElement);
            if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
            if (bubInner && bubInner.contains(el)) return;
            (el as HTMLElement).style.display = 'none';
          });
        }

        // ④ 清除渲染抑制属性（容器撑高后这些"滚动优化"技巧会错位/卡死）
        document.querySelectorAll('*').forEach((el) => {
          const cs = getComputedStyle(el as HTMLElement);
          if ((cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none')) {
            (el as HTMLElement).style.setProperty('mask-image', 'none', 'important');
            (el as HTMLElement).style.setProperty('-webkit-mask-image', 'none', 'important');
          }
          if (cs.clipPath && cs.clipPath !== 'none') {
            (el as HTMLElement).style.setProperty('clip-path', 'none', 'important');
            (el as HTMLElement).style.setProperty('-webkit-clip-path', 'none', 'important');
          }
          if (cs.contentVisibility && cs.contentVisibility !== 'visible') {
            (el as HTMLElement).style.setProperty('content-visibility', 'visible', 'important');
          }
          if (cs.contain && cs.contain !== 'none') {
            (el as HTMLElement).style.setProperty('contain', 'none', 'important');
          }
          if (cs.opacity === '0') {
            (el as HTMLElement).style.setProperty('opacity', '1', 'important');
          }
          if (cs.visibility === 'hidden') {
            (el as HTMLElement).style.setProperty('visibility', 'visible', 'important');
          }
        });

        // ⑤ 清文本选中
        const selObj = window.getSelection();
        if (selObj) selObj.removeAllRanges();

        window.scrollTo(0, 0);
      }, { sel: qaSel, root: rootSel, qsel: qSel })
      .catch(() => {});
    await page.waitForTimeout(300);

    const qaLocator = page.locator(qaSel).last();
    const qaCount = await qaLocator.count().catch(() => 0);
    if (qaCount === 0) throw new Error('Q&A 块未定位到（qaBlock 候选均不匹配）');

    // —— 诊断三件套（平台私有，按用户要求在本方法内打印）——
    const diag = await page
      .evaluate((args: { sel: string; qsel: string }) => {
        const { sel, qsel } = args;
        const qa = document.querySelector(sel);
        const bub = qsel ? document.querySelector(qsel) : null;
        const r1 = qa ? qa.getBoundingClientRect() : null;
        const r2 = bub ? bub.getBoundingClientRect() : null;
        return {
          qaTop: r1 ? Math.round(r1.top) : null,
          qaH: r1 ? Math.round(r1.height) : null,
          bubTop: r2 ? Math.round(r2.top) : null,
          bubH: r2 ? Math.round(r2.height) : null,
          bubInQa: r1 && r2 ? r2.top >= r1.top && r2.bottom <= r1.bottom : null,
          bubPos: bub ? getComputedStyle(bub).position : null,
        };
      }, { sel: qaSel, qsel: qSel })
      .catch(() => null);
    console.log('📐 qa box / 问题气泡诊断:', JSON.stringify(diag));

    const maskDiag = await page
      .evaluate((sel) => {
        const out: string[] = [];
        let el = document.querySelector(sel) as HTMLElement | null;
        while (el) {
          const cs = getComputedStyle(el);
          const m = cs.maskImage || cs.webkitMaskImage;
          if (m && m !== 'none') out.push(((el.className || '').toString().slice(0, 40)) + ' -> ' + m.slice(0, 40));
          el = el.parentElement;
        }
        return out;
      }, qaSel)
      .catch(() => []);
    console.log('🎭 mask 诊断（qa 祖先链，应为空）:', JSON.stringify(maskDiag));

    const bubSnap = await page
      .evaluate((qsel) => {
        const rows: Record<string, string>[] = [];
        let el = qsel ? (document.querySelector(qsel) as HTMLElement | null) : null;
        while (el) {
          const cs = getComputedStyle(el);
          rows.push({
            el: el.tagName + '.' + ((el.className || '').toString().trim().slice(0, 30)),
            pos: cs.position, disp: cs.display, vis: cs.visibility, op: cs.opacity,
            clip: cs.clipPath.slice(0, 24), cv: cs.contentVisibility, contain: cs.contain,
            tr: cs.transform.slice(0, 24), filter: cs.filter.slice(0, 20), z: cs.zIndex,
          });
          el = el.parentElement;
        }
        return rows;
      }, qSel)
      .catch(() => []);
    console.log('🔬 气泡渲染快照（气泡→根）:', JSON.stringify(bubSnap));

    // ⑥ 元素级截图：边界 = qa 容器本身，Playwright 自己处理高于视口的滚动/拼接
    await qaLocator.screenshot({ path: outPath, animations: 'disabled', timeout: 60000 });
    const sz = fs.statSync(outPath).size;
    console.log(`✂️ Q&A 长屏截图完成（文心·策略A：边界=chat-qa-container，问题→回答结束，${sz} bytes）`);
  }

}
