// 真人化交互原语（中性浏览器工具，不含任何平台 DOM 结构）。
// 定位：与 elementProbe.firstFound 同——只封装「输入/点击/拖动的节奏与轨迹」，
// 不感知任何平台的页面结构。各平台 Adapter 的平台操作应调用本文件方法，保持一致的
// 「仿人类」节奏，避免瞬时点击/拖动被风控识别为脚本。
// ⚠️ 这不是「平台操作」，故不违反"平台操作全部私有"原则；它是所有平台共用的输入基本功。
import { Page } from 'playwright';

// 随机停顿：base ± 抖动（默认抖动 ±base*0.5），模拟人类不确定节奏
export async function humanDelay(base: number, jitter = 0): Promise<void> {
  const j = jitter || base * 0.5;
  const d = base + Math.floor(Math.random() * j);
  await new Promise((r) => setTimeout(r, d));
}

// 真人点击：鼠标先移到元素上方→短暂停顿→带曲线移到元素内→按下→停顿→抬起→停顿。
// 比 page.click 多一层"人类犹豫"，避免点击过快被识别为脚本。返回是否点到。
export async function humanClick(page: Page, selector: string): Promise<boolean> {
  try {
    const box = await page.locator(selector).first().boundingBox({ timeout: 5000 });
    if (!box) return false;
    const tx = box.x + box.width * (0.35 + Math.random() * 0.3);
    const ty = box.y + box.height * (0.35 + Math.random() * 0.3);
    await page.mouse.move(box.x + box.width / 2, box.y - 10, { steps: 3 }); // 先悬到上方
    await humanDelay(70, 120);
    await page.mouse.move(tx, ty, { steps: 5 + Math.floor(Math.random() * 5) }); // 带微抖动曲线移入
    await humanDelay(50, 90);
    await page.mouse.down();
    await humanDelay(35, 55);
    await page.mouse.up();
    await humanDelay(110, 170); // 点击后停顿
    return true;
  } catch {
    return false;
  }
}

// 真人滑动：从 (fromX,fromY) 拖到 (toX,toY)。相比旧版"干净 easeInOutQuad"，本版刻意模拟
// 真实人手的轨迹特征，以通过阿里 no-captcha 之类带行为风控的滑块：
//   - 前段慢、中段加速、末段减速（非线性 increment，而非纯缓动曲线）；
//   - 全程 X/Y 双轴抖动 + 正弦 Y 摆动（人手不可能绝对水平）；
//   - 中段 1~2 处"犹豫停顿"（hesitation）；
//   - 约 6% 概率出现"回退微修正"（先往回挪一点再继续）；
//   - 终点前轻微过冲（overshoot）2~4px，再回正到精确目标（人的"对位"动作）。
// steps 越多轨迹点越密。专用于滑块验证等拖拽场景。
export async function humanDrag(
  page: Page,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  opts: { steps?: number; beforeMs?: number; afterMs?: number } = {}
): Promise<void> {
  const steps = opts.steps ?? 75;
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dir = dx >= 0 ? 1 : -1;

  // 1) 直接移到把手上方（steps:1 瞬间到位），按住前犹豫（像人在瞄准）。
  //    ⚠️ 用 steps:1 而非多步滑移：避免从屏幕任意旧位置横跨整页滑到滑块时，
  //    途经页面的 hover 元素（按钮、底部横幅 hover-only 关闭钮等）级联触发 hover 态 → 整页"闪"。
  //    真人也是快速伸手去抓滑块，不会慢滑过整页。
  await page.mouse.move(fromX, fromY, { steps: 1 });
  await humanDelay(opts.beforeMs ?? 120, 90);
  await page.mouse.down();
  await humanDelay(30, 30);

  // 2) 分段推进：progress 0→1，increment 非线性（首尾慢、中段快）。
  //    整体约 0.5~0.8s：正常人拖滑块的速度（用户反馈之前太慢）。
  let p = 0;
  const hesitations = new Set([Math.floor(steps * (0.35 + Math.random() * 0.2))]); // 1 处犹豫
  for (let i = 1; i <= steps; i++) {
    let inc = (0.9 / steps) * (0.7 + Math.random() * 0.9); // 每步推进量带随机
    if (i < steps * 0.15) inc *= 0.7; // 起步慢
    if (i > 0.82 * steps) inc *= 0.7; // 收尾慢
    p = Math.min(1, p + inc);
    const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;

    // 回退微修正：约 5% 步出现，制造非直线、非单向轨迹
    let pe = eased;
    if (Math.random() < 0.05) pe = Math.max(0, eased - 0.008 - Math.random() * 0.012);

    const x = fromX + dx * pe + (Math.random() - 0.5) * 1.8; // X 抖动 ±0.9
    const y = fromY + dy * pe + Math.sin(i * 0.7) * 0.9 + (Math.random() - 0.5) * 1.4; // Y 摆动+抖动
    await page.mouse.move(x, y, { steps: 1 });

    let delay = 2 + Math.random() * 5; // 2~7ms（快速但非匀速）
    if (hesitations.has(i)) delay += 50 + Math.random() * 70; // 犹豫停顿（短）
    await humanDelay(delay, 0);
  }

  // 3) 终点对位：轻微过冲再回正（人手"到位"动作），避免停在墙边的生硬感
  await page.mouse.move(toX + dir * 3, toY, { steps: 2 });
  await humanDelay(30, 25);
  await page.mouse.move(toX, toY, { steps: 2 });
  await humanDelay(opts.afterMs ?? 130, 90);
  await page.mouse.up();
  await humanDelay(120, 120); // 松手后停顿
}
