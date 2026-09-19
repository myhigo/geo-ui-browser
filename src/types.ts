// 共享类型定义

export interface ElementDiagnosisItem {
  name: string; // 输入框 / 发送按钮 / 回答区域 / 信源区域 / 展开信源
  found: boolean;
  tag?: string; // textarea / button / div ...
  selector?: string; // 命中的候选 selector
  text?: string; // 样本文本（截断）
}

export interface SourceInfo {
  title?: string; // 文章标题
  url?: string; // 文章地址
  platform?: string; // 媒体平台名称（如"百度百科""有赞官网"）；平台数据中无独立字段时派生
}

// 长屏截图策略：各平台按需实现，运行时可切换（用户 2026-08-31 定：最终 A/B 都要有，随时切）
//   expand = 展开滚动容器 + 清理渲染抑制 + 元素级截图（文心已跑通）
//   stitch = 页面原样不动 + 滚动分段截图 + 拼接（规避超视口渲染坑，文心暂未实现）
export type ScreenshotMode = 'expand' | 'stitch';

// 一个平台需要定位的「关键元素」候选 selector 集合（按元素分组，组内按顺序尝试）
export interface CandidateSelectors {
  input: string[];
  sendButton: string[];
  answerContainer: string[];
  sourceArea: string[];
  expandSourceButton: string[];
  qaBlock?: string[]; // 「问题+回答」整组对话容器（用于定向元素截图，天然裁掉导航/侧栏/输入栏）
  // ↓ 截图专用锚点，**平台私有**：截图逻辑不共用，故这些锚点也只由对应平台自己解释
  expandRoot?: string[]; // 展开逻辑的内容根（撑开滚动容器的起点）
  questionBlock?: string[]; // 问题业务元素（祖先链 relative 化的起点 + 浮层清理豁免子树 + 诊断对象）
}

// 平台适配器统一接口：诊断流程与具体平台解耦。
// ⚠️ 截图方法**不共用**（用户 2026-08-31 定）：各平台页面结构/渲染技巧差异极大，
//    所谓"通用截图方法"必然要引用平台元素名 → 与其假通用，不如各平台自己实现、自己演进。
export interface PlatformAdapter {
  checkLogin(): Promise<boolean>;
  sendQuestion(question: string): Promise<void>;
  // midDumpPath：可选。生成中途（约 20s 处）把当时 DOM 落盘到该路径，用于定标
  // 「生成中/已结束」的真实标志（豆包无文字级结束标记，靠样本迭代）。
  waitForAnswer(timeoutMs?: number, midDumpPath?: string): Promise<void>;
  getAnswer(): Promise<string | null>;
  expandSources(): Promise<void>;
  getSources(captureDir?: string): Promise<SourceInfo[] | null>;
  // 定向长屏截图（平台私有实现）。设为可选：未实现的平台（如尚未适配的豆包）由 run.ts
  // 走整页兜底，避免"编造一个假实现"误导后续排查。诊断日志在实现内部打印。
  captureQaScreenshot?(outPath: string, mode?: ScreenshotMode): Promise<void>;
  // 关闭平台自带的干扰弹层（首页引导/营销广告/活动浮层等）。设为可选钩子：由各平台自己
  // 识别与关闭（页面结构私有，不假通用）。返回 true=本检测到并关闭了弹层；false=无弹层。
  // run.ts 在定位输入框之前调用，确保弹层不会挡住后续交互。诊断日志在实现内部打印。
  dismissAds?(): Promise<boolean>;
  // 处理平台发送后弹出的滑动验证（风控滑块）。可选钩子，平台私有实现：由各平台自己识别
  // 滑块结构并仿人类拖动（不假通用、不用打码平台/漏洞）。captureDir 为样本根目录，用于落盘
  // 验证码现场（DOM+截图）供精确调参；未提供则跳过抓取。返回 true=已通过（自动或人工）。
  // run.ts 在 sendQuestion 之后、等待回答之前调用，避免滑块挡住回答。
  // restart：可选「刷新重开」回调（用户 2026-09-02 实操经验：连滑失败后刷新页面重开，
  //   一次基本能过；但刷新会丢掉已输入的问题，故重开 = 重新导航 + 重发问题）。
  //   重发属于编排层职责，由 run.ts 提供；未提供则退化为「滑 N 次失败即转人工」。
  solveCaptcha?(captureDir?: string, restart?: () => Promise<void>): Promise<boolean>;
}

export interface DiagnosticArtifacts {
  screenshots: string[]; // 相对样本目录的 4 阶段截图路径
  qaScreenshot?: string; // 「问题+回答」整组元素截图路径（生成失败时缺省）
  beforeHtml: string;
  finishedHtml: string;
  har: string;
  video?: string;
  reportHtml: string;
}

export interface DiagnosticResult {
  platform: string;
  url: string;
  question: string;
  timestamp: string;
  loginRequired: boolean; // 是否检测到需要登录（匿名路径不可行）
  answerText: string | null; // null = 定位不到回答区
  sources: SourceInfo[] | null; // null = 定位不到信源区
  sourceCount: number | null; // 0 / 正整数 / null(定位不到)
  elementDiagnosis: ElementDiagnosisItem[];
  /** 样本根目录（绝对路径）；artifactMode=none 时不落盘，此值为空串 */
  sampleDir: string;
  artifacts: DiagnosticArtifacts;
  notes: string[]; // 人工可读提示
  /** 长截图内容（artifactMode=none 时直接给 Buffer，调用方无需读盘） */
  qaScreenshotBuffer?: Buffer;
}
