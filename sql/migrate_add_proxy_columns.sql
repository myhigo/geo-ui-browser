-- geo-ui-browser 代理系统迁移（2026-09-22 新增）
-- 仅对「已存在旧库」需要执行：schema.sql 用 CREATE TABLE IF NOT EXISTS，
-- 已存在的 geo_ui_platform_account 表不会被追加新字段，必须手动 ALTER。
-- 全新库直接跑 schema.sql 即可，无需本文件。
-- 执行顺序：先跑 schema.sql（会新建 geo_ui_proxy_ip 表），再跑本文件。

-- 给账号表追加 4 个代理字段
ALTER TABLE geo_ui_platform_account
  ADD COLUMN proxy_host      VARCHAR(64)  NULL COMMENT '绑定的代理 IP（代理启用后使用）' AFTER leased_at,
  ADD COLUMN proxy_port      INT          NULL COMMENT '绑定的代理端口'                 AFTER proxy_host,
  ADD COLUMN proxy_id        BIGINT       NULL COMMENT '绑定代理 IP 的 id（geo_ui_proxy_ip.id）；null=不绑代理（走宿主机）' AFTER proxy_port,
  ADD COLUMN proxy_bound_at  DATETIME     NULL COMMENT '代理绑定时间，用于续期判断'     AFTER proxy_id;

-- 若提示 Duplicate column name，说明字段已存在，可忽略该错误继续。
-- geo_ui_proxy_ip 表由 schema.sql 的 CREATE TABLE IF NOT EXISTS 自动新建，无需手动处理。
