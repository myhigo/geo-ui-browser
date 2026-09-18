# geo-ui-browser 文档

| 文档 | 内容 |
|---|---|
| [refactor-design.md](./refactor-design.md) | **重构设计 v2.1**（定稿）：服务器部署 / MySQL 账号存储 / 产物不落盘 / 出口 IP 与代理 / 实施计划 |
| [project-notes.md](./project-notes.md) | **项目笔记**：代码结构地图、踩过的坑、与 geo-browser 的关系与同步规则、部署形态、常用命令 |

## 项目定位

模拟真实用户行为，对大模型平台（豆包 / 千问 / 百度文心 / DeepSeek / 腾讯元宝）提问，抓取**回答内容 + 信源信息 + 长截图**，通过接口回推给业务侧（Java 服务）。

对外关系：**我们调用别人的接口**（拉词、回推结果），本身不是对外提供服务的 API。

## 当前状态（2026-09-19）

- 代码处于**重构前**状态：仅 1 次 initial commit，且 `src/diagnostics/` 未提交 → **当前无法编译**。
- 重构设计已定稿（见上表），尚未开工。
- 一期范围：单实例 Docker、账号信息入 MySQL、产物不落盘、代理 `provider=none`。

## 快速开始（重构落地后）

```bash
docker compose up -d     # 见 refactor-design.md §9
# /admin  → 账号管理与登录（内嵌 noVNC）
# :6080   → noVNC 直连容器浏览器
```
