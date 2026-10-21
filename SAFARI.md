# 在 Safari 上使用这个扩展

## 先说结论

**这台机器目前装不了**，缺的是一个绕不过去的工具链：

| 检查项 | 本机实际 | 影响 |
| --- | --- | --- |
| macOS | 12.7.6 (Monterey) | 决定能用哪个版本的 Xcode |
| Xcode | ❌ 未安装（只有 Command Line Tools） | **没有转换工具，无法生成 Safari 扩展工程** |
| `safari-web-extension-converter` | ❌ 不存在 | 它在 Xcode.app 里面，CLT 不带 |
| Safari | 17.6 | 支持 Web Extension，本身没问题 |
| 磁盘可用 | 58 GB | 够，但不宽裕（Xcode 装完约 20 GB） |

Safari **不能像 Chrome 那样"加载已解压的扩展"**。Apple 的规矩是：扩展必须打包成一个已签名的 macOS App（App 里套 appex），再注册到系统，Safari 才能在设置里看到它。这个 App 只能用 Xcode 编译出来。

而 Monterey 12.7.6 能安装的最后一个 Xcode 是 **14.2**（Xcode 14.3 起要求 macOS 13+），App Store 已经不给 Monterey 提供 Xcode 了，必须从 Apple 开发者网站手动下载 7 GB 的 `.xip`。

---

## 三条路，先算成本

| 方案 | 成本 | 结果 |
| --- | --- | --- |
| **A. 继续用 Chrome**（推荐） | 0，已装好并验证通过 | 功能完整，立刻可用 |
| **B. 装 Xcode 转换到 Safari** | 下载 7 GB + 磁盘 20 GB + 首次配置约 1 小时 + **每 7 天重新签名** | 功能基本可用，但少快捷键 |
| **C. Safari 自带翻译** | 0 | 只能整页机翻，没有中英对照、没有自定义模型 |

如果你只是想要"Safari 里也能读英文网页"，方案 C 其实够用：Safari 地址栏右侧有翻译按钮（Safari 17 自带），右键也能翻译选中的段落。它不联网到你自己的模型，也没有双语对照。

下面写方案 B 的完整步骤，你决定走再动手。

---

## 方案 B：把扩展转成 Safari Web Extension

### B1. 安装 Xcode 14.2

1. 打开 <https://developer.apple.com/download/all/?q=Xcode%2014.2>（需登录 Apple ID，免费账号即可）。
2. 下载 `Xcode_14.2.xip`（约 7 GB，别用浏览器断点续传容易坏，用 Safari 或 `curl -L` 下载）。
3. 解压（你装了 The Unarchiver，双击即可；或命令行 `xip -x Xcode_14.2.xip`）。
4. 把解压出来的 `Xcode.app` 拖到 `/Applications`。
5. 切换工具链并接受协议：

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
```

6. 打开一次 Xcode，让它装完 "additional components"。
7. 验证：

```bash
xcrun safari-web-extension-converter --help
```

能打出帮助就说明工具链就绪。

### B2. 转换工程

```bash
cd ~/WorkBuddy/2026-10-20-14-01-28

xcrun safari-web-extension-converter \
  ./immersive-ai-translate \
  --project-location ./safari-build \
  --app-name "Immersive AI Translate" \
  --bundle-identifier com.local.immersiveaitranslate \
  --swift \
  --macos-only \
  --copy-resources \
  --no-open \
  --no-prompt \
  --force
```

- `--copy-resources` 很关键：默认是引用原目录，原目录一动 Xcode 工程就找不到资源。
- App 名用英文，避免后面 xcodebuild 路径里的空格和中文。
- 转换完会打印一串 **warning**，重点看有没有提到 `background`、`commands`、`permissions`。`commands`（Alt+T 快捷键）在 Safari 里不支持，警告可以忽略。

### B3. 编译与签名

Safari 要求 App 被签名。两种方式：

**方式一：Xcode 图形界面（最省事）**

1. `open ./safari-build/Immersive\ AI\ Translate/Immersive\ AI\ Translate.xcodeproj`
2. 左侧选中项目 → TARGETS 里两个 target（App 和 Extension）分别进 **Signing & Capabilities**。
3. Team 选你的 Apple ID（Xcode → Settings → Accounts 里先登录，免费账号会显示 "Personal Team"）。
4. Bundle Identifier 如果冲突，改成 `com.你的名字.immersiveaitranslate`。
5. 顶部 scheme 选 App，按 `⌘R` 运行一次。

**方式二：命令行 + 本地临时签名（不需要 Apple ID）**

```bash
cd "./safari-build/Immersive AI Translate"
xcodebuild -project "Immersive AI Translate.xcodeproj" \
  -scheme "Immersive AI Translate" \
  -configuration Release \
  -derivedDataPath ./build \
  CODE_SIGN_IDENTITY="-" \
  CODE_SIGNING_REQUIRED=YES \
  CODE_SIGNING_ALLOWED=YES \
  build
```

产物在 `./build/Build/Products/Release/Immersive AI Translate.app`，复制到 `/Applications` 并打开一次：

```bash
cp -R "./build/Build/Products/Release/Immersive AI Translate.app" /Applications/
open "/Applications/Immersive AI Translate.app"
```

### B4. 在 Safari 里启用

1. Safari → 设置 → **高级** → 勾选「**显示网页开发者功能**」。
2. 菜单栏 **开发** → 勾选「**允许未签名扩展**」（用方式二签名时必做；用方式一正式签名可跳过）。
3. Safari → 设置 → **扩展** → 左侧找到「Immersive AI Translate」→ 勾选启用。
4. 在同一页把 **权限** 改成「允许访问所有网站」，否则内容脚本不会注入。
5. 点工具栏的扩展图标 → 首次会打开设置页，填 API Key，点「测试连接」。

### B5. 会遇到的三个坑

**① 免费账号签名 7 天过期**

用 Personal Team 签名，证书 7 天后失效，App 打不开。解决：重新 `⌘R` 跑一次，或改用方式二（ad-hoc 签名不过期，但要配合"允许未签名扩展"）。

**② 「允许未签名扩展」每次重启 Safari 都会失效**

这是 Apple 的开发调试开关，Safari 重启后要重新勾一次（开发 → 允许未签名扩展）。嫌烦就买 Apple Developer 正式账号（$99/年）做正式签名。

**③ 改了扩展代码要重新编译**

Safari 不像 Chrome 有"重新加载"按钮。改完 `content.js` 后要回到 Xcode 重新 `⌘R`，再回 Safari 刷新页面。

---

## Safari 上的功能差异

| 功能 | Safari | 说明 |
| --- | --- | --- |
| 段落双语对照 | ✅ | 核心功能一致 |
| 仅译文模式 | ✅ | |
| 悬浮按钮 | ✅ | |
| 弹窗（显示方式/重新翻译） | ✅ | |
| 设置页 | ✅ | |
| 视口懒加载 / 动态内容 | ✅ | |
| **Alt+T 快捷键** | ❌ | Safari 不支持扩展自定义全局快捷键，只能用悬浮按钮或工具栏图标 |
| **右键菜单** | ⚠️ | `contextMenus` 在 Safari 支持，但 `contexts: ['action']` 那一条可能不显示 |
| 站点记忆 | ✅ | 存在 Safari 的扩展容器里，与 Chrome 不互通 |

代码层面已经做了兼容处理：`commands` / `contextMenus` / `onStartup` 都做了存在性探测，缺失时不会让后台脚本崩溃（这一条不改，Safari 上一开就会整片失效）。

---

## 排错

**转换时报 "Unsupported manifest version"**
Xcode 14.2 的 converter 对 MV3 支持有限。先把 `manifest.json` 里的 `"commands"` 整段删掉再转。

**Safari 设置里看不到扩展**
1. App 是否真的打开过（LaunchServices 需要注册一次）；
2. 开发菜单里「允许未签名扩展」是否勾上；
3. 终端跑 `pluginkit -mAvvv -p com.apple.Safari.web-extension` 看扩展是否被系统识别。

**扩展启用了但不翻译**
Safari 设置 → 扩展 → 该扩展 → 权限必须是「允许访问所有网站」。Safari 默认只给「询问」，不授权的话内容脚本不会运行。

**译文不出现、控制台报 CORS**
Safari 对扩展后台的跨域请求校验比 Chrome 严。检查 `manifest.json` 的 `host_permissions` 是否包含你的 API 域名（当前是 `<all_urls>`，一般没问题）；用本地 Ollama 时地址要写成 `http://localhost:11434/v1`。

---

## 我的建议

装 Xcode 只为了跑一个翻译插件，性价比很低：7 GB 下载、20 GB 磁盘、每 7 天重签或每次重启 Safari 重新授权。**日常阅读英文网页，Chrome 那个版本已经跑通并验证过了，直接用就好。**

如果确实不喜欢 Chrome，可以考虑 Edge / Brave / Arc —— 它们都是 Chromium，`加载已解压的扩展程序` 流程完全一样，零改动。
