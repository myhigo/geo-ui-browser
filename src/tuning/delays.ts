// src/tuning/delays.ts
//
// 拟人停顿 / 延迟参数集中管理（human-emulation timing）。
//
// 设计原则（用户 2026-09-02 决定）：
//   1. 所有「模拟真人停顿」的时长集中在此文件，便于统一调参与审计；
//   2. 前期【不合并】：即便不同平台/用途的取值相同，也按「平台 + 用途」独立命名，
//      各自可微调、互不影响；
//   3. 待全部平台写完，再「按类型」归并（例如把文心/千问的「弹窗关闭前停顿」
//      合并为统一的 AD_CLOSE_DETECT_PAUSE），届时提取出不同的停顿时间类型。
//
// 取值语义：
//   Delay = readonly [base, jitter]
//   - humanDelay(...D)： base + floor(random * jitter) 毫秒（见 diagnostics/human.ts）
//   - randWaitMs(D)：    同样的公式，用于直接 page.waitForTimeout 的随机停顿（jitter=0 即固定等待）
// 行为一致性：randWaitMs 严格按 base + floor(random*jitter) 计算，不会像 humanDelay 那样
// 把 jitter=0 兜底成 base*0.5——固定等待请务必用 randWaitMs([n, 0])，切勿用 humanDelay(n, 0)。

export type Delay = readonly [base: number, jitter: number];

/** 随机停顿毫秒：base + floor(random * jitter)。jitter=0 时为固定等待。 */
export const randWaitMs = (d: Delay): number => d[0] + Math.floor(Math.random() * d[1]);

// ════════════════════════════════════════════════════════════════════
// 文心（wenxin）
// ════════════════════════════════════════════════════════════════════

// —— 输入：聚焦 / 打字 / 发送（真人节奏） ——
export const WENXIN_INPUT_FOCUS_SETTLE: Delay = [120, 120]; // 点击输入框后、强制聚焦前
export const WENXIN_INPUT_FOCUS_AFTER: Delay = [60, 0]; // 强制聚焦后（固定微顿）
export const WENXIN_INPUT_PRE_TYPE: Delay = [500, 1500]; // 打字前「准备输入」停顿 0.5~2.0s
export const WENXIN_INPUT_PRE_ENTER: Delay = [500, 500]; // 发送（Enter）前「检查后发送」停顿 0.5~1.0s

// —— 关闭首页引导弹窗（cos-dialog 任务模式） ——
export const WENXIN_AD_DETECT_PAUSE: Delay = [900, 700]; // 检测到弹窗 → 点关闭（0.9~1.6s）
export const WENXIN_AD_MOVE_DOWN: Delay = [120, 80]; // 移到关闭钮中心 → 按下
export const WENXIN_AD_HOLD: Delay = [60, 40]; // 按下 → 抬起
export const WENXIN_AD_AFTER: Delay = [250, 150]; // 抬起后
export const WENXIN_AD_ESC_RECHECK: Delay = [300, 200]; // Esc 兜底后复检（0.3~0.5s）

// ════════════════════════════════════════════════════════════════════
// 千问（qianwen）
// ════════════════════════════════════════════════════════════════════

// —— 输入：聚焦 / 打字 / 发送 ——
export const QIANWEN_INPUT_FOCUS_SETTLE: Delay = [120, 120];
export const QIANWEN_INPUT_FOCUS_AFTER: Delay = [60, 0];
export const QIANWEN_INPUT_PRE_TYPE: Delay = [500, 1500];
export const QIANWEN_INPUT_PRE_ENTER: Delay = [500, 500];

// —— 关闭弹窗：形态 A 居中轮播卡片 ——
export const QIANWEN_AD_A_DETECT_PAUSE: Delay = [900, 700];
export const QIANWEN_AD_A_MOVE_DOWN: Delay = [120, 80];
export const QIANWEN_AD_A_HOLD: Delay = [60, 40];
export const QIANWEN_AD_A_AFTER: Delay = [250, 150];

// —— 关闭弹窗：形态 B 底部广告横幅（需先 hover 显示关闭钮） ——
export const QIANWEN_AD_B_PRE_HOVER: Delay = [500, 300]; // 检测到横幅 → hover 前停顿
export const QIANWEN_AD_B_POST_HOVER: Delay = [350, 150]; // hover 后 → 点关闭前停顿
export const QIANWEN_AD_B_MOVE_DOWN: Delay = [120, 80];
export const QIANWEN_AD_B_HOLD: Delay = [60, 40];
export const QIANWEN_AD_B_AFTER: Delay = [250, 150];

// —— 滑动验证（baxia 滑块） ——
export const QIANWEN_CAPTCHA_DETECT_PAUSE: Delay = [800, 400]; // 检测到弹窗 → 抓取滑块前（0.8~1.2s）
export const QIANWEN_CAPTCHA_FIRST_PREWAIT: Delay = [1000, 2000]; // 首次滑动前「发呆/读题」1~3s（用户实操经验 2026-09-02）
export const QIANWEN_CAPTCHA_RETRY_PREWAIT: Delay = [1000, 1000]; // 失败重试前 1~2s（用户实操经验 2026-09-02）
export const QIANWEN_CAPTCHA_MANUAL_DOWN: Delay = [90, 90]; // 人工兜底：按下前
export const QIANWEN_CAPTCHA_MANUAL_HOLD: Delay = [45, 45]; // 按下 → 抬起
export const QIANWEN_CAPTCHA_REFRESH_DOWN: Delay = [80, 60]; // 刷新重开：点容器前
export const QIANWEN_CAPTCHA_REFRESH_HOLD: Delay = [40, 40]; // 按下 → 抬起

// ════════════════════════════════════════════════════════════════════
// 豆包（doubao）
// ════════════════════════════════════════════════════════════════════

// —— 输入：聚焦 / 打字 / 发送（暂未发现弹窗关闭/滑块，仅有输入节奏；其余留待探明后补） ——
export const DOUBAO_INPUT_FOCUS_SETTLE: Delay = [120, 120];
export const DOUBAO_INPUT_FOCUS_AFTER: Delay = [60, 0];
export const DOUBAO_INPUT_PRE_TYPE: Delay = [500, 1500];
export const DOUBAO_INPUT_PRE_ENTER: Delay = [500, 500];

// ════════════════════════════════════════════════════════════════════
// DeepSeek（deepseek）
// ════════════════════════════════════════════════════════════════════

// —— 输入：聚焦 / 打字 / 发送（回车即发；按钮点击作兜底。其余留待探明后补） ——
export const DEEPSEEK_INPUT_FOCUS_SETTLE: Delay = [120, 120];
export const DEEPSEEK_INPUT_FOCUS_AFTER: Delay = [60, 0];
export const DEEPSEEK_INPUT_PRE_TYPE: Delay = [500, 1500];
export const DEEPSEEK_INPUT_PRE_ENTER: Delay = [500, 500];
