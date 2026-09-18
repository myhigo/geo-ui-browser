// 数据库自检：配好环境变量后一键确认「连得上 + 表建对了 + 字段齐全」。
// 用法：npm run db:check
// （建表由人工执行 sql/schema.sql，本脚本只做校验，不改表结构）

import { config, describeConfig } from '../src/config/index.js';
import { dbPool, pingDb } from '../src/db/pool.js';
import type { RowDataPacket } from 'mysql2';

interface ColRow extends RowDataPacket {
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
}
interface TblRow extends RowDataPacket {
  TABLE_NAME: string;
}

const REQUIRED: Record<string, string[]> = {
  platform_account: [
    'node_id', 'platform_id', 'account_code', 'alias', 'marker', 'status', 'enabled',
    'priority', 'note', 'profile_dir', 'today_queries', 'query_date', 'consecutive_fails',
    'last_used_at', 'leased_by', 'leased_at', 'proxy_host', 'proxy_port', 'created_at', 'updated_at',
  ],
  identity_state: ['node_id', 'state_key', 'payload', 'updated_at'],
  login_session: ['node_id', 'platform_id', 'account_code', 'kind', 'phase', 'started_at', 'expires_at'],
};

async function main(): Promise<void> {
  console.log(`[config] ${describeConfig()}`);
  if (config.storage !== 'mysql') {
    console.log('❌ 当前 GEO_STORAGE=file，不会连库。请设置 GEO_STORAGE=mysql 后再检查。');
    process.exit(1);
  }
  try {
    await pingDb();
  } catch (e) {
    console.error(`❌ 连不上数据库：${(e as Error).message}`);
    console.error('   请检查 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME 是否正确。');
    process.exit(1);
  }
  console.log(`✅ 连接正常：${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);

  const [tables] = await dbPool().query<TblRow[]>(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
  );
  const have = new Set(tables.map((t) => t.TABLE_NAME));
  let bad = 0;

  for (const [table, cols] of Object.entries(REQUIRED)) {
    if (!have.has(table)) {
      console.error(`❌ 缺表：${table}（请执行 sql/schema.sql）`);
      bad++;
      continue;
    }
    const [rows] = await dbPool().query<ColRow[]>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table]
    );
    const exist = new Set(rows.map((r) => r.COLUMN_NAME));
    const missing = cols.filter((c) => !exist.has(c));
    if (missing.length) {
      console.error(`❌ ${table} 缺列：${missing.join(', ')}`);
      bad++;
    } else {
      console.log(`✅ ${table}（${cols.length} 个字段齐全）`);
    }
  }

  const [cnt] = await dbPool().query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM platform_account WHERE node_id = ?`,
    [config.nodeId]
  );
  console.log(`ℹ️  当前节点 ${config.nodeId} 下已有账号 ${(cnt[0] as { n: number }).n} 条`);

  if (bad) {
    console.error(`\n${bad} 项不通过，请按 sql/schema.sql 建表后重试。`);
    process.exit(1);
  }
  console.log('\n全部通过 ✅');
  process.exit(0);
}

void main();
