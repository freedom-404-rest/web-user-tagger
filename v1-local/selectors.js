/**
 * 知乎 DOM 选择器配置
 *
 * 知乎前端改版导致插件失效时，优先修改这里的配置即可，
 * 无需改动 content.js 核心逻辑。
 */
window.ZH_SELECTORS = {
  // 用户昵称链接：知乎页面中所有指向用户主页的链接
  // 形如 https://www.zhihu.com/people/{urlToken} 或 /people/{urlToken}
  peopleLink: 'a[href*="/people/"]',

  // 用户主页顶部昵称元素（多个候选，querySelector 取第一个匹配）
  profileName:
    '.ProfileHeader-name, [class*="ProfileHeader-name"], .ProfileHeader h1, [class*="ProfileHeader"] h1',

  // 预留：后续可细化到回答区 / 评论区 / 关注列表等，分别控制
  answerAuthor: '',
  commentAuthor: '',
};
