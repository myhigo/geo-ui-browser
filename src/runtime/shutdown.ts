// 优雅退出：容器停止（SIGTERM）时把所有浏览器/上下文关干净。
//
// 不做这件事的后果：每次重启都留下一批僵尸 Chrome，几轮之后内存被吃光 ——
// 这是这类服务最常见的"跑着跑着就挂"的原因。

import type { Browser, BrowserContext } from 'playwright';

const contexts = new Set<BrowserContext>();
const browsers = new Set<Browser>();
let shuttingDown = false;

export function trackContext(c: BrowserContext): void {
  contexts.add(c);
}
export function untrackContext(c: BrowserContext): void {
  contexts.delete(c);
}
export function trackBrowser(b: Browser | null): void {
  if (b) browsers.add(b);
}
export function untrackBrowser(b: Browser | null): void {
  if (b) browsers.delete(b);
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

async function graceful(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const n = contexts.size;
  console.log(`[shutdown] 收到 ${signal}，正在关闭 ${n} 个浏览器上下文…`);
  await Promise.all([...contexts].map((c) => c.close().catch(() => {})));
  await Promise.all([...browsers].map((b) => b.close().catch(() => {})));
  contexts.clear();
  browsers.clear();
  console.log('[shutdown] 已关闭，退出');
  process.exit(0);
}

export function installShutdownHandlers(): void {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      void graceful(sig);
    });
  }
}
