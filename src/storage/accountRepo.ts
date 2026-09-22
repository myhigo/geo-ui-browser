// 账号台账仓储层。
//
// 两种实现：
//   FileAccountRepo  —— 本地 json（GEO_STORAGE=file，本机开发用）
//   MysqlAccountRepo —— 数据库（默认，生产用）
// 上层只依赖 AccountRepo 接口，切换后端零改动。接口一律异步（MySQL 天然异步）。
//
// 上层 Account.id 即库里的 account_code（如 doubao-1），自增 id 仅库内使用。

import fs from 'fs';
import path from 'path';
import { paths, config } from '../config/index.js';
import { dbPool } from '../db/pool.js';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

export type AccountStatus = 'none' | 'waiting' | 'active' | 'cooling' | 'failed';

export interface Account {
  id: string; // = account_code（如 doubao-1）
  /** 专属 profile 目录（绝对路径） */
  dir: string;
  alias?: string;
  /** 登录后抓取的账号昵称 */
  marker?: string;
  status: AccountStatus;
  note?: string;
  createdAt?: number;
  lastUsedAt?: number;
  todayQueries?: number;
  /** 最后更新 todayQueries 的本地日期 YYYY-MM-DD，用于跨天自动归零 */
  queryDate?: string;
  consecutiveFails?: number;
  /** 停用后不参与挑号 */
  enabled?: boolean;
  /** 越大越优先 */
  priority?: number;
  proxyHost?: string;
  proxyPort?: number;
  /** 绑定代理 IP 的 id（geo_ui_proxy_ip.id）；null/未填 = 不绑代理（走宿主机出口） */
  proxyId?: number;
  /** 占用者（instanceId）；null/空 = 空闲。跨重启可据此回收脏占用 */
  leasedBy?: string | null;
}

export interface AccountRepo {
  list(platformId: string): Promise<Account[]>;
  get(platformId: string, accountId: string): Promise<Account | undefined>;
  /** 局部更新；不存在返回 undefined */
  patch(platformId: string, accountId: string, patch: Partial<Account>): Promise<Account | undefined>;
  add(platformId: string, account: Account): Promise<void>;
  remove(platformId: string, accountId: string): Promise<void>;
}

/** 账号 profile 目录：<profilesRoot>/<platform>-<seq> */
export const profileDirOf = (platformId: string, seq: number): string =>
  path.join(paths.profilesRoot, `${platformId}-${seq}`);

// ─────────────────────────── 文件实现 ───────────────────────────

const ledgerFileOf = (platformId: string): string =>
  path.join(paths.profilesRoot, `${platformId}.accounts.json`);
const legacyStateFileOf = (platformId: string): string =>
  path.join(paths.profilesRoot, `${platformId}.login.json`);

export class FileAccountRepo implements AccountRepo {
  async list(platformId: string): Promise<Account[]> {
    try {
      return JSON.parse(fs.readFileSync(ledgerFileOf(platformId), 'utf-8')) as Account[];
    } catch {
      return this.migrateLegacy(platformId);
    }
  }

  /** 无台账时尝试迁移旧版「单身份」文件 */
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
      migrated = [
        {
          id: `${platformId}-1`,
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
        },
      ];
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
    this.saveSync(platformId, accounts);
    return accounts[idx];
  }

  async add(platformId: string, account: Account): Promise<void> {
    const accounts = await this.list(platformId);
    accounts.push(account);
    this.saveSync(platformId, accounts);
  }

  async remove(platformId: string, accountId: string): Promise<void> {
    const accounts = await this.list(platformId);
    this.saveSync(
      platformId,
      accounts.filter((a) => a.id !== accountId)
    );
  }

  private saveSync(platformId: string, accounts: Account[]): void {
    fs.mkdirSync(paths.profilesRoot, { recursive: true });
    fs.writeFileSync(ledgerFileOf(platformId), JSON.stringify(accounts, null, 2));
  }
}

// ─────────────────────────── MySQL 实现 ───────────────────────────

/** 上层字段 → 列名白名单（防注入：只认这些 key） */
const FIELD_MAP: Record<string, string> = {
  id: 'account_code',
  dir: 'profile_dir',
  alias: 'alias',
  marker: 'marker',
  status: 'status',
  note: 'note',
  createdAt: 'created_at',
  lastUsedAt: 'last_used_at',
  todayQueries: 'today_queries',
  queryDate: 'query_date',
  consecutiveFails: 'consecutive_fails',
  enabled: 'enabled',
  priority: 'priority',
  proxyHost: 'proxy_host',
  proxyPort: 'proxy_port',
  proxyId: 'proxy_id',
  leasedBy: 'leased_by',
};

/** note 列写入长度保护：浏览器启动失败等报错可能很长（含 ASCII 提示框），超长截断，
 *  避免 ER_DATA_TOO_LONG 让一次本该写入的失败状态反过来拖垮进程。 */
const NOTE_MAX = 500;
const clipNote = (v: unknown): unknown =>
  typeof v === 'string' && v.length > NOTE_MAX ? v.slice(0, NOTE_MAX) : v;

const SELECT_COLS = `account_code AS id, profile_dir AS dir, alias, marker, status, note,
  enabled, priority,
  UNIX_TIMESTAMP(created_at) * 1000 AS createdAt,
  UNIX_TIMESTAMP(last_used_at) * 1000 AS lastUsedAt,
  today_queries AS todayQueries, query_date AS queryDate,
  consecutive_fails AS consecutiveFails,
  proxy_host AS proxyHost, proxy_port AS proxyPort, proxy_id AS proxyId, leased_by AS leasedBy`;

interface Row extends RowDataPacket {
  id: string;
  dir: string;
  alias?: string | null;
  marker?: string | null;
  status: AccountStatus;
  note?: string | null;
  enabled: number;
  priority: number;
  createdAt?: number | string | null;
  lastUsedAt?: number | string | null;
  todayQueries?: number | null;
  queryDate?: string | null;
  consecutiveFails?: number | null;
  proxyHost?: string | null;
  proxyPort?: number | null;
  proxyId?: number | null;
  leasedBy?: string | null;
}

const toAccount = (r: Row): Account => ({
  id: r.id,
  dir: r.dir,
  alias: r.alias ?? undefined,
  marker: r.marker ?? undefined,
  status: r.status,
  note: r.note ?? undefined,
  createdAt: r.createdAt == null ? undefined : Number(r.createdAt),
  lastUsedAt: r.lastUsedAt == null ? undefined : Number(r.lastUsedAt),
  todayQueries: r.todayQueries ?? 0,
  queryDate: r.queryDate ?? undefined,
  consecutiveFails: r.consecutiveFails ?? 0,
  enabled: r.enabled === 1,
  priority: r.priority ?? 0,
  proxyHost: r.proxyHost ?? undefined,
  proxyPort: r.proxyPort ?? undefined,
  proxyId: r.proxyId == null ? undefined : Number(r.proxyId),
  leasedBy: r.leasedBy ?? null,
});

/** 值转换：时间戳→FROM_UNIXTIME、布尔→0/1、其余原样 */
const toColumnValue = (key: string, v: unknown): unknown => {
  if (key === 'createdAt' || key === 'lastUsedAt') {
    return v == null ? null : new Date(v as number);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v ?? null;
};

export class MysqlAccountRepo implements AccountRepo {
  async list(platformId: string): Promise<Account[]> {
    const [rows] = await dbPool().query<Row[]>(
      `SELECT ${SELECT_COLS} FROM geo_ui_platform_account
        WHERE node_id = ? AND platform_id = ?
        ORDER BY account_code`,
      [config.nodeId, platformId]
    );
    return rows.map(toAccount);
  }

  async get(platformId: string, accountId: string): Promise<Account | undefined> {
    const [rows] = await dbPool().query<Row[]>(
      `SELECT ${SELECT_COLS} FROM geo_ui_platform_account
        WHERE node_id = ? AND platform_id = ? AND account_code = ?`,
      [config.nodeId, platformId, accountId]
    );
    return rows.length ? toAccount(rows[0]) : undefined;
  }

  async patch(
    platformId: string,
    accountId: string,
    patch: Partial<Account>
  ): Promise<Account | undefined> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = FIELD_MAP[k];
      if (!col || k === 'id') continue; // 主键不参与更新
      sets.push(`${col} = ?`);
      vals.push(toColumnValue(k, k === 'note' ? clipNote(v) : v));
    }
    if (!sets.length) return this.get(platformId, accountId);
    const [res] = await dbPool().query<ResultSetHeader>(
      `UPDATE geo_ui_platform_account SET ${sets.join(', ')}
        WHERE node_id = ? AND platform_id = ? AND account_code = ?`,
      [...vals, config.nodeId, platformId, accountId]
    );
    return res.affectedRows ? this.get(platformId, accountId) : undefined;
  }

  async add(platformId: string, account: Account): Promise<void> {
    await dbPool().query(
      `INSERT INTO geo_ui_platform_account
         (node_id, platform_id, account_code, alias, marker, status, note, profile_dir,
          today_queries, query_date, consecutive_fails, last_used_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(? / 1000), NOW())`,
      [
        config.nodeId,
        platformId,
        account.id,
        account.alias ?? null,
        account.marker ?? null,
        account.status,
        clipNote(account.note) ?? null,
        account.dir,
        account.todayQueries ?? 0,
        account.queryDate ?? null,
        account.consecutiveFails ?? 0,
        account.lastUsedAt ?? null,
      ]
    );
  }

  async remove(platformId: string, accountId: string): Promise<void> {
    await dbPool().query(
      `DELETE FROM geo_ui_platform_account WHERE node_id = ? AND platform_id = ? AND account_code = ?`,
      [config.nodeId, platformId, accountId]
    );
  }
}

// ─────────────────────────── 工厂 ───────────────────────────

let instance: AccountRepo | null = null;

/** 惰性构造：首次调用时才根据配置选择实现（避免模块加载期就连库） */
export function accountRepo(): AccountRepo {
  if (!instance) instance = config.storage === 'file' ? new FileAccountRepo() : new MysqlAccountRepo();
  return instance;
}
