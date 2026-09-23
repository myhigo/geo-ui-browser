import { Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { YUANBAO_CANDIDATE_SELECTORS } from './selectors.js';
import { firstFound } from '../../diagnostics/elementProbe.js';
import { humanClick } from '../../diagnostics/human.js';
import { randWaitMs } from '../../tuning/delays.js';
import { CandidateSelectors, PlatformAdapter, SourceInfo, ScreenshotMode } from '../../types.js';

// 元宝引用数据提取（运行在 Node 侧，非浏览器上下文）：聊天 API 响应为 SSE，
// 其中 docs 数组含每条信源的 {index,docId,title,url,quote,...}。用 docId 定位对象、
// brace-match 取出完整对象，再抽取 title/url（过滤元宝/腾讯系域名）。
type RawRef = { title?: string; url: string; quote?: string };
function extractRefsFromText(txt: string): RawRef[] {
  const out: RawRef[] = [];
  const re = /"docId"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt))) {
    const start = txt.lastIndexOf('{', m.index);
    let depth = 0;
    let j = m.index;
    for (; j < txt.length; j++) {
      if (txt[j] === '{') depth++;
      else if (txt[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    const obj = txt.slice(start, j + 1);
    const urlM = obj.match(/"url"\s*:\s*"(https?:\/\/[^"]+)"/);
    if (!urlM) continue;
    const url = urlM[1];
    if (/yuanbao\.tencent\.com|hunyuan\.tencent|tencent\.com|qq\.com/i.test(url)) continue;
    const tM = obj.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const title = tM ? tM[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim() : undefined;
    const qM = obj.match(/"quote"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const quote = qM ? qM[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim() : undefined;
    out.push({ title, url, quote });
  }
  return out;
}
function mergeRefs(a: RawRef[], b: RawRef[]): RawRef[] {
  const seen = new Set(a.map((r) => r.url));
  for (const r of b) if (!seen.has(r.url)) { seen.add(r.url); a.push(r); }
  return a;
}

// 腾讯部分 SSE/JSON 响应存在双重编码：原始 UTF-8 字节先被按 cp1252 解读成字符串，
// 再按 UTF-8 编码返回（例如 /api/chat/ 的 title 字段）。常见症状：中文变成
// "Ã©â\x80\x9c..." / "ç›¸å…³è§†é¢‘" 等 mojibake。detail 端点通常是干净 UTF-8。
// 这里做 cp1252 回退，并以「CJK 字符数更多」作为择优标准，两端都兼容。
const CP1252_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};
function toCp1252Bytes(s: string): Buffer {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (CP1252_EXTRA[cp] !== undefined) out.push(CP1252_EXTRA[cp]);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else out.push(0x3f); // fallback '?'
  }
  return Buffer.from(out);
}
function fixMojibake(s: string): string {
  try { return toCp1252Bytes(s).toString('utf-8'); } catch { return s; }
}
function countCJK(s: string): number {
  return Array.from(s).filter((ch) => {
    const cp = ch.codePointAt(0)!;
    return (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2a700 && cp <= 0x2b73f) ||
      (cp >= 0x2b740 && cp <= 0x2b81f) ||
      (cp >= 0x2b820 && cp <= 0x2ceaf) ||
      (cp >= 0x2ceb0 && cp <= 0x2ebef)
    );
  }).length;
}

// 元宝（腾讯 Yuanbao）适配器 —— 2026-09-07 真实 DOM 校准版（用户登录后落盘 finished.html 实测定标）。
//   DOM 结构已据真实页面校准：输入框 contenteditable、发送钮 #yuanbao-send-btn、回答气泡
//   .agent-chat__bubble--ai、引用列表 .hyc-common-markdown__ref-list__item（来源名在 __name）。
//   ⚠️ 元宝引用条目是「内部知识来源」标记：DOM 中【无真实文章 URL】（全页仅埋点外链），
//      故信源以【来源名】归因（platform=来源名），url 留空；信源分析侧按 siteName 归因（见 sourceAnalysis）。
// 设计原则（与千问/文心一致，平台操作全部私有，禁止共享基类/通用函数）：
//    - 交互逻辑独立实现，可独立演进；
//    - getSources / getAnswer 均带 captureDir 落盘探针，便于登录后读 DOM 校准选择器与信源结构；
//    - 可选钩子 captureQaScreenshot / dismissAds / solveCaptcha 初版先不实现（run.ts 对缺失项安全跳过），
//      待元宝真实页面确认需要截图/广告/验证码处理时再补。

// 真人节奏延迟（元宝初版沿用通用区间；后续按元宝实测手感微调，不跨平台引用其它适配器常量）
const FOCUS_SETTLE: [number, number] = [120, 120];
const FOCUS_AFTER: [number, number] = [60, 0];
const PRE_TYPE: [number, number] = [500, 1500];

export class YuanbaoAdapter implements PlatformAdapter {
  constructor(
    private page: Page,
    private context: BrowserContext,
    private selectors: CandidateSelectors = YUANBAO_CANDIDATE_SELECTORS
  ) {
    this.installReferenceCapture();
  }

  // 引用数据捕获：元宝真实信源不在可见 DOM 文本里（引用条目仅图标 + data-idx-list 索引），
  // 而在聊天 API 响应 /api/chat/ 与 /api/user/agent/conversation/v1/detail 的 docs 数组
  // （含 index/docId/title/url/quote）。拦截这两个响应，解析 docs 即可拿到全部真实信源。
  private chatRefs: { title?: string; url: string; quote?: string }[] = [];
  private detailRefs: { title?: string; url: string; quote?: string }[] = [];
  private refCaptureInstalled = false;
  private installReferenceCapture(): void {
    if (this.refCaptureInstalled) return;
    this.refCaptureInstalled = true;
    this.page.on('response', (resp) => {
      const u = resp.url();
      const isChat = /yuanbao\.tencent\.com\/api\/chat\//.test(u);
      const isDetail = /yuanbao\.tencent\.com\/api\/user\/agent\/conversation\/v1\/detail/.test(u);
      if (!isChat && !isDetail) return;
      resp
        .body()
        .then((buf) => {
          if (!buf) return;
          // ⚠️ /api/chat/ 等响应存在双重编码：原始 UTF-8 被按 cp1252 解读成 str 后再按 UTF-8 编码
          //   → mojibake（conversation/v1/detail 通常是干净 UTF-8）。
          //   先按 UTF-8 解码，再做 cp1252 回退，选择 CJK 字符更多的版本。
          const rawUtf8 = buf.toString('utf-8');
          const fixed = fixMojibake(rawUtf8);
          const txt = countCJK(fixed) > countCJK(rawUtf8) ? fixed : rawUtf8;
          const refs = extractRefsFromText(txt);
          if (!refs.length) return;
          if (isChat) this.chatRefs = mergeRefs(this.chatRefs, refs);
          else this.detailRefs = mergeRefs(this.detailRefs, refs);
        })
        .catch(() => {});
    });
  }

  // 登录墙检测（初版启发式）：有输入框 → 视为可对话（登录态/匿名可用）；否则看有无登录入口。
  // ⚠️ 元宝真实登录墙结构未知，待登录落盘后校准（例如某些登录墙仍渲染输入框但禁发，到时需在
  //    这里补元宝专属登录墙 marker 判定）。
  // 登录墙检测（初版）：用「通用输入框」判定而非未校准的占位候选选择器——
  // 元宝对话页（已登录）必有可对话输入框（contenteditable/textarea/input），命中即视为可对话（已登录）；
  // 否则看有无登录入口，都没有则兜底视为需登录。⚠️ 待落盘真实 DOM 后若有特例再补元宝专属 marker。
  async checkLogin(): Promise<boolean> {
    const hasInput = await this.page
      .locator('textarea, input, [contenteditable="true"]')
      .count()
      .catch(() => 0);
    if (hasInput > 0) return false; // 有可对话输入框 → 已登录可聊
    const loginBtn = this.page.locator('a:has-text("登录"), button:has-text("登录")');
    if ((await loginBtn.count()) > 0) return true;
    return true; // 兜底：没输入框就没法问答
  }

  // 输入并发送问题：聚焦可编辑区 → 逐字真人打字 → 点一次发送钮 → 以「助手气泡出现」确认发送。
  // ⚠️ 关键修复（2026-09-07）：元宝发送后【不立即清空输入框】，旧逻辑用「输入框是否清空」判断
  //    是否发送成功会误判为未发送 → 触发兜底二次点击 → 而发送钮在回答生成中是「停止」切换，
  //    二次点击即中断回答。故改为：只点一次发送钮，确认标志是「.agent-chat__bubble--ai 出现」，
  //    Enter 仅作为「发送钮未生效」的兜底（且仅一次），绝不重复点钮，杜绝双发中断。
  async sendQuestion(question: string): Promise<void> {
    const input = await firstFound(this.page, this.selectors.input);
    if (!input) throw new Error('ELEMENT_NOT_FOUND: input');

    await humanClick(this.page, this.selectors.input.join(', ')).catch(() => {});
    await this.page.waitForTimeout(randWaitMs(FOCUS_SETTLE));
    await input.locator.focus().catch(() => {});
    await this.page.waitForTimeout(randWaitMs(FOCUS_AFTER));

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
      console.warn('⚠️ 元宝编辑器未获焦点，尝试 textarea 兜底聚焦');
      const ta = this.page.locator('textarea').first();
      await ta.click().catch(() => {});
      await ta.focus().catch(() => {});
    }

    if (!(await focusedEditable())) {
      await input.locator.focus().catch(() => {});
    }
    await this.page.waitForTimeout(randWaitMs(PRE_TYPE));
    await this.humanType(question);

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
      console.warn('⚠️ 元宝输入校验失败：问题文本未进入输入框，请人工检查（见 02-question.png）');
    }

    // ① 只点一次发送钮（稳定选择器：#yuanbao-send-btn / a[aria-label="发送"]）
    const sendSel = this.selectors.sendButton.join(', ');
    await humanClick(this.page, sendSel);
    if (await this.waitAnswerStarted(15000)) return; // 助手气泡出现=已发送，立即返回（不二次点）

    // ② 兜底：发送钮未生效时尝试一次 Enter（仅一次，不重复点钮，避免双发中断）
    await this.page.keyboard.press('Enter').catch(() => {});
    if (await this.waitAnswerStarted(15000)) return;

    console.warn('⚠️ 元宝发送未能确认（未见助手回答气泡），请人工检查发送交互');
  }

  // 发送确认：等待助手气泡（.agent-chat__bubble--ai）出现即视为发送成功。
  // 区别于旧「输入框清空」判定——元宝发送后保持输入框文本，旧判定会误触发二次点击。
  private async waitAnswerStarted(timeoutMs = 15000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await this.page
        .evaluate(() => !!document.querySelector('.agent-chat__bubble--ai, [class*="bubble--ai"]'))
        .catch(() => false);
      if (ok) return true;
      await this.page.waitForTimeout(400);
    }
    return false;
  }

  // 模拟真人逐字输入
  private async humanType(text: string): Promise<void> {
    const punctuations = '，。、；：？！,.!?;:';
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      let d = 180 + Math.floor(Math.random() * 270);
      if (punctuations.includes(ch)) d += 200 + Math.floor(Math.random() * 300);
      if (Math.random() < 0.08) d += 400 + Math.floor(Math.random() * 500);
      await this.page.waitForTimeout(d);
    }
  }

  // 等待流式回答完整输出。
  //   元宝专属完成信号（2026-09-08 用户确认）：AI 回答操作栏中的「重新生成（Repeat_）」/
  //   「赞/踩（ToolbarSuitable_）」按钮【只在回答完整后才渲染】。比「文本长度稳定 8s」更稳更快
  //   （视频卡片/秒答/纯图片答案也能立即判定）。两个信号并行竞速，任意一个命中即视为完成。
  //   ⚠️ 区分：用户的「复制/编辑问题」操作栏（ToolbarCopy_/agent-chat__conv--human__toolbar）
  //      在发问前就存在，不能用作信号；元宝专属的 Repeat_/ToolbarSuitable_ 是回答完成后才出现。
  //   evaluate 内一律匿名。
  async waitForAnswer(timeoutMs = 180000): Promise<void> {
    const start = Date.now();

    // 信号 A：AI 回答操作栏的「重新生成」或「赞/踩」按钮可见
    const actionBarDone = this.page
      .waitForSelector('[class*="Repeat_"], [class*="ToolbarSuitable_"]', {
        timeout: timeoutMs,
        state: 'visible',
      })
      .then(() => 'action-bar' as const)
      .catch(() => 'action-bar-timeout' as const);

    // 信号 B：文本长度先增长后稳定的兜底
    const textStableDone = (async (): Promise<'text-stable' | 'text-timeout' | 'text-stable-cache'> => {
      const growthSel = this.selectors.answerContainer.join(', ');
      const getAnswerLen = async (): Promise<number | null> =>
        this.page
          .evaluate((sel) => {
            const nodes = document.querySelectorAll(sel);
            const el = nodes.length ? nodes[nodes.length - 1] : null;
            return el ? (el.textContent || '').length : null;
          }, growthSel)
          .catch(() => null);

      let lastLen: number | null = null;
      let everGrew = false;
      let noGrowth = 0;
      let lastProgressLog = Date.now();

      while (Date.now() - start < timeoutMs) {
        const len = await getAnswerLen();
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

        if (everGrew && noGrowth >= 8) {
          console.log(
            `[${(Date.now() - start) / 1000}s] 🏁 元宝回答文本连续 8s 无增长（兜底），当前 ${lastLen ?? 0} 字`
          );
          return 'text-stable';
        }
        if (noGrowth >= 40) {
          console.log(
            `[${(Date.now() - start) / 1000}s] 🏁 元宝文本连续 40s 无增长（可能缓存/瞬时答案），当前 ${lastLen ?? 0} 字`
          );
          return 'text-stable-cache';
        }

        if (Date.now() - lastProgressLog > 10000) {
          const phase = everGrew ? '📝 回答流式输出中…' : '⏳ 检索/思考中…';
          console.log(
            `[${(Date.now() - start) / 1000}s] ${phase}（容器 ${len === null ? '未出现' : len + ' 字'}）`
          );
          lastProgressLog = Date.now();
        }
        await this.page.waitForTimeout(1000);
      }
      return 'text-timeout';
    })();

    // 任意一个先到即完成
    const winner = await Promise.race([actionBarDone, textStableDone]);
    console.log(
      `[${(Date.now() - start) / 1000}s] ✅ 元宝回答输出完成（信号: ${winner}），开始抽取`
    );
    await this.page.waitForTimeout(500);
  }

  // 抽取回答正文；定位不到 → null。取最后一个助手气泡（最新回答），克隆后剔除噪音再读文本。
  async getAnswer(): Promise<string | null> {
    return this.page
      .evaluate((sels: string[]) => {
        let el: Element | null = null;
        for (const s of sels) {
          const nodes = document.querySelectorAll(s);
          if (nodes.length) {
            el = nodes[nodes.length - 1];
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

  // 展开信源（仅作 DOM 兜底展开；主路径是 API 拦截，见 installReferenceCapture）。
  //   ⚠️ 用户反馈：运行中浏览器被打开了几个信源地址（新标签页）——元宝的 ref trigger / 「查看来源」
  //      按钮点击后会打开对应外部信源页。而真实信源已由 /api/chat/ 与 conversation/v1/detail 的
  //      docs 数组拦截拿到（chatRefs/detailRefs），DOM 展开点击完全多余且有害。
  //   ⇒ API 已拿到信源时【跳过一切点击】；仅 API 未命中（罕见兜底）才展开，且不点被 <a href=外链>
  //      包裹的元素，避免误开外部页。
  async expandSources(): Promise<void> {
    const page = this.page;
    if (this.chatRefs.length || this.detailRefs.length) {
      console.log(
        `⏭️ [元宝] 信源已由 API 拦截拿到（chat=${this.chatRefs.length}/detail=${this.detailRefs.length}），跳过 DOM 展开点击（避免误开外链新标签）`
      );
      return;
    }
    const triggers = this.page.locator('.hyc-common-markdown__ref-list__trigger');
    const tCount = await triggers.count().catch(() => 0);
    for (let i = 0; i < Math.min(tCount, 12); i++) {
      const extWrap = await triggers
        .nth(i)
        .evaluate((n) => {
          const link = n.closest('a[href^="http"]');
          return !!link && !/yuanbao\.tencent\.com/.test(link.getAttribute('href') || '');
        })
        .catch(() => true);
      if (extWrap) continue; // 被外链 <a> 包裹 → 点击会开新页，跳过
      await triggers.nth(i).click({ timeout: 3000 }).catch(() => {});
      await this.page.waitForTimeout(400);
    }
    const txtBtns = this.page
      .locator('button, [role="button"]')
      .filter({ hasText: /展开|查看来源|查看引用|查看信源|信源|参考|来源/ });
    const bCount = await txtBtns.count().catch(() => 0);
    for (let i = 0; i < Math.min(bCount, 8); i++) {
      const extWrap = await txtBtns
        .nth(i)
        .evaluate((n) => {
          const link = n.closest('a[href^="http"]');
          return !!link && !/yuanbao\.tencent\.com/.test(link.getAttribute('href') || '');
        })
        .catch(() => true);
      if (extWrap) continue;
      await txtBtns.nth(i).click({ timeout: 3000 }).catch(() => {});
      await this.page.waitForTimeout(300);
    }
    await this.page.waitForTimeout(3000);
  }

  // 抽取信源列表（URL + 标题 + 平台）。初版分层兜底：
  //   ① 旧结构引用胶囊 a[class*=bg-option]；② reference 容器内 <a>；③ 回答卡片内 <a>；
  //   ④ 外层 wrap 兜底（全部外链）；⑤ 新版内嵌 JSON norm_url（多平台新结构并存，先覆盖）。
  // 外链过滤元宝自身域名（yuanbao.tencent.com）；其余真实来源站点留待校准后细化。
  // 语义约定（与 run.ts 的 sourceCount 对齐）：信源区存在但 0 条 → []；连信源区都定位不到 → null。
  async getSources(captureDir?: string): Promise<SourceInfo[] | null> {
    type Attempt = { found: boolean; items: { title?: string; url?: string; platform?: string }[]; diag: Record<string, unknown> };
    let last: Attempt = null;
    for (let attempt = 0; attempt < 14; attempt++) {
      last = await this.page
        .evaluate((areaSel: string) => {
          try {
          const diag = {
            bgOptions: document.querySelectorAll('a[class*="bg-option"]').length,
            refAreas: document.querySelectorAll('[class*="reference"]').length,
            refListAreas: document.querySelectorAll('.hyc-common-markdown__ref-list').length,
            refTriggers: document.querySelectorAll('.hyc-common-markdown__ref-list__trigger').length,
            refWrapExists: !!document.querySelector(areaSel),
            refWrapAnchors: document.querySelector(areaSel)?.querySelectorAll('a').length ?? 0,
            cardAnchors:
              document.querySelector('[class*="answer"]')?.querySelectorAll('a').length ?? 0,
            wrapAnchors:
              document.querySelector('[class*="message"]')?.querySelectorAll('a').length ?? 0,
          };
          // ① 旧结构：bg-option 胶囊
          const m1 = Array.from(document.querySelectorAll('a[class*="bg-option"]'))
            .map((a) => ({ title: ((a.querySelector('.truncate')?.textContent || a.textContent || '') as string).trim() || undefined, url: a.getAttribute('href') || undefined }))
            .filter((s) => !!s.url && /^https?:\/\//i.test(s.url) && !/yuanbao\.tencent\.com/i.test(s.url));
          if (m1.length) return { found: true, items: m1, diag };
          // ② reference 容器内 <a>
          for (const area of Array.from(document.querySelectorAll('[class*="reference"]'))) {
            const anc = Array.from(area.querySelectorAll('a'))
              .map((a) => ({ title: (a.textContent || '').trim() || undefined, url: a.getAttribute('href') || undefined }))
              .filter((s) => !!s.url && /^https?:\/\//i.test(s.url) && !/yuanbao\.tencent\.com/i.test(s.url));
            if (anc.length) return { found: true, items: anc, diag };
          }
          // ③ 回答卡片内全部外链
          const card = document.querySelector('[class*="answer"]');
          if (card) {
            const anc = Array.from(card.querySelectorAll('a'))
              .map((a) => ({ title: (a.textContent || '').trim() || undefined, url: a.getAttribute('href') || undefined }))
              .filter((s) => !!s.url && /^https?:\/\//i.test(s.url) && !/yuanbao\.tencent\.com/i.test(s.url));
            if (anc.length) return { found: true, items: anc, diag };
          }
          // ④ 外层 wrap 兜底
          const wrapEl = document.querySelector('[class*="message"]');
          if (wrapEl) {
            const anc = Array.from(wrapEl.querySelectorAll('a'))
              .map((a) => ({ title: (a.textContent || '').trim() || undefined, url: a.getAttribute('href') || undefined }))
              .filter((s) => !!s.url && /^https?:\/\//i.test(s.url) && !/yuanbao\.tencent\.com/i.test(s.url));
            if (anc.length) return { found: true, items: anc, diag };
          }
          // ④½ 元宝信源：source 容器内引用条目可能非 <a>，URL 藏在 data-url / data-href
          const srcWrap = document.querySelector('[class*="source"]');
          if (srcWrap) {
            const sitems = Array.from(srcWrap.querySelectorAll('a, [data-url], [data-href]'))
              .map((n) => {
                const eln = n as HTMLElement;
                const href =
                  (n as HTMLAnchorElement).getAttribute?.('href') ||
                  eln.getAttribute('data-url') ||
                  eln.getAttribute('data-href') ||
                  '';
                return { title: (eln.textContent || '').trim() || undefined, url: href || undefined };
              })
              .filter((s) => !!s.url && /^https?:\/\//i.test(s.url) && !/yuanbao\.tencent\.com/i.test(s.url));
            if (sitems.length) return { found: true, items: sitems, diag: { ...diag, sourceItems: sitems.length } };
          }
          // ⑤ 新版结构：内嵌 JSON 的 norm_url 真实地址字段
          const html5 = document.documentElement.innerHTML;
          const normUrls = Array.from(html5.matchAll(/"norm_url"\s*:\s*"([^"]*)"/g))
            .map((mm) => mm[1].replace(/\\\//g, '/'))
            .filter((u) => /^https?:\/\//i.test(u) && !/yuanbao\.tencent\.com/i.test(u));
          if (normUrls.length) return { found: true, items: normUrls.map((u) => ({ url: u })), diag: { ...diag, normUrls: normUrls.length } };

          // ⑥ 元宝引用面板（点击 trigger 展开后）将真实来源以 <a href> 渲染于文档任意处。
          //   展开前全文档无外链（仅框架资源），故展开后出现的外链即引用来源——全文档扫描兜底。
          const allExt = Array.from(document.querySelectorAll('a[href^="http"]'))
            .map((a) => ({ title: (a.textContent || '').trim() || undefined, url: a.getAttribute('href') || undefined }))
            .filter((s) => !!s.url && /^https?:\/\//i.test(s.url) && !/yuanbao\.tencent\.com/i.test(s.url));
          if (allExt.length) return { found: true, items: allExt, diag: { ...diag, allExt: allExt.length } };
          // ⑦ 元宝真实引用条目（来源名，可能无 URL）：.hyc-common-markdown__ref-list__item__name。
          //   ⚠️ 元宝引用是「内部知识来源」标记，DOM 中无真实文章 URL（全页仅埋点外链），
          //      故以【来源名】作为有效信源（platform=来源名），url 留空；信源分析侧按 siteName 归因。
          const refItems = Array.from(document.querySelectorAll('.hyc-common-markdown__ref-list__item'));
          const named: { title?: string; url?: string; platform?: string }[] = [];
          const seenName = new Set<string>();
          for (const ri of refItems) {
            const nm = ri.querySelector('.hyc-common-markdown__ref-list__item__name');
            const title = ((nm?.textContent) || ri.textContent || '').trim();
            if (!title || seenName.has(title)) continue; // 图标/占位项跳过
            seenName.add(title);
            const href =
              ri.getAttribute('data-url') ||
              ri.getAttribute('data-href') ||
              (ri.querySelector('a')?.getAttribute('href') || '');
            named.push({
              title,
              url: /^https?:\/\//i.test(href) && !/yuanbao\.tencent\.com/i.test(href) ? href : undefined,
              platform: title,
            });
          }
          if (named.length) return { found: true, items: named, diag: { ...diag, namedRefs: named.length } };
          return { found: diag.refWrapExists || diag.refListAreas > 0, items: [], diag };
          } catch (e) {
            return { found: false, items: [], diag: { error: (e as Error).message, stack: (e as Error).stack } };
          }
        }, this.selectors.sourceArea.join(', '))
        .catch((e) => {
          if (attempt === 0) console.log(`[元宝信源诊断] evaluate 异常：${(e as Error).message}`);
          return null;
        });
      if (last && last.found && last.items.length > 0) break;
      await this.page.waitForTimeout(800);
    }
    const attemptErr =
      (last && (last.diag as Record<string, unknown>)?.error) || (last ? null : 'evaluate_rejected_all_attempts');
    console.log(`[元宝信源诊断] ${JSON.stringify(last?.diag ?? { none: true })}，抽到 ${last?.items.length ?? 0} 条`);

    // 全量扫描落盘：无论是否定位到/是否抛错都落盘（之前静默失败无落盘，导致排查无据），便于校准与定位根因
    if (captureDir) {
      const scan = await this.page
        .evaluate((cnt: number) => {
          const ref = document.querySelector('[class*="reference"]');
          const srcWrap = document.querySelector('[class*="source"]');
          const extAnchors = Array.from(document.querySelectorAll('a[href^="http"]'))
            .map((a) => {
              const anc: string[] = [];
              let p = a.parentElement;
              for (let i = 0; p && i < 8; i++) {
                anc.push((p.className || '').toString().slice(0, 90));
                p = p.parentElement;
              }
              const href = a.getAttribute('href') || '';
              return {
                text: (a.textContent || '').trim().slice(0, 80),
                href: href.slice(0, 140),
                external: /^https?:\/\//i.test(href) && !/yuanbao\.tencent\.com/i.test(href),
                ancestors: anc,
              };
            });
          const refAll = Array.from(document.querySelectorAll('[class*="reference"]')).map((e) => e.outerHTML.slice(0, 6000));
          const sourceContainers = Array.from(document.querySelectorAll('[class*="source"]'))
            .slice(0, 5)
            .map((e) => e.outerHTML.slice(0, 4000));
          // 元宝引用列表展开后面板（真实来源在此）
          const refListContainers = Array.from(document.querySelectorAll('.hyc-common-markdown__ref-list'))
            .slice(0, 5)
            .map((e) => e.outerHTML.slice(0, 6000));
          return {
            ts: Date.now(),
            found: !!ref || !!srcWrap || document.querySelectorAll('.hyc-common-markdown__ref-list').length > 0,
            items: cnt,
            refHTML: ref ? ref.outerHTML.slice(0, 8000) : '',
            sourceContainers,
            refListContainers,
            docExtAnchors: extAnchors,
            refAllHTML: refAll,
          };
        }, (last?.items.length ?? 0))
        .catch((e) => ({ error: (e as Error).message }));
      const scanOut = { ts: Date.now(), attemptError: attemptErr, scan };
      const p = path.join(captureDir, 'sources-scan.json');
      fs.writeFileSync(p, JSON.stringify(scanOut, null, 2));
      console.log(`[元宝信源诊断] 全量扫描已落盘：${path.relative(process.cwd(), p)}`);
    }
    // 优先用 API 拦截拿到的真实引用：元宝信源不在可见 DOM 文本里，全靠 chat/detail 响应的 docs 数组。
    const apiRefs = this.chatRefs.length ? this.chatRefs : this.detailRefs;
    if (apiRefs.length) {
      console.log(
        `[元宝信源] 经 API 拦截拿到 ${apiRefs.length} 条真实信源（chat=${this.chatRefs.length}/detail=${this.detailRefs.length}）`
      );
      const seen = new Set<string>();
      const items = apiRefs.filter((s) => {
        if (seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
      });
      return items.map((s) => ({ title: s.title, url: s.url, platform: this.derivePlatform(s.title, s.url) }));
    }

    if (!last) return null;

    // 校准落盘：信源区在但最终 0 条 → 抓现场
    if (last.found && last.items.length === 0 && captureDir) {
      const dump = await this.page
        .evaluate(() => {
          const ref = document.querySelector('[class*="reference"]');
          const srcWrap = document.querySelector('[class*="source"]');
          const extAnchors = Array.from(document.querySelectorAll('a[href^="http"]'))
            .slice(0, 10)
            .map((a) => {
              const anc: string[] = [];
              let p = a.parentElement;
              for (let i = 0; p && i < 6; i++) {
                anc.push((p.className || '').toString().slice(0, 90));
                p = p.parentElement;
              }
              return { text: (a.textContent || '').trim().slice(0, 60), href: (a.getAttribute('href') || '').slice(0, 90), ancestors: anc };
            });
          return {
            ts: Date.now(),
            refHTML: ref ? ref.outerHTML.slice(0, 8000) : '',
            sourceContainers: srcWrap ? [srcWrap.outerHTML.slice(0, 8000)] : [],
            docExtAnchors: extAnchors,
          };
        })
        .catch(() => null);
      if (dump) {
        const p = path.join(captureDir, 'sources-debug.json');
        fs.writeFileSync(p, JSON.stringify(dump, null, 2));
        console.log(`[元宝信源诊断] 0 条现场已落盘：${path.relative(process.cwd(), p)}`);
      }
    }
    if (!last.found) return null;
    if (last.items.length === 0) return [];
    const seen = new Set<string>();
    const items = last.items.filter((s) => {
      if (!s.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });
    return items.map((s) => ({ title: s.title, url: s.url, platform: s.platform ?? this.derivePlatform(s.title, s.url) }));
  }

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

  // 长屏截图（策略 A：clip 裁剪）。
  //   元宝回答形态复杂：可能是长文本（.hyc-common-markdown）、视频卡片（.ybc-chat-videoBoxV2-v3Card）
  //   或气泡卡片；且对话列表常带虚拟滚动 / content-visibility，导致回答容器量出来 0 高。策略：
  //   ① 多候选锚点（按真实高度择优，避开 0 尺寸占位项）；② 滚入视图；③ 强制可见并覆盖子树
  //     （!important 以压住可能带权重的 content-visibility:auto）；④ 隐藏问答块外浮层；
  //   ⑤ page.screenshot({ clip }) 按绝对坐标裁剪，不做可见性/稳定性检查。
  //   若主策略仍量不到，兜底裁剪「最后一条用户问题 → 对话列表底部」的对话区域（仍非整页）。
  //   ⚠️ evaluate 内一律内联，禁止具名/变量赋值函数（esbuild keepNames 注入 __name → 页面报错）。
  async captureQaScreenshot(outPath: string, mode: ScreenshotMode = 'expand'): Promise<void> {
    if (mode === 'stitch') {
      console.log('⚠️ 元宝策略 B（滚动分段拼接）尚未实现，本次回退到策略 A（clip 裁剪）');
    }
    const page = this.page;
    const aiCands = [
      '.agent-chat__list__item--ai',
      '.agent-chat__bubble--ai',
      '[class*="videoBoxV2-v3Card"]', // 视频答案卡片（如「相关视频」）
      '.ybc-chat-videoBoxV2-v3Card',
      '.hyc-common-markdown', // 文本答案 markdown
      '.agent-chat__list__item__content',
    ];
    const fbCands = [
      '.agent-chat__list__content',
      '.agent-chat__list',
      '[class*="message"]',
      '.agent-dialogue__content--common__content',
    ];

    // 主策略：单次 evaluate 内选锚、滚入视图、强制可见、量取 clip（避免跨 evaluate 状态丢失）
    const main = await page
      .evaluate(
        (args: { ai: string[]; fb: string[] }) => {
          const st = document.createElement('style');
          st.textContent = '*{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
          document.head.appendChild(st);

          const docH0 = document.documentElement.scrollHeight;
          // ⚠️ 本 evaluate 全程匿名：esbuild keepNames 会给「具名 const 箭头/具名函数」注入 __name，
          //    浏览器页面无 __name → ReferenceError（已在线上踩坑：qa-shot-v3 eval-error）。
          //    故一律内联匿名回调，禁止 const setImportant/measureAll/forceVisible 这类定义。
          const measured: { sel: string; el: Element; h: number; w: number; sh: number; ch: number; cv: string }[] = [];
          args.ai.forEach((s) => {
            document.querySelectorAll(s).forEach((el) => {
              const r = el.getBoundingClientRect();
              measured.push({ sel: s, el, h: r.height, w: r.width, sh: (el as HTMLElement).scrollHeight, ch: (el as HTMLElement).clientHeight, cv: getComputedStyle(el).contentVisibility });
            });
          });
          const aiSummary = measured.map((x) => ({ sel: x.sel, h: Math.round(x.h), sh: x.sh, ch: x.ch, cv: x.cv }));

          measured.sort((x, y) => y.h - x.h);
          let best = measured[0] || null;
          let from = 'ai';
          if (!best || best.h < 8) {
            args.fb.forEach((s) => {
              document.querySelectorAll(s).forEach((el) => {
                const r = el.getBoundingClientRect();
                measured.push({ sel: s, el, h: r.height, w: r.width, sh: (el as HTMLElement).scrollHeight, ch: (el as HTMLElement).clientHeight, cv: getComputedStyle(el).contentVisibility });
              });
            });
            let fbBest: (typeof measured)[number] | null = null;
            measured.forEach((x) => {
              if (args.fb.includes(x.sel) && (!fbBest || x.h > fbBest.h)) fbBest = x;
            });
            if (fbBest && fbBest.h > best.h) {
              best = fbBest;
              from = 'fallback';
            }
          }
          if (!best || best.h < 8) {
            return { ok: false, reason: best ? 'zero-measure' : 'no-anchor', diag: { docH0, aiSummary, fbN: args.fb.length } };
          }

          const a = best.el as HTMLElement;
          // 滚入视图，让虚拟列表 / content-visibility 有渲染机会
          a.scrollIntoView({ block: 'center', inline: 'nearest' });

          // ① 强制可见：自身 + 祖先（!important 压住带权重的 content-visibility:auto）
          const chain: HTMLElement[] = [a];
          let pp: HTMLElement | null = a.parentElement;
          while (pp && pp !== document.documentElement) {
            chain.push(pp);
            pp = pp.parentElement;
          }
          chain.forEach((el) => {
            const cs = getComputedStyle(el);
            if (cs.contentVisibility && cs.contentVisibility !== 'visible') el.style.setProperty('content-visibility', 'visible', 'important');
            if (cs.visibility === 'hidden') el.style.setProperty('visibility', 'visible', 'important');
            if (cs.opacity === '0') el.style.setProperty('opacity', '1', 'important');
            if (cs.display === 'contents') el.style.setProperty('display', 'block', 'important');
            if (cs.display === 'none') el.style.setProperty('display', 'block', 'important');
            el.style.setProperty('max-height', 'none', 'important');
            el.style.setProperty('overflow', 'visible', 'important');
          });
          //    全部后代
          a.querySelectorAll('*').forEach((el) => {
            const he = el as HTMLElement;
            const cs = getComputedStyle(he);
            if (cs.contentVisibility && cs.contentVisibility !== 'visible') he.style.setProperty('content-visibility', 'visible', 'important');
            if (cs.visibility === 'hidden') he.style.setProperty('visibility', 'visible', 'important');
            if (cs.opacity === '0') he.style.setProperty('opacity', '1', 'important');
            if (cs.display === 'contents') he.style.setProperty('display', 'block', 'important');
            if (cs.display === 'none') he.style.setProperty('display', 'block', 'important');
            he.style.setProperty('max-height', 'none', 'important');
            he.style.setProperty('overflow', 'visible', 'important');
          });

          // ② 撑开所有「内容溢出」的裁剪容器（定高 / max-height / overflow 会把长回答截成一屏）
          //    迭代到稳定，让完整回答参与布局，才能量到真实全高。
          let changed = true;
          let guard = 0;
          let expandedN = 0;
          while (changed && guard++ < 30) {
            changed = false;
            let n: HTMLElement | null = a;
            while (n && n !== document.documentElement) {
              if (n.scrollHeight > n.clientHeight + 1) {
                n.style.setProperty('height', n.scrollHeight + 'px', 'important');
                n.style.setProperty('max-height', 'none', 'important');
                n.style.setProperty('overflow', 'visible', 'important');
                expandedN++;
                changed = true;
              }
              n = n.parentElement;
            }
            a.querySelectorAll('*').forEach((el) => {
              const he = el as HTMLElement;
              if (he.scrollHeight > he.clientHeight + 1) {
                he.style.setProperty('height', he.scrollHeight + 'px', 'important');
                he.style.setProperty('max-height', 'none', 'important');
                he.style.setProperty('overflow', 'visible', 'important');
                expandedN++;
                changed = true;
              }
            });
          }

          // 强制 reflow，确保新样式生效
          void a.offsetHeight;

          // ③ 隐藏问答块外 fixed/absolute/sticky 浮层。⚠️ 只隐藏「旁支浮层」：
          //    必须跳过锚点的后代（a.contains）与【祖先】（el.contains(a)）——
          //    聊天面板容器（SplitPane 等）常是 position:absolute，若把祖先也 display:none，
          //    整个回答块会变 0×0（线上 postH 1793→0 已踩坑，离线复刻确认）。
          document.querySelectorAll('*').forEach((el) => {
            if (a.contains(el) || el.contains(a)) return;
            const cs = getComputedStyle(el as HTMLElement);
            if (cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky') {
              (el as HTMLElement).style.setProperty('display', 'none', 'important');
            }
          });
          const selObj = window.getSelection();
          if (selObj) selObj.removeAllRanges();

          const r = a.getBoundingClientRect();
          // ④ 上边界抬到「最后一条用户问题」顶部：Q&A 块 = 问题 + 回答（当前锚点只是回答块）。
          //    若问题在回答上方且已渲染，就从问题顶部开始裁；否则退化为纯回答块。
          const topAbs = r.top + window.scrollY;
          const bottomAbs = r.bottom + window.scrollY;
          let clipTop = topAbs;
          const hCands = '.agent-chat__list__item--human, .agent-chat__bubble--human';
          const hAll = document.querySelectorAll(hCands);
          if (hAll.length) {
            const h = hAll[hAll.length - 1] as HTMLElement;
            const hr = h.getBoundingClientRect();
            if (hr.height > 4 && hr.top + window.scrollY < clipTop) {
              clipTop = hr.top + window.scrollY;
            }
          }
          // ⑤ 下边界 = 真实输入框（composer）顶部 - 8px：截取「用户问题 → 页面最底部输入框之前」的
          //    全部信息（AI 块 + 其后相关内容），但不把输入框截进来。
          //    ⚠️ 输入框必须位于【文档最底部】（下缘贴近 doc 底）才算，避免回答内容中部同名字段
          //       （chat-input/input-editor 等）把回答尾巴裁掉。优先校准过的 composer 结构：
          //       .agent-dialogue__content--common__input-box / [class*="__input-box"] / [class*="input-box"]。
          //    取贴底候选中 abs top 最小者（=输入框最上沿）。候选坐标全部进 diag 便于核对。
          const inputCands =
            '.agent-dialogue__content--common__input-box, [class*="__input-box"], [class*="input-box"], textarea, ' +
            '[contenteditable="true"], [class*="chat-input"], [class*="input-editor"], [class*="AgentInput"], [class*="composer"]';
          const inputList = document.querySelectorAll(inputCands);
          const docBottomAbs = document.documentElement.scrollHeight;
          const inputCandDiag: { cls: string; top: number; h: number; nearBottom: boolean }[] = [];
          let composerTopAbs: number | null = null;
          let composerEl: HTMLElement | null = null;
          for (let k = 0; k < inputList.length; k++) {
            const ip = inputList[k] as HTMLElement;
            const ir = ip.getBoundingClientRect();
            const inTop = ir.top + window.scrollY;
            const inBottom = ir.bottom + window.scrollY;
            const nearBottom = inBottom >= docBottomAbs - 80;
            if (ir.height > 8) {
              inputCandDiag.push({
                cls: (ip.className || '').toString().slice(0, 60) || ip.tagName,
                top: Math.round(inTop),
                h: Math.round(ir.height),
                nearBottom,
              });
            }
            if (ir.height > 8 && inTop >= clipTop - 1 && nearBottom) {
              if (composerTopAbs === null || inTop < composerTopAbs) {
                composerTopAbs = inTop;
                composerEl = ip; // 候选最外层（.agent-dialogue__content--common__input-box）
              }
            }
          }
          let finalBottomAbs =
            composerTopAbs !== null ? Math.max(composerTopAbs - 8, clipTop + 8) : bottomAbs;

          // ⑥ 隐藏 composer（输入框整块）以露出其上方的「操作栏/相关问题/下载提示」等元宝尾部信息。
          //    元宝「下载元宝电脑版」banner (agent-chat__conv--ai__promptHintV2--hint--main / download_hint__wrap)
          //    是独立元素，不在 composer 内部；藏 composer 不影响它。doc 收缩后 clip 底自动到 banner 处，
          //    信息全部进图，composer 完全排除。⚠️ 截图完本页就关/下一轮重建，无需恢复。
          let composerHidden = false;
          let newDocBottomAbs: number | null = null;
          if (composerEl) {
            composerEl.style.setProperty('display', 'none', 'important');
            composerHidden = true;
            void document.body.offsetHeight;
            newDocBottomAbs = document.documentElement.scrollHeight;
            const r2 = a.getBoundingClientRect();
            const anchorBottom2 = r2.bottom + window.scrollY;
            finalBottomAbs = Math.max(
              Math.min(newDocBottomAbs, Math.max(anchorBottom2, finalBottomAbs)),
              clipTop + 8
            );
          }
          return {
            ok: r.height >= 8 && r.width >= 8,
            reason: r.height >= 8 ? 'ok' : 'zero-after-expand',
            diag: {
              pickedSel: best.sel,
              pickedFrom: from,
              preH: Math.round(best.h),
              preW: Math.round(best.w),
              postH: Math.round(r.height),
              postW: Math.round(r.width),
              scrollY: Math.round(window.scrollY),
              docH0,
              docH1: document.documentElement.scrollHeight,
              expandedN,
              aiSummary,
              anchorTextLen: (a.innerText || '').length,
              anchorTextHead: (a.innerText || '').slice(0, 40),
              humanMergedTop: clipTop !== topAbs ? Math.round(clipTop) : null,
              humanCount: hAll.length,
              anchorBottomAbs: Math.round(bottomAbs),
              composerCapAbs: composerTopAbs !== null ? Math.round(composerTopAbs - 8) : null,
              composerHidden,
              newDocBottomAbs: newDocBottomAbs !== null ? Math.round(newDocBottomAbs) : null,
              inputCandDiag,
            },
            clip: { x: Math.round(r.left + window.scrollX), y: Math.round(clipTop), width: Math.round(r.width), height: Math.round(finalBottomAbs - clipTop) },
          };
        },
        { ai: aiCands, fb: fbCands }
      )
      .catch((e) => ({ ok: false, reason: 'eval-error', error: String(e) }));

    // 落盘诊断（平台私有）：写到截图旁的 .diag.json，不依赖服务 stdout，便于离线读取真实现场
    const diagPath = outPath.replace(/\.png$/, '.diag.json');
    try {
      fs.writeFileSync(diagPath, JSON.stringify({ version: 'qa-shot-v8-20260908', main }, null, 1));
    } catch {
      /* 诊断落盘失败不影响截图 */
    }
    console.log('📐 元宝截图主策略诊断:', JSON.stringify(main));

    let clip: { x: number; y: number; width: number; height: number } | null =
      (main as any).ok && (main as any).clip ? (main as any).clip : null;

    // 兜底 1：按「最后一条用户问题 → 对话列表底部」区域裁剪，仍属对话区域（非整页）
    if (!clip || clip.height < 8 || clip.width < 8) {
      const region = await page
        .evaluate(() => {
          const lastHuman =
            document.querySelector('.agent-chat__list__item--human, .agent-chat__bubble--human') as HTMLElement | null;
          const list = document.querySelector('.agent-chat__list, .agent-chat__list__content') as HTMLElement | null;
          if (!lastHuman || !list) return null;
          const rQ = lastHuman.getBoundingClientRect();
          const rL = list.getBoundingClientRect();
          const y = Math.min(rQ.top, rL.top) + window.scrollY;
          const h = rL.bottom - Math.min(rQ.top, rL.top);
          if (h < 8 || rL.width < 8) return null;
          return { x: Math.round(rL.left + window.scrollX), y: Math.round(y), width: Math.round(rL.width), height: Math.round(h) };
        })
        .catch(() => null);
      if (region) {
        console.log('📐 元宝截图兜底区域（问题→列表底部）:', JSON.stringify(region));
        clip = region;
      }
    }

    if (!clip || clip.height < 8 || clip.width < 8) {
      throw new Error(`Q&A 块无有效渲染尺寸，无法裁剪截图（clip=${JSON.stringify(clip)}，主策略=${JSON.stringify(main)}）`);
    }

    await page.waitForTimeout(200);
    // ⚠️ 关键：page.screenshot({ clip }) 【不带 fullPage】时只会截到视口高度（长回答被截成一屏）。
    //   实测同一 clip：不带 fullPage → 1014x776；带 fullPage:true → 1014x4544（完整长图）。
    //   故长屏截图必须 fullPage:true + clip（仍按坐标裁剪，非整页兜底）。
    await page.screenshot({ path: outPath, clip, fullPage: true, animations: 'disabled', timeout: 60000 });
    const sz = fs.statSync(outPath).size;
    console.log(`✂️ Q&A 长屏截图完成（元宝·clip 裁剪 + fullPage，${clip.width}x${clip.height}，${sz} bytes）`);
  }
}
