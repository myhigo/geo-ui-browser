import { Page, BrowserContext, Frame } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { QIANWEN_CANDIDATE_SELECTORS } from './selectors.js';
import { firstFound } from '../../diagnostics/elementProbe.js';
import { humanClick, humanDrag, humanDelay } from '../../diagnostics/human.js';
import { CandidateSelectors, PlatformAdapter, SourceInfo, ScreenshotMode } from '../../types.js';
import {
  QIANWEN_AD_A_AFTER,
  QIANWEN_AD_A_DETECT_PAUSE,
  QIANWEN_AD_A_HOLD,
  QIANWEN_AD_A_MOVE_DOWN,
  QIANWEN_AD_B_AFTER,
  QIANWEN_AD_B_HOLD,
  QIANWEN_AD_B_MOVE_DOWN,
  QIANWEN_AD_B_POST_HOVER,
  QIANWEN_AD_B_PRE_HOVER,
  QIANWEN_CAPTCHA_DETECT_PAUSE,
  QIANWEN_CAPTCHA_FIRST_PREWAIT,
  QIANWEN_CAPTCHA_MANUAL_DOWN,
  QIANWEN_CAPTCHA_MANUAL_HOLD,
  QIANWEN_CAPTCHA_REFRESH_DOWN,
  QIANWEN_CAPTCHA_REFRESH_HOLD,
  QIANWEN_CAPTCHA_RETRY_PREWAIT,
  QIANWEN_INPUT_FOCUS_AFTER,
  QIANWEN_INPUT_FOCUS_SETTLE,
  QIANWEN_INPUT_PRE_ENTER,
  QIANWEN_INPUT_PRE_TYPE,
  randWaitMs,
} from '../../tuning/delays.js';

// 千问适配器（V1 诊断用，2026-08-31 初版）。用户确认千问**无需登录**即匿名可用。
// 交互逻辑为千问**独立实现**（聚焦可编辑区 → 逐字真人打字 → Enter/点发送兜底），
// 虽与豆包写法相似，但互不引用、可独立演进——即使重复也优于"假通用"。
// 平台差异全部收敛在 selectors.ts；待诊断跑到真实 DOM 后再据此定标。
// ⚠️ 遵循"平台操作全部私有"原则：禁止抽成共享基类/通用函数。
export class QianwenAdapter implements PlatformAdapter {
  constructor(
    private page: Page,
    private context: BrowserContext,
    private selectors: CandidateSelectors = QIANWEN_CANDIDATE_SELECTORS
  ) {}

  // 千问匿名可用（用户确认无需登录）。判定：有输入框 → 匿名可用；否则看有无登录入口。
  // ⚠️ 注意：千问首屏若落在「未进入对话」的壳页（仅有登录入口、暂无输入框），会误判为需登录——
  //   这属于 defaultUrl/进入对话的导航问题，不是真登录墙；诊断后据 before.html 调整。
  async checkLogin(): Promise<boolean> {
    const input = await firstFound(this.page, this.selectors.input);
    if (input) return false; // 有输入框 → 匿名可用
    const loginBtn = this.page.locator('a:has-text("登录"), button:has-text("登录")');
    if ((await loginBtn.count()) > 0) return true;
    return true; // 兜底：没输入框就没法问答
  }

  // 输入并发送问题。先聚焦可编辑区（点击 + focus 兜底），再逐字真人打字，
  // 最后 Enter 发送；失败兜底点发送钮。绝不用 locator.innerText()/inputValue() 校验（live 页面会卡 30s）。
  async sendQuestion(question: string): Promise<void> {
    const input = await firstFound(this.page, this.selectors.input);
    if (!input) throw new Error('ELEMENT_NOT_FOUND: input');

    // 聚焦可编辑区：先真人式点击（带停顿），再用 .focus() 强制兜底（避免点击被拦截导致失焦）
    await humanClick(this.page, this.selectors.input.join(', ')).catch(() => {});
    await this.page.waitForTimeout(randWaitMs(QIANWEN_INPUT_FOCUS_SETTLE));
    await input.locator.focus().catch(() => {});
    await this.page.waitForTimeout(randWaitMs(QIANWEN_INPUT_FOCUS_AFTER));

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
    await this.page.waitForTimeout(randWaitMs(QIANWEN_INPUT_PRE_TYPE)); // 打字前随机停顿
    await this.humanType(question);

    // 校验问题文本是否进入输入框（contenteditable 或 textarea 任一含即可）
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

    // 1) 优先 Enter（贴合用户习惯）。发送前随机停顿（真人节奏，不瞬时）
    await humanDelay(...QIANWEN_INPUT_PRE_ENTER);
    await this.page.keyboard.press('Enter');
    if (await waitSent()) return;

    // 2) 兜底：真人式点发送钮
    const send = await firstFound(this.page, this.selectors.sendButton);
    if (send) await humanClick(this.page, this.selectors.sendButton.join(', '));
    if (await waitSent()) return;

    console.warn('⚠️ 发送未能确认（输入框仍含原问题），请人工检查发送交互');
  }

  // 模拟真人逐字输入：单字录入，随机间隔 180–450ms；标点后断句长停顿；约 8% 概率随机「思考停顿」。
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

  // 等待流式回答完整输出（全元素驱动，无固定分段时间）。
  //   完成信号（权威）：千问回答 markdown 渲染完成后会给根节点加 `qk-markdown-complete` 类
  //     —— 这是真实「已输出完毕」标志，优先据此判定。
  //   兜底信号：回答容器文本连续无增长（everGrew 后稳定 / 从未增长但已长时间稳定，应对缓存式瞬时答案）。
  //   ⚠️ 绝不靠全局 `[class*="loading"]` 判定流式——千问左侧导航常驻 `rn-right-navigator-loading-empty`
  //     占位元素（宽度>0），会制造"永远在输出"的假阳性，实测把等待拖满 180s 超时（2026-08-31 踩坑）。
  async waitForAnswer(timeoutMs = 180000): Promise<void> {
    const start = Date.now();

    const growthSel = this.selectors.answerContainer.join(', ');
    const getAnswerLen = async (): Promise<number | null> =>
      this.page
        .evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? (el.textContent || '').length : null;
        }, growthSel)
        .catch(() => null);

    // 千问「完成」标志：回答 markdown 根带上 `qk-markdown-complete`（生成中不带）。
    const isComplete = (): Promise<boolean> =>
      this.page
        .evaluate(() => {
          const el = document.querySelector('[class*="qk-markdown"]');
          return !!el && (el.className || '').includes('qk-markdown-complete');
        })
        .catch(() => false);

    let lastLen: number | null = null;
    let everGrew = false;
    let noGrowth = 0;
    let lastProgressLog = Date.now();

    while (Date.now() - start < timeoutMs) {
      const len = await getAnswerLen();
      const complete = await isComplete();

      if (len !== null) {
        if (lastLen === null) lastLen = len;
        else if (len > lastLen + 2) {
          lastLen = len;
          everGrew = true;
          noGrowth = 0;
        } else {
          noGrowth += 1;
        }
      } else {
        noGrowth += 1;
      }

      // 完成判定（任一满足即收尾）：
      if (complete && noGrowth >= 2) {
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(1)}s] 🏁 回答完成标志 qk-markdown-complete 出现且文本稳定，当前 ${lastLen ?? 0} 字`
        );
        break;
      }
      if (everGrew && noGrowth >= 8) {
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(1)}s] 🏁 已生长后文本连续 8s 无增长（兜底），当前 ${lastLen ?? 0} 字`
        );
        break;
      }
      if (noGrowth >= 40) {
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(1)}s] 🏁 文本连续 40s 无增长（可能缓存/瞬时答案），当前 ${lastLen ?? 0} 字`
        );
        break;
      }

      if (Date.now() - lastProgressLog > 10000) {
        const phase = complete ? '✅ 完成待稳定…' : everGrew ? '📝 回答流式输出中…' : '⏳ 检索/思考中…';
        console.log(
          `[${((Date.now() - start) / 1000).toFixed(1)}s] ${phase}（容器 ${len === null ? '未出现' : len + ' 字'}）`
        );
        lastProgressLog = Date.now();
      }

      await this.page.waitForTimeout(1000);
    }
    console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s] ✅ 回答输出完成，开始抽取`);
    await this.page.waitForTimeout(500); // 收尾缓冲
  }

  // 抽取回答正文；定位不到 → null。用 page.evaluate 一次读 textContent，绝不用 locator.innerText()。
  // 2026-09-02 修 ①：候选 selector 不能逗号拼接后 querySelector——它按**文档序**取第一个，
  //   永远命中外层 wrap（chat-answers-card-wrap 在 answer-common-card 之前），把 wrap 内
  //   「已完成分析，共参考 N 篇资料」摘要块 + 引用胶囊标题一并卷进 answerText。
  //   必须按候选优先级逐个尝试（selectors.ts 注释里早已提示此坑）。
  // 2026-09-02 修 ②：回答卡片混有大量非正文节点——SSR 水合 <script type="application/json">
  //   （视频推荐卡数据）、<style>、可见视频推荐卡（card_card_video_*）、「N篇来源」引用区。
  //   与文心同构：克隆后剔除噪音再读文本（bs4 真实样本模拟验证 27734→1356、1613→1288）。
  async getAnswer(): Promise<string | null> {
    return this.page
      .evaluate((sels: string[]) => {
        let el: Element | null = null;
        for (const s of sels) {
          const found = document.querySelector(s);
          if (found) {
            el = found;
            break;
          }
        }
        if (!el) return null;
        const clone = el.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll(
            'script, style, noscript, template, iframe, [class*="reference"], [class*="card_video"], [class*="video_note"]'
          )
          .forEach((n) => n.remove());
        const txt = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        return txt || null;
      }, this.selectors.answerContainer)
      .catch(() => null);
  }

  // 展开信源：只对带「展开/查看来源/查看引用/信源/参考」文案的按钮点击（最多 5 个），
  // 用 evaluate 派发 click，零自动等待。绝不对全部候选元素逐个 locator.click()。
  // 2026-09-02~03 演进：受信任 mouse.click 曾点空（元素在视口外→先 scrollIntoViewIfNeeded）；
  //   11-39/11-59 两轮结构 B 仍无效——mouse.click 按坐标命中顶层元素，会被覆盖层劫持，
  //   不保证触发 React。2026-09-03 12:00 定论：改用 **JS dispatchEvent 直接派发到
  //   link-title**（React 17+ 事件委托在根容器，bubbles 事件必然到达，无命中测试问题；
  //   isTrusted 对 onClick 无影响）。JS 派发后再补一次受信任点击兜底。
  async expandSources(): Promise<void> {
    await this.page
      .evaluate(() => {
        const btns = Array.from(
          document.querySelectorAll('button, [role="button"], [class*="expand"]')
        ).filter((b) => /展开|查看来源|查看引用|查看信源|信源|参考/.test(b.textContent || ''));
        btns.slice(0, 5).forEach((b) => (b as HTMLElement).click());
        // 主路径：JS 派发 mousedown/mouseup/click 到「N篇来源」头部（link-title）
        const lt = document.querySelector('[class*="reference-wrap"] > div > div');
        if (lt) {
          ['mousedown', 'mouseup', 'click'].forEach((t) =>
            lt.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
          );
        }
      })
      .catch(() => {});
    await this.page.waitForTimeout(2500); // 等 JS 派发生效（展开疑似异步拉取引用列表）
    const hasPills = await this.page
      .evaluate(() => {
        const wrap = document.querySelector('[class*="chat-answers-card-wrap"]');
        return wrap ? wrap.querySelectorAll('a[href^="http"]').length > 0 : false;
      })
      .catch(() => false);
    if (!hasPills) {
      // JS 派发无效 → 受信任点击兜底（与 dismissAds 同法）
      const head = this.page.locator('[class*="reference-wrap"] span', { hasText: '篇来源' }).first();
      await head.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      const box = await head.boundingBox().catch(() => null);
      if (box) {
        await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
    }
  }

  // 抽取信源列表（URL + 标题 + 平台）。
  // 2026-09-03 定论：千问**两种引用结构并存**（回答方差）——
  //   结构 A：引用胶囊 <a>（inline-flex…rounded-full）已挂 DOM，包在折叠容器
  //           grid-rows-[0fr] opacity-0 里（藏在「已完成分析」头部后，视觉隐藏但
  //           textContent 可读）；且胶囊**不在** answer-common-card / reference 容器内，
  //           而在外层 chat-answers-card-wrap 下（09-40 轮实测）。
  //   结构 B：DOM 无胶囊，只有「N篇来源」折叠头部 → 需点击展开（头部常在视口外，
  //           必须先 scrollIntoView），胶囊 mount 后同样落在 wrap 层。
  // 抽取四层兜底：① 旧 bg-option 胶囊；② reference 容器内 <a>；③ 回答卡片内 <a>；
  //   ④ wrap 内全部外链（覆盖 A/B 两结构的胶囊最终落点）。外链过滤千问内部域名。
  // 语义约定（与 run.ts 的 sourceCount 对齐）：
  //   - 信源区存在但 0 条 → 返回空数组 []（sourceCount=0，即"本轮回答未引用信源"）；
  //   - 连信源区都定位不到 → 返回 null（sourceCount=null，即"无法定位"）。
  //   千问同一问题可能有时引信源、有时不引（回答方差），故 0 与 null 必须区分。
  // 2026-09-02 19:12 轮复盘：引用面板渲染时机不稳 → 轮询重读抢时间窗。
  // 2026-09-03 11:39 轮复盘：结构 B 点击后胶囊疑似异步拉取（>4s 未就绪）→ 轮询拉长到
  //   14 次 × 800ms（≈11s）；最终仍 0 条且给了 captureDir → 落盘 reference-wrap 现场
  //   （sources-debug.html）供下轮校准（区分"未挂载 / 挂载晚 / 挂载到别处"）。
  async getSources(captureDir?: string): Promise<SourceInfo[] | null> {
    type Attempt = {
      found: boolean;
      items: { title?: string; url?: string }[];
      diag: Record<string, number | boolean>;
    };
    let last: Attempt = null;
    for (let attempt = 0; attempt < 14; attempt++) {
      last = await this.page
        .evaluate((areaSel: string) => {
          // ⚠️ evaluate 内禁具名/变量赋值函数（esbuild keepNames 注入 __name → 页面报错被 catch 吞成 null）。
          //    2026-09-02 18:38 轮实测踩坑：sources=null 但 reference-wrap 明明存在，就是这里抛的。
          //    外链条件全内联（匿名参数箭头没事）：/^https?:\/\// 且非千问内部域名。
          const diag = {
            bgOptions: document.querySelectorAll('a[class*="bg-option"]').length,
            refAreas: document.querySelectorAll('[class*="reference"]').length,
            refWrapExists: !!document.querySelector(areaSel),
            refWrapAnchors: document.querySelector(areaSel)?.querySelectorAll('a').length ?? 0,
            refWrapHTMLLen: document.querySelector(areaSel)?.innerHTML.length ?? 0,
            cardAnchors:
              document.querySelector('[class*="answer-common-card"]')?.querySelectorAll('a').length ?? 0,
            wrapAnchors:
              document.querySelector('[class*="chat-answers-card-wrap"]')?.querySelectorAll('a').length ?? 0,
          };
          // ① 旧结构：bg-option 胶囊
          const mapped = Array.from(
            document.querySelectorAll('a[class*="bg-option"]')
          )
            .map((a) => ({
              title:
                ((a.querySelector('.truncate')?.textContent || a.textContent || '') as string).trim() ||
                undefined,
              url: a.getAttribute('href') || undefined,
            }))
            .filter(
              (s) =>
                !!s.url && /^https?:\/\//i.test(s.url) && !/qianwen\.com|qwen\.ai/i.test(s.url)
            );
          if (mapped.length) return { found: true, items: mapped, diag };
          // ② reference 容器内的 <a>（展开面板挂载点）
          for (const area of Array.from(document.querySelectorAll('[class*="reference"]'))) {
            const anc = Array.from(area.querySelectorAll('a'))
              .map((a) => ({
                title: (a.textContent || '').trim() || undefined,
                url: a.getAttribute('href') || undefined,
              }))
              .filter(
                (s) =>
                  !!s.url && /^https?:\/\//i.test(s.url) && !/qianwen\.com|qwen\.ai/i.test(s.url)
              );
            if (anc.length) return { found: true, items: anc, diag };
          }
          // ③ 回答卡片内全部外链
          const card = document.querySelector('[class*="answer-common-card"]');
          if (card) {
            const anc = Array.from(card.querySelectorAll('a'))
              .map((a) => ({
                title: (a.textContent || '').trim() || undefined,
                url: a.getAttribute('href') || undefined,
              }))
              .filter(
                (s) =>
                  !!s.url && /^https?:\/\//i.test(s.url) && !/qianwen\.com|qwen\.ai/i.test(s.url)
              );
            if (anc.length) return { found: true, items: anc, diag };
          }
          // ④ 外层 wrap 兜底：引用胶囊的最终落点（A/B 两结构都归这里），折叠容器不影响读取
          const wrapEl = document.querySelector('[class*="chat-answers-card-wrap"]');
          if (wrapEl) {
            const anc = Array.from(wrapEl.querySelectorAll('a'))
              .map((a) => ({
                title: (a.textContent || '').trim() || undefined,
                url: a.getAttribute('href') || undefined,
              }))
              .filter(
                (s) =>
                  !!s.url && /^https?:\/\//i.test(s.url) && !/qianwen\.com|qwen\.ai/i.test(s.url)
              );
            if (anc.length) return { found: true, items: anc, diag };
          }
          // ⑤ 新版结构（2026-09-07 实测）：信源不再以 <a> 呈现，而是序列化进内嵌 JSON
          //    （每条来源含 norm_url 真实地址字段，DOM 全文无外链）。当①②③④ 都落空时，
          //    从 innerHTML 正则抽取 norm_url 作为真实来源 URL；JSON 可能将 / 转义为 \/，需还原；
          //    过滤千问/神马搜索代理(sm.cn 等)及阿里 CDN 等内部域名，仅留真实来源站点。
          const html5 = document.documentElement.innerHTML;
          const normUrls = Array.from(html5.matchAll(/"norm_url"\s*:\s*"([^"]*)"/g))
            .map((mm) => mm[1].replace(/\\\//g, '/'))
            .filter(
              (u) =>
                /^https?:\/\//i.test(u) &&
                !/(qianwen\.com|qwen\.ai|sm\.cn|zimgs\.cn|alicdn\.com|aliyuncs\.com)/i.test(u)
            );
          if (normUrls.length) {
            return {
              found: true,
              items: normUrls.map((u) => ({ url: u })),
              diag: { ...diag, normUrls: normUrls.length },
            };
          }
          // 区在，0 条 / 区都未定位到
          return {
            found: diag.refWrapExists,
            items: [],
            diag,
          };
        }, this.selectors.sourceArea.join(', '))
        .catch((e) => {
          if (attempt === 0) console.log(`[千问信源诊断] evaluate 异常：${(e as Error).message}`);
          return null;
        });
      if (last && last.found && last.items.length > 0) break;
      await this.page.waitForTimeout(800);
    }
    if (!last) return null;
    console.log(`[千问信源诊断] ${JSON.stringify(last.diag)}，抽到 ${last.items.length} 条`);
    // 全量扫描落盘（无论新旧哪种结构、抓到几条都落，便于校准"多结构并存"场景）：
    // 旧结构胶囊落点(docExtAnchors) / 新结构 favicon(img src 内 base64 key) / 全部 reference 容器 HTML。
    if (captureDir) {
      const scan = await this.page
        .evaluate((cnt: number) => {
          const ref = document.querySelector('[class*="reference-wrap"]');
          const iconImgs = Array.from(document.querySelectorAll('.search-icon-item img')).map((i) =>
            (i.getAttribute('src') || '').slice(0, 240)
          );
          const extAnchors = Array.from(document.querySelectorAll('a[href^="http"]'))
            .slice(0, 30)
            .map((a) => {
              const anc: string[] = [];
              let p = a.parentElement;
              for (let i = 0; p && i < 6; i++) {
                anc.push((p.className || '').toString().slice(0, 90));
                p = p.parentElement;
              }
              return {
                text: (a.textContent || '').trim().slice(0, 60),
                href: (a.getAttribute('href') || '').slice(0, 90),
                ancestors: anc,
              };
            });
          const refAll = Array.from(document.querySelectorAll('[class*="reference"]')).map((e) =>
            e.outerHTML.slice(0, 6000)
          );
          return {
            ts: Date.now(),
            found: !!(ref || document.querySelector('[class*="reference"]')),
            items: cnt,
            refHTML: ref ? ref.outerHTML.slice(0, 8000) : '',
            searchIconImgs: iconImgs,
            docExtAnchors: extAnchors,
            refAllHTML: refAll,
          };
        }, last.items.length)
        .catch(() => null);
      if (scan) {
        const p = path.join(captureDir, 'sources-scan.json');
        fs.writeFileSync(p, JSON.stringify(scan, null, 2));
        console.log(`[千问信源诊断] 全量扫描已落盘：${path.relative(process.cwd(), p)}`);
      }
    }
    // 校准落盘：信源区在但最终 0 条 → 抓现场，区分"未挂载/挂载晚/挂载到别处(portal)"
    if (last.found && last.items.length === 0 && captureDir) {
      const dump = await this.page
        .evaluate(() => {
          const ref = document.querySelector('[class*="reference-wrap"]');
          // 全文外链锚点扫描：若胶囊挂到 wrap 之外（portal/下一条消息），这里能暴露落点
          const extAnchors = Array.from(document.querySelectorAll('a[href^="http"]'))
            .slice(0, 10)
            .map((a) => {
              const anc: string[] = [];
              let p = a.parentElement;
              for (let i = 0; p && i < 6; i++) {
                anc.push((p.className || '').toString().slice(0, 90));
                p = p.parentElement;
              }
              return {
                text: (a.textContent || '').trim().slice(0, 60),
                href: (a.getAttribute('href') || '').slice(0, 90),
                ancestors: anc,
              };
            });
          return {
            ts: Date.now(),
            refHTML: ref ? ref.outerHTML.slice(0, 8000) : '',
            refText: ref ? (ref.textContent || '').trim().slice(0, 120) : '',
            docExtAnchors: extAnchors,
          };
        })
        .catch(() => null);
      if (dump) {
        const p = path.join(captureDir, 'sources-debug.json');
        fs.writeFileSync(p, JSON.stringify(dump, null, 2));
        console.log(`[千问信源诊断] 0 条现场已落盘：${path.relative(process.cwd(), p)}`);
      }
    }
    if (!last.found) return null;
    if (last.items.length === 0) return [];
    // 去重（同 URL 只留一条）
    const seen = new Set<string>();
    const items = last.items.filter((s) => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });
    return items.map((s) => ({ title: s.title, url: s.url, platform: this.derivePlatform(s.title, s.url) }));
  }

  // 派生媒体平台名称：优先以标题最后分隔符切出短后缀；否则回退 URL 域名
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

  // 长屏截图（**平台私有实现**；2026-08-31 从共享 run.ts 下沉到 Adapter）。
  // 所有锚点来自 this.selectors（千问私有配置），本方法只对千问负责。
  // 策略 A（expand，默认）：六步与文心同构，但锚点按千问真实 DOM 校准：
  //   ① 从回答外层 wrap（expandRoot）向上逐层撑开有界滚动容器；
  //   ② 问题气泡（questionBlock）→ qa 容器（chat-round）祖先链 fixed/absolute 改 relative（非 static）；
  //   ③ 隐藏 qa 外 / qa 内（问题气泡子树豁免）的浮层；
  //   ④ 清除渲染抑制属性（mask-image / clip-path / content-visibility / contain / opacity:0 / visibility:hidden）；
  //   ⑤ 清文本选中；⑥ locator.screenshot() 元素级截图，边界 = 最新 chat-round。
  // 策略 B（stitch）：尚未实现，传入时回退 A 并打印警告。
  async captureQaScreenshot(outPath: string, mode: ScreenshotMode = 'expand'): Promise<void> {
    if (mode === 'stitch') {
      console.log('⚠️ 千问策略 B（滚动分段拼接）尚未实现，本次回退到策略 A（expand）');
    }
    const page = this.page;
    const qaSel =
      this.selectors.qaBlock && this.selectors.qaBlock.length
        ? this.selectors.qaBlock.join(', ')
        : '[class*="chat-round"]';
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
                h.style.height = h.scrollHeight + 'px';
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
          // ③ 非 qa 后代的 fixed/absolute/sticky 浮层全隐藏
          document.querySelectorAll('*').forEach((el) => {
            if (qa.contains(el)) return;
            const cs = getComputedStyle(el as HTMLElement);
            if (cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky') {
              (el as HTMLElement).style.display = 'none';
            }
          });
          //    qa 后代的干扰浮层也隐藏，但**问题元素内部整棵子树豁免**
          const bubInner = qsel ? qa.querySelector(qsel) : null;
          qa.querySelectorAll('*').forEach((el) => {
            const cs = getComputedStyle(el as HTMLElement);
            if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
            if (bubInner && bubInner.contains(el)) return;
            (el as HTMLElement).style.display = 'none';
          });
        }

        // ④ 清除渲染抑制属性
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

    // 诊断三件套（平台私有，按用户要求在本方法内打印）
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

    // ⑥ 元素级截图：边界 = 最新 chat-round（问题开始 → 回答结束）
    await qaLocator.screenshot({ path: outPath, animations: 'disabled', timeout: 60000 });
    const sz = fs.statSync(outPath).size;
    console.log(`✂️ Q&A 长屏截图完成（千问·策略A：边界=chat-round.last，问题→回答结束，${sz} bytes）`);
  }

  // 关闭千问首屏营销弹层。存在两种形态（2026-09-01 实测）：
  //   A) 居中大卡片轮播 `div[data-testid="home-guide-carousel"]`，卡片内有常显关闭钮
  //      `button[aria-label="关闭"]`；
  //   B) 底部横幅 `div.group.relative.flex...bg-pc-sidebar`，含 `canvas[data-promo-banner-canvas]`，
  //      关闭钮是卡片内 hover-only 的 `button[aria-label="关闭"]`（默认 opacity-0 / pointer-events-none）。
  // 策略：先处理 A（如有），再处理 B（如有），均用仿人类节奏。返回 true=检测到并点击了任一关闭。
  async dismissAds(): Promise<boolean> {
    let closed = false;

    // ---- 形态 A：居中轮播卡片 ----
    const carousel = this.page.locator('div[data-testid="home-guide-carousel"]').first();
    const carouselCount = await carousel.count().catch(() => 0);
    if (carouselCount > 0) {
      const closeBtn = carousel.locator('button[aria-label="关闭"]').first();
      if ((await closeBtn.count()) > 0) {
        console.log('🛡️ 检测到千问居中轮播弹窗，稍作停顿后仿人类点击关闭…');
        await humanDelay(...QIANWEN_AD_A_DETECT_PAUSE);
        const box = await closeBtn.boundingBox().catch(() => null);
        if (box) {
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          // steps:1 直接定位：横跨页面滑移会途经 hover 元素级联触发样式变化 → 整页"闪"
          await this.page.mouse.move(cx, cy, { steps: 1 });
          await humanDelay(...QIANWEN_AD_A_MOVE_DOWN);
          await this.page.mouse.down();
          await humanDelay(...QIANWEN_AD_A_HOLD);
          await this.page.mouse.up();
          await humanDelay(...QIANWEN_AD_A_AFTER);
        } else {
          await closeBtn.click().catch(() => {});
        }
        const gone = await carousel
          .waitFor({ state: 'detached', timeout: 5000 })
          .then(() => true)
          .catch(() => false);
        if (gone) {
          console.log('✅ 千问居中轮播弹窗已关闭');
          closed = true;
        } else {
          console.log('⚠️ 轮播弹窗关闭钮已点，弹窗仍未消失');
        }
        await this.page.waitForTimeout(500);
      }
    }

    // ---- 形态 B：底部横幅 ----
    // 用 `div.group.relative.flex.bg-pc-sidebar` 限定，避免命中左侧导航栏的 bg-pc-sidebar。
    const candidates = await this.page
      .locator('div.group.relative.flex.bg-pc-sidebar:has(canvas[data-promo-banner-canvas])')
      .all();
    let card = null;
    for (const c of candidates) {
      const visible = await c
        .evaluate((el) => {
          const cs = getComputedStyle(el as HTMLElement);
          const rect = (el as HTMLElement).getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && cs.opacity !== '0' && cs.visibility !== 'hidden' && cs.display !== 'none';
        })
        .catch(() => false);
      if (visible) {
        card = c;
        break;
      }
    }
    if (card) {
      const closeBtn = card.locator('button[aria-label="关闭"]');
      if ((await closeBtn.count()) > 0) {
        console.log('🛡️ 检测到千问底部广告横幅，悬停显示关闭钮后仿人类点击…');
        await humanDelay(...QIANWEN_AD_B_PRE_HOVER);
        await card.hover();
        await humanDelay(...QIANWEN_AD_B_POST_HOVER);

        const box = await closeBtn.boundingBox();
        if (box) {
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          // steps:1 直接定位，避免跨页滑移 hover 级联闪屏
          await this.page.mouse.move(cx, cy, { steps: 1 });
          await humanDelay(...QIANWEN_AD_B_MOVE_DOWN);
          await this.page.mouse.down();
          await humanDelay(...QIANWEN_AD_B_HOLD);
          await this.page.mouse.up();
          await humanDelay(...QIANWEN_AD_B_AFTER);
        }
        const gone = await this.page
          .waitForFunction(
            () => {
              const cards = Array.from(
                document.querySelectorAll('div.group.relative.flex.bg-pc-sidebar')
              ).filter((d) => d.querySelector('canvas[data-promo-banner-canvas]'));
              return cards.every((c) => {
                const cs = getComputedStyle(c as HTMLElement);
                const rect = (c as HTMLElement).getBoundingClientRect();
                return cs.opacity === '0' || rect.width === 0 || rect.height === 0;
              });
            },
            { timeout: 5000 }
          )
          .then(() => true)
          .catch(() => false);
        if (gone) {
          console.log('✅ 千问底部广告横幅已关闭');
          closed = true;
        } else {
          console.log('⚠️ 已点击底部横幅关闭钮，横幅未从 DOM 移除（继续后续流程）');
          closed = true; // 点过也算处理过，避免外层报错
        }
      }
    }

    if (!closed) console.log('🛡️ 未发现千问营销弹层');
    return closed;
  }

  // 处理千问发送后弹出的滑动验证（baxia 阿里系，渲染在 iframe #baxia-dialog-content 内）。
  // 实测（2026-09-01）：验证码不在主文档，而在跨域 iframe
  //   `chat2.qianwen.com/.../punish?x5secdata=...` 中；原 detector 只扫描主文档，因此完全漏检。
  // 本实现：
  //   1) 检测主文档的 baxia 弹窗/iframe；
  //   2) 切换到 iframe（Playwright frame.evaluate / frameLocator，不依赖同源）；
  //   3) 在 iframe 内用文案+几何定位滑块把手与轨道；
  //   4) 换算成页面视口坐标后仿人类拖动到轨道右端；
  //   5) 自动不过则进入「等待人工滑动」模式（run 不卡死）。
  // ⚠️ 这是模拟用户本就手动做的拖拽动作（非打码平台/漏洞破解）。
  //
  // 重试策略（用户 2026-09-02 手动实操经验定，与旧版「单页死磕 8 次」不同）：
  //   每轮最多滑 2 次 → 两次都失败就**刷新页面重开**（刷新后滑一次基本就过）→ 最多刷新 3 次。
  // ⚠️ 刷新会丢掉已输入的问题，所以「重开」= 刷新页面 + 重发问题。重发属于编排层职责，
  //    故由 run.ts 通过 restart 回调提供（它知道目标 URL 与问题文本）；
  //    本适配器仍然只负责滑块本身，符合「平台操作私有、编排层只做编排」。
  // ⚠️ 用**递归**实现重开：重新走完整的「监控弹窗 → 等滑块就绪 → 滑动」流程，
  //    避免把这套状态（frame / sliderInfo / 若干闭包）拆散传递，也更不容易漏掉准备步骤。
  async solveCaptcha(
    captureDir?: string,
    restart?: () => Promise<void>,
    refreshCount = 0
  ): Promise<boolean> {
    const sub = captureDir ? path.join(captureDir, 'captcha') : null;
    if (sub) fs.mkdirSync(sub, { recursive: true });

    // 检测：baxia 弹窗、iframe、关闭钮任一出现即认为需要处理
    const detectModal = (): Promise<boolean> =>
      this.page
        .evaluate(() => {
          const iframe = document.querySelector('#baxia-dialog-content') as HTMLElement | null;
          const closeBtn = document.querySelector('.baxia-dialog-close') as HTMLElement | null;
          return !!(iframe || closeBtn);
        })
        .catch(() => false);

    const MONITOR_ITERS = 28; // 28 × 800ms ≈ 22.4s
    const MONITOR_GAP = 800;
    let detected = false;
    for (let i = 0; i < MONITOR_ITERS; i++) {
      if (await detectModal()) {
        detected = true;
        console.log(`🔒 第 ${i + 1} 次轮询检测到 baxia 验证弹窗`);
        break;
      }
      await this.page.waitForTimeout(MONITOR_GAP);
    }
    if (!detected) {
      // 刷新重开后若**没有**再弹验证码 → 重发的问题已被直接接受，视为通过（不能当失败再刷）。
      if (refreshCount > 0) {
        console.log('✅ 刷新重开后未再触发滑动验证，问题已发送成功');
        return true;
      }
      console.log('🔓 未检测到千问滑动验证弹窗');
      if (sub) {
        try {
          fs.writeFileSync(path.join(sub, 'page-dump.html'), await this.page.content());
        } catch {
          /* ignore */
        }
      }
      return false;
    }

    // 给 iframe 内 JS 渲染滑块留一点时间（spinner 后才出现真正滑块）。
    // ⚠️ 真正的就绪把关在下面的 waitForSliderReady（会轮询到滑块出现），这里只是起步缓冲；
    //    用户 2026-09-02 反馈整体节奏偏慢，故由原 1.2~2.0s 下调为 0.8~1.2s。
    await humanDelay(...QIANWEN_CAPTCHA_DETECT_PAUSE);

    // 抓取现场
    if (sub) {
      try {
        await this.page.screenshot({ path: path.join(sub, 'captcha.png') });
        fs.writeFileSync(path.join(sub, 'modal-dump.html'), await this.page.content());
      } catch (e) {
        console.log(`⚠️ 验证码现场抓取失败：${(e as Error).message}`);
      }
    }

    // 获取 iframe 框架（baxia punish URL）
    let frame: Frame | null = null;
    for (let i = 0; i < 15 && !frame; i++) {
      frame = this.page.frame({ url: /\/punish\?/ });
      if (!frame) await this.page.waitForTimeout(400);
    }
    if (!frame) {
      return this.retryOrManual(
        captureDir,
        restart,
        refreshCount,
        detectModal,
        sub,
        '检测到弹窗但未定位到 baxia iframe'
      );
    }

    // 先落盘 iframe 当前 HTML（无论 slider 是否就绪，供调试）
    if (sub) {
      try {
        const iframeHtml = await frame.content();
        fs.writeFileSync(path.join(sub, 'iframe-content-initial.html'), iframeHtml);
      } catch (e) {
        console.log(`⚠️ iframe 初始 HTML 落盘失败：${(e as Error).message}`);
      }
    }

    type SliderBox = { x: number; y: number; w: number; h: number };

    // 等待真正滑块渲染：阿里 no-captcha 常见类 .nc_scale + .nc_iconfont。
    // 加载中为 spinner，无这些类；必须等到它们出现且几何合理。
    const waitForSliderReady = async (f: Frame): Promise<{ handle: SliderBox; track: SliderBox } | null> => {
      for (let attempt = 0; attempt < 50; attempt++) {
        // 50 × 600ms = 30s
        const boxes = await f
          .evaluate(() => {
            const track = document.querySelector('.nc_scale') as HTMLElement | null;
            const handle =
              (document.querySelector('.nc_scale .nc_iconfont') as HTMLElement | null) ||
              (document.querySelector('.nc_iconfont') as HTMLElement | null) ||
              (document.querySelector('.btn_slide') as HTMLElement | null);
            if (!track || !handle) return null;
            const tb = track.getBoundingClientRect();
            const hb = handle.getBoundingClientRect();
            if (tb.width < 150 || hb.width < 12 || hb.width > 90) return null;
            return {
              track: { x: tb.x, y: tb.y, w: tb.width, h: tb.height },
              handle: { x: hb.x, y: hb.y, w: hb.width, h: hb.height },
            };
          })
          .catch(() => null);
        if (boxes) {
          console.log('🎯 baxia iframe 滑块已就绪（Aliyun 标准类）');
          return boxes;
        }
        await this.page.waitForTimeout(600);
      }
      return null;
    };

    let sliderInfo: { handle: SliderBox; track: SliderBox } | null = null;
    sliderInfo = await waitForSliderReady(frame);

    // 回退：用文案+几何扫描（兼容类名不同的变种）
    if (!sliderInfo) {
      const info = await frame
        .evaluate(() => {
          const HINT_RE = /按住滑块|拖动到最右边|拖动下方滑块|滑动验证|完成验证|安全验证|请拖动/;
          const all = Array.from(document.querySelectorAll('*')) as HTMLElement[];
          const tracks = all.filter((el) => {
            const b = el.getBoundingClientRect();
            const hasHint = HINT_RE.test((el.textContent || '').trim());
            return hasHint && b.width >= 180 && b.height >= 25 && b.height <= 140;
          });
          if (!tracks.length) return null;
          const track = tracks.reduce((a, b) => {
            const ab = a.getBoundingClientRect();
            const bb = b.getBoundingClientRect();
            return ab.width * ab.height > bb.width * bb.height ? a : b;
          });
          const tb = track.getBoundingClientRect();
          const handleCandidates = all
            .filter((el) => {
              const b = el.getBoundingClientRect();
              const role = el.getAttribute('role');
              const cls = (el.className || '').toString();
              const isSmall = b.width >= 12 && b.width <= 90 && b.height >= 12 && b.height <= 90;
              const looksLikeHandle =
                role === 'slider' || /slide|slider|thumb|handle|iconfont|btn_slide|nc_/i.test(cls);
              return isSmall && looksLikeHandle;
            })
            .sort((a, b) => {
              const ab = a.getBoundingClientRect();
              const bb = b.getBoundingClientRect();
              const aIn =
                ab.x >= tb.x - 5 &&
                ab.x + ab.width <= tb.x + tb.width + 5 &&
                ab.y >= tb.y - 5 &&
                ab.y + ab.height <= tb.y + tb.height + 5;
              const bIn =
                bb.x >= tb.x - 5 &&
                bb.x + bb.width <= tb.x + tb.width + 5 &&
                bb.y >= tb.y - 5 &&
                bb.y + bb.height <= tb.y + tb.height + 5;
              if (aIn && !bIn) return -1;
              if (!aIn && bIn) return 1;
              return ab.x - bb.x;
            });
          const handle = handleCandidates[0];
          if (!handle) return null;
          const hb = handle.getBoundingClientRect();
          if (tb.width < 150 || hb.width < 12 || tb.width < hb.width * 1.2) return null;
          return {
            track: { x: tb.x, y: tb.y, w: tb.width, h: tb.height },
            handle: { x: hb.x, y: hb.y, w: hb.width, h: hb.height },
          };
        })
        .catch(() => null);
      if (info) {
        console.log('🎯 baxia iframe 滑块已就绪（几何回退）');
        sliderInfo = info;
      }
    }

    // 滑块就绪后再落一份 iframe HTML
    if (sub) {
      try {
        const iframeHtml = await frame.content();
        fs.writeFileSync(path.join(sub, 'iframe-content-ready.html'), iframeHtml);
      } catch (e) {
        console.log(`⚠️ iframe 就绪 HTML 落盘失败：${(e as Error).message}`);
      }
    }

    if (!sliderInfo) {
      console.log('⚠️ 无法在 baxia iframe 内定位滑块/轨道');
      return this.retryOrManual(captureDir, restart, refreshCount, detectModal, sub, '无法在 baxia iframe 内定位滑块/轨道');
    }

    // 读取滑块"把手"当前在 iframe 内的实时位置（每次拖动前重读，因为失败会回弹到 left:0 或换新挑战）
    const readHandle = async (): Promise<{ x: number; y: number; w: number; h: number } | null> =>
      frame!
        .evaluate(() => {
          const hb = (document.querySelector('.nc_iconfont.btn_slide') ||
            document.querySelector('.btn_slide')) as HTMLElement | null;
          if (!hb) return null;
          const r = hb.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        })
        .catch(() => null);

    // 最新 punish frame：iframe 在失败/重试时可能 navigate，旧 frame 会 detach（evaluate 抛错→null，
    // 导致 errloading 永远读不到 → 假成功）。所有对 iframe 的读取/点击都必须用最新 frame。
    const latestFrame = (): Frame | null => this.page.frame({ url: /\/punish\?/ }) ?? frame;

    // 读取滑块状态（把手 left / 背景填充宽）用于"是否真的在动"的诊断
    const readSliderState = async (): Promise<Record<string, unknown>> => {
      const f = latestFrame();
      if (!f) return {};
      return f
        .evaluate(() => {
          const tb = document.querySelector('.nc_scale') as HTMLElement | null;
          const hb = (document.querySelector('.nc_iconfont.btn_slide') ||
            document.querySelector('.btn_slide')) as HTMLElement | null;
          const bg = document.querySelector('.nc_bg') as HTMLElement | null;
          return {
            trackW: tb ? Math.round(tb.getBoundingClientRect().width) : null,
            handleLeftPx: hb ? hb.style.left : null,
            handleX: hb ? Math.round(hb.getBoundingClientRect().x) : null,
            bgWidthPx: bg ? bg.style.width : null,
            // 环境指纹（阿里风控会读取 iframe 内 navigator）：用于判断是否被环境检测拦截
            webdriver: (navigator as unknown as { webdriver?: boolean }).webdriver ?? null,
            plugins: navigator.plugins ? navigator.plugins.length : null,
            ua: navigator.userAgent.slice(0, 60),
          };
        })
        .catch(() => ({}));
    };

    // 滑块是否"已拖到终点"：验证成功时把手贴到轨道最右、绿色背景 (.nc_bg) 填满整轨。
    // ⚠️ 拖完瞬间 .nc_scale 宽可能被读成 0（成功态隐藏轨道），故用【拖动前】捕获的 sliderInfo.track.w 作基准。
    const reachedEnd = async (): Promise<boolean> => {
      const s = await readSliderState();
      const trackW = sliderInfo?.track.w ?? 0;
      if (trackW <= 0) return false;
      const bgW = parseInt(String(s.bgWidthPx ?? ''), 10);
      const hLeft = parseInt(String(s.handleLeftPx ?? ''), 10);
      if (!Number.isNaN(bgW) && bgW >= trackW * 0.85) return true; // 绿底填满 ≥85%
      if (!Number.isNaN(hLeft)) {
        const handleW = sliderInfo?.handle.w ?? 0;
        if (hLeft + handleW >= trackW * 0.85) return true; // 把手到轨道末端
      }
      return false;
    };

    // 点击「验证失败，点击框体重试」框体换新挑战。
    // ⚠️ 仅在出现 .errloading（明确失败）时才点；对正常/进行中的滑块误点容器会触发阿里重载
    //    → 整页闪屏（这就是"偶尔闪一下"的主因）。用受信任的 page.mouse（iframe 内 evaluate
    //    派发的 .click() 是 isTrusted=false，阿里会忽略）。返回是否真的点了重试框。
    const clickRetry = async (): Promise<boolean> => {
      const ib = await this.page.locator('#baxia-dialog-content').boundingBox();
      if (!ib) return false;
      const f = latestFrame();
      if (!f) return false;
      const box = await f
        .evaluate(() => {
          const err = document.querySelector('.errloading') as HTMLElement | null;
          if (!err) return null; // 非失败态不点（避免误触发重载闪屏）
          const r = err.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        })
        .catch(() => null);
      if (!box) return false;
      const cx = ib.x + box.x + box.w / 2;
      const cy = ib.y + box.y + box.h / 2;
      // steps:1 直接定位，避免跨页滑移 hover 级联闪屏
      await this.page.mouse.move(cx, cy, { steps: 1 });
      await humanDelay(...QIANWEN_CAPTCHA_MANUAL_DOWN);
      await this.page.mouse.down();
      await humanDelay(...QIANWEN_CAPTCHA_MANUAL_HOLD);
      await this.page.mouse.up();
      await this.page.waitForTimeout(1500);
      return true;
    };

    // 读取阿里验证结果：成功 / 失败 / 未定。
    // 成功：滑块变绿并显示「验证通过」（.nc_scale 加 nc_ok / .scale_text 文案变化），
    //        或主文档 baxia 弹窗直接消失；失败：显示 .errloading（验证失败，点击框体重试）。
    // ⚠️ 此前只在拖完等 1.8s 后单次 detectModal()：若此时弹窗正处于「成功→淡出」动画、
    //    #baxia-dialog-content 仍在 DOM，会被误判成「没过」而进重试/人工模式（用户实测第6次已过却没识别到）。
    const readOutcome = async (): Promise<'success' | 'failed' | null> => {
      const f = latestFrame();
      if (!f) return null;
      return f
        .evaluate(() => {
          // ⚠️ 假成功根因（2026-09-01 01:54 诊断铁证）：本 iframe 的**引导文案**自带"通过验证"
          //    （`captcha-h5-tips`："亲，请拖动下方滑块完成验证<通过验证>以确保正常访问"），
          //    旧实现用 body.innerText + 正则 /通过验证/ 匹配 → 任何时刻都命中 → 每次拖完必假成功。
          //    现在：不再扫全 body，只查滑块本身的 .scale_text 文案与可见成功元素。
          // 失败态（优先级高）：验证失败框存在即失败
          if (document.querySelector('.errloading')) return 'failed';
          // 成功态：滑块文字（.scale_text 内的 .nc-lang-cnt）成功时变为"验证通过"
          const st = document.querySelector('.scale_text .nc-lang-cnt, .scale_text');
          const txt = (st && st.textContent ? st.textContent : '').trim();
          if (txt === '验证通过' || txt.includes('验证通过')) return 'success';
          // 成功态兜底：可见的 .nc_ok / .btn_ok 成功元素（绿底对勾），不可见的不算
          const ok = document.querySelector('.nc_scale .nc_ok, .btn_ok');
          if (ok) {
            const r = (ok as HTMLElement).getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return 'success';
          }
          return null;
        })
        .catch(() => null);
    };

    console.log('🔍 拖动前滑块状态:', JSON.stringify(await readSliderState()));

    // 重试若干次：每次都用"全新随机真人轨迹"拖到底。阿里风控是按单次轨迹判定的，
    // 换换节奏/落点常能蹭过一次；失败则点击重试框换新挑战再试。
    // 每轮最多滑 2 次（用户 2026-09-02 定：8 次连滑仍失败后转人工大概率还是失败，
    // 不如尽早刷新页面重开——实测刷新后滑一次基本就过）。刷新额度见 MAX_REFRESH。
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // 新一轮前先确认弹窗是否还在；若已消失说明上一轮其实已通过（轮询竞态兜底，避免漏检成功）
      if (!(await detectModal())) {
        console.log('✅ 滑动验证通过（弹窗已消失）');
        return true;
      }

      // ⚠️ 关键顺序修正：滑动前的等待【必须放在读坐标之前】。
      // 旧版先读 hc/iframeBox，再等 11s——期间 iframe 可能重渲染（这就是"滑动前的闪"），
      // 坐标过期导致拖到 mask/背景 → 阿里 mask 点击关闭对话框 → 弹窗真消失 → goneStreak 误判假成功。
      // 现在先等（让人/iframe 都稳定），再读最新坐标、立刻拖。
      const preWait =
        attempt === 1
          ? randWaitMs(QIANWEN_CAPTCHA_FIRST_PREWAIT) // 用户 2026-09-02：弹窗出现后 1~3s 最佳
          : randWaitMs(QIANWEN_CAPTCHA_RETRY_PREWAIT); // 用户 2026-09-02：失败后 1~2s
      console.log(
        attempt === 1
          ? `⏱️ 首次滑动前随机等待 ${(preWait / 1000).toFixed(1)}s（模拟真人发呆/读题）…`
          : `⏱️ 第 ${attempt} 次重试前随机等待 ${(preWait / 1000).toFixed(1)}s…`
      );
      await this.page.waitForTimeout(preWait);

      // 等待之后**重新**获取一切：frame、iframeBox、把手位置。
      // 即便 iframe 在等待期间 navigate/重渲染，下面也读到的是最新状态。
      for (let g = 0; g < 10; g++) {
        const f = this.page.frame({ url: /\/punish\?/ });
        if (f) {
          frame = f;
          break;
        }
        await this.page.waitForTimeout(300);
      }
      if (!frame) {
        console.log('⚠️ 重试时无法定位 baxia iframe');
        return this.retryOrManual(captureDir, restart, refreshCount, detectModal, sub, '重试时无法定位 baxia iframe');
      }

      const iframeBox = await this.page.locator('#baxia-dialog-content').boundingBox();
      if (!iframeBox) {
        console.log('⚠️ 无法获取 baxia iframe 位置');
        return this.retryOrManual(captureDir, restart, refreshCount, detectModal, sub, '无法获取 baxia iframe 位置');
      }

      // 把手位置重读；读不到说明 iframe 还没渲染出滑块，等一下
      let hc = await readHandle();
      if (!hc) {
        console.log(`⚠️ 第 ${attempt} 次拖动前重读把手失败，等待新滑块渲染…`);
        const re = await waitForSliderReady(frame);
        if (!re) {
          console.log('⚠️ 未能重新定位滑块');
          return this.retryOrManual(captureDir, restart, refreshCount, detectModal, sub, '未能重新定位滑块');
        }
        sliderInfo = re;
        hc = await readHandle();
        if (!hc) {
          console.log('⚠️ 新滑块把手仍定位不到');
          return this.retryOrManual(captureDir, restart, refreshCount, detectModal, sub, '新滑块把手仍定位不到');
        }
      }

      // 拖前最后一刻再校验一次"鼠标起点在把手上"：避免微小坐标偏差导致拖到 mask
      // 之前也校验过一次 hc，但这里再做一次 sanity 防止从读到拖之间的几 ms 内 iframe 又重渲染
      hc = await readHandle();
      if (!hc) {
        console.log('⚠️ 拖前最后校验把手时丢失，重新…');
        const re = await waitForSliderReady(frame);
        if (!re) return this.retryOrManual(captureDir, restart, refreshCount, detectModal, sub, '拖前最后校验把手时丢失');
        sliderInfo = re;
        hc = await readHandle();
        if (!hc) return this.retryOrManual(captureDir, restart, refreshCount, detectModal, sub, '拖前把手重读仍失败');
      }
      const iframeBoxFinal = await this.page.locator('#baxia-dialog-content').boundingBox();
      if (!iframeBoxFinal) {
        console.log('⚠️ 拖前最后校验 iframe 位置时丢失');
        return this.retryOrManual(captureDir, restart, refreshCount, detectModal, sub, '拖前最后校验 iframe 位置时丢失');
      }

      const fromX = iframeBoxFinal.x + hc.x + hc.w / 2;
      const fromY = iframeBoxFinal.y + hc.y + hc.h / 2;
      // 把手可移动距离 = 轨道宽 - 把手宽（把手 right 贴住轨道 right 才到底）。
      // 旧版用 factor(<1.0) 计算，导致把手始终差 2%~8% 不到底 → 永远不过。
      const travel = sliderInfo.track.w - hc.w;
      // 每次落点加微小随机抖动（−2~+5px）：完全相同的轨迹容易被风控按「机器」标记，变一变更像人
      const jitter = Math.floor(Math.random() * 8) - 2;
      const targetX = fromX + travel + jitter;
      const targetY = fromY;
      console.log(`🖱️ 第 ${attempt}/${MAX_ATTEMPTS} 次仿人类滑动（位移≈${Math.round(travel + jitter)}px）…`);
      // 每轮步数随机：节奏各不相同，避���固定步数被风控按「机器」标记。
      // ⚠️ 用户 2026-09-02 反馈「滑动太慢，提速 0.5 倍」→ 步数由 40~64 降为 27~43（/1.5），
      //    整体时长由约 0.5~0.8s 降到约 0.35~0.55s，仍在真人手速区间（人手拖滑块通常 0.3~0.6s）。
      await humanDrag(this.page, fromX, fromY, targetX, targetY, {
        steps: 27 + Math.floor(Math.random() * 17),
      });

      // 拖完后轮询判定结果（最多 ~12s）。
      // 关键约束：
      //   (a) 优先 iframe 内显式成功/失败标志（不受阿里 detach/reattach 干扰）；
      //   (b) goneStreak 提升到 3（约 3s 连续消失），覆盖阿里"重新加载挑战"可能引起的 >1s 短暂 detach；
      //   (c) 触发 3 次 gone 时，再用【最新 frame】查 .errloading——若新挑战是失败态（用户实测 AT4xN1），
      //       一定要判失败，不能算通过。
      let outcome: 'success' | 'failed' | 'pending' = 'pending';
      let goneStreak = 0;
      let endStreak = 0; // 滑块"到终点且未失败"的稳定计数；阿里失败必显 errloading 并回弹，故终点稳定=通过
      const pollLog: string[] = [];
      for (let t = 0; t < 12; t++) {
        await this.page.waitForTimeout(1000);
        const st = await readOutcome();
        const modal = await detectModal();
        const atEnd = await reachedEnd();
        const pFrames = this.page.frames().filter((fr) => /\/punish\?/.test(fr.url()));
        pollLog.push(
          `t${t}:st=${st}|modal=${modal}|end=${atEnd}|streak=${goneStreak}|frames=${pFrames.length}(${(pFrames[0]?.url() || '').slice(0, 60)})`
        );
        if (st === 'success') {
          outcome = 'success';
          break;
        }
        if (st === 'failed') {
          outcome = 'failed';
          break;
        }
        // 🟢 滑块到终点且未失败：视为已提交/服务器接受中。稳定 3s（endStreak>=3）即判通过——
        // 这是对 detectModal 不可靠（阿里关闭按钮可能常驻 DOM）与 readOutcome 漏检成功文案的兜底。
        if (atEnd && st !== 'failed') {
          endStreak++;
          if (endStreak >= 3) {
            outcome = 'success';
            break;
          }
        } else {
          endStreak = 0;
        }
        if (!modal) {
          goneStreak++;
          if (goneStreak >= 3) {
            // 只有【页面已无任何 punish frame】才算弹窗真实关闭（成功）。
            // 若仍存在 punish frame（新挑战加载中，滑块/errloading 都还没渲染），
            // 绝不能判通过——这正是上一版 "cleared" 误判的漏洞（用户实测 errloading 在却判 success）。
            if (!this.page.frame({ url: /\/punish\?/ })) {
              outcome = 'success';
            } else {
              // 有 punish frame → 新挑战加载中/失败态即将出现 → 重置 streak 继续等
              goneStreak = 0;
            }
            if (outcome !== 'pending') break;
          }
        } else {
          goneStreak = 0;
        }
      }
      // 终点稳定判过后的二次确认：避免"阿里延迟弹 errloading（慢 reject）"被误判通过。
      // 若 2s 内出现失败标记，降级为失败走重试；否则确认通过。
      if (outcome === 'success') {
        await this.page.waitForTimeout(2000);
        if ((await readOutcome()) === 'failed') {
          console.log(`⚠️ 第 ${attempt} 次终点态后延迟出现失败标记，降级为失败重试…`);
          outcome = 'failed';
        }
      }
      console.log(`📋 第 ${attempt} 次轮询明细:`, pollLog.join(' | '));

      const after = await readSliderState();
      console.log(`🔍 第 ${attempt} 次拖动后滑块状态:`, JSON.stringify(after), '判定:', outcome);
      if (sub) {
        try {
          await this.page.screenshot({ path: path.join(sub, `after-drag-${attempt}.png`) });
          fs.writeFileSync(path.join(sub, `iframe-after-drag-${attempt}.html`), await frame.content());
        } catch {
          /* ignore */
        }
      }

      if (outcome === 'success') {
        console.log(`✅ 滑动验证通过（第 ${attempt} 次）`);
        return true;
      }

      // 区分「明确失败」与「结果未定」：
      //  - 明确失败（.errloading）：点击重试框换全新挑战（受信任鼠标，触发阿里重载→会有一次闪屏，属正常）；
      //  - 结果未定（超时但无失败标记）：多半是滑块仍在「验证中」卡住，**不要**盲目点容器
      //    （会误触发阿里重载→整页闪屏），直接稍等后在现有/新滑块上重拖一次。
      const explicitFail = (await readOutcome()) === 'failed';
      const endReached = await reachedEnd();
      if (explicitFail) {
        console.log(`⚠️ 第 ${attempt} 次明确失败（验证失败），点击重试框换新挑战…`);
        const clicked = await clickRetry();
        if (!clicked) {
          console.log('⚠️ 未找到重试框（可能已自动关闭），检查弹窗状态…');
          if (!(await detectModal())) {
            console.log('✅ 滑动验证通过');
            return true;
          }
        }
      } else if (endReached) {
        // 🟢 滑块已到终点且无失败标记：极可能已经提交/服务器接受。此前 bug 是把这当"未定"
        //    去点容器刷新，结果把已完成的挑战重置/触发重载 → 滑块不再渲染 → 卡死进人工模式
        //    （用户实测首滑已过却卡死）。修法：绝不刷新，改为延长等待服务器确认（弹窗关闭=成功；
        //    出现 errloading=失败）；仍卡住则转人工，避免破坏已提交态。
        console.log(`✅ 第 ${attempt} 次滑块已到终点且无失败标记，延长等待服务器确认（不刷新）…`);
        let confirmed: 'success' | 'failed' | 'pending' = 'pending';
        for (let w = 0; w < 10; w++) {
          await this.page.waitForTimeout(1000);
          if (!(await detectModal())) { confirmed = 'success'; break; }
          if ((await readOutcome()) === 'failed') { confirmed = 'failed'; break; }
        }
        if (confirmed === 'success') {
          console.log(`✅ 滑动验证通过（第 ${attempt} 次，终点态确认）`);
          return true;
        }
        if (confirmed === 'failed') {
          console.log(`⚠️ 延长等待期间出现失败标记，点击重试框换新挑战…`);
          const clicked = await clickRetry();
          if (!clicked && !(await detectModal())) { console.log('✅ 滑动验证通过'); return true; }
        } else {
          console.log('⚠️ 滑块已到终点但服务器长时间未确认');
          return this.retryOrManual(captureDir, restart, refreshCount, detectModal, sub, '滑块已到终点但服务器长时间未确认');
        }
      } else {
        // 结果未定且滑块未到终点：可能卡在「加载中/验证中」或挑战损坏。点容器强制换新挑战。
        console.log(`⚠️ 第 ${attempt} 次结果未定，多等 3s 复查…`);
        await this.page.waitForTimeout(3000);
        const st2 = await readOutcome();
        if (st2 === 'success') {
          console.log('✅ 滑动验证通过（延迟确认成功）');
          return true;
        }
        if (st2 !== 'failed') {
          console.log(`⚠️ 第 ${attempt} 次仍未定（可能卡在加载），点击容器强制换新挑战…`);
          const ib = await this.page.locator('#baxia-dialog-content').boundingBox();
          if (ib) {
            const f = latestFrame();
            if (f) {
              const box = await f
                .evaluate(() => {
                  const el =
                    document.querySelector('.nc_wrapper') || document.querySelector('#nocaptcha');
                  if (!el) return null;
                  const r = el.getBoundingClientRect();
                  return { x: r.x, y: r.y, w: r.width, h: r.height };
                })
                .catch(() => null);
              if (box) {
                const cx = ib.x + box.x + box.w / 2;
                const cy = ib.y + box.y + box.h / 2;
                await this.page.mouse.move(cx, cy, { steps: 1 });
                await humanDelay(...QIANWEN_CAPTCHA_REFRESH_DOWN);
                await this.page.mouse.down();
                await humanDelay(...QIANWEN_CAPTCHA_REFRESH_HOLD);
                await this.page.mouse.up();
                await this.page.waitForTimeout(1500);
              }
            }
          }
        }
      }
      // 重试后 iframe 可能 navigate 到新 punish URL（旧 frame 失效）→ 重新获取再等滑块
      let reFrame: Frame | null = null;
      for (let g = 0; g < 12; g++) {
        const f = this.page.frame({ url: /\/punish\?/ });
        if (f) {
          reFrame = f;
          break;
        }
        await this.page.waitForTimeout(400);
      }
      const reReady = reFrame ? await waitForSliderReady(reFrame) : null;
      if (!reReady) {
        // 滑块没重新渲染：可能上一轮其实已出结果（成功关闭 / 失败框）。别急着放弃，复查一次。
        await this.page.waitForTimeout(4000);
        const st3 = await readOutcome();
        if (!(await detectModal()) || st3 === 'success') {
          console.log('✅ 滑动验证通过（复查确认）');
          return true;
        }
        console.log('⚠️ 重试后未能重新渲染滑块');
        return this.retryOrManual(captureDir, restart, refreshCount, detectModal, sub, '重试后未能重新渲染滑块');
      }
      frame = reFrame ?? frame;
      sliderInfo = reReady;
      await this.page.waitForTimeout(600);
    }

    // 本轮 2 次滑动都失败 → 统一走刷新重开（额度内刷新，用尽才转人工）
    return this.retryOrManual(
      captureDir,
      restart,
      refreshCount,
      detectModal,
      sub,
      `本轮 ${MAX_ATTEMPTS} 次滑动均未通过`
    );
  }

  // 滑动/准备失败的**统一收口**（用户 2026-09-02 实操经验：失败后刷新页面重开，一次基本能过）。
  //   - 还有刷新额度 → restart() 刷新重开，再递归重跑完整流程；
  //   - 额度用尽，或调用方没提供 restart → 才转「等待人工滑动」。
  // ⚠️ MAX_REFRESH 硬卡 3 次 + 递归深度有限，绝不可能无限刷新（用户明确要求不能死循环）。
  private async retryOrManual(
    captureDir: string | undefined,
    restart: (() => Promise<void>) | undefined,
    refreshCount: number,
    detectModal: () => Promise<boolean>,
    sub: string | null,
    reason: string
  ): Promise<boolean> {
    const MAX_REFRESH = 3;
    if (restart && refreshCount < MAX_REFRESH) {
      console.log(`🔄 ${reason} → 第 ${refreshCount + 1}/${MAX_REFRESH} 次刷新页面重开…`);
      try {
        await restart();
      } catch (e) {
        console.log(`⚠️ 刷新重开失败：${(e as Error).message}，进入等待人工滑动模式`);
        return this.waitForManualSlide(detectModal, sub);
      }
      // 递归重跑完整流程：重新监控弹窗 → 重新等滑块就绪 → 重新滑
      return this.solveCaptcha(captureDir, restart, refreshCount + 1);
    }
    console.log(
      restart
        ? `⚠️ ${reason}，且刷新重开 ${MAX_REFRESH} 次仍未通过，进入等待人工滑动模式`
        : `⚠️ ${reason}（调用方未提供刷新重开能力），进入等待人工滑动模式`
    );
    return this.waitForManualSlide(detectModal, sub);
  }

  // 等待人工滑动（不卡死 run）
  private async waitForManualSlide(detectModal: () => Promise<boolean>, sub: string | null): Promise<boolean> {
    console.log('⏳ 请手动滑动验证码，程序会自动继续…');
    const deadline = Date.now() + 120000;
    let m = 0;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(2000);
      const still = await detectModal();
      if (!still) {
        console.log('✅ 人工滑动已通过，继续诊断');
        return true;
      }
      if (sub && m % 6 === 0) {
        try {
          await this.page.screenshot({ path: path.join(sub, `manual-wait-${String(m).padStart(2, '0')}.png`) });
        } catch {
          /* ignore */
        }
      }
      m++;
    }
    console.log('⚠️ 等待人工滑动超时（120s），本次按未通过继续');
    return false;
  }
}
