// 出口（egress）并发闸门。
//
// 目的：同一个公网出口 IP 上，同时只能用有限个账号在对话。
// 50 个账号挤同一个 IP 时，若多个浏览器并发，平台看到的是"同一 IP 秒级内多账号对话"
// ——最典型的机器人特征。上限设 1 即"同一 IP 一次只做一件事"，最像真人。
//
// 出口归属：账号配了代理 → 每个代理 IP 一个出口；没配代理 → 共享服务器默认出口（default）。
// 将来买了代理，只需在账号上填 proxyHost，并发控制自动按出口生效，代码不用改。

import { config } from '../config/index.js';
import type { Account } from '../storage/accountRepo.js';

const running = new Map<string, number>();

/** 账号所属出口的键 */
export function egressKeyOf(acc: Pick<Account, 'proxyHost' | 'proxyPort'>): string {
  return acc.proxyHost ? `proxy:${acc.proxyHost}:${acc.proxyPort ?? ''}` : 'default';
}

export function egressCount(key: string): number {
  return running.get(key) ?? 0;
}

/** 该出口是否还有空位 */
export function egressAvailable(key: string): boolean {
  return egressCount(key) < Math.max(1, config.maxPerEgress);
}

export function acquireEgress(key: string): void {
  running.set(key, egressCount(key) + 1);
}

export function releaseEgress(key: string): void {
  const n = egressCount(key);
  if (n <= 1) running.delete(key);
  else running.set(key, n - 1);
}

/** 各出口当前占用（日志/排查用） */
export function egressSnapshot(): Record<string, number> {
  return Object.fromEntries(running);
}
