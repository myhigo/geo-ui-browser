-- geo-ui-browser 建表脚本
-- 由人工在 MySQL 上执行（不进代码自动建表）。字段与 src/storage/*Repo.ts 严格对应，勿随意改名。
-- 如需重建：DROP TABLE 后重跑本文件。

CREATE TABLE IF NOT EXISTS geo_ui_platform_account (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  node_id           VARCHAR(64)  NOT NULL DEFAULT 'default' COMMENT '持有该账号 profile 的节点（GEO_NODE_ID）',
  platform_id       VARCHAR(32)  NOT NULL COMMENT 'doubao/qwen/wenxiaoyan/deepseek/hunyuan',
  account_code      VARCHAR(64)  NOT NULL COMMENT '业务账号号，如 doubao-1（上层 Account.id 即此值）',
  alias             VARCHAR(64)  COMMENT '备注',
  marker            VARCHAR(128) COMMENT '平台侧昵称（登录后抓取）',
  status            VARCHAR(16)   NOT NULL DEFAULT 'none' COMMENT 'none/waiting/active/cooling/failed',
  enabled           TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '0=停用，不参与挑号',
  priority          INT          NOT NULL DEFAULT 0 COMMENT '越大越优先',
  note              TEXT,
  profile_dir       VARCHAR(512) NOT NULL COMMENT '浏览器 userDataDir 绝对路径（卷内）',
  today_queries     INT          NOT NULL DEFAULT 0,
  query_date        DATE         NULL COMMENT 'YYYY-MM-DD，用于跨天归零',
  consecutive_fails INT          NOT NULL DEFAULT 0,
  last_used_at      DATETIME     NULL,
  leased_by         VARCHAR(64)  NULL COMMENT '占用者 nodeId:runId；NULL=空闲',
  leased_at         DATETIME     NULL,
  proxy_host        VARCHAR(64)  NULL COMMENT '绑定的代理 IP（代理启用后使用）',
  proxy_port        INT          NULL,
  proxy_bound_at    DATETIME     NULL COMMENT '代理绑定时间，用于续期判断',
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_node_platform_code (node_id, platform_id, account_code),
  KEY idx_pick (node_id, platform_id, status, enabled, leased_by, priority, last_used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='平台账号台账';

CREATE TABLE IF NOT EXISTS geo_ui_identity_state (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  node_id    VARCHAR(64)  NOT NULL DEFAULT 'default',
  state_key  VARCHAR(128) NOT NULL COMMENT 'qwen-conv-count / rotation:<dir>',
  payload    JSON         NOT NULL,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_node_key (node_id, state_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='匿名身份与轮换计数';

-- P3 起使用（登录会话跨重启可见）；先建好，字段与 loginRegistry 的 activeLogin/testSessions 对应
CREATE TABLE IF NOT EXISTS geo_ui_login_session (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  node_id      VARCHAR(64) NOT NULL DEFAULT 'default',
  platform_id  VARCHAR(32) NOT NULL,
  account_code VARCHAR(64) NOT NULL,
  kind         VARCHAR(16)   NOT NULL COMMENT 'login/test',
  phase        VARCHAR(16)   NOT NULL DEFAULT 'waiting' COMMENT 'waiting/verifying/done',
  started_at   DATETIME NOT NULL,
  expires_at   DATETIME NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_node_account_kind (node_id, platform_id, account_code, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='登录/测试会话（P3 启用）';
