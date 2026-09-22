-- geo-ui-browser 字段重命名迁移（2026-09-22）
-- 仅「已存在旧库」需要执行：schema.sql 用 CREATE TABLE IF NOT EXISTS，
-- 已存在的 geo_ui_platform_account 表不会被改名，必须手动 CHANGE COLUMN。
-- 全新库直接跑 schema.sql 即可（已是 remark / nickname），无需本文件。
--
-- 与 sql/migrate_add_proxy_columns.sql（加 4 个代理字段）互不依赖，顺序任意。

-- alias（备注）→ remark
ALTER TABLE geo_ui_platform_account
  CHANGE COLUMN alias remark VARCHAR(64) NULL COMMENT '备注';

-- marker（平台侧昵称）→ nickname
ALTER TABLE geo_ui_platform_account
  CHANGE COLUMN marker nickname VARCHAR(128) NULL COMMENT '平台侧昵称（登录后抓取）';

-- 若提示 Unknown column 'alias' / 'marker'，说明已改过名，忽略即可。
