# 网页用户备注助手（Web User Tagger）

> 为网页中的用户添加自定义备注，并在浏览时自动渲染到昵称旁边。
>
> **非官方开源工具**，与知乎及任何网站官方无关。仅用于用户个人浏览时本地标注，不提供抓取、上传或商业化服务。

---

## 功能

- **昵称旁显示备注**：回答、评论、用户主页等位置的昵称旁自动渲染备注徽标
- **备注库**：预定义备注、下拉搜索、多选、回车新增（新增自动入库）
- **反显**：点击当前页用户或输入已知用户后，自动回显其已保存的备注
- **快捷入口**：用户名旁的「备注」按钮，点击即可编辑
- **用户主页**：昵称后显示备注
- **导入 / 导出**：JSON 备份与恢复
- **用户识别**：优先使用真实 `uid`，改昵称 / 改主页地址仍可追踪
- **纯 DOM 操作**：不调用网站接口
- **v2 独有**：SQLite 数据库、数据库软件直接管理、统计页面

## 两个版本

| | `v1-local` | `v2-sqlite` |
|---|---|---|
| 数据存储 | `chrome.storage.local` | **SQLite 数据库文件** |
| 需要后端 | ❌ | ✅ Python（零第三方依赖） |
| 数据管理 | 扩展内 / JSON 导入导出 | **DB Browser / DBeaver 直接管理** |
| 多设备 | ❌ | ✅ 后端部署到局域网/服务器 |
| 统计 | ❌ | ✅ 用户量 / 备注量 / 每日新增 / 来源 |
| 离线 | 完全离线 | 扩展缓存离线可用 |

## 目录结构

```
web-user-tagger/
├── README.md
├── .gitignore
├── v1-local/                  # 本地版（Chrome 扩展）
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── storage.js
│   ├── selectors.js
│   ├── popup.html / popup.js
│   ├── scripts/
│   └── icons/
└── v2-sqlite/                 # SQLite 同步版
    ├── backend/               # Python 后端
    │   ├── app.py
    │   ├── schema.sql
    │   ├── stats.html
    │   └── data/              # 运行时生成数据库（已 gitignore）
    └── extension/             # Chrome 扩展
        ├── manifest.json
        ├── background.js
        ├── content.js
        ├── popup.html / popup.js
        ├── options.html / options.js
        └── icons/
```

## 快速开始

### v1 本地版

1. 打开 `chrome://extensions`
2. 开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `v1-local/`
4. 打开任意知乎页面，点击扩展图标使用

### v2 SQLite 版

**1. 启动后端**

```bash
cd v2-sqlite/backend
python app.py
```

启动成功输出：

```
网页用户备注助手后端已启动: http://127.0.0.1:8000
数据库文件: .../backend/data/zhihu-tagger.db
```

**2. 加载扩展**

`chrome://extensions` → 开发者模式 → 加载已解压 → 选择 `v2-sqlite/extension/`

**3. 配置后端地址**

扩展图标 → 底部「设置」→ 确认 `http://127.0.0.1:8000` → 测试连接

**4. 使用**

- 打开知乎页面，点击扩展图标
- 或在用户名旁点击「备注」按钮
- 选择备注、保存 → 数据写入 SQLite

**5. 统计页面**

```
http://127.0.0.1:8000/stats
```

## 用户识别机制

网页上的用户标识有三种：

| 标识 | 稳定性 | 说明 |
|---|---|---|
| 昵称 | ❌ | 可修改、可重名 |
| 主页别名（`url_token`，如 `young-dong`） | ❌ | 用户可自行修改 |
| 真实 `uid`（32 位十六进制） | ✅ | 内部唯一，改昵称/地址不变 |

本项目优先使用真实 `uid`：

1. 从页面内嵌数据（`#js-initialData` 的实体）提取 `url_token -> uid`
2. 从回答卡片埋点 `data-za-extra-module` 的 `author_member_hash_id`（等于真实 uid）关联卡片内作者链接
3. 拿不到 uid 时用 `url_token` 占位，后续解析到 uid 自动迁移

> 限制：纯 DOM 方案无法保证所有位置都能拿到 uid；文章/视频 Feed、部分评论区可能只能拿到 `url_token`。

## 数据存储

### v1

浏览器本地 `chrome.storage.local`：

```js
// zhTaggerTags
{ version: 2, users: { [uid]: { uid, urlToken, name, tags, color } }, tokenIndex: { urlToken: uid } }
// zhTaggerLabels
["大佬", "干货"]
```

### v2

SQLite 文件：`v2-sqlite/backend/data/zhihu-tagger.db`

```sql
users        -- uid, url_token, name, color, created_at, updated_at, created_by, updated_by, zhihu_user_id
labels       -- id, name, color, created_at, created_by, zhihu_user_id
user_labels  -- uid, label_id, created_at, created_by, zhihu_user_id
```

- 备份：直接复制 `zhihu-tagger.db`
- 管理：DB Browser for SQLite / DBeaver
- 修改后扩展会在 1 分钟内自动同步

## 后端 API（v2）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/snapshot` | 全量数据 |
| GET | `/api/export` | 导出 |
| GET | `/api/stats?days=30` | 统计数据 |
| GET | `/stats` | 统计页面 |
| POST | `/api/users` | 保存/更新用户备注 |
| DELETE | `/api/users/{uid}` | 删除用户 |
| GET | `/api/labels` | 备注库 |
| POST | `/api/labels` | 新增备注 |
| DELETE | `/api/labels/{id}` | 删除备注 |
| POST | `/api/import` | 合并导入 |

## 技术要点

- Manifest V3 Chrome 扩展
- `MutationObserver` 监听 SPA 动态内容，防抖 + `WeakSet` 去重
- 备注按钮、备注面板、徽标样式均带 `zh-tagger-` 前缀，避免样式冲突
- v2 后端使用 Python 标准库（`http.server` + `sqlite3`），零第三方依赖
- v2 支持旧数据库自动迁移（补字段 / 删废弃字段）

## 常见问题

**Q：修改了代码，页面没变化？**

A：需要在 `chrome://extensions` 点击扩展的刷新按钮重新加载，再刷新页面。

**Q：标签 / 备注不显示？**

A：确认页面已登录知乎；部分页面结构变化可能导致选择器失效，可检查 `selectors.js`。

**Q：换了目录后数据没了？**

A：已解压扩展的 ID 由目录路径决定，移动目录会改变 ID，导致旧数据找不到。保持目录路径不变即可。

**Q：v2 后端 22 端口 / 网络问题？**

A：这与扩展无关；后端走 HTTP `127.0.0.1:8000`。如需多设备访问，把 `HOST` 改为 `0.0.0.0` 并用局域网 IP。

**Q：能识别是谁添加的备注吗？**

A：v2 会记录设备标识（`clientId`）和当前登录知乎用户 ID（`zhihu_user_id`）。未登录时拿不到知乎用户 ID；它也不等于严格的真人身份认证。

## 免责声明

本项目为非官方开源工具，与相关网站官方无关。使用者应自行遵守目标网站的服务条款及当地法律法规；作者不对使用本项目产生的任何后果负责。
