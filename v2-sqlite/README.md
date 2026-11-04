# 网页用户备注助手（Python + SQLite 后端 + Chrome 扩展）

> 非官方开源工具，与知乎及任何网站官方无关。仅用于用户个人浏览时本地标注，不提供抓取、上传或商业化服务。
>
> 独立的新版本，**不影响** `zhihu-tagger`（v1 纯本地版）。

## 架构

```
┌───────────────────────────┐
│      Chrome 扩展（v2）     │
│  background.js  定时同步   │
│  content.js     渲染标签   │
│  popup.js       调用 API   │
└─────────────┬─────────────┘
              │ HTTP / JSON
              ▼
┌───────────────────────────┐
│  Python 后端（标准库）      │
│  backend/app.py            │
│  127.0.0.1:8000            │
└─────────────┬─────────────┘
              │ sqlite3
              ▼
┌───────────────────────────┐
│ SQLite 数据库               │
│ backend/data/zhihu-tagger.db│
│ ← DB Browser / DBeaver 可开 │
└───────────────────────────┘
```

## 与 v1 的区别

| | v1（zhihu-tagger） | v2（本项目） |
|---|---|---|
| 存储 | chrome.storage.local（LevelDB） | **SQLite 数据库文件** |
| 数据管理 | 只能通过扩展 / JSON 导入导出 | **可用 DB Browser / DBeaver 直接管理** |
| 多设备 | 不支持 | 支持（后端部署到局域网/服务器） |
| 依赖 | 无 | Python 3.8+（零第三方库） |
| 离线 | 完全离线 | 扩展缓存离线可用，需后端同步 |

## 快速开始

### 1. 启动后端

```bash
cd backend
python app.py
```

看到以下输出即成功：

```
网页用户标签助手后端已启动: http://127.0.0.1:8000
数据库文件: .../backend/data/zhihu-tagger.db
```

> 首次启动会自动创建数据库和表结构。

### 2. 加载扩展

1. 打开 `chrome://extensions`
2. 开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择本项目的 **`extension`** 目录

### 3. 配置服务地址

- 点扩展图标 → 底部「设置」，确认后端地址为 `http://127.0.0.1:8000`，点「测试连接」
- 如果把后端部署到其他机器/端口，在这里改成对应地址

### 4. 使用

- 打开知乎页面，点扩展图标
- 选用户、选标签、保存 → 数据写入 SQLite
- 页面上的标签由 `background.js` 同步后自动渲染

## 数据库管理

**数据库文件**：`backend/data/zhihu-tagger.db`

用 [DB Browser for SQLite](https://sqlitebrowser.org/) 或 DBeaver 直接打开即可增删改查。

**表结构**：

```sql
users        -- 用户（uid 为主键）
  uid, url_token, name, color, updated_at

labels       -- 标签库
  id, name, color, created_at

user_labels  -- 用户-标签多对多关联
  uid, label_id
```

**手动维护示例**：

```sql
-- 给某个 uid 打标签（标签不存在会自动创建）
INSERT OR IGNORE INTO labels(name) VALUES('大佬');
INSERT OR IGNORE INTO user_labels(uid, label_id)
SELECT 'b337102c34f885a60007dd301dee3975', id FROM labels WHERE name='大佬';
```

> 改完数据库后，扩展会在下一次同步（≤1 分钟）自动拉取，或点扩展里的操作触发同步。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/snapshot` | 全量数据（用户 + 标签库） |
| GET | `/api/export` | 导出（同 snapshot） |
| **GET** | **`/api/stats?days=30`** | **统计数据（总量 / 每日新增 / 来源设备）** |
| **GET** | **`/stats`** | **统计页面（含走势图）** |
| POST | `/api/users` | 保存/更新用户标签 |
| DELETE | `/api/users/{uid}` | 删除用户 |
| GET | `/api/labels` | 标签库 |
| POST | `/api/labels` | 新增标签 |
| DELETE | `/api/labels/{id}` | 删除标签 |
| POST | `/api/import` | 合并导入 |

**保存用户示例**：

```bash
curl -X POST http://127.0.0.1:8000/api/users \
  -H "Content-Type: application/json" \
  -d "{\"uid\":\"b337102c34f885a60007dd301dee3975\",\"urlToken\":\"timeless-84-31\",\"name\":\"timeless\",\"tags\":[\"大佬\",\"干货\"]}"
```

## 数据统计

后端启动后，浏览器打开：

```
http://127.0.0.1:8000/stats
```

包含：

- 用户量、备注量、用户-备注关联数、平均每位用户备注数
- 最近 30 天每日新增：用户、备注、关联（折线走势图）
- 来源设备分布

也可通过 API 获取：`GET /api/stats?days=30`

### 关于「谁添加的备注」

- 扩展会为每个浏览器生成一个 `clientId`（存于 `chrome.storage.local` 的 `zhTaggerClientId`）
- 扩展会从页面登录态解析**当前登录的知乎用户**（`js-initialData` 的 `entities.users`），存于 `zhTaggerZhihuUser`
- 保存时写入数据库的 `created_by` / `updated_by`（设备）和 `zhihu_user_id`（知乎用户 ID）
- 统计页的「来源」能看到「知乎用户 ID + 设备」的贡献分布
- **限制**：知乎用户 ID 来自页面登录态，未登录时拿不到；它标识的是“哪个知乎账号在操作”，仍不等于严格的真人身份认证

## 数据同步机制

1. `background.js` 启动时、每 1 分钟、以及 popup 保存后，都会请求 `/api/snapshot`
2. 拿到数据后转成内容脚本使用的结构，写入 `chrome.storage.local` 作为**本地缓存**
3. `content.js` 只读缓存渲染标签，因此即使后端暂时不可用，已有标签仍能显示
4. popup 的增删改直接写后端，成功后触发一次同步

## 目录结构

```
zhihu-tagger-v2/
├── backend/
│   ├── app.py              # 后端服务（标准库 http.server + sqlite3）
│   ├── schema.sql          # 表结构
│   ├── requirements.txt    # 零依赖说明
│   └── data/               # 运行时生成 zhihu-tagger.db
├── extension/
│   ├── manifest.json
│   ├── background.js       # 定时同步后端
│   ├── content.js          # 渲染标签（复用 v1 逻辑）
│   ├── storage.js          # 本地缓存结构工具
│   ├── selectors.js
│   ├── popup.html / popup.js
│   ├── options.html / options.js
│   └── icons/
└── README.md
```

## 注意事项

- 后端默认只监听 `127.0.0.1`（仅本机访问）。如需多设备共享：
  ```bash
  set HOST=0.0.0.0
  python app.py
  ```
  然后扩展设置里填 `http://<局域网IP>:8000`
- 端口默认 `8000`，可改：
  ```bash
  set PORT=9000
  python app.py
  ```
  （扩展的 `host_permissions` 已覆盖本机任意端口；如果换到其他主机，需在 manifest 中补上对应 host）
- 数据库是普通 SQLite 文件，**备份直接复制 `zhihu-tagger.db` 即可**
- 扩展与 v1 可以同时安装（名称、ID 不同），互不影响
