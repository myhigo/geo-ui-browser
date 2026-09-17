// ⚠️ 候选 Selector —— 已用 2026-08-28_15-34-45 样本（before/finished.html）实测核对，锁定真实结构。
// 文心真实 DOM（与豆包不同）：
//   输入框 = <textarea class="ci-textarea">（textarea，非 contenteditable）
//   发送钮 = <span class="ci-submit-button">（含图标 img，不是 <button>！）
//   回答容器 = conversation-flow-answer-container / .answer-box（含 "共参考N篇资料" 头）
//   信源区 = _reference-list_... 容器 + _reference-item_... 子项；URL 不在 <a>，而在 item 的
//            data-long-press-ext-info JSON（link / linkTitle 字段），可见标题在 _text_... span。
// 注意：文心用 CSS-module 哈希类名（如 _answer-container_1cf7j_22），故统一用 [class*="稳定子串"] 匹配。
// 仍有未覆盖场景时程序标记 found=false，绝不崩溃、绝不误报"无信源"。

import { CandidateSelectors } from '../../types.js';

export const WENXIN_CANDIDATE_SELECTORS: CandidateSelectors = {
  // 输入框：文心为 textarea（ci-textarea）
  input: [
    'textarea.ci-textarea',
    'textarea',
    '[contenteditable="true"]',
    'div[role="textbox"]',
  ],
  // 发送按钮：文心是 <span class="ci-submit-button">（非 button），故放最前
  sendButton: [
    '.ci-submit-button',
    'button:has-text("发送")',
    'button[type="submit"]',
    '.send-btn',
  ],
  // 回答区域（容器）：优先 answer-container / answer-box
  answerContainer: [
    '[class*="answer-container"]',
    '.answer-box',
    '[class*="content-area"]',
    '[class*="chat-search-answer"]',
  ],
  // 信源区域：reference-list 容器
  sourceArea: [
    '[class*="reference-list"]',
    '[class*="reference"]',
  ],
  // 展开信源按钮（文心信源多以 data 属性内嵌，item 已在 DOM，展开多为可选项）
  expandSourceButton: [
    '[class*="reference"]',
    'button:has-text("展开")',
    'button:has-text("查看来源")',
  ],
  // 「问题+回答」整组对话容器：文心实测为 .chat-qa-container（稳定语义类名，非哈希），
  // 同时包住提问气泡 + 回答容器 + 信源列表，用于定向元素截图。
  qaBlock: ['.chat-qa-container', '[class*="chat-qa-container"]'],
  // ↓ 截图专用锚点（平台私有，仅由 WenxinAdapter.captureQaScreenshot 解释）
  //   展开逻辑的内容根：文心聊天流容器（多层有界滚动的其中一层，从它往上逐层撑开）
  expandRoot: ['#conversation-flow-content'],
  //   问题业务元素：祖先链 relative 化的起点 + 浮层清理豁免子树 + 诊断快照对象。
  //   ⚠️ 只给"气泡"本身，不给后代——后代由代码用 contains 判定，避免误伤其中的背景层。
  questionBlock: ['.cs-question-bubble'],
};
