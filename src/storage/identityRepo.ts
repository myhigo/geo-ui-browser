// 匿名身份/轮换计数的键值仓储（对应 identity_state 表）。
//
// file 实现：.profiles/_identity.json
// mysql 实现：identity_state(state_key, payload JSON)

import fs from 'fs';
import path from 'path';
import { paths, config } from '../config/index.js';
import { dbPool } from '../db/pool.js';
import type { RowDataPacket } from 'mysql2';

export interface IdentityRepo {
  get(key: string): Promise<Record<string, unknown> | null>;
  set(key: string, value: Record<string, unknown>): Promise<void>;
}

// ─────────────────────────── 文件实现 ───────────────────────────

const file = (): string => path.join(paths.profilesRoot, '_identity.json');

interface PayloadRow extends RowDataPacket {
  payload: Record<string, unknown> | string;
}

export class FileIdentityRepo implements IdentityRepo {
  async get(key: string): Promise<Record<string, unknown> | null> {
    try {
      const all = JSON.parse(fs.readFileSync(file(), 'utf-8')) as Record<
        string,
        Record<string, unknown>
      >;
      return all[key] ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: Record<string, unknown>): Promise<void> {
    let all: Record<string, Record<string, unknown>> = {};
    try {
      all = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    } catch {
      /* 文件不存在则从空开始 */
    }
    all[key] = value;
    fs.mkdirSync(paths.profilesRoot, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(all, null, 2));
  }
}

// ─────────────────────────── MySQL 实现 ───────────────────────────

export class MysqlIdentityRepo implements IdentityRepo {
  async get(key: string): Promise<Record<string, unknown> | null> {
    const [rows] = await dbPool().query<PayloadRow[]>(
      `SELECT payload FROM identity_state WHERE node_id = ? AND state_key = ?`,
      [config.nodeId, key]
    );
    if (!rows.length) return null;
    const p = rows[0].payload;
    return typeof p === 'string' ? (JSON.parse(p) as Record<string, unknown>) : p;
  }

  async set(key: string, value: Record<string, unknown>): Promise<void> {
    await dbPool().query(
      `INSERT INTO identity_state (node_id, state_key, payload) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE payload = VALUES(payload)`,
      [config.nodeId, key, JSON.stringify(value)]
    );
  }
}

// ─────────────────────────── 工厂 ───────────────────────────

let instance: IdentityRepo | null = null;

export function identityRepo(): IdentityRepo {
  if (!instance) instance = config.storage === 'file' ? new FileIdentityRepo() : new MysqlIdentityRepo();
  return instance;
}
