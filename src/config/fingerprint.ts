// 浏览器指纹：登录窗口与采集任务必须共用同一份，否则同一账号会出现
// "在 A 环境登录、在 B 环境对话" → 被平台判异地登录。
//
// UA 不再硬编码（原为 macOS + Chrome/124，在 Linux 服务器上与真实环境矛盾 = 主动暴露）：
// 改为按容器内实际 Chrome 版本动态拼接 Linux UA。

import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { chromium } from 'playwright';
import { config } from './index.js';

export interface Fingerprint {
  userAgent: string;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
  deviceScaleFactor: number;
  hardwareConcurrency: number;
  deviceMemory: number;
}

/** 探测本机 Chrome/Chromium 主版本号；探测不到返回 null */
function detectChromeMajor(): number | null {
  const exe = config.chromePath ?? safeExecutablePath();
  if (!exe || !fs.existsSync(exe)) return null;
  try {
    const out = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 5000 });
    const m = /(\d+)\.\d+\.\d+\.\d+/.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function safeExecutablePath(): string | null {
  try {
    return chromium.executablePath();
  } catch {
    return null; // 浏览器未安装（如仅跑 CI 编译）时不要炸
  }
}

const linuxUA = (major: number): string =>
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

// 探测不到版本时的兜底：仍与真实版本可能有出入，故打告警提示显式配置
const FALLBACK_MAJOR = 128;

/** 硬件并发数取真实值（原硬编码 8，与 4 核服务器矛盾） */
function realHardwareConcurrency(): number {
  const n = os.cpus()?.length ?? 4;
  return Math.min(16, Math.max(2, n));
}

/** 设备内存取真实值并收敛到浏览器常见档位（deviceMemory 上限 8） */
function realDeviceMemory(): number {
  const gb = Math.round(os.totalmem() / (1024 ** 3));
  const ladder = [2, 4, 8];
  const hit = ladder.find((v) => gb <= v) ?? 8;
  return Math.min(8, Math.max(2, hit));
}

let cached: Fingerprint | null = null;

export function fingerprint(): Fingerprint {
  if (cached) return cached;
  const major = detectChromeMajor();
  const explicit = process.env.GEO_FINGERPRINT_UA?.trim();
  if (!explicit && major === null) {
    console.warn(
      `[fingerprint] 未探测到 Chrome 版本，UA 回退为 Chrome/${FALLBACK_MAJOR}。` +
        `若与实际版本不符请显式设置 GEO_FINGERPRINT_UA。`
    );
  }
  cached = {
    userAgent: explicit || linuxUA(major ?? FALLBACK_MAJOR),
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    timezoneId: process.env.TZ || 'Asia/Shanghai',
    deviceScaleFactor: 1,
    hardwareConcurrency: realHardwareConcurrency(),
    deviceMemory: realDeviceMemory(),
  };
  return cached;
}
