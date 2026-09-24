// 有头浏览器窗口位置分配：容器内 Xvfb(1600x1000) 上，多个有头 Chrome 默认都从 (0,0)
// 堆叠、互相遮挡 —— noVNC iframe 里只能看到最上层的窗口（如登录窗口），
// 收录检测任务窗口被盖住 → "看不到输入"。
// 这里按 profile 目录名（seed）哈希错开摆放：5 列 x 4 行 = 20 个槽位，互不重叠。

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function windowPositionFor(seed: string): string {
  const h = hash(seed || 'default');
  const col = h % 5;
  const row = Math.floor(h / 5) % 4;
  const x = 24 + col * 210; // 210 步进：窗口可分辨错开
  const y = 24 + row * 160;
  return `--window-position=${x},${y}`;
}
