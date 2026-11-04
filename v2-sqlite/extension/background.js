/**
 * 知乎用户标签 v2 —— 后台脚本
 *
 * 职责：
 *   1. 定时从 Python + SQLite 后端拉取全量数据
 *   2. 转成内容脚本使用的本地缓存结构，写入 chrome.storage.local
 *   3. 提供手动同步消息（popup 保存后触发）
 */

const DEFAULT_API = 'http://127.0.0.1:8000';
const API_KEY = 'zhTaggerApiBase';
const STORAGE_KEY = 'zhTaggerTags';
const LABEL_KEY = 'zhTaggerLabels';
const ALARM_NAME = 'zhihu-tagger-v2-sync';
const MENU_ID = 'web-user-tagger-add-tag';

/** 创建右键菜单（在知乎页面的链接上显示） */
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '给该用户打标签',
      contexts: ['link'],
      documentUrlPatterns: [
        'https://*.zhihu.com/*',
        'http://*.zhihu.com/*',
      ],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
  syncNow().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenus();
  syncNow().catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || !tab.id) return;
  const url = info.linkUrl || '';
  if (url.indexOf('/people/') === -1) return;
  chrome.tabs.sendMessage(tab.id, {
    type: 'OPEN_TAG_PANEL',
    url,
  });
});

async function getApiBase() {
  const res = await chrome.storage.local.get(API_KEY);
  return String(res[API_KEY] || DEFAULT_API).replace(/\/+$/, '');
}

/** 把后端 snapshot 转成内容脚本使用的 v2 本地结构 */
function toLocalStore(snapshot) {
  const store = { version: 2, users: {}, tokenIndex: {} };

  (snapshot.users || []).forEach((u) => {
    const key = u.uid || (u.urlToken ? 't:' + u.urlToken : '');
    if (!key) return;
    store.users[key] = {
      uid: u.uid || '',
      urlToken: u.urlToken || '',
      name: u.name || '',
      tags: Array.isArray(u.tags) ? u.tags : [],
      color: u.color || '',
    };
    if (u.urlToken) store.tokenIndex[u.urlToken] = key;
  });

  const labels = (snapshot.labels || [])
    .map((l) => l.name)
    .filter((n) => typeof n === 'string' && n.trim());

  return { store, labels };
}

async function syncNow() {
  const base = await getApiBase();
  const resp = await fetch(base + '/api/snapshot', { cache: 'no-store' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  const { store, labels } = toLocalStore(data);

  await chrome.storage.local.set({
    [STORAGE_KEY]: store,
    [LABEL_KEY]: labels,
  });

  return {
    users: Object.keys(store.users).length,
    labels: labels.length,
    apiBase: base,
  };
}

/** 设备标识：用于统计"来源设备"（不能识别真人，仅区分浏览器/设备） */
async function getClientId() {
  const CLIENT_KEY = 'zhTaggerClientId';
  const res = await chrome.storage.local.get(CLIENT_KEY);
  if (res[CLIENT_KEY]) return res[CLIENT_KEY];

  const id = 'client-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await chrome.storage.local.set({ [CLIENT_KEY]: id });
  return id;
}

/** 保存用户备注到后端（供页面右键面板调用） */
async function saveUserToApi(user) {
  const base = await getApiBase();
  const clientId = await getClientId();
  const zhihuRes = await chrome.storage.local.get('zhTaggerZhihuUser');
  const zhihuUser = zhihuRes.zhTaggerZhihuUser || {};
  const resp = await fetch(base + '/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uid: user.uid || '',
      urlToken: user.token || '',
      name: user.name || '',
      tags: user.tags || [],
      clientId,
      zhihuUserId: zhihuUser.id || '',
    }),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.json();
}

// 定时同步（幂等创建）
chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });

chrome.runtime.onInstalled.addListener(() => {
  syncNow().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  syncNow().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) syncNow().catch(() => {});
});

// service worker 启动时也同步一次
syncNow().catch(() => {});
setupContextMenus();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'SYNC_NOW') {
    syncNow()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'SAVE_USER') {
    saveUserToApi(msg.user)
      .then(() => syncNow())
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'GET_API_BASE') {
    getApiBase().then((base) => sendResponse({ base }));
    return true;
  }

  return true;
});
