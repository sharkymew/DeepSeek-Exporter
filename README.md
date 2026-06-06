# DeepSeek Exporter

DeepSeek Exporter 是一个零依赖 Chrome Manifest V3 扩展，用于从 `chat.deepseek.com` 导出选中的 DeepSeek 对话。

## 功能

- 从 DeepSeek 侧边栏读取当前已加载的会话。
- 支持用户滚动侧边栏后刷新，增量识别更多会话。
- 支持多选会话并在后台标签页逐个抓取。
- 导出一个 ZIP，每个会话一个目录，目录内包含：
  - `conversation.md`
  - `conversation.json`
- 支持开关控制是否导出 DeepSeek 页面中可见的思考/推理内容。

## 安装与使用

1. 打开 Chrome 的 `chrome://extensions`。
2. 开启开发者模式。
3. 点击“加载已解压的扩展程序”，选择扩展。目录
4. 打开或刷新 `https://chat.deepseek.com/` 并登录。
5. 点击浏览器工具栏里的 DeepSeek Exporter。
6. 在 popup 中刷新、勾选会话并导出 ZIP。

如果侧边栏中还有更多历史会话，先在 DeepSeek 页面向下滚动侧边栏，再回到 popup 点击“刷新”。
如果你是在 DeepSeek 页面已经打开后才加载扩展，需要先刷新 DeepSeek 页面一次。

## 数据与权限

扩展只声明：

- `host_permissions`: `https://chat.deepseek.com/*`
- `permissions`: `tabs`, `downloads`

它不调用 DeepSeek 私有接口，不上传对话内容，也不把数据发往任何外部服务。导出只基于当前浏览器已经能访问的 DeepSeek 页面 DOM。

## 验证

```bash
node --check background.js
node --check content.js
node --check popup.js
node --check zip.js
python3 -m json.tool manifest.json
```

## 已知限制

- DeepSeek 页面结构变化可能导致选择器需要更新。
- 批量导出依赖后台标签逐个打开页面，网络慢或会话过长时会比较耗时。
- ZIP 采用未压缩 store 格式，避免引入依赖；文件体积不会被压缩。
- MV3 service worker 使用 data URL 触发下载，超大导出可能受浏览器 data URL 大小限制。
