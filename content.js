/**
 * 沉浸式 AI 翻译 — 内容脚本
 * 抓取段落 → 视口懒加载 → 批量送大模型 → 原段落内插入译文（中英对照）
 */
(() => {
  'use strict';

  if (window.__llmtLoaded__) return;
  window.__llmtLoaded__ = true;

  /* ---------------- 常量 ---------------- */

  const DEFAULTS = {
    autoTranslate: false,
    showFloatingButton: true,
    displayMode: 'bilingual',
    targetLang: '简体中文',
    maxCharsPerBatch: 1600,
    maxSegmentsPerBatch: 16,
    concurrency: 2,
    skipSelectors: ''
  };

  // 整块跳过（不翻译、不递归）
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'SVG', 'CANVAS',
    'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'MAP', 'TEMPLATE',
    'HEAD', 'TITLE', 'META', 'LINK', 'RUBY', 'RT', 'RP'
  ]);

  // 内联元素：不作为段落单位
  const INLINE = new Set([
    'A', 'SPAN', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'DEL', 'INS', 'SMALL',
    'BIG', 'SUB', 'SUP', 'MARK', 'ABBR', 'ACRONYM', 'CITE', 'Q', 'TIME',
    'BDI', 'BDO', 'FONT', 'LABEL', 'BR', 'IMG', 'WBR', 'CODE', 'KBD', 'SAMP',
    'VAR', 'TT', 'RUBY', 'RT', 'RP', 'AUDIO', 'VIDEO', 'PICTURE', 'NOBR',
    'NOBR', 'OUTPUT', 'METER', 'PROGRESS'
  ]);

  const LANG_ATTR = {
    '简体中文': 'zh-CN',
    '繁體中文': 'zh-TW',
    'English': 'en',
    '日本語': 'ja',
    '한국어': 'ko'
  };

  /* ---------------- 状态 ---------------- */

  let S = Object.assign({}, DEFAULTS);
  let running = false;
  let io = null;
  let mo = null;
  let flushTimer = null;
  let scanTimer = null;
  let buffer = [];
  let inflight = 0;
  let doneCount = 0;
  let toastShown = false;

  const pendingMap = new Map(); // el -> {el, text, split}
  const cache = new Map();      // 原文 -> 译文
  const MAX_CACHE = 3000;
  const scanRoots = new Set();

  /* ---------------- 启动 ---------------- */

  init();

  async function init() {
    await loadSettings();
    ensureUI();

    const { sites } = await chrome.storage.local.get('sites');
    const override = sites ? sites[location.hostname] : undefined;
    if (override === true || (override === undefined && S.autoTranslate)) {
      start();
    }
    updateFab();
  }

  async function loadSettings() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      S = Object.assign({}, DEFAULTS, settings || {});
    } catch (e) {
      S = Object.assign({}, DEFAULTS);
    }
  }

  async function persistSite(on) {
    try {
      const { sites } = await chrome.storage.local.get('sites');
      const next = Object.assign({}, sites || {});
      next[location.hostname] = on;
      await chrome.storage.local.set({ sites: next });
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 扫描 ---------------- */

  function scan(root) {
    if (!running || !root) return;
    visit(root.nodeType === 1 ? root : document.body);
  }

  function visit(el) {
    if (!running || !el || el.nodeType !== 1) return;

    const tag = (el.tagName || '').toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    if (INLINE.has(tag)) return;
    if (el.hasAttribute('data-llmt-done')) return;
    if (el.hasAttribute('data-llmt-ui')) return;

    // 有块级子元素 → 继续下钻
    let hasBlockChild = false;
    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      const t = (kids[i].tagName || '').toUpperCase();
      if (!INLINE.has(t) && !SKIP_TAGS.has(t)) { hasBlockChild = true; break; }
    }
    if (hasBlockChild) {
      for (let i = 0; i < kids.length; i++) visit(kids[i]);
      return;
    }

    queueSegment(el);
  }

  function queueSegment(el) {
    if (pendingMap.has(el)) return;

    const text = extractText(el);
    if (!text) return;
    if (isAlreadyTarget(text)) return;

    if (S.skipSelectors) {
      try {
        if (el.matches(S.skipSelectors) || el.closest(S.skipSelectors)) return;
      } catch (e) { /* 选择器写错就当没写 */ }
    }

    const rec = { el, text, split: false };
    pendingMap.set(el, rec);
    if (io) io.observe(el);
  }

  function extractText(el) {
    let t = '';
    try {
      t = el.innerText;
    } catch (e) { /* 某些节点没有 innerText */ }
    if (typeof t !== 'string' || !t.trim()) t = el.textContent || '';
    t = String(t).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

    if (t.length < 2) return '';
    // 至少包含一种「有意义的文字」
    if (!/[A-Za-z\u00c0-\u024f\u0400-\u04ff\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)) return '';
    return t;
  }

  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/g;

  function isAlreadyTarget(text) {
    const target = S.targetLang || '';
    if (/中文|Chinese/i.test(target)) {
      const cjk = (text.match(CJK) || []).length;
      const latinWords = (text.match(/[A-Za-z]{2,}/g) || []).length;
      return cjk >= 4 && latinWords <= 1;
    }
    if (/English|英文/i.test(target)) {
      return (text.match(CJK) || []).length === 0 && text.length > 10;
    }
    if (/日本語|Japanese/i.test(target)) {
      return /[\u3040-\u30ff]/.test(text) && (text.match(CJK) || []).length > 0;
    }
    if (/한국어|Korean/i.test(target)) {
      return /[\uac00-\ud7af]/.test(text);
    }
    return false;
  }

  /* ---------------- 视口懒加载 ---------------- */

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      io.unobserve(el);

      const rec = pendingMap.get(el);
      if (!rec) continue;
      pendingMap.delete(el);

      const cached = cache.get(rec.text);
      if (cached) {
        render(el, cached);
        doneCount++;
        continue;
      }
      buffer.push(rec);
    }
    scheduleFlush();
    updateFab();
  }

  /* ---------------- 批量调度 ---------------- */

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 220);
  }

  function flush() {
    if (!running) return;
    const concurrency = Math.max(1, Number(S.concurrency) || 2);
    const maxSeg = Math.max(1, Number(S.maxSegmentsPerBatch) || 16);
    const maxChars = Math.max(200, Number(S.maxCharsPerBatch) || 1600);

    while (buffer.length && inflight < concurrency) {
      const batch = [];
      let chars = 0;
      while (buffer.length && batch.length < maxSeg) {
        const item = buffer[0];
        if (batch.length && chars + item.text.length > maxChars) break;
        buffer.shift();
        batch.push(item);
        chars += item.text.length;
      }
      if (!batch.length) break;
      sendBatch(batch);
    }
    updateFab();
  }

  async function sendBatch(batch) {
    inflight++;
    updateFab();
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'llmt:translate',
        texts: batch.map((b) => b.text)
      });

      if (!res || res.error) throw new Error((res && res.error) || '翻译请求失败');
      const arr = res.translations || [];

      batch.forEach((item, i) => {
        const t = (arr[i] || '').trim();
        if (!t) return;
        remember(item.text, t);
        if (item.el.isConnected && !item.el.hasAttribute('data-llmt-done')) {
          render(item.el, t);
          doneCount++;
        }
      });

      const missing = batch.filter((_, i) => !(arr[i] || '').trim());
      if (missing.length) handleFailure(missing, new Error('部分片段未返回译文'));
    } catch (e) {
      handleFailure(batch, e);
    } finally {
      inflight--;
      updateFab();
      flush();
    }
  }

  function handleFailure(batch, err) {
    const msg = String((err && err.message) || err);

    // 未配置 Key：提示一次，并中断
    if (/API Key|API 地址|模型名称|鉴权失败/.test(msg)) {
      if (!toastShown) {
        toastShown = true;
        toast('需要先配置大模型接口：填好 API 地址 / Key / 模型名后即可翻译。', {
          actionText: '去设置',
          onAction: () => chrome.runtime.sendMessage({ type: 'llmt:open-options' })
        });
      }
      return;
    }

    // 批次失败 → 拆半重试一次（常见于模型漏条）
    const splittable = batch.filter((b) => !b.split);
    if (batch.length > 1 && splittable.length === batch.length) {
      const mid = Math.ceil(batch.length / 2);
      const halves = [batch.slice(0, mid), batch.slice(mid)];
      for (const half of halves) {
        half.forEach((b) => { b.split = true; if (running && b.el.isConnected) buffer.unshift(b); });
      }
      return;
    }

    for (const b of batch) {
      if (b.el && b.el.isConnected) b.el.classList.add('llmt-failed');
    }
    console.warn('[llmt] 翻译失败：', msg);
  }

  function remember(src, dst) {
    if (cache.size >= MAX_CACHE) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(src, dst);
  }

  /* ---------------- 渲染 ---------------- */

  function render(el, text) {
    if (!el || !el.isConnected) return;
    if (el.hasAttribute('data-llmt-done')) return;

    if (S.displayMode === 'replace') wrapOriginal(el);
    el.setAttribute('data-llmt-done', '1');

    const node = document.createElement('span');
    node.className = 'llmt-translation';
    const lang = LANG_ATTR[S.targetLang];
    if (lang) node.setAttribute('lang', lang);
    node.textContent = text;
    el.appendChild(node);
  }

  /* 仅译文模式：把原有内容包进一层 display:contents 的 span，用 CSS 隐藏 */
  function wrapOriginal(el) {
    if (el.querySelector(':scope > [data-llmt-orig]')) return;
    const wrap = document.createElement('span');
    wrap.setAttribute('data-llmt-orig', '1');
    while (el.firstChild) wrap.appendChild(el.firstChild);
    el.appendChild(wrap);
  }

  /* ---------------- DOM 变更监听 ---------------- */

  function onMutate(mutations) {
    if (!running) return;
    let dirty = false;
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (isOurs(n)) continue;
        scanRoots.add(n);
        dirty = true;
      }
    }
    if (!dirty) return;
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const roots = Array.from(scanRoots);
      scanRoots.clear();
      for (const r of roots) if (r.isConnected) scan(r);
    }, 260);
  }

  function isOurs(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.classList && node.classList.contains('llmt-translation')) return true;
    if (node.hasAttribute && (node.hasAttribute('data-llmt-orig') || node.hasAttribute('data-llmt-ui'))) return true;
    return false;
  }

  /* ---------------- 开始 / 停止 ---------------- */

  function start() {
    if (running) return;
    if (!document.body) return;
    running = true;
    doneCount = 0;
    toastShown = false;
    buffer = [];
    pendingMap.clear();
    scanRoots.clear();

    document.documentElement.classList.add('llmt-on');
    if (S.displayMode === 'replace') document.documentElement.classList.add('llmt-mode-replace');

    io = new IntersectionObserver(onIntersect, { rootMargin: '600px 0px' });
    mo = new MutationObserver(onMutate);

    scan(document.body);
    mo.observe(document.body, { childList: true, subtree: true });
    updateFab();
  }

  function stop() {
    if (!running) {
      updateFab();
      return;
    }
    running = false;

    if (io) { io.disconnect(); io = null; }
    if (mo) { mo.disconnect(); mo = null; }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }

    buffer = [];
    pendingMap.clear();
    scanRoots.clear();
    resetDOM();
    updateFab();
  }

  function resetDOM() {
    document.querySelectorAll('span.llmt-translation').forEach((n) => n.remove());
    document.querySelectorAll('[data-llmt-done]').forEach((n) => {
      n.removeAttribute('data-llmt-done');
      n.classList.remove('llmt-failed');
    });
    document.querySelectorAll('[data-llmt-orig]').forEach((w) => {
      const parent = w.parentNode;
      if (!parent) return;
      while (w.firstChild) parent.insertBefore(w.firstChild, w);
      w.remove();
    });
    document.documentElement.classList.remove('llmt-on', 'llmt-mode-replace');
  }

  async function toggle() {
    if (running) {
      stop();
      await persistSite(false);
    } else {
      await loadSettings();
      start();
      await persistSite(true);
    }
    return running;
  }

  /* ---------------- 界面：悬浮按钮 + 提示 ---------------- */

  let fab = null;

  function ensureUI() {
    if (!S.showFloatingButton) {
      if (fab) { fab.remove(); fab = null; }
      return;
    }
    if (fab && fab.isConnected) return;
    if (document.querySelector('[data-llmt-ui="fab"]')) return;

    fab = document.createElement('button');
    fab.type = 'button';
    fab.setAttribute('data-llmt-ui', 'fab');
    fab.className = 'llmt-fab';
    fab.innerHTML = '<span class="llmt-fab-ring"></span><span class="llmt-fab-txt">译</span>';
    fab.title = '沉浸式 AI 翻译（Alt+T 切换）';
    fab.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
    document.documentElement.appendChild(fab);
    updateFab();
  }

  function updateFab() {
    if (!fab || !fab.isConnected) return;
    const busy = inflight > 0 || buffer.length > 0;
    fab.classList.toggle('llmt-on', running);
    fab.classList.toggle('llmt-busy', busy);
    const txt = fab.querySelector('.llmt-fab-txt');
    if (txt) {
      txt.textContent = running ? (busy ? `译 ${doneCount}` : '译') : '译';
      txt.style.fontSize = running && busy ? '11px' : '15px';
    }
    fab.title = running
      ? `已翻译 ${doneCount} 段${busy ? '（进行中…）' : ''}，点击恢复原文（Alt+T）`
      : '点击翻译此页（Alt+T）';
  }

  function toast(msg, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.setAttribute('data-llmt-ui', 'toast');
    el.className = 'llmt-toast';
    const p = document.createElement('span');
    p.textContent = msg;
    el.appendChild(p);
    if (opts.actionText) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = opts.actionText;
      btn.addEventListener('click', () => {
        if (opts.onAction) opts.onAction();
        el.remove();
      });
      el.appendChild(btn);
    }
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  /* ---------------- 与 popup / 后台通信 ---------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'llmt:toggle') {
      toggle().then((on) => sendResponse({ running: on })).catch(() => sendResponse({ running: false }));
      return true;
    }

    if (msg.type === 'llmt:state') {
      sendResponse({
        running,
        host: location.hostname,
        doneCount,
        settings: {
          displayMode: S.displayMode,
          targetLang: S.targetLang,
          showFloatingButton: S.showFloatingButton,
          autoTranslate: S.autoTranslate
        }
      });
      return true;
    }

    if (msg.type === 'llmt:set-mode') {
      S.displayMode = msg.mode === 'replace' ? 'replace' : 'bilingual';
      chrome.storage.local.get('settings').then(({ settings }) => {
        const next = Object.assign({}, settings || {}, { displayMode: S.displayMode });
        chrome.storage.local.set({ settings: next });
      });
      sendResponse({ ok: true, running });
      return true;
    }

    if (msg.type === 'llmt:retranslate') {
      cache.clear();
      const wasRunning = running;
      stop();
      start();
      sendResponse({ ok: true, wasRunning });
      return true;
    }

    if (msg.type === 'llmt:settings-changed') {
      loadSettings().then(() => {
        ensureUI();
        const wantReplace = S.displayMode === 'replace';
        const isReplace = document.documentElement.classList.contains('llmt-mode-replace');
        if (running && wantReplace !== isReplace) {
          stop();
          start();
        }
      });
      sendResponse({ ok: true });
      return true;
    }
  });

  /* 设置变更即时生效 */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const modeChanged =
      changes.settings.oldValue && changes.settings.newValue &&
      changes.settings.oldValue.displayMode !== changes.settings.newValue.displayMode;
    const fabChanged =
      changes.settings.oldValue && changes.settings.newValue &&
      changes.settings.oldValue.showFloatingButton !== changes.settings.newValue.showFloatingButton;

    loadSettings().then(() => {
      if (fabChanged) { if (fab) { fab.remove(); fab = null; } ensureUI(); }
      if (modeChanged && running) { stop(); start(); }
    });
  });
})();
