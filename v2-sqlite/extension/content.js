/**
 * 知乎用户标签 —— 内容脚本（注入所有 zhihu.com 页面）
 *
 * 职责：
 *   1. 扫描页面中的知乎用户昵称链接（a[href*="/people/"]）
 *   2. 解析用户真实 ID（uid）——优先从页面内嵌数据 / 埋点属性中获取
 *   3. 为已添加标签的用户，在昵称后渲染标签徽标
 *   4. 监听 DOM 变化（知乎为 SPA）与存储变化，自动渲染
 *
 * 用户标识说明：
 *   - 昵称可修改、可重复，不可靠；
 *   - url_token（如 young-dong）是知乎允许用户自定义修改的主页别名，也不稳定；
 *   - 知乎真实用户 ID（uid，32 位十六进制）稳定唯一，故优先作为标识；
 *     拿不到 uid 时退回 url_token 占位，后续拿到 uid 自动迁移。
 */

(() => {
  'use strict';

  const storeApi = window.ZH_TAG_STORE;
  if (!storeApi) return;

  const STORAGE_KEY = storeApi.STORAGE_KEY;

  const SELECTORS =
    (window.ZH_SELECTORS && window.ZH_SELECTORS.peopleLink) ||
    'a[href*="/people/"]';

  // 用户主页昵称元素候选（按优先级依次查询，避免误命中父级 H1）
  const PROFILE_NAME_SELECTORS =
    ((window.ZH_SELECTORS && window.ZH_SELECTORS.profileName) ||
      '.ProfileHeader-name, [class*="ProfileHeader-name"], .ProfileHeader h1, [class*="ProfileHeader"] h1')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  // 已处理过的昵称链接元素
  const PROCESSED = new WeakSet();
  // urlToken -> 昵称链接元素集合（标签更新时整体重渲染）
  const NODES_BY_TOKEN = new Map();
  // 链接元素 -> 已解析到的 uid（只缓存非空值）
  const UID_CACHE = new WeakMap();
  // 埋点元素 -> 解析出的作者列表
  const MODULE_CACHE = new WeakMap();

  // 页面内 urlToken -> { uid, name } 映射（来自 js-initialData）
  const PAGE_USER_MAP = new Map();
  let initialDataFingerprint = '';

  // 当前标签数据（v2 结构）
  let store = storeApi.emptyStore();

  // 自动配色
  const PALETTE = [
    { bg: '#e8f0fe', fg: '#1a56db', border: '#c7d7fb' },
    { bg: '#fef3c7', fg: '#a16207', border: '#fde68a' },
    { bg: '#dcfce7', fg: '#15803d', border: '#bbf7d0' },
    { bg: '#fce7f3', fg: '#be185d', border: '#fbcfe8' },
    { bg: '#ede9fe', fg: '#6d28d9', border: '#ddd6fe' },
    { bg: '#cffafe', fg: '#0e7490', border: '#a5f3fc' },
  ];

  function hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) % 9973;
    }
    return h;
  }

  /** 从链接 href 中提取 urlToken（排除 /people/{token}/answers 等子页面） */
  function extractToken(href) {
    const m = String(href || '').match(/(?:^|\/)people\/([^?#/]+)\/?(?:[?#].*)?$/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** 昵称链接：有可见文本，且不是纯数字（排除统计数字链接） */
  // 用户主页顶部的 tab 名称（这些链接的 href 可能与主页链接相同，不能当作昵称链接）
  const TAB_TEXTS = new Set([
    '动态', '回答', '视频', '提问', '文章', '专栏', '想法', '收藏',
    '关注', '粉丝', '主页', '个人主页', '盐选', '直播', '书籍', '课程',
    '圈子', '推荐', '最新', '热门',
  ]);

  function isNameLink(a) {
    const text = (a.textContent || '').trim();
    if (!text) return false;
    if (/^\d+$/.test(text)) return false;
    if (TAB_TEXTS.has(text)) return false;
    if (a.getAttribute('role') === 'tab') return false;
    if (a.closest('[role="tablist"], .Tabs, .ProfileMain-nav')) return false;
    return true;
  }

  // ------------------------------------------------------------------
  // 真实 uid 提取
  // ------------------------------------------------------------------

  function safeParse(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      /* ignore */
    }
    try {
      return JSON.parse(decodeURIComponent(raw));
    } catch (e) {
      return null;
    }
  }

  function collectAuthors(data, out) {
    if (!data || typeof data !== 'object') return out;
    if (data.url_token && (data.id || data.uid)) {
      out.push({ id: data.id || data.uid, urlToken: data.url_token });
    }
    Object.keys(data).forEach((k) => {
      const v = data[k];
      if (v && typeof v === 'object') collectAuthors(v, out);
    });
    return out;
  }

  /** 递归收集页面数据中的用户映射（覆盖 users / answers / feeds / comments 等实体） */
  function collectUserMappings(root) {
    const seen = new Set();
    const stack = [root];
    let visited = 0;

    while (stack.length && visited < 50000) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      visited++;

      const token = node.url_token || node.urlToken;
      const id = node.id || (node.uid !== undefined && node.uid !== null ? String(node.uid) : '');
      if (token && typeof token === 'string' && id) {
        PAGE_USER_MAP.set(token, { uid: String(id), name: node.name || '' });
      }

      Object.keys(node).forEach((k) => {
        const v = node[k];
        if (v && typeof v === 'object') stack.push(v);
      });
    }
    return visited;
  }

  /** 解析页面内嵌初始数据（当前页面涉及的用户 -> uid 映射） */
  function refreshInitialData() {
    const el = document.getElementById('js-initialData');
    if (!el) return false;

    const text = el.textContent || '';
    const fp = text.length + ':' + text.slice(0, 160);
    if (fp === initialDataFingerprint) return false;
    initialDataFingerprint = fp;

    try {
      const data = JSON.parse(text);
      collectUserMappings(data.initialState || data);
      detectCurrentZhihuUser(data);
      return true;
    } catch (e) {
      return false;
    }
  }

  let lastZhihuUserJson = '';

  /** 解析当前登录的知乎用户，写入 storage 供统计「来源」使用 */
  function detectCurrentZhihuUser(data) {
    try {
      const users = ((data.initialState || {}).entities || {}).users || {};
      const list = Object.keys(users).map((k) => Object.assign({ key: k }, users[k]));
      // 当前登录用户通常只有 id/uid/userType，没有 url_token；匿名访问时为空
      const me = list.find((u) => u.userType === 'people' && !u.url_token) || list[0];
      if (!me || !me.id) return;

      const payload = {
        id: me.id,
        uid: me.uid != null ? String(me.uid) : '',
      };
      const json = JSON.stringify(payload);
      if (json === lastZhihuUserJson) return;
      lastZhihuUserJson = json;
      chrome.storage.local.set({ zhTaggerZhihuUser: payload });
    } catch (e) {
      /* ignore */
    }
  }

  function getModuleAuthors(el) {
    if (MODULE_CACHE.has(el)) return MODULE_CACHE.get(el);
    const authors = collectAuthors(safeParse(el.getAttribute('data-za-extra-module')), []);
    MODULE_CACHE.set(el, authors);
    return authors;
  }

  /** 为某个昵称链接解析真实 uid（向上查找埋点属性，再查页面映射） */
  function findUidForLink(a, token) {
    if (UID_CACHE.has(a)) return UID_CACHE.get(a);

    let uid = '';
    let node = a;
    let depth = 0;
    while (node && depth < 10) {
      if (node.getAttribute && node.getAttribute('data-za-extra-module')) {
        const authors = getModuleAuthors(node);
        const hit = authors.find((au) => au.urlToken === token);
        if (hit && hit.id) {
          uid = hit.id;
          break;
        }
      }
      node = node.parentElement;
      depth++;
    }

    if (!uid) {
      const mapped = PAGE_USER_MAP.get(token);
      if (mapped) uid = mapped.uid;
    }

    // 只缓存非空结果，避免页面数据后到时被空值锁死
    if (uid) UID_CACHE.set(a, uid);
    return uid;
  }

  // ------------------------------------------------------------------
  // 回答卡片埋点 -> 作者 uid 关联
  // ------------------------------------------------------------------

  function collectAuthorHashes(data, out) {
    if (!data || typeof data !== 'object') return out;
    if (typeof data.author_member_hash_id === 'string' && data.author_member_hash_id) {
      out.push(data.author_member_hash_id);
    }
    Object.keys(data).forEach((k) => {
      const v = data[k];
      if (v && typeof v === 'object') collectAuthorHashes(v, out);
    });
    return out;
  }

  /**
   * 通过回答卡片的埋点关联作者：
   *   - data-za-extra-module 中的 author_member_hash_id 就是作者真实 uid
   *     （已与 answers.author.id 核对一致）；
   *   - 该埋点元素的子树内，首个用户链接给出作者 url_token；
   *   - 两者关联即可建立 url_token -> uid 映射。
   *
   * 这样即使页面 SSR 数据不包含其他用户（首页推荐流、问题页），也能拿到 uid。
   */
  function buildModuleMappings() {
    let changed = false;

    document.querySelectorAll('[data-za-extra-module]').forEach((el) => {
      const data = safeParse(el.getAttribute('data-za-extra-module'));
      if (!data) return;

      const hashes = collectAuthorHashes(data, []);
      if (!hashes.length) return;

      const candidates = el.querySelectorAll('a[href*="/people/"]');
      let link = null;
      for (let i = 0; i < candidates.length; i++) {
        if ((candidates[i].textContent || '').trim()) {
          link = candidates[i];
          break;
        }
      }
      if (!link) link = candidates[0];
      if (!link) return;

      const token = extractToken(link.getAttribute('href'));
      if (!token || PAGE_USER_MAP.has(token)) return;

      PAGE_USER_MAP.set(token, { uid: hashes[0], name: (link.textContent || '').trim() });
      changed = true;
    });

    return changed;
  }

  // ------------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById('zh-tagger-style')) return;
    const style = document.createElement('style');
    style.id = 'zh-tagger-style';
    style.textContent = `
      .zh-tagger-badge {
        display: inline-flex;
        align-items: center;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: middle;
        margin-left: 6px;
        padding: 1px 6px;
        border-radius: 10px;
        font-size: 12px !important;
        line-height: 18px !important;
        font-weight: 500;
        border: 1px solid;
        cursor: default;
        user-select: none;
      }
      .zh-tagger-badge span { margin-right: 4px; }
      .zh-tagger-badge span:last-child { margin-right: 0; }
    `;
    document.head.appendChild(style);
  }

  function removeBadge(a) {
    let node = a.nextElementSibling;
    for (let i = 0; i < 3 && node; i++) {
      if (node.classList && node.classList.contains('zh-tagger-badge')) {
        node.remove();
        return;
      }
      node = node.nextElementSibling;
    }
  }

  /** 构建标签徽标元素（不插入 DOM） */
  function createBadge(user) {
    const seed = user.uid || user.urlToken || '';
    const palette = PALETTE[hashString(seed) % PALETTE.length];
    let bg = palette.bg;
    let fg = palette.fg;
    let border = palette.border;
    if (user.color && /^#[0-9a-f]{6}$/i.test(user.color)) {
      bg = user.color;
      fg = '#ffffff';
      border = user.color;
    }

    const badge = document.createElement('span');
    badge.className = 'zh-tagger-badge';
    badge.dataset.token = user.urlToken || '';
    badge.dataset.uid = user.uid || '';
    badge.title = '标签：' + user.tags.join('、') + (user.uid ? '\nuid：' + user.uid : '');
    user.tags.forEach((t) => {
      const s = document.createElement('span');
      s.textContent = t;
      badge.appendChild(s);
    });
    badge.style.cssText = `background:${bg};color:${fg};border-color:${border};`;
    badge.style.cursor = 'pointer';
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTagPanel({ token: user.urlToken, uid: user.uid, name: user.name });
    });
    return badge;
  }

  /** 在昵称旁注入「标签」按钮（固定排在标签徽标之后） */
  function findSibling(a, className) {
    let node = a.nextElementSibling;
    for (let i = 0; i < 3 && node; i++) {
      if (node.classList && node.classList.contains(className)) return node;
      node = node.nextElementSibling;
    }
    return null;
  }

  /** 找到昵称所在行的最后一个行内元素（跳过会员徽章等，遇到块级元素停止） */
  function findLineEnd(a) {
    let last = a;
    let cur = a.nextElementSibling;
    let count = 0;

    while (cur && count < 10) {
      if (cur.nodeType !== 1) break;
      if (cur.classList && cur.classList.contains('zh-tagger-trigger')) break;
      if (cur.classList && cur.classList.contains('zh-tagger-badge')) {
        last = cur;
        cur = cur.nextElementSibling;
        count++;
        continue;
      }

      const display = window.getComputedStyle(cur).display;
      if (
        display === 'block' ||
        display === 'flex' ||
        display === 'grid' ||
        display === 'list-item'
      ) {
        break;
      }

      last = cur;
      cur = cur.nextElementSibling;
      count++;
    }
    return last;
  }

  function ensureTrigger(a, token) {
    const trigger = findSibling(a, 'zh-tagger-trigger');
    const anchor = findLineEnd(a);

    // 已正确排在行末则跳过，避免重复重建
    if (trigger && trigger.previousElementSibling === anchor) return;
    if (trigger) trigger.remove();

    const btn = document.createElement('span');
    btn.className = 'zh-tagger-trigger';
    btn.textContent = '备注';
    btn.title = '为此用户添加备注';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTagPanel({
        token,
        uid: findUidForLink(a, token),
        name: (a.textContent || '').trim(),
      });
    });

    anchor.insertAdjacentElement('afterend', btn);
  }

  function renderBadge(a, user) {
    removeBadge(a);
    if (!user || !user.tags || user.tags.length === 0) return;
    a.insertAdjacentElement('afterend', createBadge(user));
  }

  /** 当前是否用户主页，返回其 urlToken */
  function getProfileToken() {
    const m = location.pathname.match(/^\/people\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function getProfileNameEl() {
    for (const sel of PROFILE_NAME_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /** 为 urlToken 解析 uid（优先页面映射，其次链接埋点） */
  function findUidForToken(token) {
    const mapped = PAGE_USER_MAP.get(token);
    if (mapped && mapped.uid) return mapped.uid;

    const nodes = NODES_BY_TOKEN.get(token);
    if (nodes) {
      for (const a of nodes) {
        if (a.isConnected) {
          const uid = findUidForLink(a, token);
          if (uid) return uid;
        }
      }
    }
    return '';
  }

  /** 在用户主页昵称后渲染标签徽标 */
  function renderProfileBadge() {
    const token = getProfileToken();
    if (!token) {
      removeProfileBadge();
      return;
    }

    const nameEl = getProfileNameEl();
    if (!nameEl) {
      removeProfileBadge();
      return;
    }

    const uid = findUidForToken(token);
    const user = storeApi.getUser(store, { uid, token });
    const existing = document.getElementById('zh-tagger-profile-badge');

    if (!user || !user.tags || user.tags.length === 0) {
      if (existing) existing.remove();
      return;
    }

    const signature = user.tags.join('|');
    // 内容未变且已挂在昵称元素上时跳过，避免重复插入
    if (existing && existing.dataset.signature === signature && existing.parentElement === nameEl) return;
    if (existing) existing.remove();

    const badge = createBadge(user);
    badge.id = 'zh-tagger-profile-badge';
    badge.dataset.signature = signature;
    badge.style.marginLeft = '8px';
    // 放进昵称元素内部末尾，避免被父级 flex 布局推到右侧
    nameEl.appendChild(badge);
  }

  function removeProfileBadge() {
    const el = document.getElementById('zh-tagger-profile-badge');
    if (el) el.remove();
  }

  /** 为链接查找匹配的用户记录 */
  function matchUser(a, token) {
    const uid = findUidForLink(a, token);
    if (uid) autoMigrate(token, uid);
    return storeApi.getUser(store, { uid, token });
  }

  // 已自动迁移过的 token，避免重复写入
  const MIGRATED = new Set();

  /**
   * 旧的 urlToken 占位记录，在解析到真实 uid 后自动迁移到 uid 主键。
   * 这样即使用户之后修改了主页地址（url_token），标签仍能通过 uid 命中。
   */
  function autoMigrate(token, uid) {
    if (!uid) return;
    if (store.users[uid]) return; // 已有 uid 记录，无需迁移
    const key = store.tokenIndex[token];
    if (!key || key.indexOf('t:') !== 0) return; // 不是占位记录
    if (MIGRATED.has(token)) return;

    const existing = store.users[key];
    if (!existing) return;

    MIGRATED.add(token);
    store = storeApi.upsert(store, {
      uid,
      token,
      name: existing.name,
      tags: existing.tags,
      color: existing.color,
    });
    chrome.storage.local.set({ [STORAGE_KEY]: store });
  }

  /** 扫描页面，识别新的昵称链接 */
  function scan() {
    const links = document.querySelectorAll(SELECTORS);
    links.forEach((a) => {
      if (PROCESSED.has(a)) return;
      const token = extractToken(a.getAttribute('href'));
      if (!token || !isNameLink(a)) return;
      PROCESSED.add(a);
      if (!NODES_BY_TOKEN.has(token)) NODES_BY_TOKEN.set(token, new Set());
      NODES_BY_TOKEN.get(token).add(a);

      const user = matchUser(a, token);
      if (user) renderBadge(a, user);
      ensureTrigger(a, token);
    });
  }

  /** 标签数据变化后整体重渲染 */
  function reRender() {
    NODES_BY_TOKEN.forEach((nodes, token) => {
      nodes.forEach((a) => {
        if (!a.isConnected) {
          nodes.delete(a);
          return;
        }
        const user = matchUser(a, token);
        if (user) renderBadge(a, user);
        else removeBadge(a);
      });
      if (nodes.size === 0) NODES_BY_TOKEN.delete(token);
    });
    renderProfileBadge();
  }

  /** 防抖的 DOM 扫描 */
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const initialChanged = refreshInitialData();
      const moduleChanged = buildModuleMappings();
      scan();
      if (initialChanged || moduleChanged) reRender();
      renderProfileBadge();
    }, 300);
  }

  const observer = new MutationObserver(scheduleScan);

  // ------------------------------------------------------------------
  // 存储
  // ------------------------------------------------------------------

  function loadStore() {
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      store = storeApi.normalize(res[STORAGE_KEY]);
      injectStyle();
      injectPanelStyle();
      refreshInitialData();
      buildModuleMappings();
      reRender();
      scan();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      store = storeApi.normalize(changes[STORAGE_KEY].newValue);
      reRender();
    }
  });

  // ------------------------------------------------------------------
  // 响应弹窗消息
  // ------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === 'OPEN_TAG_PANEL') {
      const token = extractToken(msg.url || '');
      if (token) {
        openTagPanel({
          token,
          uid: findUidForToken(token),
          name: '',
        });
      }
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'GET_USERS') {
      const users = [];
      NODES_BY_TOKEN.forEach((nodes, token) => {
        let el = null;
        nodes.forEach((a) => {
          if (!el && a.isConnected) el = a;
        });
        if (!el) return;
        const uid = findUidForLink(el, token);
        const user = storeApi.getUser(store, { uid, token });
        users.push({
          token,
          uid,
          name: (el.textContent || '').trim() || (user && user.name) || '',
          tagged: !!(user && user.tags && user.tags.length),
        });
      });
      sendResponse({ users });
      return true;
    }

    if (msg.type === 'FIND_USER_BY_NAME') {
      const seen = new Set();
      const users = [];
      NODES_BY_TOKEN.forEach((nodes, token) => {
        nodes.forEach((a) => {
          if ((a.textContent || '').trim() === msg.name && !seen.has(token)) {
            seen.add(token);
            users.push({ token, uid: findUidForLink(a, token), name: msg.name });
          }
        });
      });
      sendResponse({ users });
      return true;
    }

    if (msg.type === 'RESOLVE_TOKEN') {
      let uid = '';
      let name = '';
      const nodes = NODES_BY_TOKEN.get(msg.token);
      if (nodes) {
        nodes.forEach((a) => {
          if (!uid) uid = findUidForLink(a, msg.token);
          if (!name && a.isConnected) name = (a.textContent || '').trim();
        });
      }
      const mapped = PAGE_USER_MAP.get(msg.token);
      if (!uid && mapped) uid = mapped.uid;
      if (!name && mapped) name = mapped.name;
      sendResponse({ uid, name });
      return true;
    }

    return true;
  });

  // ------------------------------------------------------------------
  // 右键昵称 -> 标签编辑浮层
  // ------------------------------------------------------------------

  const PANEL_LABEL_KEY = 'zhTaggerLabels';
  const MAX_PANEL_ITEMS = 50;

  let panelEl = null;
  let panelState = null;
  let contextMenuEl = null;

  function injectPanelStyle() {
    if (document.getElementById('zh-tagger-ui-style')) return;
    const style = document.createElement('style');
    style.id = 'zh-tagger-ui-style';
    style.textContent = `
      .zh-tagger-menu {
        position: fixed; z-index: 2147483647;
        background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18); padding: 4px; min-width: 180px;
        font-size: 13px; color: #1e293b;
      }
      .zh-tagger-menu-item {
        padding: 7px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
      }
      .zh-tagger-menu-item:hover { background: #f1f5f9; }

      .zh-tagger-mask {
        position: fixed; inset: 0; z-index: 2147483646;
        background: rgba(15, 23, 42, 0.28);
      }
      .zh-tagger-panel {
        position: fixed; z-index: 2147483647;
        top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 360px; max-width: calc(100vw - 32px);
        background: #fff; border-radius: 10px;
        box-shadow: 0 16px 40px rgba(15, 23, 42, 0.25);
        font-size: 13px; color: #1e293b;
        display: flex; flex-direction: column; max-height: 70vh;
      }
      .zh-tagger-panel-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 14px; border-bottom: 1px solid #e2e8f0; font-weight: 600;
      }
      .zh-tagger-panel-close {
        cursor: pointer; font-size: 18px; line-height: 1; color: #64748b;
        background: none; border: none; padding: 0;
      }
      .zh-tagger-panel-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 10px 14px 0; }
      .zh-tagger-panel-chip {
        display: inline-flex; align-items: center; gap: 4px;
        background: #e8f0fe; color: #1a56db; border: 1px solid #c7d7fb;
        border-radius: 10px; padding: 2px 8px; font-size: 12px;
      }
      .zh-tagger-panel-chip .x { cursor: pointer; font-weight: 700; }
      .zh-tagger-panel-search {
        margin: 10px 14px; padding: 7px 8px; border: 1px solid #e2e8f0;
        border-radius: 6px; font-size: 13px; outline: none;
      }
      .zh-tagger-panel-list { overflow-y: auto; padding: 0 8px; flex: 1; min-height: 40px; }
      .zh-tagger-panel-item {
        display: flex; align-items: center; justify-content: space-between;
        padding: 7px 8px; border-radius: 6px; cursor: pointer;
      }
      .zh-tagger-panel-item:hover { background: #f1f5f9; }
      .zh-tagger-panel-item.selected { color: #2563eb; font-weight: 600; }
      .zh-tagger-panel-item.create { color: #15803d; }
      .zh-tagger-panel-item.more { color: #94a3b8; cursor: default; }
      .zh-tagger-panel-empty { padding: 12px 8px; color: #64748b; font-size: 12px; }
      .zh-tagger-panel-actions {
        display: flex; gap: 8px; padding: 12px 14px; border-top: 1px solid #e2e8f0;
      }
      .zh-tagger-panel-actions button {
        flex: 1; padding: 8px; border-radius: 6px; cursor: pointer; font-size: 13px;
        border: 1px solid #e2e8f0; background: #fff; color: #1e293b;
      }
      .zh-tagger-panel-actions .save { background: #2563eb; border-color: #2563eb; color: #fff; }

      .zh-tagger-trigger {
        display: inline-flex; align-items: center; justify-content: center;
        height: 18px; padding: 0 6px; margin-left: 6px;
        border-radius: 4px; background: #fff; color: #4f46e5;
        border: 1px solid #c7d2fe;
        font-size: 11px; line-height: 1; cursor: pointer; vertical-align: middle;
        opacity: 0.9; transition: opacity 0.15s, background 0.15s, color 0.15s;
        user-select: none;
      }
      .zh-tagger-trigger:hover { opacity: 1; background: #4f46e5; color: #fff; border-color: #4f46e5; }
    `;
    document.head.appendChild(style);
  }

  function removeContextMenu() {
    if (contextMenuEl) {
      contextMenuEl.remove();
      contextMenuEl = null;
    }
  }

  // 右键用户链接：弹出「给 TA 打标签」（在 window 捕获阶段尝试抢在知乎之前）
  window.addEventListener(
    'contextmenu',
    (e) => {
      const target = e.target;
      if (!target || !target.closest) return;
      const a = target.closest('a[href*="/people/"]');
      if (!a) return;

      const token = extractToken(a.getAttribute('href'));
      if (!token) return;

      const text = (a.textContent || '').trim();
      // 排除 tab 类链接
      if (
        (text && TAB_TEXTS.has(text)) ||
        a.getAttribute('role') === 'tab' ||
        a.closest('[role="tablist"], .Tabs, .ProfileMain-nav')
      ) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      removeContextMenu();

      const user = {
        token,
        uid: findUidForLink(a, token) || '',
        name: text || '',
      };

      const menu = document.createElement('div');
      menu.className = 'zh-tagger-menu';
      menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + 'px';
      menu.style.top = Math.min(e.clientY, window.innerHeight - 60) + 'px';

      const item = document.createElement('div');
      item.className = 'zh-tagger-menu-item';
      item.textContent = '给「' + (user.name || user.token) + '」添加备注';
      item.addEventListener('click', () => {
        removeContextMenu();
        openTagPanel(user);
      });
      menu.appendChild(item);

      document.body.appendChild(menu);
      contextMenuEl = menu;
    },
    true
  );

  document.addEventListener('mousedown', (e) => {
    if (contextMenuEl && !contextMenuEl.contains(e.target)) removeContextMenu();
  });

  function openTagPanel(user) {
    injectPanelStyle();
    closeTagPanel();

    chrome.storage.local.get([STORAGE_KEY, PANEL_LABEL_KEY], (res) => {
      const localStore = storeApi.normalize(res[STORAGE_KEY]);
      const record = storeApi.getUser(localStore, { uid: user.uid, token: user.token });
      const library = Array.isArray(res[PANEL_LABEL_KEY]) ? res[PANEL_LABEL_KEY].slice() : [];

      panelState = {
        user: {
          token: user.token,
          uid: user.uid || (record && record.uid) || '',
          name: user.name || (record && record.name) || '',
          color: (record && record.color) || '',
        },
        library,
        selected: record && Array.isArray(record.tags) ? record.tags.slice() : [],
        keyword: '',
      };
      renderTagPanel();
    });
  }

  function closeTagPanelDom() {
    if (panelEl) {
      if (panelEl.mask) panelEl.mask.remove();
      if (panelEl.panel) panelEl.panel.remove();
      panelEl = null;
    }
  }

  function closeTagPanel() {
    closeTagPanelDom();
    panelState = null;
  }

  function renderTagPanel() {
    if (!panelState) return;
    closeTagPanelDom();

    const mask = document.createElement('div');
    mask.className = 'zh-tagger-mask';
    mask.addEventListener('click', closeTagPanel);

    const panel = document.createElement('div');
    panel.className = 'zh-tagger-panel';

    const header = document.createElement('div');
    header.className = 'zh-tagger-panel-header';
    const title = document.createElement('span');
    title.textContent = (panelState.user.name || panelState.user.token) + ' 的备注';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'zh-tagger-panel-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeTagPanel);
    header.appendChild(title);
    header.appendChild(closeBtn);

    const chips = document.createElement('div');
    chips.className = 'zh-tagger-panel-chips';

    const search = document.createElement('input');
    search.className = 'zh-tagger-panel-search';
    search.placeholder = '搜索或输入新备注，回车新增';
    search.value = panelState.keyword || '';

    const list = document.createElement('div');
    list.className = 'zh-tagger-panel-list';

    const actions = document.createElement('div');
    actions.className = 'zh-tagger-panel-actions';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeTagPanel);
    const save = document.createElement('button');
    save.className = 'save';
    save.textContent = '保存';
    save.addEventListener('click', saveTagPanel);
    actions.appendChild(cancel);
    actions.appendChild(save);

    panel.appendChild(header);
    panel.appendChild(chips);
    panel.appendChild(search);
    panel.appendChild(list);
    panel.appendChild(actions);

    document.body.appendChild(mask);
    document.body.appendChild(panel);
    panelEl = { mask, panel, chips, list, search };

    renderPanelChips();
    renderPanelList();

    search.addEventListener('input', () => {
      panelState.keyword = search.value;
      renderPanelList();
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const raw = search.value.trim();
        if (raw) {
          addPanelTag(raw);
          search.value = '';
          panelState.keyword = '';
          renderPanelList();
        }
      }
    });

    search.focus();
  }

  function renderPanelChips() {
    if (!panelEl) return;
    const { chips } = panelEl;
    chips.innerHTML = '';
    panelState.selected.forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'zh-tagger-panel-chip';

      const text = document.createElement('span');
      text.textContent = tag;

      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.addEventListener('click', () => {
        const i = panelState.selected.indexOf(tag);
        if (i >= 0) panelState.selected.splice(i, 1);
        renderPanelChips();
        renderPanelList();
      });

      chip.appendChild(text);
      chip.appendChild(x);
      chips.appendChild(chip);
    });
  }

  function renderPanelList() {
    if (!panelEl) return;
    const { list } = panelEl;
    const kw = (panelState.keyword || '').trim().toLowerCase();
    const matched = panelState.library.filter((t) => !kw || t.toLowerCase().includes(kw));
    const items = matched.slice(0, MAX_PANEL_ITEMS);
    list.innerHTML = '';

    items.forEach((tag) => {
      const row = document.createElement('div');
      const selected = panelState.selected.indexOf(tag) >= 0;
      row.className = 'zh-tagger-panel-item' + (selected ? ' selected' : '');

      const name = document.createElement('span');
      name.textContent = tag;
      row.appendChild(name);

      if (selected) {
        const check = document.createElement('span');
        check.textContent = '✓';
        row.appendChild(check);
      }

      row.addEventListener('click', () => {
        const i = panelState.selected.indexOf(tag);
        if (i >= 0) panelState.selected.splice(i, 1);
        else panelState.selected.push(tag);
        renderPanelChips();
        renderPanelList();
      });

      list.appendChild(row);
    });

    if (matched.length > MAX_PANEL_ITEMS) {
      const more = document.createElement('div');
      more.className = 'zh-tagger-panel-item more';
      more.textContent = `还有 ${matched.length - MAX_PANEL_ITEMS} 条，继续输入可缩小范围`;
      list.appendChild(more);
    }

    const raw = (panelState.keyword || '').trim();
    if (raw && panelState.library.indexOf(raw) === -1) {
      const create = document.createElement('div');
      create.className = 'zh-tagger-panel-item create';
      create.textContent = '＋ 新建备注「' + raw + '」';
      create.addEventListener('click', () => {
        addPanelTag(raw);
        if (panelEl) panelEl.search.value = '';
        panelState.keyword = '';
        renderPanelList();
      });
      list.appendChild(create);
    }

    if (!list.children.length) {
      const empty = document.createElement('div');
      empty.className = 'zh-tagger-panel-empty';
      empty.textContent = '暂无备注，输入后回车即可新增';
      list.appendChild(empty);
    }
  }

  function addPanelTag(tag) {
    const t = (tag || '').trim();
    if (!t) return;
    if (panelState.library.indexOf(t) === -1) panelState.library.push(t);
    if (panelState.selected.indexOf(t) === -1) panelState.selected.push(t);
    renderPanelChips();
  }

  function saveTagPanel() {
    if (!panelState) return;
    const { user, selected, library } = panelState;
    const payload = {
      uid: user.uid,
      token: user.token,
      name: user.name,
      tags: selected.slice(),
      color: user.color || '',
    };

    // v2：交给 background 调用 API；v1 没有 background 时回退到本地存储
    chrome.runtime.sendMessage({ type: 'SAVE_USER', user: payload }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        saveLocalUser(payload, library);
      } else {
        closeTagPanel();
      }
    });
  }

  function saveLocalUser(payload, library) {
    chrome.storage.local.get([STORAGE_KEY, PANEL_LABEL_KEY], (res) => {
      let localStore = storeApi.normalize(res[STORAGE_KEY]);
      localStore = storeApi.upsert(localStore, {
        uid: payload.uid,
        token: payload.token,
        name: payload.name,
        tags: payload.tags,
        color: payload.color,
      });

      const labels = Array.isArray(res[PANEL_LABEL_KEY]) ? res[PANEL_LABEL_KEY].slice() : [];
      (library || []).concat(payload.tags).forEach((t) => {
        if (t && labels.indexOf(t) === -1) labels.push(t);
      });

      chrome.storage.local.set({ [STORAGE_KEY]: localStore, [PANEL_LABEL_KEY]: labels }, () => {
        closeTagPanel();
      });
    });
  }

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------

  function init() {
    loadStore();
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  }
})();
