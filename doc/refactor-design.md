# geo-ui-browser 重构设计 v2

版本：v2 · 2026-09-19 · 取代 v1
变更依据：用户明确 ①不考虑 macOS（全在服务器跑）②diagnostics/analysis 产物不落盘，走接口传出 ③只要账号信息入 MySQL

---

## 0. 与 v1 的差异（一眼看清改了什么）

| 项 | v1 | **v2** |
|---|---|---|
| 登录位置 | 本地 Mac 有头登录 → 上传服务器 | **服务器容器内登录**（Xvfb + noVNC），本地不参与 |
| 登录态载体 | storageState 上传（跨平台） | **userDataDir 存卷 + DB 记路径**（不跨平台，登录态最完整） |
| 指纹风险 | 最大风险（Mac/Linux 不一致） | **风险消失** —— 登录与采集同一容器、同一 Chrome、同一 IP |
| diagnostics 产物 | 本地卷 + 清理 | **不落盘**，截图以 Buffer 走内存直接回推 |
| analysis 产物 | 本地卷 | **不落盘**，结果走接口传出 |
| 截图 | 落盘 + 定期清理 | **不落盘**；仅在 `--debug` 校准模式才落盘 |

---

## 1. 需求确认（我的理解，如有偏差请指出）

| 你的需求 | 我的落地 |
|---|---|
| 可以增加用户信息 | `/admin` 新增账号槽 → 走登录流程（含备注、启停） |
| 登录信息存储到数据库 | 账号台账 + 登录会话 + 登录态路径全部入 MySQL |
| 能管理切换用户信息 | 列表管理 + 启停 + 手动/自动切换账号（采集可指定 accountId） |
| 浏览器登录态必须本地吗 | 不必；但本项目选 userDataDir 存卷（见 §2） |
| diagnostics 不用存 | 关掉落盘，截图完成后调对方接口传出（见 §4） |
| analysis 不用存 | 关掉落盘，结果走接口传出（见 §5） |
| 指纹重新设计（不考虑 macOS） | 见 §3 —— 问题基本消失 |

⚠️ **一处需要你确认**："用户信息"我按**平台账号**（doubao-1、qwen-1…）理解。如果指的是**业务用户/租户**（谁提交的采集任务），需要再加一张 `app_user` 表 + 任务归属字段。当前按平台账号设计。

---

## 2. 登录态载体选型：为什么仍用 userDataDir

**Chrome 的登录态无法脱离文件系统**。`launchPersistentContext(userDataDir)` 要求真实目录；不存在"从 DB 读 profile"这种用法。

可选的两种：

| | userDataDir（推荐） | storageState |
|---|---|---|
| 存储位置 | 本地卷 `/data/geo/profiles/<platform>-<n>/` | DB 或卷（JSON，数十 KB） |
| 登录态完整性 | 完整（cookie + localStorage + IndexedDB + SW） | 仅 cookie + localStorage |
| 自动更新 | Chrome 自己写回，天然滚动续期 | 每次采集后必须手动导出回写 |
| Adapter / 编排改动 | **零** | 需改注入逻辑 |
| 是否怕掉登录 | 低 | 中（漏回写就掉） |
| 跨机迁移 | 差 | 好 |

**决策：用 userDataDir。** 单实例 Docker + 持久卷，跨机迁移本来就不是需求；卷本身持久化，容器重建不丢。

**低成本增强（建议做）**：每晚把每个 active 账号的 `storageState` 导出成快照存 `/data/geo/states/`，仅作灾备/迁移用，不参与运行。几十 KB × 十几个账号，几乎无成本。

---

## 3. 指纹一致性：重新设计（不考虑 macOS）

v1 之所以把它列为"最大风险"，是因为 **Mac 登录 ≠ Linux 采集**。现在登录与采集都在同一容器，问题从根上消失。剩下要做的只是**让指纹稳定、真实、不矛盾**：

### 3.1 必做

1. **删掉硬编码的 macOS UA** —— `run.ts:124-125` 写死了 `Macintosh ... Chrome/124.0`，在 Linux 服务器上 UA 与真实环境矛盾，等于主动暴露。
   改为：**从容器实际 Chrome 版本动态拼 UA**。启动时 `chromium --version` 拿版本号，拼成：
   ```
   Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{实际版本} Safari/537.36
   ```
   避免"UA 说 124、实际 128"的版本漂移。

2. **登录与采集共用同一份 fingerprint profile** —— UA、viewport、locale、timezone、deviceScaleFactor 集中配置，两处引用同一份，不可能不一致。

3. **每个账号绑定固定的 profile 目录 + 固定指纹参数** —— 同一账号每次起来都是同一台"设备"。

4. **Xvfb 虚拟屏分辨率固定**（如 1600×1000），不要每次随机；视口 1280×800 保持不变。

5. `addInitScript` 里现有的 `navigator.webdriver / languages / hardwareConcurrency / deviceMemory` 覆盖保留，但 `hardwareConcurrency=8`、`deviceMemory=8` 要**改成与服务器真实配置一致**（否则自相矛盾）。

### 3.2 不要做

- 不要随机化 UA / 视口 / 分辨率 —— 同一账号随机化 = 每次像新设备，反而触发风控。
- 不要伪造 `navigator.platform`（Linux 就是 `Linux x86_64`，与 X11 UA 自洽即可）。

---

## 4. 服务器上的"人工扫码登录"怎么做

服务器无 GUI，但登录必须人工（扫码/短信）。方案：**Xvfb 虚拟屏 + x11vnc + noVNC**，`/admin` 页面内嵌。

```
容器内：Xvfb :99 -screen 0 1600x1000x24
        x11vnc -forever -shared -display :99
        websockify/noVNC → 0.0.0.0:6080
        node 服务 8787（/admin 页面 iframe 嵌入 noVNC）
```

运维打开 `http://server:8787/admin` → 选账号 → 点「登录」→ 页面内出现浏览器画面 → 直接扫码 → 点「我已登录完成」。**与现有 `startLogin` / `confirmLogin` 逻辑完全一致，只是窗口从本机屏幕搬到网页里。**

- 镜像加 `xvfb x11vnc websockify novnc`（约 30MB）；或用 supervisord/s6 三个进程，也可拆 sidecar 容器。
- 生产环境 noVNC 只在内网暴露，或走 SSH 隧道；不要裸奔公网。
- 现有 `channel: 'chrome'`（本机 Chrome）在容器里改成 Playwright 自带 chromium，或容器内安装 Chrome 后指定 `executablePath`。**两者都要配成同一个二进制**，避免登录/采集二进制不同导致指纹差异。

---

## 5. MySQL 表设计（v2）

在 v1 基础上补"启停/优先级/指定账号"字段。

```sql
-- ① 平台账号（核心）
CREATE TABLE platform_account (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  platform_id       VARCHAR(32)  NOT NULL COMMENT 'doubao/qwen/wenxiaoyan/deepseek/hunyuan',
  account_code      VARCHAR(64)  NOT NULL COMMENT 'doubao-1',
  alias             VARCHAR(64)  COMMENT '备注',
  marker            VARCHAR(128) COMMENT '平台侧昵称（登录后抓取）',
  status            ENUM('none','waiting','active','cooling','failed') NOT NULL DEFAULT 'none',
  enabled           TINYINT(1) NOT NULL DEFAULT 1 COMMENT '0=停用（不参与挑号）',
  priority          INT NOT NULL DEFAULT 0 COMMENT '越大越优先，手动置顶用',
  note              VARCHAR(512),
  profile_dir       VARCHAR(512) NOT NULL COMMENT 'userDataDir 绝对路径（卷内）',
  snapshot_path     VARCHAR(512) COMMENT 'storageState 灾备快照（可选）',
  today_queries     INT NOT NULL DEFAULT 0,
  query_date        DATE,
  consecutive_fails INT NOT NULL DEFAULT 0,
  last_used_at      DATETIME,
  leased_by         VARCHAR(64) NULL COMMENT '占用者 instanceId:runId；NULL=空闲',
  leased_at         DATETIME,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_platform_code (platform_id, account_code),
  KEY idx_pick (platform_id, status, enabled, leased_by, priority, last_used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ② 匿名身份/轮换计数（替换 qwen.json 与轮换 json）
CREATE TABLE identity_state (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  state_key  VARCHAR(128) NOT NULL,
  payload    JSON NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_key (state_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ③ 登录会话（替换内存 activeLogin / testSessions，跨重启可见）
CREATE TABLE login_session (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_id  BIGINT NOT NULL,
  platform_id VARCHAR(32) NOT NULL,
  kind        ENUM('login','test') NOT NULL,
  phase       ENUM('waiting','verifying','done') NOT NULL DEFAULT 'waiting',
  instance_id VARCHAR(64) NOT NULL,
  started_at  DATETIME NOT NULL,
  expires_at  DATETIME NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_account_kind (account_id, kind),
  CONSTRAINT fk_ls_account FOREIGN KEY (account_id) REFERENCES platform_account(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**借还号（单实例原子性）**：

```sql
-- 借：条件更新 + affectedRows 判成败
UPDATE platform_account SET leased_by=?, leased_at=NOW()
 WHERE platform_id=? AND status='active' AND enabled=1 AND leased_by IS NULL
 ORDER BY priority DESC, last_used_at IS NULL DESC, last_used_at ASC,
          today_queries ASC, consecutive_fails ASC
 LIMIT 1;

-- 还：带 lease 校验
UPDATE platform_account SET leased_by=NULL, leased_at=NULL, last_used_at=NOW(), ...
 WHERE id=? AND leased_by=?;
```

启动时清理本实例 stale lease：`UPDATE ... SET leased_by=NULL WHERE leased_by LIKE CONCAT(?,'%')`。

**驱动**：`mysql2/promise`，连接池 10，**不引 ORM**。连接强制 `timezone:'+08:00'`，容器 `TZ=Asia/Shanghai`（否则"今日次数"跨天归零错乱）。

---

## 6. 管理/切换能力（/admin 改造）

在现有账号卡基础上增加：

| 能力 | 接口 | 说明 |
|---|---|---|
| 新增账号 | `POST /api/accounts` | 建槽 + 分配 profile_dir + 开 noVNC 登录 |
| 列表 | `GET /api/accounts` | 平台/别名/昵称/状态/今日次数/连续失败/占用中 |
| 改备注 | `POST /api/accounts/:id/alias` | 已有 |
| **停用/启用** | `POST /api/accounts/:id/toggle` | `enabled` 取反；停用后不参与挑号，已占用任务跑完为止 |
| **置顶优先** | `POST /api/accounts/:id/priority` | 调 `priority`，影响下次挑号顺序 |
| **手动切换** | 采集接口可选传 `accountId` | 传了就强制用该号（被占/停用则报 409）；不传走自动挑号 |
| 退出登录 | `POST /api/accounts/:id/logout` | 清 profile 目录 + 状态置 none |
| 删除 | `POST /api/accounts/:id/delete` | 清目录 + 删记录 |

页面：现有 `loginUI.ts` 无依赖单页 HTML，直接扩展 —— 加「启用/停用」开关、「置顶」按钮、内嵌 noVNC iframe。

---

## 7. 产物不落盘改造（diagnostics）

### 7.1 三种模式

```
ArtifactMode = 'none'  (生产默认) → 任何产物不写盘
             | 'debug' (CLI 校准 selector 时用) → 保持现有 diagnostics/ 落盘行为
```

`GEO_ARTIFACT_MODE=none|debug`，CLI `--debug` 强制 debug。

### 7.2 run.ts 精确改造点（行号对应当前 run.ts）

| 行 | 现状 | 改造 |
|---|---|---|
| 109-118 | 建 `diagnostics/<平台>/<日>/<时间>-<词>/{screenshot,page,network}` | none 模式：不建目录 |
| 123 | `recordHar: {path: network.har}` | none 模式：不传 recordHar（HAR 很占内存） |
| 124-125 | 硬编码 macOS UA | → Linux UA（动态版本号） |
| 284 / 340 / 405 / 421 / 426 | `page.screenshot({path})` | → `page.screenshot()` 拿 Buffer，存进结果数组 |
| 287 / 342 / 492 | `before.html` / `finished.html` 写盘 | none 模式：HTML 只留内存（若后续不需要可直接不取，省一次 DOM 序列化） |
| 425 | `waitForAnswer(180000, midDumpPath)` | → `waitForAnswer(180000)`（不传 dump 路径） |
| 450-468 | `captureQaScreenshot(outPath)` 写盘后 statSync 判定 | **Adapter 签名不变**，outPath 指向 `os.tmpdir()`；读完 Buffer 立即 unlink。Adapter 零改动 |
| 481 | `getSources(root)` | → `getSources()`（不传 captureDir，Adapter 内部跳过诊断落盘） |
| 522-523 | `result.json` / `report.html` 写盘 | none 模式：不写 |

### 7.3 结果结构

```ts
export interface CollectResult {
  platform: string; url: string; question: string; timestamp: string;
  loginRequired: boolean;
  answerText: string | null;
  sources: SourceInfo[] | null;
  sourceCount: number | null;
  elementDiagnosis: ElementDiagnosisItem[];
  notes: string[];
  /** 截图 Buffer，按阶段命名；none 模式下 qa 截图就是 05-qa-block */
  screenshots: { name: string; buffer: Buffer }[];
  qaScreenshot?: Buffer;   // 主交付物（长截图）
}
```

`execute()` 拿到 Buffer → base64 → 走**现有回推链路**（`POST {host}/geoWebCollect/report` 的 `screenshot` 字段本来就是 base64）。**与现有机制完全吻合，对方接口不用改。**

> 若长截图过大（几 MB 塞 JSON），可选优化：先 multipart 上传拿 URL，再回推 URL。保持 `screenshot` 字段兼容即可，列为可选。

---

## 8. analysis 不落盘改造

`sourceAnalysis.ts` 现有落盘三处（`<modelId>.json` / `_details.json` / `_meta.json`）→ 改为：

1. 内存里完成分桶聚合（逻辑完全不变，三条口径不改）。
2. 跑完直接 POST 到 `GEO_ANALYSIS_REPORT_URL`（环境变量配置，缺省则只记日志不传出）。
   ```json
   { "taskId":"...", "name":"...", "startedAt":..., "finishedAt":...,
     "platforms":[{"modelId":"qwen","stats":[{"siteName":"","domain":"","citeCount":12}],
                   "details":[...]}] }
   ```
3. `/api/source-analysis/status` 仍返回当次结果（内存态），页面能看；不再有"历史任务列表/下载文件"接口（产物不在了）。
4. 需要存档时由接收方落库 —— 本服务不存。

---

## 9. 部署设计

```
容器（单实例）
├─ Xvfb :99 1600x1000x24
├─ x11vnc + websockify/noVNC :6080（内网）
├─ node dist/cli.js --server :8787
└─ 卷 /data/geo/profiles/<platform>-<n>/   ← 唯一有状态的东西
```

**Dockerfile 要点**
```dockerfile
FROM mcr.microsoft.com/playwright:v1.47.0-jammy
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-noto-cjk tzdata xvfb x11vnc websockify novnc supervisor \
 && rm -rf /var/lib/apt/lists/*
ENV TZ=Asia/Shanghai
VOLUME ["/data/geo"]
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

**docker-compose 骨架**（单容器跑全部进程；MySQL 接公司现有实例或单独起一个）

```yaml
services:
  geo:
    build: .
    restart: unless-stopped
    environment:
      TZ: Asia/Shanghai
      GEO_DATA_ROOT: /data/geo
      DB_HOST: ${DB_HOST}
      GEO_PULL_HOST: ${GEO_PULL_HOST}
      GEO_ARTIFACT_MODE: none
      GEO_PROXY_PROVIDER: none
      GEO_HEADLESS: "true"
      DISPLAY: :99
    volumes:
      - geo-data:/data/geo          # 唯一有状态的部分（profile 卷）
    ports:
      - "8787:8787"                 # API + /admin（仅内网）
      - "6080:6080"                 # noVNC（仅内网）
    shm_size: "1gb"                 # 或启动时加 --disable-dev-shm-usage
    stop_grace_period: 30s          # 留给优雅退出关浏览器
volumes:
  geo-data:
```

容器内进程（entrypoint 脚本或 supervisord 启，共享同一个 `DISPLAY=:99`）：
```
Xvfb :99 -screen 0 1600x1000x24
x11vnc -forever -shared -display :99
websockify 6080 localhost:5900        # noVNC
node dist/cli.js --server
```

**本机 Docker 测试**（同一套 compose，只改三处）

```yaml
services:
  geo:
    build: .
    environment:
      DB_HOST: host.docker.internal      # 连宿主机 MySQL（Docker Desktop 内置该 DNS）
      GEO_PULL_HOST: http://host.docker.internal:8101   # 对方 Java 服务也在宿主机上
      GEO_ARTIFACT_MODE: debug           # 本机测试时开落盘，方便看现场
      GEO_HEADLESS: "true"
    volumes:
      - ./data:/data/geo                 # 挂本地目录，删容器不丢 profile
    extra_hosts:
      - "host.docker.internal:host-gateway"   # Linux 宿主机需要显式加这行
```

**三个必踩的坑**

| 坑 | 现象 | 解法 |
|---|---|---|
| 连不上宿主机 MySQL | `ECONNREFUSED 127.0.0.1:3306` | 用 `host.docker.internal`，别用 `localhost`（容器内 localhost 是自己）；Linux 需 `extra_hosts` |
| 挂载目录写不进去 | `EACCES` / profile 创建失败 | 容器内以 root 跑（默认即是），或宿主目录 `chmod 777`；before：先确认 `./data` 已存在 |
| 浏览器起不来 | `Target crashed` / 白屏 | `shm_size: 1gb` 或 `--disable-dev-shm-usage`；本机 Docker Desktop 默认 shm 只有 64MB |

**本机测试时的登录**：访问 `http://localhost:6080`（noVNC）直接看容器内的浏览器窗口，或走 `/admin` 内嵌页。注意本机容器里的 Chrome 是 Linux 版、UA 也是 Linux —— **与服务器环境一致**，这正好是好事：本机测出来的行为就是线上行为。

**一句话概括部署**：`Docker 镜像（无状态） + 挂一个本地目录（有状态：profile） + 连外部 MySQL（账号数据）`。其余什么都不需要持久化。

**为什么不上 K8s**：单实例 + 有状态（profile 目录），K8s 需要 StatefulSet + PVC + 滚动更新时处理浏览器优雅退出，复杂度不划算。等真要多实例时再迁。

**备选（不推荐但可行）**：直接在裸机上 systemd 跑。缺点是要手工装 Playwright 系统依赖 + 中文字体 + Xvfb，且 Playwright/Chrome 版本升级会污染宿主环境、不可复现。除非服务器不让装 Docker，否则不建议。

**Chrome 启动参数（Linux 必加）**：`--no-sandbox`、`--disable-dev-shm-usage`（默认 /dev/shm 64MB 会崩）、`--disable-gpu`、`--disable-blink-features=AutomationControlled`、`--font-render-hinting=none`。

**环境变量**
```
DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME
GEO_DATA_ROOT=/data/geo
GEO_TZ=Asia/Shanghai
GEO_PULL_HOST=…                对方服务地址
GEO_ANALYSIS_REPORT_URL=…      分析结论外传地址（可选）
GEO_ARTIFACT_MODE=none         none|debug
GEO_HEADLESS=true              采集无头；登录窗口走 Xvfb 有头
GEO_MAX_BROWSERS=4
GEO_FINGERPRINT_UA=…           留空则动态取 Chrome 版本
GEO_NOVNC_URL=/novnc/          /admin 内嵌地址
```

**稳定性**
- 优雅退出：`SIGTERM` → 停止接新任务 → 关 BrowserContext/Browser → 释放 lease → 关 DB 池 → exit。**不做会留僵尸 Chrome，是内存泄漏主因。**
- 资源：单 Chromium 300–500MB，`MAX_BROWSERS=4` 建议 4C/8G 起。
- 中文字体必须装，否则截图全方块。
- noVNC 只内网/SSH 隧道，不裸奔公网。

---

## 10. 实施计划

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **P0** | 从 workbuddy-backup 复制 `diagnostics/{run,elementProbe,human}.ts` | `npm run build` 通过，本地 CLI 跑通一次 |
| **P1** | 抽 config 层 + 存储层接口；**登录端与采集端共用 fingerprint**；删 macOS UA | 行为不变，回归跑通 |
| **P2** | MySQL 3 张表 + repo + 迁移（导入现有 accounts.json / qwen.json） | 账号台账全走 DB，不再写 json |
| **P3** | /admin 管理增强：新增/启停/置顶/手动切换 + noVNC 内嵌 | 网页内能完成扫码登录与切换 |
| **P4** | `ArtifactMode`：diagnostics/analysis 不落盘，结果走接口传出 | 生产跑一轮，磁盘零新增文件 |
| **P5** | 容器化：Dockerfile / Xvfb / noVNC / 优雅退出 / 健康检查 | 服务器容器起得来、采集成功 |

**P0 是最优先且零风险的一步**，建议先做，让代码能跑起来再谈其他。

---

## 11. 补充设计（v2.1 定稿）

### 11.1 范围收窄：无管理员 / 无权限体系

"用户信息" = **平台账号**（doubao-1、qwen-2…），系统不涉及管理员、租户、权限控制。据此简化：

- 不加 `app_user` 表，不加登录鉴权、不加 RBAC。
- `/admin` 与所有 `/api/*` 靠**网络层隔离**（Nginx 只允许内网 / VPN 访问，或直接不开公网端口）。
- 内部接口无需 token；唯一要求是"外网访问不到"。

---

### 11.2 截图体积：越小越好，但保清晰度

**现状**：PNG 长截图，实测常见 1–5 MB，base64 后 ×1.33，塞进回推 JSON 很重。

**原则**：长截图内容是**文字为主 + 少量头像/图标**，所以走"有损压缩 + 适度缩放"，不要用 PNG-8 降色（文字边缘会很脏）。

**方案（sharp 已是依赖，直接用）**

| 手段 | 取值 | 说明 |
|---|---|---|
| 格式 | **WebP 有损** | 比 PNG 小 60–80%；文字边缘表现远好于 JPEG（无块状振铃） |
| 质量 | 起始 `quality=80` | 自适应下调：80 → 72 → 64 → 58 |
| 宽度上限 | `maxWidth=900` | 原生截图 1280 宽 → 等比缩到 ≤900（缩放 0.70），12px 正文仍清晰可读 |
| `deviceScaleFactor` | 固定 1 | 别用 2x，体积直接翻 4 倍 |
| 字节上限 | `maxBytes=300KB` | 压缩后仍超限 → 降 quality，再超限 → 降宽度（最低 720），仍超限则记 note 放行 |

**自适应压缩流程**（`shotCompressor.ts`，统一在 run.ts 出口做，Adapter 不用改）：
```
Buffer(PNG) → sharp.webp({quality:80}) → size > 300KB ? quality-8 重试 : 出
                                       → quality 触底(58) ? resize(width-90) 重试 : 出
                                       → width 触底(720) ? 记 note 放行 : 出
```
**目标：单张长截图 ≤ 300KB（base64 后 ≈ 400KB）。** 实测按平台微调默认参数。

环境变量：`GEO_SHOT_FORMAT=webp`、`GEO_SHOT_QUALITY=80`、`GEO_SHOT_MAX_WIDTH=900`、`GEO_SHOT_MAX_BYTES=307200`。

---

### 11.3 出口 IP 与账号规模（**必须先想清楚**）

> **直接回答：是的。** 不做处理的话，50 个账号的对话流量全部来自服务器**同一个公网出口 IP**。

**风险**：平台侧看到的是"同一 IP 短时间内几十个不同账号高频对话"，这是最典型的风控特征 —— 后果是限流、强制重新登录、滑块频出、甚至封号。50 个账号共用一 IP **风险很高**。

**分层方案**（从便宜到贵，按实际触发情况逐级上）：

| 层级 | 做法 | 成本 | 说明 |
|---|---|---|---|
| **L0**（已有） | 同平台串行 + 词间冷却 45–90s | 0 | 现有 `enqueue(platform)` + `sleep` 已实现 |
| **L1**（建议先做） | **按出口 IP 分组限流**：同一出口同时只跑 1 个任务 | 0 | 见下方调度改造，50 账号同 IP 时退化为全局串行（安全但慢） |
| **L2** | 每账号绑定独立代理出口 | 代理费 | Playwright context 级 `proxy`；同 IP 承载账号建议 ≤5 |
| **L3** | 多机部署分散 | 机器费 | 每台 5–10 个账号 |

**同 IP 账号数 vs 风险**（经验值，需实测校准）

| 同 IP 账号数 | 风险 | 建议 |
|---|---|---|
| ≤ 5 | 低 | L0 + L1 即可 |
| 5 – 15 | 中 | L1 + 冷却加到 90–180s + 错峰（不同平台交替） |
| > 15 | 高 | 必须上 L2（代理）或 L3（多机） |

**两条硬约束**

1. **登录与采集必须同 IP**。代理要**粘性**（sticky）—— 登录时用哪个出口，采集就必须用同一个。否则平台判"异地登录"，直接掉线或二次验证。所以代理配置存在**账号维度**，登录窗口和采集任务都读它。
2. **数据中心 IP 权重低于住宅 IP**。机房/云服务器 IP 段本身就被很多平台打标，同样账号数下更容易被风控。预算允许优先住宅代理。

**数据模型补充**（加到 §5 的 `platform_account`）

```sql
proxy_url   VARCHAR(512) NULL COMMENT 'http://user:pass@host:port；空=走服务器默认出口',
egress_key  VARCHAR(64) NOT NULL DEFAULT 'default' COMMENT '出口分组键：无代理=default；有代理=代理标识',
KEY idx_egress (egress_key)
```

**调度改造**：新增出口维度信号量，与现有"同平台串行队列"叠加。

```
allocateAccount(platform):
  候选 = 按 priority/lastUsed/todayQueries/consecutiveFails 排序的可用账号
  逐个检查 egressSemaphore[账号.egress_key] 是否已达 GEO_MAX_PER_EGRESS(默认1)
  取第一个"出口有空位"的账号 → 占用出口 + 占用账号
release: 归还出口 + 归还账号
```
这样：全用默认出口 → 全局串行（安全）；每账号独立代理 → 可跑到 `GEO_MAX_BROWSERS` 并发。

**风控监控**（早发现）：账号 `consecutiveFails` 突增、某平台 `loginRequired` 比例飙升、滑块出现频率上升 → 都是"这个 IP 被盯上了"的信号，应该在 `/admin` 页显著提示。

#### 11.3.1 复用公司现有代理：快代理 kdlapi（已核实）

已在 `joolun-agent-post` 中确认**公司已有在用的代理基建**，无需重新采购选型：

| 项 | 现状 |
|---|---|
| 供应商 | 快代理 `https://dps.kdlapi.com/api/getdps`（私密代理 DPS） |
| 取 IP | `POST` 表单：`secret_id` / `signature` / `num` / `format=json` |
| 连接认证 | 全局 `userName` + `userPwd`（Basic `Proxy-Authorization`） |
| 配置 | `ProxyProperties`（prefix=`proxy`）；仓库 yml 未含，应在 Nacos |
| 现有用法 | `ProxyUtils.getDpsWithOkHttp(num=1)` → `getFirstProxyHost/Port` → OkHttp `Proxy.Type.HTTP` |
| 覆盖范围 | **仅发布侧**（头条/企鹅/百家/网易/知乎/搜狐/小红书 + 文章生成）；采集检测侧未用 |
| 降级 | 取不到代理 → `null` → 直连（优雅降级，与我们的设计一致） |

**⚠️ 不能照搬他们的用法，三个关键差异**

1. **他们每次取新 IP，我们必须固定 IP** —— 发布是一次性动作，IP 换了无妨；我们是**登录态绑定 IP**，每次换 = 异地登录 = 掉线。
   落地：账号**首次登录时取一个 IP → 存库 → 该账号永久复用**。
2. **IP 有效期未知** —— 快代理 DPS 部分产品按"每次提取有效 X 分钟"计，若如此，登录态会周期性掉线，不可接受。需确认/改用**长期独享/静态 IP**。
3. ~~流量量级差几十倍~~ → **已修正，流量并不大**。每次只提问一次，且 persistent context 有磁盘缓存：同一账号仅**首次**加载重（几 MB 的 JS/字体），后续提问只是几十 KB 的文本与接口请求。50 账号 × 20 次/天 ≈ **10GB/月量级**（此前估的 150GB 是按"每次都全量加载"算的，偏高一整个数量级）。结论：按流量计费的套餐也扛得住，选型不必被计费方式绑死，重点仍放在**IP 能否长期固定**。

> 附带印证：静态资源缓存与 cookie 同在 userDataDir 里 —— 这正是 §2 选 `userDataDir` 存卷而非 storageState 的又一个理由（缓存随登录态一起保留）。

**一期决策：`provider = none`**（不接代理，走 L0+L1 调度）。Java 侧实现仅作参考，真正接入时再把变量提取为配置。

**配置项预留清单**（一期不实现，先把名字定好，到时填值即可）：

```bash
GEO_PROXY_PROVIDER=none          # none | static | kdl
# —— kdl 模式启用时才需要（对标 ProxyProperties）——
GEO_PROXY_KDL_API=https://dps.kdlapi.com/api/getdps
GEO_PROXY_KDL_SECRET_ID=…
GEO_PROXY_KDL_SIGNATURE=…
GEO_PROXY_KDL_NUM=1
GEO_PROXY_USER=…                 # 连接认证（对标 userName）
GEO_PROXY_PASS=…                 # 连接认证（对标 userPwd）
GEO_PROXY_HEALTHCHECK=https://dev.kdlapi.com/testproxy
GEO_PROXY_BIND_TTL_HOURS=720     # IP 绑定有效期，超时才重新取（保障登录态不漂）
```
账号级字段走 DB：`proxy_host` / `proxy_port` / `proxy_bound_at`。

接入时的代码落点只有两处（各 1 个参数）：`run.ts` 的 contextOpts、`loginRegistry.launchOpts()`（**登录窗口必须传同一个 proxy**，否则判异地登录掉线）。

**数据模型调整**（替代上面的 `proxy_url`）：

```sql
proxy_host    VARCHAR(64)  NULL COMMENT '绑定给该账号的代理 IP',
proxy_port    INT          NULL,
proxy_bound_at DATETIME    NULL COMMENT '绑定时间，用于判断是否需要续期',
egress_key    VARCHAR(64) NOT NULL DEFAULT 'default',
```
用户名/密码走全局配置（`GEO_PROXY_USER` / `GEO_PROXY_PASS`），不进账号表。

**ProxyProvider 抽象**（一期可先 `none`，切换不改业务代码）：

```
none   → 不代理（默认出口）
static → 读账号表已绑定的 host:port
kdl    → 调 getdps 取 IP 并写回账号表（首次绑定/续期用）
```
Playwright 侧：`launchPersistentContext(dir, { proxy: { server:'http://host:port', username, password } })`，**登录窗口与采集必须传同一个**。

健康检查：复用 `proxyTest` 的探测地址 `https://dev.kdlapi.com/testproxy`，验证可用并回读实际出口 IP。

> ⚠️ 顺带：`ProxyUtils.java` 里 `proxyTest()` 硬编码了真实凭据（IP/端口/用户名/密码），且有无参 `getDpsWithOkHttp()` 带明文密钥，建议清理后提交。

---

### 11.4 登录窗口：noVNC 网页内嵌（推荐）

**选 noVNC**。理由：

| | noVNC 内嵌 | SSH 隧道 + 本地 VNC 客户端 |
|---|---|---|
| 使用成本 | 打开 `/admin` 点「登录」即用，**零安装** | 本地要装 TigerVNC/RealVNC，每次 `ssh -L` 建隧道 |
| 多人协作 | 谁都能开网页操作 | 每人要配 SSH + 客户端 |
| 扫码 | 页面里直接扫 | 同 |
| 短信验证码 | 页面里输入手机号，收到后手输 | 同 |

**结论**：noVNC 内嵌为主方案，SSH 隧道作为 noVNC 卡顿时的备用通道（两者不冲突，x11vnc 一直开着即可）。

**验证码登录的便利性细节**（值得做）：noVNC 默认剪贴板同步较麻烦，在 `/admin` 账号卡上加一个「发送文本到窗口」输入框 + 按钮，调用 noVNC API 把文本注入远程窗口 —— 手机号/验证码不用手打，也不用在网页和手机之间来回切。

---

### 11.5 分析结论接口：本期预留，不实现

- 保留 `GEO_ANALYSIS_REPORT_URL` 环境变量与统一的外发函数；**未配置则只打日志不传出**。
- 结果仍在内存，`/api/source-analysis/status` 可查当次结果。
- 接口契约（URL、字段、鉴权、重试）**放到后面单独设计**，本期只留插槽，不影响其他阶段开工。

---

## 12. 实施计划（更新）

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **P0** | 从 workbuddy-backup 复制 `diagnostics/{run,elementProbe,human}.ts` | `npm run build` 通过，本地 CLI 跑通一次 |
| **P1** | 抽 config 层 + 存储层接口；登录/采集共用 fingerprint；删 macOS UA | 行为不变，回归跑通 |
| **P2** | MySQL 表 + repo + 迁移；账号表含 `proxy_url`/`egress_key` | 账号台账全走 DB，不再写 json |
| **P3** | `/admin` 增强：新增/启停/置顶/手动切换 + noVNC 内嵌 + 文本注入 | 网页内能完成扫码/验证码登录与切换 |
| **P3.5** | 出口 IP 调度：egress 信号量 + 风控监控提示 | 同出口串行生效；有代理时按出口并发 |
| **P4** | `ArtifactMode` 不落盘 + 截图 WebP 自适应压缩 | 生产跑一轮：磁盘零新增、截图 ≤300KB |
| **P5** | 容器化：Dockerfile / Xvfb / noVNC / 优雅退出 / 健康检查 | 服务器容器起得来、采集成功 |
| **P6** | 分析结论外发接口（待契约设计） | — |

P0 零风险且是其他一切的前提，建议先做。

---

## 14. 两个项目的关系与复制规则

**原则：`geo-browser` 只读，`geo-ui-browser` 只改。** 单向复制，永不反向写回。

| 项目 | 定位 | 运行方式 |
|---|---|---|
| `workbuddy-backup/geo-browser` | 本地手动测试 / selector 校准 | 本机有头，产物落盘，人工看 `report.html` |
| `github/geo-ui-browser` | 服务器生产 | 无头，产物不落盘，账号入 MySQL |

### 已核实的两项目差异（2026-09-19 diff）

`platforms/`、`tuning/`、`types.ts`、`concurrency.ts`、`sourceAnalysis.ts`、`loginUI.ts` **完全一致**；以下 3 处不同，且**都是 geo-browser 更新**：

1. `loginRegistry.ts`：挑号评分带跨天归零（`queryDate === today ? todayQueries : 0`）
2. `pull.ts` / `server.ts`：日志带时间戳前缀 `[MM-DD HH:mm:ss][pull]`

**P0 复制清单**（全部单向 copy，复制后不再与 geo-browser 同步）：
```
src/diagnostics/run.ts            (538 行)
src/diagnostics/elementProbe.ts   (44 行)
src/diagnostics/human.ts          (98 行)
src/server/loginRegistry.ts       ← 带跨天归零修复
src/server/pull.ts / server.ts    ← 带时间戳日志（可选，仅影响可读性）
```

### 分叉管理（重要，否则会出难查的 bug）

复制之后两边就**正式分叉**了。为避免"本地修了 selector、服务器还是旧的"这类问题，约定：

- **共享资产**（必须双向保持一致）：`platforms/**`（Adapter + selectors）、`tuning/delays.ts`、`types.ts`。任一侧修了 selector / 拟人化参数，都要同步到另一侧。
- **各自演进**（不要求一致）：`server/**`（运行模式不同）、`diagnostics/**`（本地要落盘诊断、服务器不落盘）。
- **在 geo-ui-browser 的 `diagnostics/run.ts` 顶部标注来源**（源项目 + 复制日期 + 来源 commit），避免日后误以为可以直接覆盖同步。
- **不在 geo-browser 上做任何修改**，包括不改它的 UA、不改它的落盘行为 —— 它是本地诊断工具，保持原样最好用。

> 若日后 `geo-browser` 停止维护（本地测试也迁到 geo-ui-browser 的 `--debug` 模式），分叉问题自然消失；在此之前按上面规则走。

---

## 13. 仍然开放的问题

1. **代理策略**：先不上（50 账号同 IP 全局串行）观察风控，还是直接接公司已有的快代理？需先向同事确认三件事：①购买的 DPS 产品 IP 有效期（能否长期固定）②剩余额度/计费方式（我们流量是发布侧的几十倍）③是否支持按账号绑定固定 IP。
2. **截图压缩默认值**：900px 宽 / quality 80 / 300KB 这组值需要拿真实长截图实测确认"清晰度可接受"。
3. 服务器机房位置（国内/海外）与 IP 段类型，会影响风控基线。
