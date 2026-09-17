import { Page, BrowserContext } from 'playwright';
import { DOUBAO_CANDIDATE_SELECTORS } from './doubao/selectors.js';
import { WENXIN_CANDIDATE_SELECTORS } from './wenxiaoyan/selectors.js';
import { QIANWEN_CANDIDATE_SELECTORS } from './qwen/selectors.js';
import { DEEPSEEK_CANDIDATE_SELECTORS } from './deepseek/selectors.js';
import { YUANBAO_CANDIDATE_SELECTORS } from './hunyuan/selectors.js';
import { DoubaoAdapter } from './doubao/DoubaoAdapter.js';
import { WenxinAdapter } from './wenxiaoyan/WenxinAdapter.js';
import { QianwenAdapter } from './qwen/QianwenAdapter.js';
import { DeepseekAdapter } from './deepseek/DeepseekAdapter.js';
import { YuanbaoAdapter } from './hunyuan/YuanbaoAdapter.js';
import { CandidateSelectors, PlatformAdapter } from '../types.js';

// 平台注册表：诊断流程与具体平台解耦。新增平台只需在此登记 + 实现对应 Adapter/selectors。
export interface PlatformDef {
  id: string;
  label: string; // 中文名，用于报告标题
  defaultUrl: string;
  selectors: CandidateSelectors;
  create: (page: Page, context: BrowserContext) => PlatformAdapter;
}

export const PLATFORMS: Record<string, PlatformDef> = {
  doubao: {
    id: 'doubao',
    label: '豆包',
    defaultUrl: 'https://www.doubao.com/chat/',
    selectors: DOUBAO_CANDIDATE_SELECTORS,
    create: (page, context) => new DoubaoAdapter(page, context, DOUBAO_CANDIDATE_SELECTORS),
  },
  wenxiaoyan: {
    id: 'wenxiaoyan',
    label: '百度文心',
    defaultUrl: 'https://wenxin.baidu.com/',
    selectors: WENXIN_CANDIDATE_SELECTORS,
    create: (page, context) => new WenxinAdapter(page, context, WENXIN_CANDIDATE_SELECTORS),
  },
  qwen: {
    id: 'qwen',
    label: '千问',
    // 用户 2026-08-31 确认：千问无需登录（匿名可用）。首屏即聊天页（title=千问-阿里 AI 助手）。
    defaultUrl: 'https://www.qianwen.com/chat/',
    selectors: QIANWEN_CANDIDATE_SELECTORS,
    create: (page, context) => new QianwenAdapter(page, context, QIANWEN_CANDIDATE_SELECTORS),
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    // 用户 2026-09-04：DeepSeek 必须登录（登录制平台，走 /admin 台账）。
    defaultUrl: 'https://chat.deepseek.com/',
    selectors: DEEPSEEK_CANDIDATE_SELECTORS,
    create: (page, context) => new DeepseekAdapter(page, context, DEEPSEEK_CANDIDATE_SELECTORS),
  },
  hunyuan: {
    id: 'hunyuan',
    label: '腾讯元宝',
    // 用户 2026-09-07：元宝（腾讯）需登录（登录制平台，走 /admin 台账，与 doubao/deepseek 同套机制）。
    // ⚠️ 2026-09-07 接入初版：候选选择器为通用聊天 UI 占位，待用户登录后落盘真实 DOM 校准
    //    （详见 YuanbaoAdapter.ts 顶部注释）。首页 / 是门户落地页（SPA 首屏 domcontentloaded
    //    迟迟不触发、未登录态不渲染输入框），已登录用户直接走对话页 /chat/ 更稳。
    defaultUrl: 'https://yuanbao.tencent.com/chat/',
    selectors: YUANBAO_CANDIDATE_SELECTORS,
    create: (page, context) => new YuanbaoAdapter(page, context, YUANBAO_CANDIDATE_SELECTORS),
  },
};

export function resolvePlatform(id: string): PlatformDef {
  const key = id.toLowerCase();
  const def = PLATFORMS[key];
  if (!def) {
    throw new Error(
      `未知平台 "${id}"。当前支持：${Object.keys(PLATFORMS).join(' / ')}`
    );
  }
  return def;
}
