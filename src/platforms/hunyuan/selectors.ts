// 元宝（腾讯 Yuanbao）候选选择器 —— 2026-09-07 真实 DOM 校准版（finished.html / 22-50-16 实测）。
//   输入框：contenteditable 的 div（.chat-input 内，非 textarea）
//   发送钮：<a id="yuanbao-send-btn" aria-label="发送">
//   回答气泡：助手=.agent-chat__bubble--ai（仅 1 个，务必只取 --ai）
//   信源区：.hyc-common-markdown__ref-list（真实引用列表），条目 .hyc-common-markdown__ref-list__item--merged，
//           来源名在 .hyc-common-markdown__ref-list__item__name（如「北京日报」）；⚠️ 条目无真实文章 URL（DOM 仅埋点外链）。
//   Q&A 整组（截图锚点）：.agent-chat__list__item--ai（仅 1 个，可见）；勿用 .agent-chat__list__item（14 个含隐藏/占位项 → 0 尺寸）。
import { CandidateSelectors } from '../../types.js';

export const YUANBAO_CANDIDATE_SELECTORS: CandidateSelectors = {
  // 输入框：元宝编辑器为 contenteditable 富文本 div
  input: [
    '[contenteditable="true"]',
    'textarea',
    '[class*="chat-input"] [contenteditable="true"]',
    '[class*="input"] [contenteditable="true"]',
  ],
  // 发送钮：稳定优先（id / aria-label），兜底按类名
  sendButton: [
    '#yuanbao-send-btn',
    'a[aria-label="发送"]',
    'button[aria-label="发送"]',
    '[class*="send-btn"]',
    '[class*="send"]',
  ],
  // 回答容器：只取助手气泡（--ai），避免误抓用户问题气泡
  answerContainer: [
    '.agent-chat__bubble--ai',
    '[class*="bubble--ai"]',
    '.agent-chat__bubble',
    '[class*="bubble"]',
    '[class*="message"]',
  ],
  // 信源区：元宝引用容器类名含 "ref-list"（真实引用列表 .hyc-common-markdown__ref-list），
  //   也兼容含 "source/reference/citation/引用/来源" 的容器（多结构并存）。
  sourceArea: [
    '.hyc-common-markdown__ref-list',
    '[class*="ref-list"]',
    '[class*="reference"]',
    '[class*="source"]',
    '[class*="citation"]',
    '[class*="cite"]',
    '[class*="引用"]',
    '[class*="来源"]',
  ],
  // 展开信源按钮
  expandSourceButton: [
    'button:has-text("展开")',
    'button:has-text("信源")',
    'button:has-text("参考")',
    'button:has-text("来源")',
    '[class*="expand"]',
  ],
  // 「问题+回答」整组（截图锚点）：元宝最新一轮回答包裹在 .agent-chat__list__item--ai（仅 1 个、可见，
  //   内含完整回答 + 引用列表）。⚠️ 勿用 .agent-chat__list__item（共 14 个，含 --human/占位/工具条隐藏项，
  //   .last() 会取到不可见元素 → 截图 element is not visible）。
  qaBlock: [
    '.agent-chat__list__item--ai',
    '.agent-chat__bubble--ai',
    '.agent-chat__list__item',
    '[class*="message"]',
  ],
  expandRoot: ['.agent-chat__list__item--ai', '.agent-chat__bubble--ai', '[class*="bubble--ai"]'],
  questionBlock: ['.agent-chat__bubble--human', '[class*="bubble--human"]'],
};
