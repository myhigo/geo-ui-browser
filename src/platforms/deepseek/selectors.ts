// ⚠️ 候选 Selector —— DeepSeek 未经人工在诊断中定标，仅作起点（2026-09-04 首次接入）。
// DeepSeek 网页 DOM 大量使用 hash 类名，但设计系统前缀 `ds-`（如 ds-markdown）相对稳定。
// 首轮运行的 finished.html / answering.html 是定标依据，届时按真实结构精调。

import { CandidateSelectors } from '../../types.js';

export const DEEPSEEK_CANDIDATE_SELECTORS: CandidateSelectors = {
  // 输入框（DeepSeek 为 textarea#chat-input；contenteditable 作变种兜底）
  input: [
    'textarea#chat-input',
    '#chat-input',
    'textarea[placeholder]',
    'div[contenteditable="true"]',
  ],
  // 发送按钮（回车即发，此候选仅作回车无效时的兜底点击）
  sendButton: [
    '[class*="send-button"]',
    'div[role="button"]:has(svg)',
    'button:has(svg)',
  ],
  // 回答区域（ds-markdown 为 DeepSeek 设计系统 markdown 渲染类）
  answerContainer: [
    '[class*="ds-markdown"]',
    '.ds-markdown--block',
    '[class*="answer"]',
    '[class*="response"]',
  ],
  // 信源区域（联网搜索来源；未定标，先宽候选）
  sourceArea: [
    '[class*="search-result"]',
    '[class*="source"]',
    '[class*="reference"]',
    '[class*="cite"]',
  ],
  // 展开信源按钮
  expandSourceButton: [
    'button:has-text("展开")',
    '[class*="expand"]',
  ],
  // 「问题+回答」整组对话容器
  qaBlock: ['[class*="message-item"]', '[class*="chat-turn"]', '[class*="conversation-item"]'],
};
