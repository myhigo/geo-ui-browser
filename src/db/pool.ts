// MySQL 连接池。惰性创建：只有 storage=mysql 时才会真正连库。
// ⚠️ 连不上就快速失败并给出明确原因，绝不静默降级到文件存储（那会导致"以为写库了其实写文件"）。

import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { config } from '../config/index.js';

let pool: Pool | null = null;

export function dbPool(): Pool {
  if (pool) return pool;
  const { host, port, user, password, database } = config.db;
  const missing = [
    !host && 'DB_HOST',
    !user && 'DB_USER',
    !database && 'DB_NAME',
  ].filter(Boolean) as string[];
  if (missing.length) {
    throw new Error(
      `storage=mysql 但缺少数据库配置：${missing.join('、')}。` +
        `请在环境变量中补齐，或设置 GEO_STORAGE=file 使用本地文件存储。`
    );
  }
  pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
    // ⚠️ 与容器 TZ 保持一致，否则"今日查询次数"的跨天归零会错乱
    timezone: '+08:00',
    dateStrings: ['DATE'], // DATE 列直接返回 'YYYY-MM-DD' 字符串
  });
  return pool;
}

/** 启动自检：连一次库，失败即抛（快速失败） */
export async function pingDb(): Promise<void> {
  const conn = await dbPool().getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}

/** 启动时回收本节点的脏占用（上次进程非正常退出留下的 lease） */
export async function releaseStaleLeases(nodeId: string): Promise<number> {
  const [res] = await dbPool().query<ResultSetHeader>(
    `UPDATE platform_account SET leased_by = NULL, leased_at = NULL
      WHERE node_id = ? AND leased_by IS NOT NULL`,
    [nodeId]
  );
  return res.affectedRows;
}

export type { PoolConnection };
