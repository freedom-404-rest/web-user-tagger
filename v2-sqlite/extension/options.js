/**
 * 知乎用户标签 v2 —— 设置页
 * 配置 Python + SQLite 后端地址
 */

const API_KEY = 'zhTaggerApiBase';
const DEFAULT_API = 'http://127.0.0.1:8000';

const input = document.getElementById('apiBase');
const saveBtn = document.getElementById('saveBtn');
const testBtn = document.getElementById('testBtn');
const statsBtn = document.getElementById('statsBtn');
const msg = document.getElementById('msg');

function show(text, ok) {
  msg.textContent = text;
  msg.className = ok ? 'ok' : 'error';
}

chrome.storage.local.get(API_KEY, (res) => {
  input.value = res[API_KEY] || DEFAULT_API;
});

saveBtn.addEventListener('click', () => {
  const v = input.value.trim().replace(/\/+$/, '') || DEFAULT_API;
  chrome.storage.local.set({ [API_KEY]: v }, () => {
    input.value = v;
    show('已保存：' + v, true);
  });
});

testBtn.addEventListener('click', async () => {
  const base = (input.value.trim() || DEFAULT_API).replace(/\/+$/, '');
  show('正在连接…', true);
  try {
    const resp = await fetch(base + '/api/health', { cache: 'no-store' });
    const data = await resp.json();
    if (data && data.ok) show('连接成功：' + base, true);
    else show('连接失败：返回异常', false);
  } catch (e) {
    show('连接失败：' + e.message + '（请确认 python backend/app.py 已启动）', false);
  }
});

statsBtn.addEventListener('click', () => {
  const base = (input.value.trim() || DEFAULT_API).replace(/\/+$/, '');
  chrome.tabs.create({ url: base + '/stats' });
});
