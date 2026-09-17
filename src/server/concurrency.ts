/**
 * 并发护栏：最多 limit 个任务同时执行 fn，全部完成才 resolve。
 *
 * 用途：并行模式下限制同时打开浏览器的数量，防止一次性起过多 Chromium 把机器内存打满。
 * 信源分析（parallel 模式：同词多平台并行）与收录检测（同词多平台并发）共用。
 *
 * ⚠️ 契约：fn 必须自行消化异常。内部用 `Promise.all`，任一任务 reject 会导致整体 reject
 *   并丢失其余任务的执行结果——所以调用方要在 fn 内部 try/catch。
 */
export async function withConcurrencyLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const cur = idx++;
      await fn(items[cur]);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
}
