// 匿名身份/轮换计数的键值仓储。
//
// 现状：.profiles/<dir>.json、.profiles/qwen.json 等零散文件。
// P2 换成 MySQL 的 identity_state 表（state_key + payload JSON），接口不变。

import fs from 'fs';
import path from 'path';
import { paths } from '../config/index.js';

export interface IdentityRepo {
  get(key: string): Promise<Record<string, unknown> | null>;
  set(key: string, value: Record<string, unknown>): Promise<void>;
}

const file = (): string => path.join(paths.profilesRoot, '_identity.json');

function readAll(): Record<string, Record<string, unknown>> {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf-8')) as Record<string, Record<string, unknown>>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Record<string, unknown>>): void {
  fs.mkdirSync(paths.profilesRoot, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}

export class FileIdentityRepo implements IdentityRepo {
  async get(key: string): Promise<Record<string, unknown> | null> {
    return readAll()[key] ?? null;
  }

  async set(key: string, value: Record<string, unknown>): Promise<void> {
    const all = readAll();
    all[key] = value;
    writeAll(all);
  }
}

/** 全局唯一实例；P2 换成 MySQL 实现时只改这里 */
export const identityRepo: IdentityRepo = new FileIdentityRepo();
