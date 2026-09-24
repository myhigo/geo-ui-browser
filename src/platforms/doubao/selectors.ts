// ⚠️ 候选 Selector —— 未经人工在诊断中确认，仅作起点。
// V1 诊断的目的就是验证/修正这些。找不到时程序标记 found=false，绝不崩溃、绝不误报。
// 命名尽量覆盖常见模式；真要在 finished.html 里研究结构，请以诊断输出的元素诊断报告为准。

import { CandidateSelectors } from '../../types.js';

export const DOUBAO_CANDIDATE_SELECTORS: CandidateSelectors = {
  // 输入框（豆包是 contenteditable 富文本编辑器，非 textarea）
  input: [
    // 实测（2026-09-24）：豆包当前渲染 textarea 形态输入框（data-testid="chat_input_input"），
    // contenteditable 富文本编辑器不再挂载；且 div.guidance-input-editor-viewport 只是外壳容器，
    // 命中它会导致点击/聚焦无效 + 多次 30s 静默超时 → 输入阶段被拖到 2 分半。
    'textarea[placeholder]',
    'textarea',
    '[data-testid="chat_input_input"]',
    '[contenteditable="true"]',
    'p[data-placeholder]',
  ],
  // 发送按钮（豆包输入区唯一圆钮，class 含 rounded-full + 18px SVG 图标）
  // 注意：rounded-full 在页面多处出现（头像等），必须限定在输入区 .guidance-input-actions 内
  sendButton: [
    '.guidance-input-actions button[class*="rounded-full"]',
    '.guidance-input-actions >> button[class*="rounded-full"]',
    'button[class*="rounded-full"]',
  ],
  // 回答区域（容器）
  answerContainer: [
    '.answer-content',
    '.message-content',
    '[class*="answer"]',
    '[class*="message"]',
    '[class*="response"]',
  ],
  // 信源区域
  sourceArea: [
    'ol[data-testid="references"]',
    '[class*="source"]',
    '[class*="reference"]',
    '[class*="citation"]',
    '[class*="cite"]',
  ],
  // 展开信源按钮
  expandSourceButton: [
    'button:has-text("展开")',
    'button:has-text("信源")',
    'button:has-text("引用")',
    '[class*="expand"]',
  ],
  // 「问题+回答」整组对话容器：豆包真实结构待诊断定标，先用通用猜测，后续以真实 DOM 修正。
  qaBlock: ['.chat-turn', '[class*="chat-turn"]', '[class*="conversation-item"]', '[class*="qa-item"]'],
};
