import { runDiagnostic } from './diagnostics/run.js';
import { startServer } from './server/server.js';
import { LOGIN_DRIVERS, allocateAccount, releaseAccount } from './server/loginRegistry.js';
import { config, paths } from './config/index.js';
import path from 'path';

const args = process.argv.slice(2);

// --server：启动对外 API 服务（端口 8787）
if (args.includes('--server')) {
  startServer().catch((e: unknown) => {
    console.error(`❌ 启动失败：${(e as Error).message}`);
    process.exit(1);
  });
} else {
  void main();
}

async function main(): Promise<void> {
  const qi = args.indexOf('--question');
  const question =
    qi >= 0 && args[qi + 1] ? args[qi + 1] : '请介绍一下人工智能在医疗领域有哪些应用？';

  // 用本机已安装的 Chrome，避免 Playwright 自带 chromium（mac12 等旧系统无法下载）
  const useSystemChrome = args.includes('--chrome') || config.useSystemChrome;
  const executablePath = config.chromePath;

  // 目标平台（默认 doubao；文心用 --platform wenxiaoyan）
  const pi = args.indexOf('--platform');
  const platform = pi >= 0 && args[pi + 1] ? args[pi + 1] : 'doubao';

  // 持久登录 profile 目录（豆包匿名发送会触发风控，必须人工登录一次后复用会话）。
  //   --profile            → 默认 .profiles/<平台>
  //   --profile ./mydir    → 指定目录
  //   GEO_PROFILE_DIR=...  → 环境变量等价写法
  const pfi = args.indexOf('--profile');
  const profileArg =
    pfi >= 0 && args[pfi + 1] && !args[pfi + 1].startsWith('--') ? args[pfi + 1] : null;
  const userDataDir =
    pfi >= 0 ? profileArg || path.join(paths.profilesRoot, platform) : process.env.GEO_PROFILE_DIR || undefined;

  // 检测到未登录时，等待人工在窗口内完成登录的秒数（默认 300s；0 = 不等待）。仅对持久 profile 生效。
  const wli = args.indexOf('--wait-login');
  const waitLoginRaw =
    wli >= 0 && args[wli + 1] && !args[wli + 1].startsWith('--') ? Number(args[wli + 1]) : 300;
  const waitLoginMs = Number.isFinite(waitLoginRaw) && waitLoginRaw > 0 ? waitLoginRaw * 1000 : 0;

  // 覆盖入口 URL（便于指向具体聊天页，如 https://wenxin.baidu.com/chat）
  const ui = args.indexOf('--url');
  const url = ui >= 0 && args[ui + 1] ? args[ui + 1] : undefined;

  // 长屏截图策略：--screenshot-mode stitch 切到「滚动分段拼接」（各平台自行实现，未实现会回退并警告）
  const mi = args.indexOf('--screenshot-mode');
  const rawMode = mi >= 0 && args[mi + 1] ? args[mi + 1] : undefined;
  const screenshotMode =
    rawMode === 'stitch' ? ('stitch' as const) : rawMode === 'expand' ? ('expand' as const) : undefined;

  // 台账平台（如豆包）：自动按现有账号切换逻辑走——自动挑一个可用已登录账号，用完归还
  // （占用/失败计数/冷却/撞墙标记全部复用 /admin 台账规则，与服务端 /api/web-collect 一致）。
  // 显式传 --profile 时仍走旧持久 profile 路径，不占台账。
  const driver = LOGIN_DRIVERS[platform];
  let allocated: { platformId: string; accountId: string } | null = null;
  let execDir = userDataDir;
  let execWaitLoginMs = waitLoginMs;
  if (driver && pfi < 0) {
    const ready = await allocateAccount(platform);
    if (!ready.ok || !ready.accountId || !ready.dir) {
      console.error(`❌ ${ready.reason ?? '没有可用的台账账号'}`);
      process.exit(1);
    }
    allocated = { platformId: platform, accountId: ready.accountId };
    execDir = ready.dir;
    execWaitLoginMs = 0; // 台账账号应已登录；撞登录墙由归还逻辑标记 failed
    console.log(`👤 使用台账账号：${ready.accountId}（${ready.dir}）`);
  }

  runDiagnostic(question, {
    useSystemChrome,
    executablePath,
    platform,
    url,
    screenshotMode,
    userDataDir: execDir,
    waitLoginMs: execWaitLoginMs,
  })
    .then(async (result) => {
      if (allocated) {
        await releaseAccount(
          allocated.platformId,
          allocated.accountId,
          !!result.answerText && !result.loginRequired,
          result.loginRequired
        );
      }
      process.exit(0);
    })
    .catch(async (e) => {
      if (allocated) await releaseAccount(allocated.platformId, allocated.accountId, false, false);
      console.error(e);
      process.exit(1);
    });
}
