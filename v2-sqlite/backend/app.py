# -*- coding: utf-8 -*-
"""
知乎用户标签 v2 —— Python + SQLite 后端（零第三方依赖）

启动：
    python app.py
默认监听 http://127.0.0.1:8000，数据库文件 data/web-user-tagger.db

接口：
    GET    /api/health              健康检查
    GET    /api/snapshot            全量数据（用户 + 标签库）
    GET    /api/export              导出（同 snapshot）
    POST   /api/users               保存 / 更新用户标签
    DELETE /api/users/{uid}         删除用户
    GET    /api/labels              标签库
    POST   /api/labels              新增标签
    DELETE /api/labels/{id}         删除标签
    POST   /api/import              导入（合并）
"""

import json
import os
import sqlite3
import urllib.parse
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
DB_PATH = os.path.join(DATA_DIR, 'web-user-tagger.db')
OLD_DB_PATH = os.path.join(DATA_DIR, 'zhihu-tagger.db')
SCHEMA_PATH = os.path.join(BASE_DIR, 'schema.sql')
STATS_PATH = os.path.join(BASE_DIR, 'stats.html')

HOST = os.environ.get('HOST', '127.0.0.1')
PORT = int(os.environ.get('PORT', '8000'))


def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    conn.execute('PRAGMA journal_mode = WAL')
    return conn


def migrate_db_filename():
    """旧数据库文件名 zhihu-tagger.db -> web-user-tagger.db（保留数据）。"""
    if os.path.exists(OLD_DB_PATH) and not os.path.exists(DB_PATH):
        for suffix in ('', '-wal', '-shm'):
            old = OLD_DB_PATH + suffix
            if os.path.exists(old):
                os.replace(old, DB_PATH + suffix)


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    migrate_db_filename()
    with open(SCHEMA_PATH, 'r', encoding='utf-8') as f:
        schema = f.read()
    conn = get_conn()
    conn.executescript(schema)
    migrate(conn)
    conn.commit()
    conn.close()


def ensure_column(conn, table, column, definition):
    cols = [r['name'] for r in conn.execute('PRAGMA table_info(%s)' % table)]
    if column not in cols:
        conn.execute('ALTER TABLE %s ADD COLUMN %s %s' % (table, column, definition))


USERS_TABLE_SQL = '''
CREATE TABLE users (
  uid           TEXT PRIMARY KEY,
  url_token     TEXT,
  name          TEXT,
  color         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  created_by    TEXT DEFAULT '',
  updated_by    TEXT DEFAULT '',
  zhihu_user_id TEXT DEFAULT ''
)
'''

USERS_COLUMNS = ['uid', 'url_token', 'name', 'color', 'created_at', 'updated_at', 'created_by', 'updated_by', 'zhihu_user_id']

LABELS_TABLE_SQL = '''
CREATE TABLE labels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  color         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  created_by    TEXT DEFAULT '',
  zhihu_user_id TEXT DEFAULT ''
)
'''

LABELS_COLUMNS = ['id', 'name', 'color', 'created_at', 'created_by', 'zhihu_user_id']

USER_LABELS_TABLE_SQL = '''
CREATE TABLE user_labels (
  uid           TEXT NOT NULL,
  label_id      INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  created_by    TEXT DEFAULT '',
  zhihu_user_id TEXT DEFAULT '',
  PRIMARY KEY (uid, label_id),
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE,
  FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
)
'''

USER_LABELS_COLUMNS = ['uid', 'label_id', 'created_at', 'created_by', 'zhihu_user_id']


def drop_column_if_exists(conn, table, column, create_sql, columns):
    """SQLite 3.35 以下不支持 DROP COLUMN，用重建表的方式删除字段（保留数据）。"""
    cols = [r['name'] for r in conn.execute('PRAGMA table_info(%s)' % table)]
    if column not in cols:
        return

    old = table + '__old'
    conn.execute('DROP TABLE IF EXISTS %s' % old)
    conn.execute('ALTER TABLE %s RENAME TO %s' % (table, old))
    conn.execute(create_sql)

    col_list = ', '.join(columns)
    conn.execute('INSERT INTO %s (%s) SELECT %s FROM %s' % (table, col_list, col_list, old))
    conn.execute('DROP TABLE %s' % old)


def migrate(conn):
    """兼容旧版数据库：补齐统计所需字段，并移除废弃字段。"""
    ensure_column(conn, 'users', 'created_at', 'TEXT')
    ensure_column(conn, 'users', 'created_by', "TEXT DEFAULT ''")
    ensure_column(conn, 'users', 'updated_by', "TEXT DEFAULT ''")
    ensure_column(conn, 'users', 'zhihu_user_id', "TEXT DEFAULT ''")
    ensure_column(conn, 'labels', 'created_by', "TEXT DEFAULT ''")
    ensure_column(conn, 'labels', 'zhihu_user_id', "TEXT DEFAULT ''")
    ensure_column(conn, 'user_labels', 'created_at', 'TEXT')
    ensure_column(conn, 'user_labels', 'created_by', "TEXT DEFAULT ''")
    ensure_column(conn, 'user_labels', 'zhihu_user_id', "TEXT DEFAULT ''")

    conn.execute(
        "UPDATE users SET created_at = COALESCE(created_at, updated_at, datetime('now', 'localtime'))"
    )
    conn.execute(
        "UPDATE user_labels SET created_at = COALESCE(created_at, datetime('now', 'localtime'))"
    )

    # 移除已废弃的 zhihu_user_name 字段
    conn.commit()
    conn.execute('PRAGMA foreign_keys = OFF')
    conn.execute('PRAGMA legacy_alter_table = ON')
    drop_column_if_exists(conn, 'user_labels', 'zhihu_user_name', USER_LABELS_TABLE_SQL, USER_LABELS_COLUMNS)
    drop_column_if_exists(conn, 'labels', 'zhihu_user_name', LABELS_TABLE_SQL, LABELS_COLUMNS)
    drop_column_if_exists(conn, 'users', 'zhihu_user_name', USERS_TABLE_SQL, USERS_COLUMNS)
    conn.execute('PRAGMA legacy_alter_table = OFF')
    conn.execute('PRAGMA foreign_keys = ON')

    conn.execute('CREATE INDEX IF NOT EXISTS idx_users_url_token ON users(url_token)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_labels_created_at ON labels(created_at)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_user_labels_created_at ON user_labels(created_at)')


def snapshot():
    """全量数据：用户（含标签）+ 标签库。"""
    conn = get_conn()
    try:
        users = []
        rows = conn.execute(
            'SELECT uid, url_token, name, color, updated_at FROM users ORDER BY updated_at DESC'
        )
        for row in rows:
            tags = [
                r['name']
                for r in conn.execute(
                    'SELECT l.name FROM user_labels ul '
                    'JOIN labels l ON l.id = ul.label_id '
                    'WHERE ul.uid = ? ORDER BY l.id',
                    (row['uid'],),
                )
            ]
            users.append({
                'uid': row['uid'],
                'urlToken': row['url_token'] or '',
                'name': row['name'] or '',
                'color': row['color'] or '',
                'tags': tags,
                'updatedAt': row['updated_at'],
            })
        labels = [dict(r) for r in conn.execute('SELECT id, name, color FROM labels ORDER BY id')]
        return {'users': users, 'labels': labels}
    finally:
        conn.close()


def _upsert_user(conn, uid, url_token, name, color, tags, client_id='', zhihu_user_id=''):
    conn.execute(
        '''INSERT INTO users(uid, url_token, name, color, created_at, updated_at,
                             created_by, updated_by, zhihu_user_id)
           VALUES(?, ?, ?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'), ?, ?, ?)
           ON CONFLICT(uid) DO UPDATE SET
             url_token = excluded.url_token,
             name = excluded.name,
             color = excluded.color,
             updated_at = excluded.updated_at,
             updated_by = excluded.updated_by''',
        (
            uid,
            url_token or '',
            name or '',
            color or '',
            client_id or '',
            client_id or '',
            zhihu_user_id or '',
        ),
    )

    label_ids = []
    for tag in tags or []:
        tag = (tag or '').strip()
        if not tag:
            continue
        row = conn.execute('SELECT id FROM labels WHERE name = ?', (tag,)).fetchone()
        if row:
            label_ids.append(row['id'])
        else:
            cur = conn.execute(
                'INSERT INTO labels(name, created_by, zhihu_user_id) VALUES(?, ?, ?)',
                (tag, client_id or '', zhihu_user_id or ''),
            )
            label_ids.append(cur.lastrowid)

    existing = set(
        r['label_id'] for r in conn.execute('SELECT label_id FROM user_labels WHERE uid = ?', (uid,))
    )
    for label_id in label_ids:
        if label_id not in existing:
            conn.execute(
                '''INSERT OR IGNORE INTO user_labels(
                     uid, label_id, created_at, created_by, zhihu_user_id
                   ) VALUES(?, ?, datetime('now', 'localtime'), ?, ?)''',
                (uid, label_id, client_id or '', zhihu_user_id or ''),
            )

    if label_ids:
        placeholders = ','.join(['?'] * len(label_ids))
        conn.execute(
            'DELETE FROM user_labels WHERE uid = ? AND label_id NOT IN (%s)' % placeholders,
            tuple([uid] + label_ids),
        )
    else:
        conn.execute('DELETE FROM user_labels WHERE uid = ?', (uid,))


def stats(days=30):
    """统计：总量、每日新增、来源设备。"""
    try:
        days = int(days)
    except (TypeError, ValueError):
        days = 30
    days = max(1, min(days, 365))

    conn = get_conn()
    try:
        users_count = conn.execute('SELECT COUNT(*) AS c FROM users').fetchone()['c']
        labels_count = conn.execute('SELECT COUNT(*) AS c FROM labels').fetchone()['c']
        ul_count = conn.execute('SELECT COUNT(*) AS c FROM user_labels').fetchone()['c']
        avg = round(ul_count / users_count, 2) if users_count else 0

        today = date.today()
        start = today - timedelta(days=days - 1)
        start_str = start.isoformat()

        def daily(table):
            rows = conn.execute(
                "SELECT date(created_at) AS d, COUNT(*) AS c FROM %s "
                "WHERE date(created_at) >= ? GROUP BY date(created_at)" % table,
                (start_str,),
            )
            return {r['d']: r['c'] for r in rows}

        by_users = daily('users')
        by_labels = daily('labels')
        by_links = daily('user_labels')

        daily_list = []
        for i in range(days):
            d = (start + timedelta(days=i)).isoformat()
            daily_list.append({
                'date': d,
                'newUsers': by_users.get(d, 0),
                'newLabels': by_labels.get(d, 0),
                'newUserLinks': by_links.get(d, 0),
            })

        sources = [
            {
                'zhihuUserId': r['zhihu_user_id'] or '',
                'device': r['created_by'] or '',
                'count': r['c'],
            }
            for r in conn.execute(
                'SELECT zhihu_user_id, created_by, COUNT(*) AS c '
                'FROM users GROUP BY zhihu_user_id, created_by ORDER BY c DESC'
            )
        ]

        return {
            'totals': {
                'users': users_count,
                'labels': labels_count,
                'userLabels': ul_count,
                'avgLabelsPerUser': avg,
            },
            'daily': daily_list,
            'sources': sources,
        }
    finally:
        conn.close()


def save_user(payload):
    uid = (payload.get('uid') or '').strip()
    url_token = (payload.get('urlToken') or payload.get('url_token') or '').strip()
    if not uid:
        uid = 't:' + url_token if url_token else ''
    if not uid:
        raise ValueError('uid 或 urlToken 至少提供一个')

    conn = get_conn()
    try:
        with conn:
            _upsert_user(
                conn,
                uid,
                url_token,
                payload.get('name'),
                payload.get('color'),
                payload.get('tags'),
                (payload.get('clientId') or '').strip(),
                (payload.get('zhihuUserId') or '').strip(),
            )
        return {'ok': True, 'uid': uid}
    finally:
        conn.close()


def import_snapshot(data):
    conn = get_conn()
    count = 0
    client_id = (data.get('clientId') or 'import').strip()
    zhihu_user_id = (data.get('zhihuUserId') or '').strip()
    try:
        with conn:
            for u in data.get('users', []) or []:
                uid = (u.get('uid') or '').strip()
                url_token = (u.get('urlToken') or u.get('url_token') or '').strip()
                if not uid:
                    uid = 't:' + url_token if url_token else ''
                if not uid:
                    continue
                _upsert_user(
                    conn,
                    uid,
                    url_token,
                    u.get('name'),
                    u.get('color'),
                    u.get('tags'),
                    client_id,
                    zhihu_user_id,
                )
                count += 1

            for label in data.get('labels', []) or []:
                name = label.get('name') if isinstance(label, dict) else label
                name = (name or '').strip()
                if name:
                    conn.execute('INSERT OR IGNORE INTO labels(name) VALUES(?)', (name,))
        return {'ok': True, 'imported': count}
    finally:
        conn.close()


class Handler(BaseHTTPRequestHandler):
    server_version = 'ZhihuTagger/2.0'

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False, indent=2).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode('utf-8') or '{}')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == '/api/health':
                self._send(200, {'ok': True, 'service': 'zhihu-tagger-v2'})
            elif path in ('/api/snapshot', '/api/export'):
                self._send(200, snapshot())
            elif path == '/api/stats':
                qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                try:
                    days = int((qs.get('days') or ['30'])[0])
                except ValueError:
                    days = 30
                self._send(200, stats(days))
            elif path == '/stats':
                with open(STATS_PATH, 'r', encoding='utf-8') as f:
                    html = f.read()
                body = html.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif path == '/api/labels':
                conn = get_conn()
                try:
                    labels = [dict(r) for r in conn.execute('SELECT id, name, color FROM labels ORDER BY id')]
                finally:
                    conn.close()
                self._send(200, {'labels': labels})
            else:
                self._send(404, {'error': 'not found'})
        except Exception as e:
            self._send(500, {'error': str(e)})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            data = self._read_json()
            if path == '/api/users':
                self._send(200, save_user(data))
            elif path == '/api/import':
                self._send(200, import_snapshot(data))
            elif path == '/api/labels':
                name = (data.get('name') or '').strip()
                if not name:
                    self._send(400, {'error': 'name required'})
                    return
                conn = get_conn()
                try:
                    with conn:
                        conn.execute('INSERT OR IGNORE INTO labels(name) VALUES(?)', (name,))
                    row = conn.execute('SELECT id, name, color FROM labels WHERE name = ?', (name,)).fetchone()
                finally:
                    conn.close()
                self._send(200, {'ok': True, 'label': dict(row) if row else None})
            else:
                self._send(404, {'error': 'not found'})
        except Exception as e:
            self._send(500, {'error': str(e)})

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path.startswith('/api/users/'):
                uid = urllib.parse.unquote(path[len('/api/users/'):])
                conn = get_conn()
                try:
                    with conn:
                        conn.execute('DELETE FROM users WHERE uid = ?', (uid,))
                finally:
                    conn.close()
                self._send(200, {'ok': True})
            elif path.startswith('/api/labels/'):
                label_id = urllib.parse.unquote(path[len('/api/labels/'):])
                conn = get_conn()
                try:
                    with conn:
                        conn.execute('DELETE FROM user_labels WHERE label_id = ?', (label_id,))
                        conn.execute('DELETE FROM labels WHERE id = ?', (label_id,))
                finally:
                    conn.close()
                self._send(200, {'ok': True})
            else:
                self._send(404, {'error': 'not found'})
        except Exception as e:
            self._send(500, {'error': str(e)})

    def log_message(self, fmt, *args):
        print('[%s] %s' % (self.log_date_time_string(), fmt % args))


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print('网页用户标签助手后端已启动: http://%s:%d' % (HOST, PORT))
    print('数据库文件: %s' % DB_PATH)
    print('按 Ctrl+C 停止')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')
        server.server_close()


if __name__ == '__main__':
    main()
