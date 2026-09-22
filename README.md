# geo-browser — V1 豆包采集诊断工具

> 📌 **现状说明**：本仓库已完成从"本地诊断工具"到"服务器部署的采集服务"的重构
> （账号入 MySQL、产物不落盘、Docker 部署，镜像内嵌部署模板）。设计与项目笔记见 **[doc/](./doc/)** —— 维护请先读 `doc/README.md`。
> 当前代码可编译（`npm run build`），各阶段进度见 `doc/project-notes.md` §6。

GEO 网页模拟收录监测的 **V1 平台采集诊断工具（平台探针）**。本地有头运行、人工可介入，
一轮诊断同时产出：4 阶段截图、**完整长截图**、before/finished HTML、network.har、
**回复信息**、**信源信息**、自动「页面元素诊断」报告、result.json、report.html。

> 设计定位：V1 不是生产监测，而是"看清真实界面 + 提炼自动化元素 + 留样本库"。
> 生产的每 query 长截图 / 规模化监测是 V3 在 V1 验证过的同一套逻辑上叠加的。

## 环境
- Node.js ≥ 18
- 主系统为 Java，本工具是独立 Node 服务（V1 阶段用 CLI 在本地跑）

## 安装
```bash
cd geo-browser
npm install
# 浏览器二选一：
npx playwright install chromium   # 方式A：用 Playwright 自带 chromium（mac12 等旧系统会失败）
```

### 用本机已安装的 Chrome（推荐，免去下载）
mac12 等旧系统 `npx playwright install chromium` 会失败（新版 Playwright 已不再支持）。
此时直接用系统 Chrome 即可，无需下载任何浏览器：

```bash
# 方式B：加 --chrome 让 Playwright 调用本机 Chrome
npm run dev -- --chrome

# 或显式指定路径（任意一种都行）：
GEO_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run dev
GEO_USE_SYSTEM_CHROME=1 npm run dev
```

> 前提：本机已安装 Google Chrome（普通版即可，不是 Chrome for Testing）。
> 用 `--chrome` 时 Playwright 通过 `channel: 'chrome'` 自动定位系统 Chrome，不下载任何文件。

### 关于视频
本工具**不录制视频**。GEO 收录监测只需截图留证 + DOM 结构分析，录屏无意义，故不引入 ffmpeg 依赖。
（之前 mac12 上报的 ffmpeg 缺失错误，根因就是视频录制，现已彻底移除。）

## 运行
```bash
# 默认问题（自带 chromium）
npm run dev

# 指定问题 + 用本机 Chrome
npm run dev -- --chrome --question "你们品牌叫什么"

# 文心（匿名可用）
npm run dev -- --chrome --platform wenxin

# 千问（2026-08-31 定标：匿名可用，无需登录）
npm run dev -- --chrome --platform qianwen

# 豆包（匿名会触发风控，必须走登录 profile，见下）
npm run dev -- --chrome --platform doubao --profile
```

### 参数
| 参数 | 说明 | 默认 |
|---|---|---|
| `--question <文本>` | 要提的问题 | 内置医疗 AI 问题 |
| `--platform <id>` | 平台 id：`doubao` / `wenxin` / `qianwen` | `doubao` |
| `--url <地址>` | 覆盖平台默认入口（便于指向具体聊天页） | 平台自带 |
| `--chrome` | 用本机已安装的 Chrome（免下载 chromium） | 关 |
| `--profile [目录]` | **持久登录 profile**，复用真实登录会话 | 关（匿名） |
| `--wait-login <秒>` | 检测到未登录时等待人工登录的秒数，`0` = 不等待 | `300` |
| `--screenshot-mode <模式>` | 长屏截图策略：`expand` / `stitch` | `expand` |

环境变量等价写法：`GEO_USE_SYSTEM_CHROME=1`、`GEO_CHROME_PATH=...`、
`GEO_PROFILE_DIR=...`、`GEO_HEADLESS=1`。

### 登录 profile（需要登录的平台用这个）
匿名跑不通的平台（实测豆包会触发风控），改用持久 profile：人工登录一次，之后一直复用。

```bash
# 首次：控制台提示登录 → 在窗口里完成登录 → 程序自动继续
npm run dev -- --chrome --platform doubao --profile

# 之后：登录态已落盘，直接跑，无需再人工介入
npm run dev -- --chrome --platform doubao --profile
```

- profile 默认落在 `.profiles/<平台>/`（已 gitignore）；可指定目录：`--profile ./my-dir`。
- `--wait-login 0` 关闭等待（未登录就直接记结论、不阻塞）。
- 登录成功的判定是「输入框出现」，与具体登录方式（短信 / 扫码 / 第三方）无关。
- 启动参数带 `--disable-blink-features=AutomationControlled`，只去掉"我是脚本"的标记，
  **不绕过**任何验证码、登录或风控——该登录的仍然要人工登录。

## 拟人化交互与滑块验证（2026-08-31 增补）
- **所有操作都仿人类**：点击/输入/拖动均带真人节奏与轨迹（随机停顿、鼠标曲线移动、缓动拖动），
  由 `src/diagnostics/human.ts` 的中性原语统一提供（非平台私有逻辑，类似 `elementProbe.firstFound`）。
  平台 Adapter 内的点击/发送/关弹窗都应走这些原语，避免瞬时操作被风控识别为脚本。
- **滑块验证（如千问发送后弹出的风控滑块）**：由平台私有方法 `solveCaptcha()` 处理——检测滑块、
  仿人类缓动拖动（多候选落点 + 重试），自动不过则进入「等待人工滑动」模式（轮询到滑块消失，最多 120s），
  **run 不会卡死**。处理时会把验证码 DOM+截图落盘到 `diagnostics/<平台>/<ts>/captcha/`，供精确调参。
- ⚠️ **边界声明**：滑块处理＝模拟用户本就手动做的那个拖拽动作（保持真人节奏），**不使用打码平台 /
  第三方识别服务 / 漏洞利用**来破解验证码。精确缺口落点需真实样本定标；v1 用"多候选落点 + 重试 +
  人工兜底"保证不卡死，见到真实样本后再据缺口校准距离。

运行后会打开一个可见的 Chromium 窗口（有头），自动走完流程并落盘到：
```
diagnostics/doubao/<时间戳>/
├─ screenshot/ 01-before.png 02-question.png 03-answering.png 04-finished.png 05-long.png
├─ page/      before.html finished.html
├─ network/   network.har
├─ result.json
└─ report.html
```

## 服务器部署（仅镜像，无需代码仓库）

镜像内嵌部署模板（`/deploy/`），目标服务器**只拉镜像**即可完成部署，规则如下：

```bash
# ① 拉镜像
docker pull <registry>/geo-ui-browser:latest

# ② 从镜像提取部署脚本 + 模板（只需一次；之后服务器上会有 deploy.sh / docker-compose.yml / .env.example）
docker create --name geo-tpl <registry>/geo-ui-browser:latest
docker cp geo-tpl:/deploy/. .
docker rm geo-tpl

# ③ 准备配置：复制模板为 geo-ui-env 并填值（IMAGE / GEO_DATA_DIR / DB_* / GEO_BASE_PATH 等）
cp .env.example geo-ui-env
vi geo-ui-env

# ④ 一键启动（自动检查镜像、compose 模板，幂等可重复执行）
bash deploy.sh
```

**一台新电脑部署需要 4 样东西**：Docker（含 compose v2）、镜像、`geo-ui-env` 配置文件、可访问的外部 MySQL（表已建好）。

- 配置一律由宿主机 `geo-ui-env` 注入（数据库密码等**不进镜像**）；`IMAGE` 可指定私有仓库镜像名。
- `GEO_DATA_DIR` 是宿主机持久化目录（必填），容器内路径恒为 `/data/geo`。
- 带 nginx 路径前缀部署的配置与规则见 `geo-ui-env` 内注释。
- 已部署过的机器再次升级：`docker pull` 新镜像 → 直接 `bash deploy.sh`（无需重新提取）。

## 怎么用（关键）
1. 跑完打开 `report.html`：看「页面元素诊断」里 **回答区域 / 信源区域** 是否 ✗。
2. 若 ✗：用浏览器打开 `page/finished.html`，肉眼找回答/信源到底在哪个结构，
   据此**修正 `src/platforms/doubao/selectors.ts` 里的候选 selector**。
3. 改完重跑，直到元素诊断全 ✓、回复/信源能抽出 → 这套 selector 即固化进 `DoubaoAdapter`。
4. 日后豆包改版导致线上失败：直接重跑本工具，对比新旧 `finished.html` 即可定位变化。

## 重要纪律
- `selectors.ts` 里的 selector 全部是**候选、未经验证**。V1 的目的就是验证它们。
- 找不到元素时程序记 `found=false` / `sourceCount=NULL`，**绝不崩溃、绝不把"解析失败"误报成"无信源"**。
- **豆包匿名会话发送即触发风控**（2026-08-31 实测：问题能打进去、能点发送，但拿不到回答）。
  这是有效诊断结论，不是 selector 问题 → 豆包必须加 `--profile` 走登录态。
  ⚠️ 另注意：豆包匿名态**输入框依然存在**，所以靠"有没有输入框"判断登录态对豆包不可靠，
     后续要给豆包补平台私有的登录判定（如识别登录入口 / 用户态元素）。
- 不绕过验证码/登录保护/平台风控；仅作正常网页访问与自有/已登录会话。
