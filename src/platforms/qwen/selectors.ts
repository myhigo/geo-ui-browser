// 千问候选 Selector —— 已据 2026-08-31 真实诊断（diagnostics/qianwen/2026-08-31_23-24-33/finished.html）定标。
// 定标来源：首屏 SPA 空壳，真实结构在发送后 JS 渲染出现。关键 class 已用真实 DOM 校验。
// 找不到时程序标记 found=false，绝不崩溃、绝不误报（V1 诊断铁律）。
//
// 平台私有原则：千问不跟文心/豆包共用任何 selector 与截图逻辑。

import { CandidateSelectors } from '../../types.js';

export const QIANWEN_CANDIDATE_SELECTORS: CandidateSelectors = {
  // 输入框：实测为 contenteditable 富文本（千问聊天输入区）。顺序：语义优先。
  input: [
    '[contenteditable="true"]',
    'textarea',
    'div[role="textbox"]',
  ],
  // 发送按钮：实测 aria-label 含"发送"；兜底通用语义与文案。
  sendButton: [
    'button[aria-label*="发送"]',
    'button[type="submit"]',
    'button[class*="send"]',
    'button:has-text("发送")',
  ],
  // 回答区域（容器）：优先真实卡片类 answer-common-card；兜底外层 wrap 与 markdown 根。
  // 实测 [class*="answer"] 会先命中 chat-answers-card-wrap（外层），answer-common-card 才是正文卡片。
  answerContainer: [
    '[class*="answer-common-card"]',
    '[class*="chat-answers-card-wrap"]',
    '[class*="qk-markdown"]',
  ],
  // 信源区域：reference-wrap 仅"N篇来源"头部（含站点图标），真实信源是下方的 a[class*=bg-option] 胶囊。
  // 此处保留头部容器作元素诊断锚点；实际抽取见 QianwenAdapter.getSources（按胶囊解析）。
  sourceArea: [
    '[class*="reference-wrap"]',
  ],
  // 展开信源按钮（千问默认已展开胶囊，此项多数为空命中，仅作诊断覆盖）。
  expandSourceButton: [
    'button:has-text("展开")',
    'button:has-text("查看来源")',
    'button:has-text("引用")',
    '[class*="expand"]',
  ],
  // 「问题+回答」整组对话容器：chat-round（每轮一个，截图取 .last() 即最新一轮）。
  qaBlock: [
    '[class*="chat-round"]',
  ],
  // ↓ 截图专用锚点（平台私有，仅供 QianwenAdapter.captureQaScreenshot 解释）
  // 展开逻辑内容根：从回答外层 wrap 起向上逐层撑开有界滚动容器。
  expandRoot: [
    '[class*="chat-answers-card-wrap"]',
    '[class*="answer-common-card"]',
  ],
  // 问题业务元素：用户气泡（祖先链 relative 化的起点 + 浮层清理豁免子树 + 诊断对象）。
  questionBlock: [
    '[class*="chat-question-wrap"]',
    '[class*="question-text-card"]',
  ],
};
