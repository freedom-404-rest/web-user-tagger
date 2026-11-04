/**
 * 知乎用户标签 —— 存储模块（内容脚本与弹窗共用）
 *
 * 存储结构（v2）：
 * {
 *   version: 2,
 *   users: {
 *     [uid]: { uid, urlToken, name, tags: [], color }
 *   },
 *   tokenIndex: { [urlToken]: uid }
 * }
 *
 * 说明：
 * - 知乎真实用户 ID（32 位十六进制，如 e8002099a78754129be0180a00890361）稳定，
 *   修改 url_token（个人主页地址）或昵称都不影响，因此作为主键；
 * - 拿不到 uid 时，临时用 "t:" + urlToken 作为占位键，后续拿到 uid 会自动迁移；
 * - tokenIndex 维护 url_token -> 用户键 的映射，便于用链接快速定位。
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'zhTaggerTags';
  const PLACEHOLDER_PREFIX = 't:';

  function emptyStore() {
    return { version: 2, users: {}, tokenIndex: {} };
  }

  /** 归一化：兼容 v1 旧数据（{ [urlToken]: { name, tags, color } }） */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return emptyStore();
    if (raw.version === 2 && raw.users && raw.tokenIndex) return raw;

    const store = emptyStore();
    Object.keys(raw).forEach((token) => {
      const item = raw[token];
      if (!item || typeof item !== 'object' || !item.tags) return;
      const key = PLACEHOLDER_PREFIX + token;
      store.users[key] = {
        uid: '',
        urlToken: token,
        name: item.name || '',
        tags: Array.isArray(item.tags) ? item.tags : [],
        color: item.color || '',
      };
      store.tokenIndex[token] = key;
    });
    return store;
  }

  /** 按 uid 或 urlToken 查用户记录 */
  function getUser(store, input) {
    store = normalize(store);
    const uid = (input && input.uid) || '';
    const token = (input && input.token) || '';

    if (uid && store.users[uid]) return store.users[uid];

    if (token) {
      const key = store.tokenIndex[token];
      if (key && store.users[key]) return store.users[key];
      if (store.users[PLACEHOLDER_PREFIX + token]) {
        return store.users[PLACEHOLDER_PREFIX + token];
      }
    }
    return null;
  }

  /**
   * 新增 / 更新用户标签
   * input: { uid, token, name, tags, color }
   */
  function upsert(store, input) {
    store = normalize(store);
    const uid = (input && input.uid) || '';
    const token = (input && input.token) || '';
    const tags = Array.isArray(input && input.tags) ? input.tags : [];
    const name = (input && input.name) || '';
    const color = (input && input.color) || '';

    // 定位已有记录
    let existing = null;
    let existingKey = null;
    if (uid && store.users[uid]) {
      existingKey = uid;
    } else if (token && store.tokenIndex[token] && store.users[store.tokenIndex[token]]) {
      existingKey = store.tokenIndex[token];
    } else if (token && store.users[PLACEHOLDER_PREFIX + token]) {
      existingKey = PLACEHOLDER_PREFIX + token;
    }
    if (existingKey) existing = store.users[existingKey];

    // 决定最终主键：优先真实 uid
    let key;
    if (uid) key = uid;
    else if (existingKey && existingKey.indexOf(PLACEHOLDER_PREFIX) !== 0) key = existingKey;
    else if (token) key = PLACEHOLDER_PREFIX + token;
    else if (existingKey) key = existingKey;
    else return store;

    const merged = {
      uid: uid || (existing && existing.uid) || '',
      urlToken: token || (existing && existing.urlToken) || '',
      name: name || (existing && existing.name) || '',
      tags: tags.length ? tags : (existing && existing.tags) || [],
      color: color || (existing && existing.color) || '',
    };

    // 从占位键迁移到 uid 键时删除旧键
    if (existingKey && existingKey !== key) delete store.users[existingKey];

    store.users[key] = merged;
    if (merged.urlToken) store.tokenIndex[merged.urlToken] = key;
    return store;
  }

  /** 删除用户标签（预留） */
  function remove(store, input) {
    store = normalize(store);
    const user = getUser(store, input);
    if (user) {
      Object.keys(store.users).forEach((k) => {
        if (store.users[k] === user) delete store.users[k];
      });
    }
    const token = (input && input.token) || '';
    if (token) delete store.tokenIndex[token];
    return store;
  }

  window.ZH_TAG_STORE = {
    STORAGE_KEY,
    emptyStore,
    normalize,
    getUser,
    upsert,
    remove,
  };
})();
