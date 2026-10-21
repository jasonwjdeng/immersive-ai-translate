/**
 * 沉浸式 AI 翻译 — Service Worker
 * 负责：设置读写、调用自定义大模型、命令/右键菜单分发
 */

const DEFAULTS = {
  provider: 'openai',            // openai | anthropic | gemini
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
  temperature: 0.2,
  systemPrompt: '',              // 留空则用内置提示词
  customHeaders: '',             // JSON 字符串，附加到请求头
  maxCharsPerBatch: 1600,
  maxSegmentsPerBatch: 16,
  concurrency: 2,
  autoTranslate: false,          // 未单独设置过的站点是否自动翻译
  showFloatingButton: true,
  displayMode: 'bilingual',      // bilingual | replace
  skipSelectors: ''              // CSS 选择器，命中的元素不翻译
};

const DEFAULT_SYSTEM = (target) =>
  `你是一个专业的网页翻译引擎，负责把网页内容翻译成${target}。` +
  `你的译文准确、自然、符合${target}的表达习惯，读起来像是原文作者用${target}写的。` +
  `你会保留原文的数字、专有名词、代码、URL 与格式标记。`;

/* ------------------------------------------------------------------ */
/* 安装 / 启动                                                         */
/* ------------------------------------------------------------------ */

/* Safari 的 WebExtension 实现里部分 API（commands / contextMenus / onStartup）
   可能不存在。顶层直接调用会让整个后台脚本抛错而彻底失效，所以统一做探测。 */
const hasApi = (obj, key) => !!(obj && obj[key] && typeof obj[key].addListener === 'function');

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(null);
  await chrome.storage.local.set({
    settings: Object.assign({}, DEFAULTS, cur.settings || {}),
    sites: cur.sites || {}
  });
  buildMenus();
});

if (hasApi(chrome.runtime, 'onStartup')) {
  chrome.runtime.onStartup.addListener(buildMenus);
}

function openOptions() {
  try {
    if (typeof chrome.runtime.openOptionsPage === 'function') {
      chrome.runtime.openOptionsPage();
      return;
    }
  } catch (e) { /* 落到下面的兜底 */ }
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  } catch (e) { /* ignore */ }
}

function buildMenus() {
  if (!chrome.contextMenus || typeof chrome.contextMenus.create !== 'function') return;
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'llmt-toggle',
        title: 'AI 翻译此页 / 恢复原文',
        contexts: ['page', 'selection']
      });
      chrome.contextMenus.create({
        id: 'llmt-options',
        title: '沉浸式翻译 · 设置',
        contexts: ['action']
      });
    });
  } catch (e) {
    console.warn('[llmt] 右键菜单创建失败：', e && e.message);
  }
}

if (hasApi(chrome.contextMenus, 'onClicked')) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'llmt-options') {
      openOptions();
      return;
    }
    if (info.menuItemId === 'llmt-toggle' && tab && tab.id) {
      await sendToTab(tab.id, { type: 'llmt:toggle' });
    }
  });
}

if (hasApi(chrome.commands, 'onCommand')) {
  chrome.commands.onCommand.addListener(async (cmd) => {
    if (cmd !== 'toggle-translate') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) await sendToTab(tab.id, { type: 'llmt:toggle' });
  });
}

/* 给标签页发消息；内容脚本没注入时（例如扩展刚安装）自动补注入一次 */
async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    try {
      if (!chrome.scripting || !chrome.scripting.executeScript) throw new Error('无 scripting 权限');
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await sleep(150);
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e2) {
      console.warn('[llmt] 无法连接到页面：', e2 && e2.message);
      return null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'llmt:translate') {
    handleTranslate(msg.texts)
      .then((translations) => sendResponse({ translations }))
      .catch((err) => sendResponse({ error: err && err.message ? err.message : String(err) }));
    return true;
  }

  if (msg.type === 'llmt:test') {
    testProvider(msg.settings)
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }

  if (msg.type === 'llmt:open-options') {
    openOptions();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'llmt:get-settings') {
    getSettings().then((s) => sendResponse({ settings: s }));
    return true;
  }
});

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULTS, settings || {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 翻译主流程                                                          */
/* ------------------------------------------------------------------ */

async function handleTranslate(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const s = await getSettings();

  const isLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(s.apiBase || '');
  if (!s.apiKey && !isLocal) {
    throw new Error('未配置 API Key，请点开扩展设置填写（本地 Ollama 等可免 Key）');
  }
  if (!s.apiBase) throw new Error('未配置 API 地址');
  if (!s.model) throw new Error('未配置模型名称');

  const prompt = buildUserPrompt(texts, s);
  const raw = await withRetry(() => callProvider(s, prompt, texts), 2);
  const parsed = parseTranslations(raw, texts.length);

  if (!parsed.some(Boolean)) {
    throw new Error('模型没有返回可解析的译文（可尝试更换模型或调低批量大小）');
  }
  return parsed;
}

function buildUserPrompt(texts, s) {
  const body = texts
    .map((t, i) => `[[${i}]] ${String(t).replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  const source = s.sourceLang && s.sourceLang !== 'auto' ? `（原文语言：${s.sourceLang}）` : '';
  return (
    `请把下面每个片段翻译成${s.targetLang}${source}。\n\n` +
    `要求：\n` +
    `1. 逐条翻译，输出格式严格为 [[序号]] 译文，序号必须与原文一一对应，不得合并、拆分或遗漏。\n` +
    `2. 只输出译文与序号，不要输出原文，不要任何解释、标题或客套话。\n` +
    `3. 保留数字、专有名词、代码片段、URL、Markdown 标记与表情符号。\n` +
    `4. 译文通顺自然，符合${s.targetLang}表达习惯，不要生硬直译。\n` +
    `5. 如果某个片段本身已经是${s.targetLang}或无需翻译，原样输出。\n\n` +
    `待翻译片段：\n${body}`
  );
}

/* 解析 [[n]] 译文 格式；容错：允许模型用代码块包裹或加了粗体 */
function parseTranslations(raw, n) {
  const out = new Array(n).fill('');
  if (!raw || typeof raw !== 'string') return out;

  const text = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');

  const re = /\[\[\s*(\d+)\s*\]\]\s*([\s\S]*?)(?=\s*\[\[\s*\d+\s*\]\]|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const i = parseInt(m[1], 10);
    if (i >= 0 && i < n) {
      out[i] = m[2].replace(/^\s*[:：\-–—]\s*/, '').trim();
    }
  }

  // 兜底：模型没按格式来，但行数刚好对得上，则按行顺序赋值
  if (!out.some(Boolean)) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const cleaned = lines
      .map((l) => l.replace(/^\[?\[?\d+\]?\]?\s*[:：.\-]?\s*/, '').trim())
      .filter(Boolean);
    if (cleaned.length === n) return cleaned;
  }
  return out;
}

async function withRetry(fn, times) {
  let last;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String(e && e.message);
      const retriable = /429|5\d\d|timeout|超时|network|Failed to fetch|aborted/i.test(msg);
      if (!retriable || i === times - 1) throw e;
      await sleep(700 * (i + 1));
    }
  }
  throw last;
}

/* ------------------------------------------------------------------ */
/* 各家协议适配                                                        */
/* ------------------------------------------------------------------ */

async function callProvider(s, userPrompt, texts) {
  const system = (s.systemPrompt && s.systemPrompt.trim()) || DEFAULT_SYSTEM(s.targetLang);
  const base = String(s.apiBase || '').replace(/\/+$/, '');
  const extraHeaders = parseHeaders(s.customHeaders);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);

  try {
    if (s.provider === 'anthropic') {
      const url = /\/v1\/messages$/.test(base) ? base : `${base}/v1/messages`;
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: Object.assign(
          {
            'content-type': 'application/json',
            'x-api-key': s.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          extraHeaders
        ),
        body: JSON.stringify({
          model: s.model,
          max_tokens: 8192,
          temperature: Number(s.temperature) || 0,
          system,
          messages: [{ role: 'user', content: userPrompt }]
        })
      });
      const data = await readJSON(res);
      if (data.error) throw new Error(`Anthropic: ${data.error.message || JSON.stringify(data.error)}`);
      const blocks = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text);
      return blocks.join('\n');
    }

    if (s.provider === 'gemini') {
      const url =
        `${base}/v1beta/models/${encodeURIComponent(s.model)}:generateContent?key=${encodeURIComponent(s.apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: Object.assign({ 'content-type': 'application/json' }, extraHeaders),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: Number(s.temperature) || 0 }
        })
      });
      const data = await readJSON(res);
      if (data.error) throw new Error(`Gemini: ${data.error.message || JSON.stringify(data.error)}`);
      const cand = (data.candidates || [])[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      return parts.map((p) => p.text || '').join('\n');
    }

    /* 默认：OpenAI 兼容协议 */
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
    const body = {
      model: s.model,
      temperature: Number(s.temperature) || 0,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt }
      ]
    };

    let data = await postOpenAI(url, s, body, extraHeaders, ctrl);
    // 部分推理模型不接受 temperature，退一步重试
    if (data && data.error && /temperature/i.test(JSON.stringify(data.error))) {
      delete body.temperature;
      data = await postOpenAI(url, s, body, extraHeaders, ctrl);
    }
    if (data.error) {
      const em = data.error.message || JSON.stringify(data.error);
      throw new Error(`接口错误：${em}`);
    }
    const choice = (data.choices || [])[0];
    if (!choice) throw new Error('接口返回为空');
    return (choice.message && choice.message.content) || '';
  } finally {
    clearTimeout(timer);
  }
}

async function postOpenAI(url, s, body, extraHeaders, ctrl) {
  const res = await fetch(url, {
    method: 'POST',
    signal: ctrl.signal,
    headers: Object.assign(
      {
        'content-type': 'application/json',
        authorization: `Bearer ${s.apiKey}`
      },
      extraHeaders
    ),
    body: JSON.stringify(body)
  });
  return readJSON(res);
}

async function readJSON(res) {
  const txt = await res.text();
  let data;
  try {
    data = txt ? JSON.parse(txt) : {};
  } catch (e) {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）：${txt.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg =
      (data && data.error && (data.error.message || data.error.type)) ||
      (data && data.message) ||
      `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new Error(`鉴权失败（HTTP ${res.status}）：${msg}`);
    if (res.status === 404) throw new Error(`接口或模型不存在（HTTP 404）：${msg}`);
    throw new Error(`${msg}（HTTP ${res.status}）`);
  }
  return data;
}

function parseHeaders(str) {
  if (!str || !str.trim()) return {};
  try {
    const obj = JSON.parse(str);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* 连通性测试                                                          */
/* ------------------------------------------------------------------ */

async function testProvider(draft) {
  const s = Object.assign({}, DEFAULTS, draft || {});
  const sample = ['The quick brown fox jumps over the lazy dog.', 'Translation makes the web readable.'];
  const prompt = buildUserPrompt(sample, s);
  const raw = await withRetry(() => callProvider(s, prompt, sample), 1);
  const parsed = parseTranslations(raw, 2);
  if (!parsed.some(Boolean)) {
    return { ok: false, error: '调用成功但无法解析译文，原始返回：' + String(raw).slice(0, 300) };
  }
  return { ok: true, sample: parsed.filter(Boolean).join(' / ') };
}
