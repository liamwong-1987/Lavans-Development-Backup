(function () {
  const NON_TRANSLATABLE_HOSTS = [
    'bilibili.com','b23.tv','xiaohongshu.com','xhslink.com','zhihu.com','weibo.com',
    'youku.com','iqiyi.com','baidu.com','taobao.com','jd.com','csdn.net','juejin.cn','gitee.com','oschina.net'
  ];
  const videoHostPrefixes = ['youtube.com','youtu.be','twitter.com','x.com','instagram.com','tiktok.com','facebook.com','reddit.com','github.com'];
  const TRANSLATE_PROXY = 'https://translate.google.com/translate?sl=auto&tl=zh-CN&u=';

  function hostOf(url) { try { return new URL(url, window.location.href).hostname.toLowerCase(); } catch (e) { return ''; } }
  function isTranslatable(url) {
    const host = hostOf(url);
    if (!host) return false;
    if (NON_TRANSLATABLE_HOSTS.some(d => host === d || host.endsWith('.' + d))) return false;
    if (videoHostPrefixes.some(p => host === p || host.endsWith('.' + p))) return false;
    return true;
  }
  function buildTranslateUrl(url) { return TRANSLATE_PROXY + encodeURIComponent(url); }

  function wrapExternalLink(anchor) {
    if (!anchor || anchor.dataset.translated === '1' || anchor.dataset.translationControl === '1') return;
    if (anchor.classList && anchor.classList.contains('link-translate-btn')) return;
    if (anchor.getAttribute('target') !== '_blank') return;
    const href = anchor.href;
    if (!href || !isTranslatable(href)) return;
    anchor.dataset.translated = '1';
    const btn = document.createElement('a');
    btn.href = buildTranslateUrl(href);
    btn.target = '_blank';
    btn.rel = 'noopener noreferrer';
    btn.className = 'link-translate-btn';
    btn.dataset.translationControl = '1';
    btn.textContent = '翻译';
    btn.title = '用 Google 翻译打开此页面';
    anchor.insertAdjacentElement('afterend', btn);
  }

  function initExternalLinkTranslator(root) {
    root = root || document;
    root.querySelectorAll('a[href][target="_blank"]').forEach(wrapExternalLink);
    if (root.body) {
      const observer = new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType !== 1) return;
            if (n.matches && n.matches('a[href][target="_blank"]')) wrapExternalLink(n);
            if (n.querySelectorAll) n.querySelectorAll('a[href][target="_blank"]').forEach(wrapExternalLink);
          });
        });
      });
      observer.observe(root.body, { childList: true, subtree: true });
    }
  }

  window.wrapExternalLink = wrapExternalLink;
  window.initExternalLinkTranslator = initExternalLinkTranslator;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initExternalLinkTranslator(); });
  } else {
    initExternalLinkTranslator();
  }
})();
