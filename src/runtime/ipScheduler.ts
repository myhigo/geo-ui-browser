// 代理 IP 调度器：收录检测 / 信源分析 / 单次问答统一从这里拿「可用 IP + 该 IP 下的账号」。
//
// 规则（2026-09-22 用户定稿）：
//   1. 一个词一个 IP：任务（词）先挑 IP，再从该 IP 绑定的账号里挑各平台账号执行；
//   2. IP 冷却：IP 用完后 last_used_at=now，冷却 GEO_IP_INTERVAL(默认120s) 内不可再次分配，
//      分配时按 last_used_at 升序取最早（LRU），最早的还在冷却 → 休眠等待直到冷却结束；
//   3. 占用租约：IP/账号被占用即记录时间戳，超过 5 分钟未释放（崩溃残留）→ 视为空闲直接可用；
//      正常结束由 finally 主动释放。
//   4. 账号挑选：同 IP 下各平台账号按 今日次数升序、最近使用升序 挑一个（IP 冷却已由 IP 层控制，
//      账号层不再判断延迟）。

import { config } from '../config/index.js';
import { accountRepo, Account } from '../storage/accountRepo.js';
import { proxyRepo, ProxyIp } from '../storage/proxyRepo.js';

// ---------- 占用表（内存，时间戳租约） ----------
// key: `ip:<id>` / `acc:<platform>/<accountId>` → 占用开始时间
const busy = new Map<string, number>();

function isBusy(key: string): boolean {
  const t = busy.get(key);
  if (t === undefined) return false;
  if (Date.now() - t >= config.ipLeaseMs) {
    // 租约过期（超过 5 分钟未释放）→ 视为空闲并回收，下次直接可用
    busy.delete(key);
    return false;
  }
  return true;
}

function markBusy(key: string): void {
  busy.set(key, Date.now());
}

function clearBusy(key: string): void {
  busy.delete(key);
}

/** 占用快照（排查用） */
export function busySnapshot(): Record<string, number> {
  const o: Record<string, number> = {};
  for (const [k, t] of busy) if (Date.now() - t < config.ipLeaseMs) o[k] = t;
  return o;
}

// ---------- 工具 ----------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function todayStr(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 冷却是否已过：now - lastUsedAt >= 冷却秒数（从未用过 → 立即可用） */
export function ipCooled(ip: ProxyIp): boolean {
  if (!ip.lastUsedAt) return true;
  return Date.now() - ip.lastUsedAt >= config.ipIntervalSec * 1000;
}

/** 剩余冷却毫秒（>0 表示还要等） */
export function ipRemainingCooldown(ip: ProxyIp): number {
  if (!ip.lastUsedAt) return 0;
  const wait = config.ipIntervalSec * 1000 - (Date.now() - ip.lastUsedAt);
  return wait > 0 ? wait : 0;
}

// ---------- 分配 ----------

export interface IpAllocation {
  ip: ProxyIp;
  /** 用完后必须调用 releaseIp(id) */
  release: () => void;
}

/**
 * 挑一个可用 IP 并占用：
 * - 启用 + 未被占用（5 分钟租约内）的 IP；
 * - 按 last_used_at 升序取最早；最早的还在冷却 → 休眠等待其冷却结束（最多等 timeoutMs）。
 * 返回 null 表示：没有启用 IP / 全部被占用 / 等待超时。
 */
export async function acquireIp(timeoutMs = 5 * 60 * 1000): Promise<IpAllocation | null> {
  const t0 = Date.now();
  for (;;) {
    const ips = await proxyRepo().list();
    const free = ips.filter(
      (p) => p.enabled !== false && !isBusy(`ip:${p.id}`)
    );
    if (free.length === 0) {
      if (Date.now() - t0 >= timeoutMs) return null;
      await sleep(2000);
      continue;
    }
    // LRU：按最近使用升序（从未用过的排最前）
    free.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
    const pick = free[0];
    const wait = ipRemainingCooldown(pick);
    if (wait > 0) {
      if (Date.now() - t0 + wait >= timeoutMs) return null;
      // 等待该 IP 冷却结束（等待期间可能有更早的 IP 冷却完成，下一轮会重新排序）
      await sleep(Math.min(wait, 5000));
      continue;
    }
    // 占用（写入租约）
    markBusy(`ip:${pick.id}`);
    const id = pick.id;
    return {
      ip: pick,
      release: () => {
        clearBusy(`ip:${id}`);
        void proxyRepo()
          .patch(id, { lastUsedAt: Date.now() })
          .catch(() => {});
      },
    };
  }
}

/** 按占用状态判断账号是否可用（5 分钟租约内被占用 → 不可用） */
export function accountIdle(accountId: string): boolean {
  return !isBusy(`acc:${accountId}`);
}

/**
 * 在指定 IP 下挑一个可用账号并占用。
 * 条件：绑定该 IP（proxyId 匹配）+ active + 启用 + 未被占用（5 分钟租约内）。
 * 排序：今日次数升序 → 最近使用升序（用得最少的优先）。
 */
export async function acquireAccountByIp(
  platformId: string,
  ipId: number,
  opts: { onlyProxyBound?: boolean } = {}
): Promise<Account | undefined> {
  const accounts = await accountRepo().list(platformId);
  const today = todayStr();
  const usable = accounts.filter(
    (a) =>
      a.status === 'active' &&
      a.enabled !== false &&
      a.proxyId === ipId &&
      accountIdle(a.id)
  );
  if (usable.length === 0) return undefined;
  usable.sort((a, b) => {
    const ta = a.queryDate === today ? (a.todayQueries ?? 0) : 0;
    const tb = b.queryDate === today ? (b.todayQueries ?? 0) : 0;
    if (ta !== tb) return ta - tb;
    return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0);
  });
  const pick = usable[0];
  markBusy(`acc:${pick.id}`);
  return pick;
}

/** 释放账号占用（清 busy 租约；DB 回写由 loginRegistry.releaseAccount 负责） */
export function releaseAccountBusy(accountId: string): void {
  clearBusy(`acc:${accountId}`);
}

/**
 * 单次任务（不指定 IP）时：挑一个可用 IP 并占用账号；返回分配信息，用完须分别 release。
 * 复用 acquireIp + acquireAccountByIp。
 */
export async function acquireForTask(
  platformId: string
): Promise<{ ip: IpAllocation; account?: Account } | null> {
  const alloc = await acquireIp();
  if (!alloc) return null;
  const account = await acquireAccountByIp(platformId, alloc.ip.id);
  if (!account) {
    // 该 IP 下没有该平台的账号 → 归还 IP，返回空（调用方决定跳过）
    alloc.release();
    return { ip: alloc, account: undefined };
  }
  return { ip: alloc, account };
}
