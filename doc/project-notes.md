# geo-ui-browser 项目笔记

维护用。记录代码里"看不出来"的经验、踩过的坑、以及两个项目的协作规则。

---

## 1. 代码结构地图

```
src/
  cli.ts                   入口：--server 起服务 / 否则单次诊断
  types.ts                 共享类型（PlatformAdapter 接口、DiagnosticResult…）
  server/
    server.ts              Express(8787)：web-collect / pull / source-analysis / admin / login
    loginRegistry.ts       账号台账 + 有头登录会话 + 测试窗口 + 挑号归还
    loginUI.ts             /admin 单页 HTML（无构建、无依赖，直接扩展即可）
    pull.ts                拉模式：分页拉词 → 采集 → 回推
    sourceAnalysis.ts      信源分析：按平台分桶聚合
    concurrency.ts         并发护栏 withConcurrencyLimit
  platforms/
    index.ts               平台注册表（新增平台在此登记）
    <平台>/{Adapter,selectors}.ts
  tuning/delays.ts         拟人化停顿参数（按「平台+用途」独立命名，暂不归并）
  diagnostics/             run.ts(编排) / elementProbe.ts / human.ts
  config/
    index.ts               环境变量集中读取 + paths（dataRoot 下所有有状态目录）
    fingerprint.ts         浏览器指纹：UA 按实际 Chrome 版本动态拼接，登录/采集共用
  storage/
    accountRepo.ts         账号台账仓储（异步接口；file / mysql 双实现，按配置切换）
    identityRepo.ts        匿名身份/轮换计数键值仓储
  db/pool.ts               MySQL 连接池（惰性创建，连不上快速失败）
sql/schema.sql             建表脚本（人工执行，不自动建表）
scripts/checkDb.ts         npm run db:check 一键校验库与表字段
```

**平台 id 即对外的 modeId**（`qwen` / `wenxiaoyan` / `doubao` / `deepseek` / `hunyuan`），不做别名映射（曾因双命名导致回推错位 bug）。

---

## 2. 关键事实与踩过的坑

### 编译
- **当前仓库无法编译**：`src/diagnostics/` 未提交，但 cli.ts / server.ts / 多个 Adapter 都 import 它。缺失文件从 `workbuddy-backup/geo-browser` 复制（见 §3）。

### 登录态
- 用 `chromium.launchPersistentContext(userDataDir)` 持久化，登录态最完整（含 IndexedDB、静态资源缓存）。
- **session cookie 关窗即丢**：`confirmLogin` 里会把 `expires<=0` 的 cookie 重种为 365 天持久。删掉这段会导致"窗口里登录成功、下次打开还是未登录"。
- **SPA 登录态水合慢**：首屏会闪现未登录态（文心的 `.chat-aside-user-mask.unlogin`）。run.ts 里有 8s 水合等待 + 超时重载，别删。
- **无登录墙平台不能只看"有没有输入框"**：文心匿名也有输入框。判据是"能否抽到账号昵称"（`markerSelector` / `fetchMarker`），抽不到就是磁盘没登录态。

### 指纹
- `run.ts` 当前**硬编码 macOS UA**，服务器是 Linux —— 矛盾即暴露。必须改成按容器实际 Chrome 版本动态拼 Linux UA。
- 不要随机化 UA / 视口 / 分辨率：同一账号每次应表现为同一台设备，随机化反而触发风控。

### 采集
- 聊天页是 SSE/长连接，`networkidle` 永不触发，导航必须用 `domcontentloaded`。
- 千问发送后可能弹风控滑块（baxia iframe），由 `solveCaptcha()` 处理；自动不过会转"等待人工"，run 不卡死。
- **纪律**：解析失败记 `null`，绝不把"定位不到"误报成"无信源"。
- 截图失败**不整页兜底**，留空即可。

### 部署相关
- 服务器必须加 `--no-sandbox`、`--disable-dev-shm-usage`（默认 64MB 会崩）。
- 必须装中文字体，否则截图全是方块。
- 容器 `TZ` 与 DB 连接 `timezone` 都要 `+08:00`，否则"今日查询次数"跨天归零会错乱。
- 不做优雅退出会留僵尸 Chrome，是内存泄漏主因。

---

## 3. 与 geo-browser 的关系

| 项目 | 定位 |
|---|---|
| `workbuddy-backup/geo-browser` | **测试/校准工具**：页面元素变化时本地有头跑，看 `report.html` 校准 selector |
| `github/geo-ui-browser`（本仓库） | **服务器生产**：无头、产物不落盘、账号入 MySQL |

**规则：单向复制，永不反向写回 geo-browser。**

- **共享资产（双向同步）**：`platforms/**`（Adapter + selectors）、`tuning/delays.ts`、`types.ts`。任一侧修了都要同步到另一侧。
- **各自演进（不要求一致）**：`server/**`、`diagnostics/**`（本地要落盘诊断，服务器不落盘）。
- 工作流：线上 selector 失效 → 用 geo-browser 本地复现 → 校准 selectors → 同步回本仓库。

**已知差异（2026-09-19 diff，均为 geo-browser 更新）**：
1. `loginRegistry.ts`：挑号评分带跨天归零
2. `pull.ts` / `server.ts`：日志带时间戳前缀
3. `package.json`：仅 `name` 不同

---

## 4. 部署形态（三件套）

```
Docker 镜像（无状态） + 挂载目录 /data/geo（唯一有状态：浏览器 profile） + 外部 MySQL（账号数据）
```

- 容器内进程：`Xvfb :99` + `x11vnc` + `websockify(noVNC :6080)` + `node dist/cli.js --server`
- 人工登录走 `/admin` 内嵌 noVNC（扫码、短信验证码都支持）
- 不上 K8s（单实例 + 有状态，不划算）

**本机用 Docker 测试的三个坑**
1. 连宿主机 MySQL 用 `host.docker.internal`，不能用 `localhost`；Linux 需 `extra_hosts: host-gateway`
2. 挂载目录权限：容器内 root 跑，宿主目录先建好
3. `shm_size: "1gb"`，否则浏览器崩

---

## 5. 代理（一期不启用）

公司已有代理基建（快代理 `dps.kdlapi.com` 私密代理），仅用在**发布侧** Java 服务，采集侧未用。

一期 `GEO_PROXY_PROVIDER=none`。接入时配置项（**只写变量名，凭据走环境变量/配置中心，禁止入库或写进文档**）：

```
GEO_PROXY_PROVIDER / _KDL_API / _KDL_SECRET_ID / _KDL_SIGNATURE / _KDL_NUM
GEO_PROXY_USER / _PASS / _HEALTHCHECK / _BIND_TTL_HOURS
```
账号级字段走 DB：`proxy_host` / `proxy_port` / `proxy_bound_at`。

**接入时三条硬约束**
1. **登录与采集必须同一个 IP** —— 代理要按账号绑定固定，不能每次取新的（发布侧是每次取新 IP，我们不行，会判异地登录掉线）
2. 代码落点只有两处：`run.ts` 的 contextOpts、`loginRegistry.launchOpts()`（**登录窗口最容易漏**）
3. 需先确认：DPS 产品 IP 有效期 / 能否长期固定 / 剩余额度

---

## 5.1 关键环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GEO_NODE_ID` | `default` | 本节点标识，账号归属；多机时每台必须不同 |
| `GEO_STORAGE` | `mysql` | `file` 仅本机开发用。**mysql 连不上会快速失败，绝不静默降级** |
| `DB_HOST/PORT/USER/PASSWORD/NAME` | — | 数据库连接；缺失时启动即报缺少哪些 |
| `GEO_DATA_ROOT` | `.` | 有状态数据根目录（profile 等） |
| `GEO_ARTIFACT_MODE` | `none` | `debug` 时落 diagnostics/ 供校准 selector |
| `GEO_HEADLESS` | `true` | 采集是否无头 |
| `GEO_MAX_BROWSERS` | `4` | 同时打开浏览器上限 |
| `GEO_FINGERPRINT_UA` | 自动探测 | 探测不到 Chrome 版本时显式指定 |
| `GEO_USE_SYSTEM_CHROME` | `false` | 本机开发用系统 Chrome；容器保持 false |

## 6. 重构阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 复制 diagnostics + loginRegistry 修复，让代码能编译 | ✅ 已完成 |
| P1 | config/storage 层；统一 fingerprint；删 macOS UA | ✅ 已完成 |
| P2 | MySQL 表 + repo（file/mysql 双实现），启动自检与脏占用回收 | ✅ 已完成 |
| P3 | /admin 增强（启停/置顶/切换）+ noVNC 内嵌 | 待开始 |
| P3.5 | 出口 IP 调度（egress 信号量）+ 风控监控 | 待开始 |
| P4 | ArtifactMode 不落盘 + 截图 WebP 压缩 | 待开始 |
| P5 | 容器化 | 待开始 |
| P6 | 分析结论外发接口（契约待定） | 待开始 |

## 7. 待办 / 待确认

- 代理：DPS 的 IP 有效期与固定绑定能力（对接时确认）
- 截图压缩参数（900px / q80 / 300KB）需拿真实长截图实测确认清晰度
