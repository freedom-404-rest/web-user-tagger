# 网页用户备注助手（Chrome 扩展）

> 非官方开源工具，与知乎及任何网站官方无关。仅用于用户个人浏览时本地标注，不提供抓取、上传或商业化服务。

在网页中为**用户**添加自定义标签，插件会在浏览页面时自动把标签渲染到对应用户昵称旁边（适用于知乎等网站）。

## 功能

- 自动识别页面上的知乎用户
- **标签库**：预定义标签下拉搜索、多选、回车新增（新增自动加入标签库）
- **标签反显**：点击当前页用户或输入已知用户后，自动回显其已保存标签
- 给用户添加一个或多个标签，可自定义标签颜色
- 标签自动渲染在昵称后，页面滚动加载的新内容也会自动出现标签
- 支持三种方式定位用户：粘贴主页链接 / urlToken / 当前页昵称
- 数据保存在浏览器本地（`chrome.storage.local`），不上传任何服务

## 用户识别机制（v2）

知乎有三类用户标识：

| 标识 | 说明 | 稳定性 |
|---|---|---|
| 昵称（name） | 可随时修改、可重名 | ❌ |
| 主页别名（url_token，如 `young-dong`） | 用户可在设置中自定义修改 | ❌ |
| 真实用户 ID（uid，32 位十六进制） | 知乎内部唯一标识，改昵称/改主页地址都不变 | ✅ |

因此存储主键**优先使用真实 uid**：

1. 从页面内嵌初始数据（`#js-initialData` 的实体，如 `answers.author.id`）提取 `url_token -> uid`；
2. 从回答卡片的埋点 `data-za-extra-module` 中读取 `author_member_hash_id`（已与 `answers.author.id` 核对一致，就是真实 uid），并关联卡片内的作者链接；
3. 保存标签时尽量写入 uid，同时维护 `urlToken -> uid` 索引；
4. 拿不到 uid 的页面，暂时以 `urlToken` 作为占位键，后续在能解析到 uid 时自动迁移到 uid 主键。

> 限制（纯 DOM 方案的边界）：
> - 知乎首页推荐流的 SSR 数据只缓存当前登录用户，但插件已通过回答卡片的埋点 `author_member_hash_id`（等于真实 uid）关联卡片内的作者链接，因此**首页的回答作者也能拿到 uid**；
> - 纯 Feed 卡片（文章 / 视频等）若埋点不含作者信息，只能拿到 `urlToken`；
> - 评论区用户若埋点不含作者信息，可能只能拿到 `urlToken`。

## 目录结构

```
zhihu-tagger/
├── manifest.json        # MV3 扩展清单
├── storage.js           # 存储模块（content / popup 共用，v1 数据自动迁移到 v2）
├── selectors.js         # 知乎 DOM 选择器配置（知乎改版时优先修改这里）
├── content.js           # 内容脚本：识别用户、解析 uid、渲染标签
├── popup.html           # 弹窗界面（添加标签）
├── popup.js             # 弹窗逻辑
├── scripts/
│   ├── gen-icons.ps1    # 图标生成脚本
│   └── detect-uid.js    # 真实 uid 探测脚本（开发者工具 Console 运行）
└── icons/               # 扩展图标
```

## 安装（加载到 Chrome）

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 打开右上角「开发者模式」开关
3. 点击「加载已解压的扩展程序」，选择本目录 `zhihu-tagger`
4. 打开任意知乎页面，开始使用

> 升级代码后，需要在 `chrome://extensions` 点击扩展卡片上的刷新按钮重新加载。

## 使用

1. 点击浏览器工具栏的插件图标，打开弹窗
2. 在弹窗中输入用户标识（主页链接 / urlToken / 昵称）+ 标签（逗号分隔）
3. 点击「保存标签」，页面上该用户昵称旁立即出现标签徽标
4. 弹窗下方「当前页面用户」列表：带 `✓` 表示已解析到真实 uid；点击可快速填入主页链接
5. 输入昵称且当前页面匹配到多个同名用户时，会列出供选择

## 验证 uid 提取是否可用

1. 打开任意知乎页面（回答页 / 用户主页 / 关注列表）
2. F12 → Console，粘贴 `scripts/detect-uid.js` 全部内容并回车
3. 查看输出的 JSON：
   - `jsInitialData.userCount`：内嵌数据中的用户数量
   - `extraModules.sample`：埋点属性中解析出的作者（含 `id` / `url_token`）
   - `peopleLinks`：页面上的用户链接
4. 若两项都拿不到 uid，说明当前页面结构已变化，需要调整 `content.js` 的提取逻辑

## 技术要点

- **用户标识**：真实 uid 优先，url_token 兜底，昵称仅用于展示
- **渲染**：内容脚本扫描 `a[href*="/people/"]`，用 `MutationObserver` 监听 SPA 动态内容，防抖 + `WeakSet` 去重
- **存储**：`chrome.storage.local`
  ```js
  // 键 zhTaggerTags：用户标签
  {
    version: 2,
    users: { [uid]: { uid, urlToken, name, tags, color } },
    tokenIndex: { [urlToken]: uid }
  }

  // 键 zhTaggerLabels：标签库（string[]）
  ["大佬", "干货", "广告"]
  ```
- **零接口**：不调用知乎任何接口，纯前端 DOM 操作，无风控风险

## 已知限制 / 后续计划

- M1（当前）：识别 + 渲染 + 弹窗添加
- M2（计划）：右键菜单「给该用户加标签」、options 批量管理、标签排序
- M3（计划）：标签导入导出（JSON 备份）
- 知乎改版可能导致选择器或 uid 提取失效，届时修改 `selectors.js` / `content.js`
