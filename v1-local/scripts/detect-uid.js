/**
 * 知乎用户真实 ID 探测脚本
 *
 * 用法：
 *   1. 打开任意知乎页面（回答页 / 用户主页 / 关注列表等）
 *   2. F12 打开开发者工具 → Console
 *   3. 复制本文件全部内容粘贴执行
 *   4. 把 console 输出（JSON）发给开发者，用于确认 uid 提取方式是否可用
 */
(function () {
  var result = {
    url: location.href,
    jsInitialData: null,
    extraModules: null,
    zopUsertoken: null,
    peopleLinks: [],
  };

  // 1) 页面内嵌初始数据 js-initialData
  var el = document.getElementById('js-initialData');
  if (el) {
    try {
      var data = JSON.parse(el.textContent || '{}');
      var entities = (data.initialState || {}).entities || {};
      var users = entities.users || {};
      var keys = Object.keys(users);
      result.jsInitialData = {
        exists: true,
        userCount: keys.length,
        sample: keys.slice(0, 5).map(function (uid) {
          var u = users[uid] || {};
          return { uid: uid, url_token: u.url_token, name: u.name };
        }),
      };
    } catch (e) {
      result.jsInitialData = { exists: true, error: String(e) };
    }
  } else {
    result.jsInitialData = { exists: false };
  }

  // 2) 埋点属性 data-za-extra-module
  var modules = document.querySelectorAll('[data-za-extra-module]');
  var authors = [];
  modules.forEach(function (m) {
    try {
      var raw = m.getAttribute('data-za-extra-module');
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e1) {
        parsed = JSON.parse(decodeURIComponent(raw));
      }
      (function walk(x) {
        if (!x || typeof x !== 'object') return;
        if (x.url_token && (x.id || x.uid)) {
          authors.push({ id: x.id, uid: x.uid, url_token: x.url_token, name: x.name });
        }
        Object.keys(x).forEach(function (k) {
          walk(x[k]);
        });
      })(parsed);
    } catch (e2) {
      /* ignore */
    }
  });
  var seen = {};
  var uniqueAuthors = authors.filter(function (a) {
    var k = a.id || a.uid;
    if (!k || seen[k]) return false;
    seen[k] = true;
    return true;
  });
  result.extraModules = {
    elementCount: modules.length,
    authorCount: authors.length,
    sample: uniqueAuthors.slice(0, 5),
  };

  // 3) data-zop-usertoken（常见于用户主页）
  var zop = document.querySelector('[data-zop-usertoken]');
  if (zop) result.zopUsertoken = zop.getAttribute('data-zop-usertoken');

  // 4) 页面上的用户链接
  var links = Array.prototype.slice.call(document.querySelectorAll('a[href*="/people/"]'));
  result.peopleLinks = links.slice(0, 15).map(function (a) {
    var m = (a.getAttribute('href') || '').match(/(?:^|\/)people\/([^?#/]+)\/?(?:[?#].*)?$/);
    return {
      href: a.getAttribute('href'),
      token: m ? decodeURIComponent(m[1]) : null,
      text: (a.textContent || '').trim().slice(0, 20),
    };
  });

  console.log(JSON.stringify(result, null, 2));
})();
