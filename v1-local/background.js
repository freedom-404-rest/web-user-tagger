/**
 * 网页用户标签助手（本地版）—— 后台脚本
 *
 * 只负责浏览器右键菜单：在知乎用户主页链接上右键，向内容脚本发送打开标签面板的消息。
 * 标签数据仍由内容脚本写入 chrome.storage.local。
 */

const MENU_ID = 'web-user-tagger-add-tag';

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

chrome.runtime.onInstalled.addListener(setupContextMenus);
chrome.runtime.onStartup.addListener(setupContextMenus);
setupContextMenus();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || !tab.id) return;
  const url = info.linkUrl || '';
  if (url.indexOf('/people/') === -1) return;
  chrome.tabs.sendMessage(tab.id, {
    type: 'OPEN_TAG_PANEL',
    url,
  });
});
