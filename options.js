/* options.js */

const DEFAULTS = {
  provider: 'openai',
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
  temperature: 0.2,
  systemPrompt: '',
  customHeaders: '',
  maxCharsPerBatch: 1600,
  maxSegmentsPerBatch: 16,
  concurrency: 2,
  autoTranslate: false,
  showFloatingButton: true,
  displayMode: 'bilingual',
  skipSelectors: ''
};

const PRESETS = {
  openai:    { provider: 'openai',    apiBase: 'https://api.openai.com/v1',                        model: 'gpt-4o-mini' },
  deepseek:  { provider: 'openai',    apiBase: 'https://api.deepseek.com/v1',                      model: 'deepseek-chat' },
  qwen:      { provider: 'openai',    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  moonshot:  { provider: 'openai',    apiBase: 'https://api.moonshot.cn/v1',                       model: 'moonshot-v1-8k' },
  zhipu:     { provider: 'openai',    apiBase: 'https://open.bigmodel.cn/api/paas/v4',             model: 'glm-4-flash' },
  ollama:    { provider: 'openai',    apiBase: 'http://localhost:11434/v1',                        model: 'qwen2.5:7b' },
  anthropic: { provider: 'anthropic', apiBase: 'https://api.anthropic.com',                        model: 'claude-sonnet-4-5' },
  gemini:    { provider: 'gemini',    apiBase: 'https://generativelanguage.googleapis.com',        model: 'gemini-2.0-flash' }
};

const FIELDS = [
  'provider', 'apiBase', 'apiKey', 'model', 'targetLang', 'temperature',
  'systemPrompt', 'customHeaders', 'maxCharsPerBatch', 'maxSegmentsPerBatch',
  'concurrency', 'autoTranslate', 'showFloatingButton', 'displayMode', 'skipSelectors'
];

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  await fillForm();
  renderSites();

  PRESET_BIND();
  $('save').addEventListener('click', save);
  $('test').addEventListener('click', test);
  $('reset').addEventListener('click', reset);
  $('pwToggle').addEventListener('click', togglePw);
  $('clearSites').addEventListener('click', clearSites);
}

function PRESET_BIND() {
  document.querySelectorAll('#presets .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const p = PRESETS[chip.dataset.preset];
      if (!p) return;
      $('provider').value = p.provider;
      $('apiBase').value = p.apiBase;
      $('model').value = p.model;
      msg(`已填入「${chip.textContent}」的默认配置，别忘了填 API Key`, '');
      $('apiKey').focus();
    });
  });
}

async function fillForm() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = Object.assign({}, DEFAULTS, settings || {});
  FIELDS.forEach((k) => {
    const el = $(k);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!s[k];
    else el.value = s[k] === undefined || s[k] === null ? '' : s[k];
  });
}

function readForm() {
  const out = {};
  FIELDS.forEach((k) => {
    const el = $(k);
    if (!el) return;
    if (el.type === 'checkbox') out[k] = el.checked;
    else if (el.type === 'number') out[k] = Number(el.value) || DEFAULTS[k];
    else out[k] = el.value.trim();
  });
  return out;
}

async function save() {
  const draft = readForm();
  const err = validate(draft);
  if (err) { msg(err, 'err'); return; }

  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: Object.assign({}, DEFAULTS, settings || {}, draft) });

  // 通知所有已打开的标签页刷新设置
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id) chrome.tabs.sendMessage(t.id, { type: 'llmt:settings-changed' }).catch(() => {});
  }
  msg('已保存 ✓', 'ok');
  setTimeout(() => msg(''), 2600);
}

function validate(s) {
  if (!s.apiBase) return '请填写 API 地址';
  if (!/^https?:\/\//i.test(s.apiBase)) return 'API 地址需要以 http:// 或 https:// 开头';
  if (!s.model) return '请填写模型名称';
  const isLocal = /localhost|127\.0\.0\.1/.test(s.apiBase);
  if (!s.apiKey && !isLocal) return '请填写 API Key（本地接口可留空）';
  if (s.customHeaders) {
    try { JSON.parse(s.customHeaders); }
    catch (e) { return '附加请求头不是合法的 JSON'; }
  }
  return null;
}

async function test() {
  const draft = readForm();
  const err = validate(draft);
  if (err) { msg(err, 'err'); return; }

  const btn = $('test');
  btn.disabled = true;
  msg('正在测试连接…', '');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'llmt:test', settings: draft });
    if (res && res.ok) {
      msg(`连接成功 ✓  示例：${res.sample}`, 'ok');
    } else {
      msg('测试失败：' + ((res && res.error) || '未知错误'), 'err');
    }
  } catch (e) {
    msg('测试失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function reset() {
  if (!confirm('恢复默认设置？API Key 也会被清空。')) return;
  await chrome.storage.local.set({ settings: Object.assign({}, DEFAULTS) });
  await fillForm();
  msg('已恢复默认设置', 'ok');
}

function togglePw() {
  const input = $('apiKey');
  const isPw = input.type === 'password';
  input.type = isPw ? 'text' : 'password';
  $('pwToggle').textContent = isPw ? '隐藏' : '显示';
}

async function renderSites() {
  const { sites } = await chrome.storage.local.get('sites');
  const box = $('sites');
  box.innerHTML = '';
  const entries = Object.entries(sites || {});
  if (!entries.length) {
    box.innerHTML = '<div class="empty">暂无记录。在页面上用悬浮按钮或 Alt+T 开关后，这里会显示。</div>';
    return;
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [host, on] of entries) {
    const row = document.createElement('div');
    row.className = 'site-row';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = host;

    const tag = document.createElement('span');
    tag.className = 'tag ' + (on ? 'on' : 'off');
    tag.textContent = on ? '自动翻译' : '已关闭';

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '移除';
    del.addEventListener('click', async () => {
      const cur = await chrome.storage.local.get('sites');
      const next = Object.assign({}, cur.sites || {});
      delete next[host];
      await chrome.storage.local.set({ sites: next });
      renderSites();
    });

    row.append(name, tag, del);
    box.appendChild(row);
  }
}

async function clearSites() {
  await chrome.storage.local.set({ sites: {} });
  renderSites();
  msg('已清空站点记录', 'ok');
}

function msg(text, kind) {
  const el = $('msg');
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}
