// 账号台账仓储层。
//
// 目前只有文件实现（FileAccountRepo，行为与重构前完全一致：.profiles/<platform>.accounts.json）。
// P2 会加 MySQL 实现，届时只需换掉 `accountRepo` 的构造，业务代码零改动 —— 故接口一律异步。

import fs from 'fs';
import path from 'path';
import { paths } from '../config/index.js';

export type AccountStatus = 'none' | 'waiting' | 'active' | 'cooling' | 'failed';

export interface Account {
  id: string;
  /** 专属 profile 目录（绝对路径） */
  dir: string;
  /** 用户备注，防混用（如：主号尾号1234） */
  alias?: string;
  /** 登录后尝试从页面抓取的账号标识（昵称/头像 alt 等），best-effort */
  marker?: string;
  status: AccountStatus;
  note?: string;
  createdAt?: number;
  lastUsedAt?: number;
  todayQueries?: number;
  /** 最后更新 todayQueries 的本地日期 YYYY-MM-DD，用于跨天自动归零 */
  queryDate?: string;
  consecutiveFails?: number;
  // ↓ 服务器部署后新增（P2 建表时落库，见 doc/refactor-design.md §5）
  enabled?: boolean; // 停用后不参与挑号
  priority?: number; // 越大越优先
  proxyHost?: string;
  proxyPort?: number;
}

export interface AccountRepo {
  list(platformId: string): Promise<Account[]>;
  get(platformId: string, accountId: string): Promise<Account | undefined>;
  /** 局部更新某账号；不存在返回 undefined */
  patch(platformId: string, accountId: string, patch: Partial<Account>): Promise<Account | undefined>;
  /** 整表覆盖写（新增/删除后调用） */
  save(platformId: string, accounts: Account[]): Promise<void>;
}

const ledgerFileOf = (platformId: string): string =>
  path.join(paths.profilesRoot, `${platformId}.accounts.json`);
const legacyStateFileOf = (platformId: string): string =>
  path.join(paths.profilesRoot, `${platformId}.login.json`);

/** 账号 profile 目录：.profiles/<platform>-<seq> */
export const profileDirOf = (platformId: string, seq: number): string =>
  path.join(paths.profilesRoot, `${platformId}-${seq}`);

export class FileAccountRepo implements AccountRepo {
  async list(platformId: string): Promise<Account[]> {
    try {
      return JSON.parse(fs.readFileSync(ledgerFileOf(platformId), 'utf-8')) as Account[];
    } catch {
      return this.migrateLegacy(platformId);
    }
  }

  /** 无台账时尝试迁移旧版「单身份」文件，迁移成功即落新台账并删旧文件 */
  private migrateLegacy(platformId: string): Account[] {
    let migrated: Account[] = [];
    try {
      const old = JSON.parse(fs.readFileSync(legacyStateFileOf(platformId), 'utf-8')) as {
        status?: string;
        note?: string;
        createdAt?: number;
        lastUsedAt?: number;
        todayQueries?: number;
        consecutiveFails?: number;
      };
      const seq = 1;
      const acc: Account = {
        id: `${platformId}-${seq}`,
        dir: path.join(paths.profilesRoot, platformId), // 旧版目录就是平台名，保持不搬动
        alias: '账号1',
        status: (['active', 'failed', 'cooling'].includes(old.status ?? '')
          ? old.status
          : 'none') as AccountStatus,
        note: old.note,
        createdAt: old.createdAt,
        lastUsedAt: old.lastUsedAt,
        todayQueries: old.todayQueries ?? 0,
        consecutiveFails: old.consecutiveFails ?? 0,
      };
      migrated = [acc];
      fs.rmSync(legacyStateFileOf(platformId), { force: true });
      this.saveSync(platformId, migrated);
    } catch {
      migrated = [];
    }
    return migrated;
  }

  async get(platformId: string, accountId: string): Promise<Account | undefined> {
    return (await this.list(platformId)).find((a) => a.id === accountId);
  }

  async patch(
    platformId: string,
    accountId: string,
    patch: Partial<Account>
  ): Promise<Account | undefined> {
    const accounts = await this.list(platformId);
    const idx = accounts.findIndex((a) => a.id === accountId);
    if (idx < 0) return undefined;
    accounts[idx] = { ...accounts[idx], ...patch };
    await this.save(platformId, accounts);
    return accounts[idx];
  }

  async save(platformId: string, accounts: Account[]): Promise<void> {
    this.saveSync(platformId, accounts);
  }

  private saveSync(platformId: string, accounts: Account[]): void {
    fs.mkdirSync(paths.profilesRoot, { recursive: true });
    fs.writeFileSync(ledgerFileOf(platformId), JSON.stringify(accounts, null, 2));
  }
}

/** 全局唯一实例；P2 换成 MySQL 实现时只改这里 */
export const accountRepo: AccountRepo = new FileAccountRepo();
