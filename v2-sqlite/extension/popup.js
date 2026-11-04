/**
 * 知乎用户标签 v2 —— 弹窗（调用 Python + SQLite 后端）
 *
 * 数据流：
 *   popup 直接请求后端 API（扩展页面有 host_permissions）
 *   保存后通知 background 同步缓存，内容脚本随之重渲染
 */

const API_KEY = 'zhTaggerApiBase';
const DEFAULT_API = 'http://127.0.0.1:8000';
const MAX_DROPDOWN_ITEMS = 50;

const userInput = document.getElementById('userInput');
const colorCheck = document.getElementById('colorCheck');
const colorInput = document.getElementById('colorInput');
const saveBtn = document.getElementById('saveBtn');
const msgEl = document.getElementById('msg');
const userListEl = document.getElementById('userList');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');
const apiText = document.getElementById('apiText');
const openOptions = document.getElementById('openOptions');

const selectedChips = document.getElementById('selectedChips');
const tagSearch = document.getElementById('tagSearch');
const tagDropdown = document.getElementById('tagDropdown');

let apiBase = DEFAULT_API;
let labelLibrary = [];
let selectedTags = [];
let currentUser = null;
let snapshot = { users: [], labels: [] };

// ------------------------------------------------------------------
// 通用
// ------------------------------------------------------------------

function showMsg(text, type) {
  msgEl.textContent = text;
  msgEl.className = type || '';
}

function getActiveTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    cb(tabs && tabs[0] ? tabs[0] : null);
  });
}

function sendToContent(tabId, message, cb) {
  if (!tabId) {
    cb(null);
    return;
  }
  chrome.tabs.sendMessage(tabId, message, (resp) => {
    if (chrome.runtime.lastError) {
      cb(null);
      return;
    }
    cb(resp);
  });
}

function extractTokenFromInput(raw) {
  if (raw.includes('zhihu.com/people/')) {
    const m = raw.match(/\/people\/([^?#/]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  if (/^[A-Za-z0-9_-]{2,}$/.test(raw) && !raw.includes('zhihu')) {
    return raw;
  }
  return null;
}

// ------------------------------------------------------------------
// 后端 API
// ------------------------------------------------------------------

async function loadApiBase() {
  const res = await chrome.storage.local.get(API_KEY);
  apiBase = String(res[API_KEY] || DEFAULT_API).replace(/\/+$/, '');
  apiText.textContent = '后端：' + apiBase;
}

async function apiFetch(path, options) {
  const resp = await fetch(apiBase + path, options);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.json();
}

async function refreshSnapshot() {
  snapshot = await apiFetch('/api/snapshot', { cache: 'no-store' });
  labelLibrary = (snapshot.labels || [])
    .map((l) => l.name)
    .filter((n) => typeof n === 'string' && n.trim());
}

function findUser(uid, token) {
  return (snapshot.users || []).find(
    (u) => (uid && u.uid === uid) || (token && u.urlToken === token)
  ) || null;
}

/** 反显某用户已保存的标签 */
function loadUserTags(user) {
  currentUser = user;
  const u = findUser(user.uid, user.token);
  selectedTags = u && Array.isArray(u.tags) ? u.tags.slice() : [];
  renderSelected();

  if (u && u.color) {
    colorCheck.checked = true;
    colorInput.disabled = false;
    colorInput.value = u.color;
  } else {
    colorCheck.checked = false;
    colorInput.disabled = true;
  }
}

/** 设备标识：用于统计"来源设备"（不能识别真人） */
async function getClientId() {
  const CLIENT_KEY = 'zhTaggerClientId';
  const res = await chrome.storage.local.get(CLIENT_KEY);
  if (res[CLIENT_KEY]) return res[CLIENT_KEY];

  const id = 'client-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await chrome.storage.local.set({ [CLIENT_KEY]: id });
  return id;
}

/** 保存用户备注到后端 */
async function saveUser(user) {
  try {
    const clientId = await getClientId();
    const zhihuRes = await chrome.storage.local.get('zhTaggerZhihuUser');
    const zhihuUser = zhihuRes.zhTaggerZhihuUser || {};
    await apiFetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...user,
        clientId,
        zhihuUserId: zhihuUser.id || '',
      }),
    });
    chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
    await refreshSnapshot();
    return true;
  } catch (e) {
    showMsg('保存失败：' + e.message + '（请确认后端已启动）', 'error');
    return false;
  }
}

/** 解析 token 对应的 uid / 昵称（借助内容脚本） */
function resolveToken(token, cb) {
  getActiveTab((tab) => {
    sendToContent(tab && tab.id, { type: 'RESOLVE_TOKEN', token }, (resp) => {
      cb({
        token,
        uid: (resp && resp.uid) || '',
        name: (resp && resp.name) || '',
      });
    });
  });
}

// ------------------------------------------------------------------
// 标签组件
// ------------------------------------------------------------------

colorCheck.addEventListener('change', () => {
  colorInput.disabled = !colorCheck.checked;
});

function renderSelected() {
  selectedChips.innerHTML = '';
  selectedTags.forEach((tag) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';

    const text = document.createElement('span');
    text.textContent = tag;

    const remove = document.createElement('span');
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = '移除';
    remove.addEventListener('click', () => removeTag(tag));

    chip.appendChild(text);
    chip.appendChild(remove);
    selectedChips.appendChild(chip);
  });
}

function renderDropdown(keyword) {
  const kw = (keyword || '').trim().toLowerCase();
  const matched = labelLibrary.filter((t) => !kw || t.toLowerCase().includes(kw));
  const items = matched.slice(0, MAX_DROPDOWN_ITEMS);

  tagDropdown.innerHTML = '';
  items.forEach((tag) => {
    const row = document.createElement('div');
    const isSelected = selectedTags.indexOf(tag) >= 0;
    row.className = 'tag-option' + (isSelected ? ' selected' : '');

    const name = document.createElement('span');
    name.textContent = tag;
    row.appendChild(name);

    if (isSelected) {
      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = '✓';
      row.appendChild(check);
    }

    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      toggleTag(tag);
      tagSearch.value = '';
      renderDropdown('');
      tagSearch.focus();
    });
    tagDropdown.appendChild(row);
  });

  if (matched.length > MAX_DROPDOWN_ITEMS) {
    const more = document.createElement('div');
    more.className = 'tag-option more';
    more.textContent = `还有 ${matched.length - MAX_DROPDOWN_ITEMS} 条，继续输入可缩小范围`;
    tagDropdown.appendChild(more);
  }

  const raw = (keyword || '').trim();
  if (raw && labelLibrary.indexOf(raw) === -1) {
    const create = document.createElement('div');
    create.className = 'tag-option create';
    create.textContent = `＋ 新建备注「${raw}」`;
    create.addEventListener('mousedown', (e) => {
      e.preventDefault();
      addTag(raw);
      tagSearch.value = '';
      renderDropdown('');
      tagSearch.focus();
    });
    tagDropdown.appendChild(create);
  }

  tagDropdown.classList.toggle('hidden', tagDropdown.children.length === 0);
}

function toggleTag(tag) {
  const idx = selectedTags.indexOf(tag);
  if (idx >= 0) selectedTags.splice(idx, 1);
  else selectedTags.push(tag);
  renderSelected();
}

function addTag(tag) {
  const t = (tag || '').trim();
  if (!t) return;

  if (labelLibrary.indexOf(t) === -1) {
    labelLibrary.push(t);
    // 异步写入后端标签库（失败不影响本地选择）
    apiFetch('/api/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: t }),
    }).catch(() => {});
  }
  if (selectedTags.indexOf(t) === -1) selectedTags.push(t);
  renderSelected();
}

function removeTag(tag) {
  const idx = selectedTags.indexOf(tag);
  if (idx >= 0) selectedTags.splice(idx, 1);
  renderSelected();
}

tagSearch.addEventListener('input', () => renderDropdown(tagSearch.value));
tagSearch.addEventListener('focus', () => renderDropdown(tagSearch.value));
tagSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const raw = tagSearch.value.trim();
    if (raw) {
      addTag(raw);
      tagSearch.value = '';
    }
    renderDropdown('');
  }
});

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest || !e.target.closest('.tag-picker')) {
    tagDropdown.classList.add('hidden');
  }
});

// ------------------------------------------------------------------
// 保存
// ------------------------------------------------------------------

saveBtn.addEventListener('click', () => {
  const raw = userInput.value.trim();
  const tags = selectedTags.slice();
  const color = colorCheck.checked ? colorInput.value : '';

  if (!raw) return showMsg('请输入用户主页链接 / urlToken / 昵称', 'error');
  if (tags.length === 0) return showMsg('请至少选择一个备注', 'error');

  const token = extractTokenFromInput(raw);
  if (token) {
    resolveToken(token, async (u) => {
      const ok = await saveUser({
        uid: u.uid,
        urlToken: u.token,
        name: u.name || (currentUser ? currentUser.name : ''),
        tags,
        color,
      });
      if (ok) {
        showMsg(`已保存：${u.name || u.token}${u.uid ? '（已绑定 uid）' : '（未解析到 uid）'} → ${tags.join('、')}`, 'ok');
      }
    });
    return;
  }

  getActiveTab((tab) => {
    sendToContent(tab && tab.id, { type: 'FIND_USER_BY_NAME', name: raw }, async (resp) => {
      const users = (resp && resp.users) || [];
      if (users.length === 0) {
        showMsg('当前页面未找到该昵称，请粘贴用户主页链接', 'error');
      } else if (users.length === 1) {
        const ok = await saveUser({
          uid: users[0].uid,
          urlToken: users[0].token,
          name: raw,
          tags,
          color,
        });
        if (ok) {
          showMsg(`已保存：${raw} → ${tags.join('、')}`, 'ok');
          loadUserTags({ uid: users[0].uid, token: users[0].token, name: raw });
        }
      } else {
        renderSelectList(users, raw, tags, color);
      }
    });
  });
});

function renderSelectList(users, raw, tags, color) {
  userListEl.innerHTML = '';
  const title = document.createElement('li');
  title.className = 'select-title';
  title.textContent = `“${raw}”匹配到多个用户，请选择：`;
  userListEl.appendChild(title);

  users.forEach((u) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.textContent = `${u.name || u.token}（${u.token}${u.uid ? ' · ' + u.uid.slice(0, 8) : ''}）`;
    btn.addEventListener('click', async () => {
      const ok = await saveUser({
        uid: u.uid,
        urlToken: u.token,
        name: u.name || raw,
        tags,
        color,
      });
      if (ok) {
        showMsg(`已保存：${u.name || raw} → ${tags.join('、')}`, 'ok');
        loadUserTags({ uid: u.uid, token: u.token, name: u.name || raw });
        userListEl.innerHTML = '';
        loadUserList();
      }
    });
    li.appendChild(btn);
    userListEl.appendChild(li);
  });
}

// ------------------------------------------------------------------
// 当前页面用户列表
// ------------------------------------------------------------------

function loadUserList() {
  getActiveTab((tab) => {
    sendToContent(tab && tab.id, { type: 'GET_USERS' }, (resp) => {
      renderUserList((resp && resp.users) || []);
    });
  });
}

function renderUserList(users) {
  userListEl.innerHTML = '';
  if (!users.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '当前页面未识别到用户（请打开知乎页面）';
    userListEl.appendChild(li);
    return;
  }
  users.forEach((u) => {
    const li = document.createElement('li');
    li.textContent = (u.name || u.token) + (u.uid ? ' ✓' : '');
    li.title = `${u.token}${u.uid ? '\nuid：' + u.uid : '\n暂未解析到 uid'}`;
    li.addEventListener('click', () => {
      userInput.value = `https://www.zhihu.com/people/${u.token}`;
      loadUserTags({ uid: u.uid || '', token: u.token, name: u.name || '' });
      userInput.focus();
    });
    userListEl.appendChild(li);
  });
}

userInput.addEventListener('blur', () => {
  const token = extractTokenFromInput(userInput.value.trim());
  if (!token) return;
  resolveToken(token, (u) => {
    if (!u) return;
    loadUserTags({ uid: u.uid, token: u.token, name: u.name });
  });
});

// ------------------------------------------------------------------
// 导入 / 导出（走后端 SQLite）
// ------------------------------------------------------------------

async function exportData() {
  try {
    const data = await apiFetch('/api/export', { cache: 'no-store' });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

    a.href = url;
    a.download = `zhihu-tagger-v2-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showMsg('已导出 SQLite 数据', 'ok');
  } catch (e) {
    showMsg('导出失败：' + e.message + '（请确认后端已启动）', 'error');
  }
}

function importData(file) {
  const reader = new FileReader();

  reader.onload = async () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (e) {
      showMsg('导入失败：文件不是合法 JSON', 'error');
      return;
    }

    if (!confirm('将把备份合并导入到 SQLite 数据库，继续？')) return;

    try {
      const payload = data && data.tags ? data.tags : data;
      const result = await apiFetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await refreshSnapshot();
      showMsg(`导入完成：合并 ${result.imported || 0} 个用户`, 'ok');
      loadUserList();
      if (currentUser) loadUserTags(currentUser);
    } catch (e) {
      showMsg('导入失败：' + e.message, 'error');
    }
  };

  reader.onerror = () => showMsg('读取文件失败', 'error');
  reader.readAsText(file, 'utf-8');
}

exportBtn.addEventListener('click', exportData);
importBtn.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importData(file);
  importFile.value = '';
});

openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

const openStats = document.getElementById('openStats');
openStats.addEventListener('click', () => {
  chrome.tabs.create({ url: apiBase + '/stats' });
});

// ------------------------------------------------------------------
// 启动
// ------------------------------------------------------------------

(async () => {
  await loadApiBase();
  try {
    await refreshSnapshot();
  } catch (e) {
    showMsg('无法连接后端（' + apiBase + '），请先运行 python backend/app.py', 'error');
  }
  renderSelected();
  loadUserList();
})();
