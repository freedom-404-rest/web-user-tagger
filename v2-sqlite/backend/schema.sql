-- 网页用户备注助手 v2（SQLite）
-- 可直接用 DB Browser for SQLite / DBeaver 打开 data/zhihu-tagger.db 管理
-- 索引在 app.py 的 migrate() 中创建，兼容旧库升级

PRAGMA foreign_keys = ON;

-- 用户表：uid 为真实用户 ID（32 位十六进制，稳定）
CREATE TABLE IF NOT EXISTS users (
  uid           TEXT PRIMARY KEY,
  url_token     TEXT,
  name          TEXT,
  color         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  created_by    TEXT DEFAULT '',
  updated_by    TEXT DEFAULT '',
  zhihu_user_id TEXT DEFAULT ''
);

-- 备注库（标签库）
CREATE TABLE IF NOT EXISTS labels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  color         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  created_by    TEXT DEFAULT '',
  zhihu_user_id TEXT DEFAULT ''
);

-- 用户与备注的多对多关联
CREATE TABLE IF NOT EXISTS user_labels (
  uid           TEXT NOT NULL,
  label_id      INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  created_by    TEXT DEFAULT '',
  zhihu_user_id TEXT DEFAULT '',
  PRIMARY KEY (uid, label_id),
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE,
  FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
);
