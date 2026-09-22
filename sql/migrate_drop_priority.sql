-- geo-ui-browser 删除 priority 字段迁移（2026-09-22）
-- 仅「已存在旧库」需要执行：schema.sql 用 CREATE TABLE IF NOT EXISTS，
-- 已存在的表不会自动删除列。全新库直接跑 schema.sql（已无 priority）即可。
--
-- 背景：priority 从未参与任何挑号排序（ipScheduler.acquireAccountByIp 与
-- loginRegistry.allocateAccount 两处挑号都不读它），仅 API 可写 + UI 显示"置顶"徽章，
-- 点了实际不生效，故整体移除。

ALTER TABLE geo_ui_platform_account DROP COLUMN priority;

-- 注：priority 原属于 KEY idx_pick，DROP COLUMN 时 MySQL 会自动把它从索引中移除，无需单独处理索引。
-- 若提示 Can't DROP 'priority'; check that column/key exists，说明已删除过，忽略即可。
