// DeepSeek 平台适配器（**平台私有实现**，与豆包同构）。
// 2026-09-04 首次接入：登录制平台（台账 /admin 多账号），发问后文本流式输出。
// ⚠️ 选择器为候选起点：首轮运行的 finished.html / answering.html 是定标依据，
//    尤其「生成中→已结束」的明确标志（待从生成态样本中找，如输入区 send↔stop 切换）。
import { Page, BrowserContext } from 'playwright';
import fs from 'fs';
import sharp from 'sharp';
import { DEEPSEEK_CANDIDATE_SELECTORS } from './selectors.js';
import { firstFound } from '../../diagnostics/elementProbe.js';
import { CandidateSelectors, PlatformAdapter, ScreenshotMode, SourceInfo } from '../../types.js';
import {
  DEEPSEEK_INPUT_FOCUS_SETTLE,
  DEEPSEEK_INPUT_FOCUS_AFTER,
  DEEPSEEK_INPUT_PRE_TYPE,
  DEEPSEEK_INPUT_PRE_ENTER,
  randWaitMs,
} from '../../tuning/delays.js';

export class DeepseekAdapter implements PlatformAdapter {
  // 发送瞬间采集的整页文本基线（sendQuestion 末尾赋值；waitForAnswer 用作增长基准）
  private baselineTextLen: number | null = null;
  // 发送瞬间的回答动作行基线：回答动作按钮带独立 hash（如 db183363），多轮旧回答也有 → 基线计数
  private actionRowBaseline = 0;

  constructor(
    private page: Page,
    private context: BrowserContext,
    private selectors: CandidateSelectors
  ) {}

  // 统计可见的回答动作按钮数（2026-09-04 定标：答案完成后下方动作行按钮带独立 hash
  // db183363；引用角标 chip 是另一 hash _2090548，互不干扰。hash 由 CSS-module 生成，
  // 改版可能变化——失效时本判定自然不触发，回落「文本稳定 10s」主判定，不影响正确性）
  private async countActionRow(): Promise<number> {
    return this.page
      .evaluate(() => {
        return Array.from(
          document.querySelectorAll('[role="button"][class*="db183363"]')
        ).filter((b) => (b as HTMLElement).getBoundingClientRect().width > 0).length;
      })
      .catch(() => 0);
  }

  // 统计全页「非 deepseek 的外链」数量——用于判断「已阅读 N 个网页」抽屉是否真的展开
  // （展开后引用抽屉会多出带标题的外链条目；内联引用角标本就已是外链，故以「增量」判定）。
  private async countExternalAnchors(): Promise<number> {
    return this.page
      .evaluate(
        () =>
          Array.from(document.querySelectorAll('a[href^="http"]')).filter((a) =>
            !/deepseek\.com/.test(a.getAttribute('href') || '')
          ).length
      )
      .catch(() => 0);
  }

  // 「已阅读 N 个网页」整行头部坐标（class 含 _60aa7fb 的可点击 header 行；
  // 找不到就退回 chip 自身）。返回视口中心坐标，供仿人类鼠标点击。
  private async findSourceHeader(): Promise<{ x: number; y: number; text: string } | null> {
    return (await this.page
      .evaluate(`(() => {
        const all = Array.from(document.querySelectorAll('span, div, button, a'));
        const chip = all.find((s) => /已(阅读|搜索|浏览)\\s*\\d+\\s*个/.test((s.textContent || '').trim()));
        if (!chip) return null;
        let row = chip;
        while (row && row !== document.body) {
          const sig = (row.className || '') + ' ' + (row.getAttribute('role') || '');
          if (/(^|\\s)_60aa7fb(\\s|$)/.test(sig) || /role="button"/.test(sig)) break;
          row = row.parentElement;
        }
        const el = (row && row !== document.body) ? row : chip;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (chip.textContent || '').trim() };
      })()`)
      .catch(() => null)) as { x: number; y: number; text: string } | null;
  }

  // 登录墙检测（2026-09-08 修正）：
  //  ⚠️ 已登录页面的历史会话里可能残留含「登录」二字的文本（如用户消息「微信授权登录实现」），
  //    旧逻辑用 `a:has-text("登录")` 会把该历史会话 <a> 链接误判为登录入口 → 已登录被当成登录墙，
  //    导致 verifySession/openProbe 误报「登录态未持久化到磁盘」。
  //  改法：**正向判定已登录**——先检测聊天输入框（textarea / contenteditable）是否可见，
  //    存在即视为已登录；仅当确认无聊天界面时，才用窄化后的登录墙入口（仅 button，排除历史 <a>）兜底。
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
      'button:has-text("登录"), [class*="login-modal"], [class*="login-container"]'
    );
    if ((await loginEntry.count()) > 0) return true;
    return true; // 既无聊天输入框、也无登录墙入口 → 保守视为未登录
  }

  // 输入并发送：聚焦 → 打字 → 回车（DeepSeek 输入框回车即发）；回车无效时点发送按钮兜底。
  async sendQuestion(question: string): Promise<void> {
    const input = await firstFound(this.page, this.selectors.input);
    if (!input) throw new Error('ELEMENT_NOT_FOUND: input');

    await input.locator.click().catch(() => {});
    await this.page.waitForTimeout(randWaitMs(DEEPSEEK_INPUT_FOCUS_SETTLE));
    await input.locator.focus().catch(() => {});
    await this.page.waitForTimeout(randWaitMs(DEEPSEEK_INPUT_FOCUS_AFTER));

    await this.humanType(question);
    await this.page.waitForTimeout(randWaitMs(DEEPSEEK_INPUT_PRE_ENTER));

    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(800);

    // 兜底：输入框仍有文字 = 回车未生效 → 点发送按钮
    const stillThere = await this.page
      .evaluate(() => {
        const ta = document.querySelector('textarea#chat-input, #chat-input, textarea');
        return ta ? ((ta as HTMLTextAreaElement).value || ta.textContent || '').trim().length > 0 : false;
      })
      .catch(() => false);
    if (stillThere) {
      const btn = await firstFound(this.page, this.selectors.sendButton);
      if (btn) await btn.locator.click().catch(() => {});
      else await this.page.keyboard.press('Enter');
    }

    // ⚠️ 基线必须在发送瞬间采集：重复提问时 DeepSeek 秒出全量答案，若等到
    //    waitForAnswer 首次轮询才取基线，答案已在其中 → 增长判定永远为假（实测踩坑）。
    this.baselineTextLen = await this.page
      .evaluate(() => ((document.body && document.body.innerText) || '').length)
      .catch(() => null);
    this.actionRowBaseline = await this.countActionRow();
  }

  // 模拟真人逐字输入：单字录入，随机间隔 180–450ms；标点后断句长停顿；
  // 约 8% 概率随机「思考停顿」（与豆包同节奏，用户 2026-09-04 反馈 25ms/字过快）。
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

  // 等待流式回答输出完毕。
  // DeepSeek 无文字级「生成结束」标志（动作图标纯 SVG）——先用「文本连续 30s 无增长」
  // 兜底（生成态样本 answering.html 拿到后再定标明确标志，如输入区 send↔stop 切换）。
  async waitForAnswer(timeoutMs = 180000, midDumpPath?: string): Promise<void> {
    const start = Date.now();
    let midDumped = false;

    const getAnswerLen = async (): Promise<number | null> =>
      this.page
        .evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) return (el.textContent || '').length;
          // 兜底：整页文本长度做增长信号（回答流式输出时必然增长）
          const body = document.body;
          return body ? (body.innerText || '').length : null;
        }, this.selectors.answerContainer.join(', '))
        .catch(() => null);

    let lastLen: number | null = null;     // 最近一次采样长度
    let baselineLen: number | null = this.baselineTextLen; // 发送瞬间基线（不含答案）
    let everGrew = false;                  // 相对基线明显增长（答案确实流式输出过）
    let noGrowthStreak = 0;                // 连续无增长采样次数
    let lastProgressLog = Date.now();

    while (Date.now() - start < timeoutMs) {
      const len = await getAnswerLen();
      if (len !== null) {
        if (baselineLen === null) baselineLen = len;
        if (lastLen !== null && len > lastLen + 2) noGrowthStreak = 0;
        else if (lastLen !== null) noGrowthStreak += 1;
        if (len > baselineLen + 100) everGrew = true; // 相对页面壳明显增长
        lastLen = len;
      } else {
        noGrowthStreak += 1;
      }

      // —— 结束判定 ——
      // ⚠️ DeepSeek 无官方状态 class；「回答动作行（复制/点赞/点踩…）出现且文本稳定 3s」
      //    作为明确完成标志（2026-09-04 用户提议：与文心底下按钮同思路）。
      //    多轮旧回答也有动作行 → 基线计数；文本稳定条件防止动作行在流式中途挂载导致截断。
      const actBars = await this.countActionRow();
      if (actBars > this.actionRowBaseline && noGrowthStreak >= 3) {
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(1)}s] 检测到回答动作行（复制/点赞/点踩…）且文本稳定，回答已完成（当前 ${lastLen ?? 0} 字）`
        );
        break;
      }
      // ① 主判定：答案流式输出过（相对基线明显增长）+ 连续 10s 无新增 → 完成
      if (everGrew && noGrowthStreak >= 10) {
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(1)}s] 回答已流式输出并稳定 10s（峰值 ${lastLen ?? 0} 字）→ 完成`
        );
        break;
      }
      // ② 安全网：始终未明显增长（搜索/思考阶段无渲染、缓存式瞬时答案或卡死）→ 45s 无变化继续
      if (!everGrew && noGrowthStreak >= 45) {
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(1)}s] 45s 未见文本明显增长（可能仍在思考/被风控），按超时继续`
        );
        break;
      }

      if (Date.now() - lastProgressLog > 10000) {
        const grew = baselineLen !== null && len !== null ? Math.max(0, len - baselineLen) : 0;
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(1)}s] 检索/思考中…（容器 ${len === null ? '未出现' : len + ' 字'}，较基线 +${grew} 字）`
        );
        lastProgressLog = Date.now();
      }

      await this.page.waitForTimeout(1000);

      // 生成态 DOM 采样（约 6s 处，一次）：留作 DeepSeek DOM 迭代时的调试现场
      if (midDumpPath && !midDumped && Date.now() - start > 2500) {
        midDumped = true;
        try {
          fs.writeFileSync(midDumpPath, await this.page.content());
          console.log(`生成态 DOM 已落盘：${midDumpPath}`);
        } catch {
          /* ignore */
        }
      }
    }
    console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s] 回答输出完成，开始抽取`);
    await this.page.waitForTimeout(500);
  }

  // 抽取回答正文；主选择器落空 → 取最后一个 ≥50 字的 ds-markdown 块（回答在文档序末尾）。
  async getAnswer(): Promise<string | null> {
    const sel = this.selectors.answerContainer.join(', ');
    const primary = await this.page
      .evaluate((s) => {
        const el = document.querySelector(s);
        return el ? (el.textContent || '').trim() || null : null;
      }, sel)
      .catch(() => null);
    if (primary) return primary;
    return this.page
      .evaluate(() => {
        const blocks = Array.from(document.querySelectorAll('[class*="ds-markdown"]')) as HTMLElement[];
        for (let i = blocks.length - 1; i >= 0; i--) {
          const t = (blocks[i].textContent || '').trim();
          if (t.length >= 50) return t;
        }
        return null;
      })
      .catch(() => null);
  }

  // 展开信源（平台私有）：DeepSeek 信源收在回答下方的「已阅读 N 个网页」 chip 里，
  // 点开抽屉才有带标题的信源列表。受信任鼠标点击整行头部（仿人类：hover 停顿 → 按下 → 抬起）；
  // 点击后用「外链增量」验证是否真的展开，未展开则对整行派发原生 click 兜底（穿透事件委托）。
  async expandSources(): Promise<void> {
    const target = await this.findSourceHeader();
    if (!target) {
      console.log('DeepSeek 未找到「已阅读 N 个网页」信源入口，跳过展开');
      return;
    }
    const before = await this.countExternalAnchors();
    // ① 仿人类鼠标点击整行头部
    await this.page.mouse.move(target.x, target.y, { steps: 1 });
    await this.page.waitForTimeout(250 + Math.floor(Math.random() * 200));
    await this.page.mouse.down();
    await this.page.waitForTimeout(40 + Math.floor(Math.random() * 50));
    await this.page.mouse.up();
    await this.page.waitForTimeout(1500); // 等抽屉渲染
    let after = await this.countExternalAnchors();
    if (after <= before) {
      // ② 兜底：对整行头部直接派发原生 click（事件委托场景下鼠标坐标可能没命中处理器）
      await this.page
        .evaluate(`(() => {
          const all = Array.from(document.querySelectorAll('span, div, button, a'));
          const chip = all.find((s) => /已(阅读|搜索|浏览)\\s*\\d+\\s*个/.test((s.textContent || '').trim()));
          if (!chip) return;
          let row = chip;
          while (row && row !== document.body) {
            const sig = (row.className || '') + ' ' + (row.getAttribute('role') || '');
            if (/(^|\\s)_60aa7fb(\\s|$)/.test(sig) || /role="button"/.test(sig)) break;
            row = row.parentElement;
          }
          (row && row !== document.body ? row : chip).click();
        })()`)
        .catch(() => {});
      await this.page.waitForTimeout(1500);
      after = await this.countExternalAnchors();
    }
    console.log(
      `点击信源入口「${target.text}」：外链 ${before} → ${after}` +
        (after > before ? '（抽屉已展开，含标题）' : '（未检测到新增外链，可能本回答无独立信源抽屉）')
    );
  }

  // 抽取信源（平台私有）：DeepSeek 内联引用角标 <a class="ds-markdown-cite"> 的文本是
  // 不可见占位符（"-"或序号，不能当标题），但其 href 是真实文章 URL（带 #fragment 定位）。
  // 真标题在 expandSources 点开抽屉后的条目里（抽屉条目也是外链，带真实标题文本）。
  // 策略：扫描全页外链（含 data-url/data-href 兜底），按 URL 去 fragment 去重；内联引用角标
  // 只取自身文本（必为 junk→标题留空），抽屉条目允许上溯祖先取非空标题；优先保留有效标题版本。
  async getSources(captureDir?: string): Promise<SourceInfo[] | null> {
    // 定标辅助：展开信源抽屉后的 DOM 落盘（after-expand.html），用于精调抽屉条目结构
    if (captureDir) {
      try {
        const path = await import('path');
        fs.writeFileSync(path.join(captureDir, 'after-expand.html'), await this.page.content());
      } catch {
        /* ignore */
      }
    }
    const raw = (await this.page
      .evaluate(`(() => {
        const junk = (t) => !t || t.length < 3 || /^[-–—\\s\\d.#]+$/.test(t) || /^-\\d+$/.test(t);
        const clean = (u) => (u || '').split('#')[0];
        const byUrl = new Map();
        const pickUrl = (el) =>
          el.getAttribute('href') || el.getAttribute('data-url') || el.getAttribute('data-href') || '';
        const els = Array.from(
          document.querySelectorAll('a[href^="http"], [data-url^="http"], [data-href^="http"]')
        );
        for (const el of els) {
          const url0 = pickUrl(el);
          if (!/^https?:\\/\\//.test(url0) || /deepseek\\.com/.test(url0)) continue;
          const url = clean(url0);
          const isCite = /ds-markdown-cite/.test((el.className || '') + '');
          let t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          // 内联引用角标只取自身文本（必为占位符）；其余（抽屉条目）可上溯祖先取标题
          if (!isCite && junk(t)) {
            let p = el.parentElement;
            for (let k = 0; k < 4 && p; k++) {
              const pt = (p.textContent || '').replace(/\\s+/g, ' ').trim();
              if (!junk(pt) && pt.length < 160) { t = pt; break; }
              p = p.parentElement;
            }
          }
          const prev = byUrl.get(url);
          const title = junk(t) ? undefined : t;
          if (!prev || (junk(prev.title || '') && !junk(title || ''))) {
            byUrl.set(url, { title, url });
          }
        }
        return Array.from(byUrl.values());
      })()`)
      .catch(() => null)) as { title?: string; url: string }[] | null;
    if (!raw || !raw.length) return null;
    const titled = raw.filter((s) => s.title).length;
    console.log(`DeepSeek 信源抽取：${raw.length} 条（含标题 ${titled} 条）`);
    return raw.slice(0, 30).map((s) => ({
      title: s.title,
      url: s.url,
      platform: this.siteName(s.url),
    }));
  }

  // 长屏截图（**平台私有实现**）：DeepSeek 消息列表是虚拟列表（ds-virtual-list，
  // 行按需挂载），fullPage 拿不到完整内容 → 滚动分片拼接：定位滚动容器 →
  // 以「已覆盖内容量」推进 scrollTop（读回实际值，避免 scrollTop 钳制导致重复拍）→
  // sharp 纵向拼接。失败不整页/当前屏兜底（2026-09-03 用户定）。
  async captureQaScreenshot(outPath: string, _mode: ScreenshotMode = 'expand'): Promise<void> {
    const page = this.page;
    try {
      const pickInfo = (await page
        .evaluate(`(() => {
          const isScrollHost = (el) => {
            const cs = getComputedStyle(el);
            return /(auto|scroll|overlay)/.test(cs.overflowY) && el.clientHeight >= 100;
          };
          const msgs = Array.from(
            document.querySelectorAll(
              '[class*="ds-assistant-message"], [class*="ds-message"], [class*="ds-markdown"]'
            )
          );
          let pick = null;
          for (let i = msgs.length - 1; i >= 0 && !pick; i--) {
            let el = msgs[i].parentElement;
            while (el && el !== document.body) {
              if (isScrollHost(el) && el.getBoundingClientRect().width >= 400) { pick = el; break; }
              el = el.parentElement;
            }
          }
          let pickBy = 'from-message';
          if (!pick) {
            const cands = Array.from(
              document.querySelectorAll(
                '[class*="ds-virtual-list"], [class*="ds-scroll-area"], [class*="ds-scroll"]'
              )
            );
            const real = cands.filter(
              (el) => isScrollHost(el) && !/(gutter|bar|thumb)/i.test((el.className || '').toString())
            );
            const wide = real.filter((el) => el.getBoundingClientRect().width >= 400);
            pick =
              wide.find((el) => el.querySelector('[class*="ds-markdown"]')) ||
              wide[0] ||
              real[real.length - 1] ||
              null;
            pickBy = 'fallback';
          }
          document.querySelectorAll('[data-ds-scroller]').forEach((el) => el.removeAttribute('data-ds-scroller'));
          if (pick) {
            pick.setAttribute('data-ds-scroller', '1');
            const r = pick.getBoundingClientRect();
            return {
              ok: true, pickBy,
              cls: ((pick.className || '').toString()).slice(0, 90),
              x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
              sh: pick.scrollHeight, ch: pick.clientHeight,
              msgTotal: msgs.length,
            };
          }
          const lastMsg = msgs[msgs.length - 1];
          const chain = [];
          let el = lastMsg ? lastMsg.parentElement : null;
          let depth = 0;
          while (el && el !== document.body && depth < 15) {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            chain.push(
              'd' + depth + ' [' + ((el.className || '').toString()).slice(0, 60) + '] ovY=' + cs.overflowY +
              ' x=' + Math.round(r.x) + ' y=' + Math.round(r.y) + ' w=' + Math.round(r.width) +
              ' h=' + Math.round(r.height) + ' sh=' + el.scrollHeight + ' ch=' + el.clientHeight
            );
            el = el.parentElement; depth++;
          }
          return { ok: false, msgTotal: msgs.length, chain };
        })()`)
        .catch((e) => ({ ok: false, evalError: String(e) }))) as {
        ok: boolean;
        pickBy?: string;
        cls?: string;
        x?: number;
        y?: number;
        w?: number;
        h?: number;
        sh?: number;
        ch?: number;
        msgTotal?: number;
        chain?: string[];
        evalError?: string;
      };
      if (!pickInfo.ok) {
        console.log(
          `DeepSeek 截图跳过：未定位滚动容器（msgTotal=${pickInfo.msgTotal ?? '?'}）。` +
            (pickInfo.chain?.join(' | ') || pickInfo.evalError || '')
        );
        return;
      }
      console.log(
        `DeepSeek 问答滚动容器（${pickInfo.pickBy}）：[${pickInfo.cls}] x=${pickInfo.x} y=${pickInfo.y} w=${pickInfo.w} h=${pickInfo.h} sh=${pickInfo.sh} ch=${pickInfo.ch}`
      );
      const scroller = page.locator('[data-ds-scroller]').first();
      if (!(await scroller.count().catch(() => 0))) {
        console.log('DeepSeek 截图跳过：未定位到滚动容器（本轮无 Q&A 截图）');
        return;
      }
      const info = (await scroller.evaluate((el) => ({
        sh: el.scrollHeight,
        ch: el.clientHeight,
        vh: window.innerHeight,
      }))) as { sh: number; ch: number; vh: number };
      const box = await scroller.boundingBox().catch(() => null);
      if (!box || info.sh <= 0 || info.ch <= 10) {
        console.log(`DeepSeek 截图跳过：滚动区异常（sh=${info.sh} ch=${info.ch}）`);
        return;
      }
      const sliceH = Math.max(60, Math.min(info.ch, info.vh - Math.max(0, Math.round(box.y)) - 12));
      // 冻结动画，避免滚动/截图期间内容跳动
      await page
        .evaluate(() => {
          const st = document.createElement('style');
          st.textContent = '*{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
          document.head.appendChild(st);
        })
        .catch(() => {});
      // 输入框(composer)与消息滚动区在视口底部重叠，滚动拼接每片都会拍到它。
      // 拍摄期间把它 visibility:hidden（保留布局不回流），拍完还原。
      await page
        .evaluate(
          `(() => {
            const ta = document.querySelector('textarea');
            if (!ta) return;
            const vh = window.innerHeight;
            let composer = null;
            let el = ta.parentElement;
            while (el && el !== document.body) {
              const r = el.getBoundingClientRect();
              if (r.bottom > vh - 40 && r.height < 400 && r.top > 60) composer = el;
              el = el.parentElement;
            }
            if (composer) {
              composer.setAttribute('data-ds-prev-visibility', composer.style.visibility || '');
              composer.style.visibility = 'hidden';
            }
          })()`
        )
        .catch(() => {});
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
        const sh = Math.max(info.sh, st.sh); // 虚拟列表边滚边挂载，sh 可能增长
        const offset = Math.max(0, covered - st.top); // 被钳制时从可视框中部续拍
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
      // 还原输入框可见性
      await page
        .evaluate(
          `(() => {
            const el = document.querySelector('[data-ds-prev-visibility]');
            if (el) {
              el.style.visibility = el.getAttribute('data-ds-prev-visibility') || '';
              el.removeAttribute('data-ds-prev-visibility');
            }
          })()`
        )
        .catch(() => {});
      await scroller.evaluate((el, t) => { el.scrollTop = t; }, originTop).catch(() => {});
      await page
        .evaluate(() =>
          document.querySelectorAll('[data-ds-scroller]').forEach((el) => el.removeAttribute('data-ds-scroller'))
        )
        .catch(() => {});
      if (!tiles.length) {
        console.log('DeepSeek 截图跳过：未拍到任何分片（本轮无 Q&A 截图）');
        return;
      }
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
      console.log(`DeepSeek Q&A 长屏截图完成（滚动拼接：${tiles.length} 片 → ${acc}px）`);
    } catch (e) {
      console.log(`DeepSeek 截图失败（按要求不整页兜底）：${(e as Error).message}`);
    }
  }

  private siteName(url?: string): string {
    if (!url) return '';
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }
}
