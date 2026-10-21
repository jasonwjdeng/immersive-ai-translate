/* popup.js */
const $ = (s) => document.querySelector(s);

let tab = null;
let tabOk = false;
let settings = {};

document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = active;

  const res = await chrome.storage.local.get(['settings', 'sites']);
  settings = Object.assign({}, res.settings || {});

  $('#model').textContent = settings.model || '未配置';
  $('#model').title = `${settings.provider || 'openai'} · ${settings.model || ''}`;

  const missing = !settings.apiKey && !/localhost|127\.0\.0\.1/.test(settings.apiBase || '');
  $('#warn').classList.toggle('show', missing);

  if (!tab || !/^https?:|^file:/.test(tab.url || '')) {
    $('#host').textContent = '此页面不支持翻译';
    $('#toggle').disabled = true;
    $('#retranslate').disabled = true;
    return;
  }

  $('#host').textContent = new URL(tab.url).hostname;
  tabOk = true;

  const state = await getState();
  renderState(state);
  bind();
}

async function getState() {
  if (!tabOk) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'llmt:state' });
  } catch (e) {
    // 扩展刚安装、页面还没注入内容脚本 → 补注入（Safari 旧版可能没有 scripting）
    try {
      if (!chrome.scripting || !chrome.scripting.executeScript) throw new Error('无 scripting 权限');
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await new Promise((r) => setTimeout(r, 200));
      return await chrome.tabs.sendMessage(tab.id, { type: 'llmt:state' });
    } catch (e2) {
      return null;
    }
  }
}

function openOptions() {
  try {
    if (typeof chrome.runtime.openOptionsPage === 'function') {
      chrome.runtime.openOptionsPage();
      return;
    }
  } catch (e) { /* 兜底 */ }
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  } catch (e) { /* ignore */ }
}

function renderState(state) {
  const on = !!(state && state.running);
  const btn = $('#toggle');
  btn.textContent = on ? '恢复原文' : '翻译此页';
  btn.classList.toggle('on', on);

  const mode = (state && state.settings && state.settings.displayMode) || settings.displayMode || 'bilingual';
  setSeg(mode);

  if (state && state.doneCount) {
    setStatus(`已翻译 ${state.doneCount} 段`);
  } else if (!state) {
    setStatus('请刷新页面后重试', true);
  }
}

function setSeg(mode) {
  document.querySelectorAll('#seg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
}

function setStatus(text, isErr) {
  const s = $('#status');
  s.textContent = text || '';
  s.classList.toggle('err', !!isErr);
}

function bind() {
  $('#toggle').addEventListener('click', async () => {
    const btn = $('#toggle');
    btn.disabled = true;
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'llmt:toggle' });
      const on = !!(r && r.running);
      btn.textContent = on ? '恢复原文' : '翻译此页';
      btn.classList.toggle('on', on);
      setStatus(on ? '已开启，正在翻译…' : '');
    } catch (e) {
      setStatus('请刷新页面后重试', true);
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelectorAll('#seg button').forEach((b) => {
    b.addEventListener('click', async () => {
      setSeg(b.dataset.mode);
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'llmt:set-mode', mode: b.dataset.mode });
        setStatus(b.dataset.mode === 'replace' ? '已切换为仅译文' : '已切换为中英对照');
      } catch (e) {
        setStatus('请刷新页面后重试', true);
      }
    });
  });

  $('#retranslate').addEventListener('click', async () => {
    setStatus('正在重新扫描页面…');
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'llmt:retranslate' });
      $('#toggle').textContent = '恢复原文';
      $('#toggle').classList.add('on');
      setStatus('已重新开始翻译');
    } catch (e) {
      setStatus('请刷新页面后重试', true);
    }
  });

  $('#options').addEventListener('click', openOptions);
  $('#warnLink').addEventListener('click', openOptions);
}
