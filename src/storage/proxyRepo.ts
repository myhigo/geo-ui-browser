// 代理 IP 池仓储层。
//
// 两种实现：
//   FileProxyRepo  —— 本地 json（GEO_STORAGE=file，本机开发用）
//   MysqlProxyRepo —— 数据库（默认，生产用）
// 上层只依赖 ProxyRepo 接口，切换后端零改动。接口一律异步。
//
// 用途：收录检测 / 采集 / 单次问答统一从 IP 池挑代理（LRU + 冷却 120s + 5 分钟占用租约），
// 账号通过 proxy_id 关联到某个 IP，浏览器启动时把代理真实传给 Chromium。

import fs from 'fs';
import path from 'path';
import { paths, config } from '../config/index.js';
import { dbPool } from '../db/pool.js';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

export interface ProxyIp {
  /** 库内自增 id */
  id: number;
  nodeId: string;
  host: string;
  port: number;
  /** http / socks5（添加时默认 http；host 带 socks5:// 前缀自动识别） */
  protocol: 'http' | 'socks5';
  username?: string;
  password?: string;
  enabled?: boolean;
  note?: string;
  /** 绑定账号数（冗余，删除前校验） */
  usedCount?: number;
  /** 最近使用时间（ms），IP 冷却 120s 依据 */
  lastUsedAt?: number;
}

export interface ProxyRepo {
  list(): Promise<ProxyIp[]>;
  get(id: number): Promise<ProxyIp | undefined>;
  add(p: Omit<ProxyIp, 'id' | 'nodeId'>): Promise<ProxyIp>;
  patch(id: number, patch: Partial<ProxyIp>): Promise<ProxyIp | undefined>;
  remove(id: number): Promise<void>;
  /** 绑定到该 IP 的账号数（删除前校验用） */
  countAccountsByProxy(id: number): Promise<number>;
}

/** host 带 socks5:// 前缀 → 识别为 socks5；否则默认 http */
export function splitProxyHost(raw: string): { host: string; protocol: 'http' | 'socks5'; port?: number } {
  const s = (raw || '').trim();
  const m = /^(socks5|http):\/\/(.+)$/i.exec(s);
  if (m) {
    const hostPort = m[2];
    const port = hostPort.includes(':') ? Number(hostPort.split(':').pop()) : undefined;
    return { host: hostPort.split(':')[0], protocol: m[1].toLowerCase() as 'http' | 'socks5', port };
  }
  const port = s.includes(':') ? Number(s.split(':').pop()) : undefined;
  return { host: s.split(':')[0], protocol: 'http', port };
}

// ─────────────────────────── 文件实现 ───────────────────────────

const proxiesFile = (): string => paths.proxiesFile;

export class FileProxyRepo implements ProxyRepo {
  private load(): ProxyIp[] {
    try {
      return JSON.parse(fs.readFileSync(proxiesFile(), 'utf-8')) as ProxyIp[];
    } catch {
      return [];
    }
  }

  private save(list: ProxyIp[]): void {
    fs.mkdirSync(path.dirname(proxiesFile()), { recursive: true });
    fs.writeFileSync(proxiesFile(), JSON.stringify(list, null, 2));
  }

  async list(): Promise<ProxyIp[]> {
    return this.load().filter((p) => p.nodeId === config.nodeId);
  }

  async get(id: number): Promise<ProxyIp | undefined> {
    return (await this.list()).find((p) => p.id === id);
  }

  async add(p: Omit<ProxyIp, 'id'>): Promise<ProxyIp> {
    const list = this.load();
    const nextId = list.reduce((m, x) => Math.max(m, x.id), 0) + 1;
    const row: ProxyIp = { ...p, id: nextId, nodeId: config.nodeId, enabled: p.enabled ?? true, usedCount: 0 };
    list.push(row);
    this.save(list);
    return row;
  }

  async patch(id: number, patch: Partial<ProxyIp>): Promise<ProxyIp | undefined> {
    const list = this.load();
    const idx = list.findIndex((p) => p.id === id);
    if (idx < 0) return undefined;
    list[idx] = { ...list[idx], ...patch, id };
    this.save(list);
    return list[idx];
  }

  async remove(id: number): Promise<void> {
    this.save(this.load().filter((p) => p.id !== id));
  }

  async countAccountsByProxy(id: number): Promise<number> {
    // file 模式没有账号库关联查询：从各平台台账统计 proxyId
    const root = paths.profilesRoot;
    let n = 0;
    try {
      for (const f of fs.readdirSync(root)) {
        if (!f.endsWith('.accounts.json')) continue;
        const arr = JSON.parse(fs.readFileSync(path.join(root, f), 'utf-8')) as { proxyId?: number }[];
        n += arr.filter((a) => a.proxyId === id).length;
      }
    } catch {
      /* ignore */
    }
    return n;
  }
}

// ─────────────────────────── MySQL 实现 ───────────────────────────

const SELECT_COLS = `id, node_id AS nodeId, host, port, protocol, username, password, enabled,
  note,
  used_count AS usedCount,
  UNIX_TIMESTAMP(last_used_at) * 1000 AS lastUsedAt`;

interface Row extends RowDataPacket {
  id: number;
  nodeId: string;
  host: string;
  port: number;
  protocol: 'http' | 'socks5';
  username?: string | null;
  password?: string | null;
  enabled: number;
  note?: string | null;
  usedCount?: number | null;
  lastUsedAt?: number | string | null;
}

const toProxy = (r: Row): ProxyIp => ({
  id: r.id,
  nodeId: r.nodeId,
  host: r.host,
  port: r.port,
  protocol: r.protocol === 'socks5' ? 'socks5' : 'http',
  username: r.username ?? undefined,
  password: r.password ?? undefined,
  enabled: r.enabled === 1,
  note: r.note ?? undefined,
  usedCount: r.usedCount ?? 0,
  lastUsedAt: r.lastUsedAt == null ? undefined : Number(r.lastUsedAt),
});

/** 可更新的列白名单（防注入） */
const FIELD_MAP: Record<string, string> = {
  host: 'host',
  port: 'port',
  protocol: 'protocol',
  username: 'username',
  password: 'password',
  enabled: 'enabled',
  note: 'note',
  lastUsedAt: 'last_used_at',
};

export class MysqlProxyRepo implements ProxyRepo {
  async list(): Promise<ProxyIp[]> {
    const [rows] = await dbPool().query<Row[]>(
      `SELECT ${SELECT_COLS} FROM geo_ui_proxy_ip WHERE node_id = ? ORDER BY id`,
      [config.nodeId]
    );
    return rows.map(toProxy);
  }

  async get(id: number): Promise<ProxyIp | undefined> {
    const [rows] = await dbPool().query<Row[]>(
      `SELECT ${SELECT_COLS} FROM geo_ui_proxy_ip WHERE node_id = ? AND id = ?`,
      [config.nodeId, id]
    );
    return rows.length ? toProxy(rows[0]) : undefined;
  }

  async add(p: Omit<ProxyIp, 'id'>): Promise<ProxyIp> {
    const [res] = await dbPool().query<ResultSetHeader>(
      `INSERT INTO geo_ui_proxy_ip (node_id, host, port, protocol, username, password, enabled, note, used_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        config.nodeId,
        p.host,
        p.port,
        p.protocol,
        p.username ?? null,
        p.password ?? null,
        p.enabled === false ? 0 : 1,
        p.note ?? null,
      ]
    );
    return (await this.get(res.insertId))!;
  }

  async patch(id: number, patch: Partial<ProxyIp>): Promise<ProxyIp | undefined> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = FIELD_MAP[k];
      if (!col) continue;
      if (k === 'lastUsedAt') {
        sets.push(`${col} = FROM_UNIXTIME(? / 1000)`);
        vals.push(v == null ? null : Number(v));
      } else if (typeof v === 'boolean') {
        sets.push(`${col} = ?`);
        vals.push(v ? 1 : 0);
      } else {
        sets.push(`${col} = ?`);
        vals.push(v ?? null);
      }
    }
    if (!sets.length) return this.get(id);
    await dbPool().query(`UPDATE geo_ui_proxy_ip SET ${sets.join(', ')} WHERE node_id = ? AND id = ?`, [
      ...vals,
      config.nodeId,
      id,
    ]);
    return this.get(id);
  }

  async remove(id: number): Promise<void> {
    await dbPool().query(`DELETE FROM geo_ui_proxy_ip WHERE node_id = ? AND id = ?`, [config.nodeId, id]);
  }

  async countAccountsByProxy(id: number): Promise<number> {
    const [rows] = await dbPool().query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM geo_ui_platform_account WHERE node_id = ? AND proxy_id = ?`,
      [config.nodeId, id]
    );
    return Number(rows[0]?.n ?? 0);
  }
}

// ─────────────────────────── 工厂 ───────────────────────────

let instance: ProxyRepo | null = null;

export function proxyRepo(): ProxyRepo {
  if (!instance) instance = config.storage === 'file' ? new FileProxyRepo() : new MysqlProxyRepo();
  return instance;
}
