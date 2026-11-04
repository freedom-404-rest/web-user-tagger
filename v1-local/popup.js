/**
 * 知乎用户标签 —— 弹窗逻辑
 *
 * 功能：
 *   1. 用户标识输入（主页链接 / urlToken / 昵称）
 *   2. 标签库 + 下拉搜索 + 多选 + 回车新增（标签库随新增自动扩充）
 *   3. 点击当前页用户 / 输入已知用户时，自动反显其已保存标签
 *   4. 保存时优先绑定用户真实 uid
 */

const storeApi = window.ZH_TAG_STORE;
const MAX_DROPDOWN_ITEMS = 50;
const STORAGE_KEY = storeApi.STORAGE_KEY;
const LABEL_KEY = 'zhTaggerLabels';

const userInput = document.getElementById('userInput');
const colorCheck = document.getElementById('colorCheck');
const colorInput = document.getElementById('colorInput');
const saveBtn = document.getElementById('saveBtn');
const msgEl = document.getElementById('msg');
const userListEl = document.getElementById('userList');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');

// 标签选择组件
const selectedChips = document.getElementById('selectedChips');
const tagSearch = document.getElementById('tagSearch');
const tagDropdown = document.getElementById('tagDropdown');

// 状态
let labelLibrary = []; // 标签库
let selectedTags = []; // 当前选中的标签
let currentUser = null; // 当前正在编辑的用户 { uid, token, name }

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
// 标签库
// ------------------------------------------------------------------

function loadLabels(cb) {
  chrome.storage.local.get(LABEL_KEY, (res) => {
    labelLibrary = Array.isArray(res[LABEL_KEY]) ? res[LABEL_KEY] : [];
    cb && cb();
  });
}

function saveLabels() {
  chrome.storage.local.set({ [LABEL_KEY]: labelLibrary });
}

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
    saveLabels();
  }
  if (selectedTags.indexOf(t) === -1) selectedTags.push(t);
  renderSelected();
}

function removeTag(tag) {
  const idx = selectedTags.indexOf(tag);
  if (idx >= 0) selectedTags.splice(idx, 1);
  renderSelected();
}

// 搜索框交互
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

// 点击组件外部收起下拉
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest || !e.target.closest('.tag-picker')) {
    tagDropdown.classList.add('hidden');
  }
});

// ------------------------------------------------------------------
// 用户与标签反显
// ------------------------------------------------------------------

/** 载入某用户已保存的标签并反显 */
function loadUserTags(user) {
  currentUser = user;
  chrome.storage.local.get(STORAGE_KEY, (res) => {
    const store = storeApi.normalize(res[STORAGE_KEY]);
    const u = storeApi.getUser(store, { uid: user.uid, token: user.token });
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
  });
}

/** 解析 token 对应的 uid / 昵称 */
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

/** 保存标签（uid 优先，token 兜底） */
function saveUser(user, cb) {
  chrome.storage.local.get(STORAGE_KEY, (res) => {
    let store = storeApi.normalize(res[STORAGE_KEY]);
    store = storeApi.upsert(store, user);
    chrome.storage.local.set({ [STORAGE_KEY]: store }, () => {
      cb && cb();
    });
  });
}

// ------------------------------------------------------------------
// 保存
// ------------------------------------------------------------------

saveBtn.addEventListener('click', () => {
  const raw = userInput.value.trim();
  const tags = selectedTags.slice();
  const color = colorCheck.checked ? colorInput.value : '';

  if (!raw) return showMsg('请输入用户主页链接 / urlToken / 昵称', 'error');
  if (tags.length === 0) return showMsg('请至少选择一个备注', 'error');

  // 把本次用到的标签补进标签库
  tags.forEach((t) => {
    if (labelLibrary.indexOf(t) === -1) labelLibrary.push(t);
  });
  saveLabels();

  const token = extractTokenFromInput(raw);
  if (token) {
    resolveToken(token, (u) => {
      saveUser({ uid: u.uid, token: u.token, name: u.name || (currentUser ? currentUser.name : ''), tags, color }, () => {
        showMsg(`已保存：${u.name || u.token}${u.uid ? '（已绑定 uid）' : '（当前页未解析到 uid）'} → ${tags.join('、')}`, 'ok');
      });
    });
    return;
  }

  // 不是 urlToken，按昵称在当前页面匹配
  getActiveTab((tab) => {
    sendToContent(tab && tab.id, { type: 'FIND_USER_BY_NAME', name: raw }, (resp) => {
      const users = (resp && resp.users) || [];
      if (users.length === 0) {
        showMsg('当前页面未找到该昵称，请粘贴用户主页链接', 'error');
      } else if (users.length === 1) {
        saveUser({ uid: users[0].uid, token: users[0].token, name: raw, tags, color }, () => {
          showMsg(`已保存：${raw} → ${tags.join('、')}`, 'ok');
          loadUserTags({ uid: users[0].uid, token: users[0].token, name: raw });
        });
      } else {
        renderSelectList(users, raw, tags, color);
      }
    });
  });
});

/** 匹配到多个同名用户时，列出供选择 */
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
    btn.addEventListener('click', () => {
      saveUser({ uid: u.uid, token: u.token, name: u.name || raw, tags, color }, () => {
        showMsg(`已保存：${u.name || raw} → ${tags.join('、')}`, 'ok');
        loadUserTags({ uid: u.uid, token: u.token, name: u.name || raw });
        userListEl.innerHTML = '';
        loadUserList();
      });
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

// 手动输入用户后，失焦时尝试解析并反显已存标签
userInput.addEventListener('blur', () => {
  const token = extractTokenFromInput(userInput.value.trim());
  if (!token) return;
  resolveToken(token, (u) => {
    if (!u) return;
    loadUserTags({ uid: u.uid, token: u.token, name: u.name });
  });
});

// ------------------------------------------------------------------
// 导入 / 导出
// ------------------------------------------------------------------

/** 一键导出全部数据为 JSON 文件 */
function exportData() {
  chrome.storage.local.get([STORAGE_KEY, LABEL_KEY], (res) => {
    const payload = {
      app: 'zhihu-tagger',
      version: 2,
      exportedAt: new Date().toISOString(),
      tags: storeApi.normalize(res[STORAGE_KEY]),
      labels: Array.isArray(res[LABEL_KEY]) ? res[LABEL_KEY] : [],
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

    a.href = url;
    a.download = `zhihu-tagger-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showMsg('已导出备份文件', 'ok');
  });
}

/** 导入备份：与本地数据合并（标签取并集，不丢数据） */
function importData(file) {
  const reader = new FileReader();

  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (e) {
      showMsg('导入失败：文件不是合法 JSON', 'error');
      return;
    }

    const incoming = data && data.tags ? data.tags : data;
    const users = incoming && incoming.users ? incoming.users : incoming;
    const incomingLabels = data && Array.isArray(data.labels) ? data.labels : [];

    if (!users || typeof users !== 'object' || Array.isArray(users)) {
      showMsg('导入失败：文件结构无法识别', 'error');
      return;
    }

    if (!confirm('将把备份数据合并到本地（保留现有备注，取并集），继续？')) return;

    chrome.storage.local.get([STORAGE_KEY, LABEL_KEY], (res) => {
      let store = storeApi.normalize(res[STORAGE_KEY]);
      let count = 0;

      Object.keys(users).forEach((key) => {
        const u = users[key];
        if (!u || typeof u !== 'object' || !Array.isArray(u.tags)) return;

        const isHexUid = /^[0-9a-f]{32}$/i.test(key);
        let uid = u.uid || (isHexUid ? key : '');
        let token = u.urlToken || '';
        if (!token) {
          if (key.indexOf('t:') === 0) token = key.slice(2);
          else if (!isHexUid) token = key;
        }

        const existing = storeApi.getUser(store, { uid, token });
        const mergedTags = [];
        ((existing && existing.tags) || []).concat(u.tags).forEach((t) => {
          if (t && mergedTags.indexOf(t) === -1) mergedTags.push(t);
        });

        store = storeApi.upsert(store, {
          uid,
          token,
          name: u.name || (existing && existing.name) || '',
          tags: mergedTags,
          color: u.color || (existing && existing.color) || '',
        });
        count++;
      });

      const labels = Array.isArray(res[LABEL_KEY]) ? res[LABEL_KEY].slice() : [];
      incomingLabels.forEach((t) => {
        if (typeof t === 'string' && t.trim() && labels.indexOf(t) === -1) labels.push(t);
      });

      chrome.storage.local.set({ [STORAGE_KEY]: store, [LABEL_KEY]: labels }, () => {
        labelLibrary = labels;
        showMsg(`导入完成：合并 ${count} 个用户，备注库共 ${labels.length} 个备注`, 'ok');
        loadUserList();
        if (currentUser) loadUserTags(currentUser);
      });
    });
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

// ------------------------------------------------------------------
// 启动
// ------------------------------------------------------------------

loadLabels(() => {
  renderSelected();
  loadUserList();
});
