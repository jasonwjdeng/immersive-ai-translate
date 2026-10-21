# 沉浸式 AI 翻译 · Immersive AI Translate

一个跑在你本机浏览器里的网页翻译插件：**用你自己的大模型接口**，把网页实时翻译成中文，**原文与译文对照显示**。

<div align="center">
  <img src="icons/icon128.png" width="96" alt="icon" />
</div>

---

## 一、它做了什么

| 能力 | 说明 |
| --- | --- |
| 段落级双语对照 | 每个段落下方插入一条译文，原文不动，不破坏网页结构 |
| 视口懒加载 | 只翻译滚动到附近的段落，长页面不会一次性烧光 token |
| 动态内容 | `MutationObserver` 监听，无限滚动 / SPA 路由切换后的新内容会自动补译 |
| 自定义模型 | OpenAI 兼容接口 / Anthropic / Gemini 三套协议，任意模型 |
| 站点记忆 | 每个网站单独记住开/关状态，关闭的网站永不自动翻译 |
| 译文缓存 | 同页重复文本直接命中内存缓存；切换显示模式不重复请求 |
| 仅译文模式 | 一键隐藏原文，只看译文 |
| 提示词可改 | 内置提示词不满意可整段替换 |

支持的接口（含一键预设）：OpenAI、DeepSeek、阿里通义（DashScope 兼容模式）、月之暗面 Kimi、智谱 GLM、Ollama 本地模型、Anthropic、Google Gemini，以及任何自建 OpenAI 兼容网关（vLLM / LM Studio / one-api 等）。

## 二、安装

1. 打开 Chrome（或 Edge）→ 地址栏输入 `chrome://extensions`（Edge 为 `edge://extensions`）。
2. 右上角打开 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择本目录 `immersive-ai-translate`（含 `manifest.json` 的这一层）。
4. 工具栏会出现一个紫色「译」图标，建议固定到工具栏。

> 首次安装后，已经打开的页面需要刷新一次，内容脚本才会注入。

**只在这台电脑上运行**：不发布、不上架、不联网除你自己的模型接口外不发任何请求；API Key 存在 `chrome.storage.local`。

> **Safari 用户**：Safari 不支持"加载已解压的扩展"，必须用 Xcode 把项目转成 Safari Web Extension 并签名，成本较高。
> 本机的具体条件、完整步骤与已知差异写在 [`SAFARI.md`](SAFARI.md) 里。

## 三、首次配置

点扩展图标 → **设置**（或右键图标 → 沉浸式翻译 · 设置）：

1. 点一个服务商预设（例如 DeepSeek），会自动填好地址和模型名。
2. 填 **API Key**。
3. 点 **测试连接**，看到「连接成功 ✓ 示例：…」就说明通了。
4. 点 **保存设置**。

### 本地 Ollama（不花钱、不出网）

```bash
ollama serve
ollama pull qwen2.5:7b
```

设置里选「Ollama（本地）」预设 → API Key 留空 → 保存。建议把并发调成 1、每批字符调到 800。

## 四、怎么用

- **页面右下角悬浮按钮**：点一下开始翻译，再点恢复原文（按钮变绿表示已开启）。
- **快捷键 `Alt + T`**：受 Chrome 快捷键限制，可在 `chrome://extensions/shortcuts` 里改成你喜欢的组合。
- **右键菜单**：AI 翻译此页 / 恢复原文。
- **扩展图标弹窗**：切换「中英对照 / 仅译文」、重新翻译、进设置。

想让所有网站一进来就自动翻译：设置里勾选 **自动翻译所有网站**（默认关闭，避免无谓消耗）。

## 五、工作原理

```
页面 DOM
  └─ content.js  遍历块级元素 → 取段落文本（跳过 code/pre/导航等）
        ↓ IntersectionObserver 只挑视口附近的
        ↓ 按「字符数 + 段数」打包
  └─ background.js  加提示词 → 调你的模型 → 解析 [[序号]] 译文
        ↓
  └─ content.js  在段落末尾插入 <span class="llmt-translation">译文</span>
```

- 批量翻译用 `[[0]] 译文` 的行格式而非 JSON，省 token 且对格式抖动更宽容；解析失败会自动把批次拆半重试。
- 目标语言是中文时，已经基本是中文的段落会被跳过（`isAlreadyTarget`），避免无意义请求。

## 六、文件结构

```
immersive-ai-translate/
├── manifest.json        扩展清单（MV3）
├── background.js        Service Worker：设置存储 + 模型调用 + 命令分发
├── content.js           内容脚本：抽取、懒加载、渲染、站点开关
├── content.css          译文/悬浮按钮/提示条样式
├── popup.html/js        工具栏弹窗
├── options.html/js      设置页
├── icons/               图标（由 tools/make_icons.py 生成）
├── tools/make_icons.py  纯标准库图标生成器
└── demo/test-page.html  本地测试页（英文文章，含代码块/引用/嵌套卡片）
```

## 七、常见问题

**译文一条条慢慢出现，正常吗？**
正常。按视口分批请求，滚到哪译到哪。想一次全译可以调大「每批最大字符」和「并发请求数」。

**报 429 / 限流**
把并发降到 1，每批字符降到 800–1200。

**某段没翻译**
多半是它被判定为「已是目标语言」，或位于 `code/pre`、按钮、表单里（默认跳过）。也可能是元素只有图片/图标没有文字。

**译文顺序乱了 / 少了**
模型没按序号返回。插件会自动拆半重试；如经常发生，换一个更强的模型或调小批量。

**`file://` 本地网页不翻译**
`chrome://extensions` → 该扩展 → 详情 → 打开「允许访问文件网址」。

**改了样式想自定义**
`content.css` 里 `span.llmt-translation` 那一段就是译文样式（左边框颜色、缩进、透明度），改完在扩展页点「重新加载」。

**换了 API 后不生效**
保存设置后，设置会广播给所有标签页；如果仍不生效，刷新页面。

## 八、隐私

- 页面文本只会发往你在设置里填写的 API 地址，没有中间服务器。
- Key 与设置在本地 `chrome.storage.local`，卸载扩展即删除。
- 不收集任何统计、不上报任何数据。
