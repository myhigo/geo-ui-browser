import { Page, Locator } from 'playwright';
import { CandidateSelectors } from '../types.js';
import { ElementDiagnosisItem } from '../types.js';

// 依次尝试候选 selector，返回第一个命中的 locator 及其 selector
export async function firstFound(
  page: Page,
  candidates: string[]
): Promise<{ locator: Locator; selector: string } | null> {
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      // count>0 不代表可见：外壳容器/隐藏 textarea 也会命中，导致点击聚焦无效后静默 30s 超时。
      // 加可见性过滤，命中真正可见可交互的输入框。
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        return { locator: loc, selector: sel };
      }
    } catch {
      /* selector 语法不支持等，忽略继续 */
    }
  }
  return null;
}

// 自动元素诊断：探测关键元素是否可定位，输出「找到/未找到」报告
export async function probeElements(page: Page, selectors: CandidateSelectors): Promise<ElementDiagnosisItem[]> {
  const defs = [
    { name: '输入框', sels: selectors.input },
    { name: '发送按钮', sels: selectors.sendButton },
    { name: '回答区域', sels: selectors.answerContainer },
    { name: '信源区域', sels: selectors.sourceArea },
    { name: '展开信源', sels: selectors.expandSourceButton },
    { name: 'QA整组块', sels: selectors.qaBlock ?? ['.chat-qa-container'] },
  ];

  const out: ElementDiagnosisItem[] = [];
  for (const d of defs) {
    const found = await firstFound(page, d.sels);
    if (!found) {
      out.push({ name: d.name, found: false });
      continue;
    }
    const tag = await found.locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => undefined);
    const text = (await found.locator.innerText().catch(() => ''))?.slice(0, 80) || undefined;
    out.push({ name: d.name, found: true, tag, selector: found.selector, text });
  }
  return out;
}
