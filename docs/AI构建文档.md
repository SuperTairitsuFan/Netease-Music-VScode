# AI / 自动化构建文档（0.2.3）

本文件面向后续 AI 助手或维护者：这个仓库是什么、怎么构建、哪些设计是“有原因的”，改功能时应该动哪里。

## 一句话状态

0.2.3 已完成 EAPI 传输、PC 风侧边栏 / 歌单主界面 / 状态栏播放控制 / 客户端风格设置、评论与收藏者、音质标签与 7 档音质、原生音频组件与三平台打包。未做真实账号 / 真实声卡端到端听感验证。

## 环境

- Node.js ≥ 20（开发环境 24.x），npm。
- TypeScript 5.5、esbuild 0.23、`@vscode/vsce` 2.32。
- 原生引擎用 zig 0.15.x 交叉编译；ALSA 头文件已 vendored。
- Windows 下测试脚本不再依赖 `python3`（zip 用 `node:zlib` 生成）。

## 常用命令

```bash
npm install
npm run typecheck
npm run build
npm test
npm run build:native
npm run package -- win32-x64
```

## esbuild

- host：`src/extension.ts` → `dist/extension.js`，CJS，`external: ["vscode"]`。
- webview 三个入口：
  - `src/webview/sidebar.ts` → `dist/sidebar.js`
  - `src/webview/main.ts` → `dist/webview.js` + `dist/webview.css`
  - `src/webview/settings.ts` → `dist/settings.js`
- `webview.css` 只在 `main.ts` 里 import，三个 surface 的 HTML 都链接它；不要让 sidebar/settings 再 import，否则会多出重复 CSS。
- `--watch` 同时监听四个 bundle。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `src/extension.ts` | 激活入口 |
| `src/app.ts` | 命令、状态栏、导航、页面切换、登录、组件、下载 |
| `src/protocol.ts` | 宿主 ↔ 三个 Webview 的消息类型；改消息两端一起改 |
| `src/api/http.ts` | 唯一传输：EAPI 签名、`#14` 解密、Cookie 指纹、限速/重试 |
| `src/api/client.ts` | 所有端点 |
| `src/api/normalize.ts` | 原始响应 → UI 类型（注意 `commentId`、`cover`、`privileges`） |
| `src/views/sidebarView.ts` | 侧边栏 WebviewView；同时是 WebAudio 持久宿主 |
| `src/views/mainPanel.ts` | 编辑器区内容面板 |
| `src/views/settingsPanel.ts` | 设置面板 |
| `src/webview/sidebar.ts` | 侧边栏 UI + AudioEngine |
| `src/webview/main.ts` | 主界面 UI |
| `src/webview/settings.ts` | 设置 UI |
| `native/src/` | C 引擎 |
| `scripts/` | 原生构建、平台打包 |

## 关键设计决策（改之前先读）

1. **只走 EAPI**：所有数据请求都是 `POST /eapi/...` + `params`；不要再加网页端 `GET /api/...` 或首页 bootstrap。
2. **EAPI 签名用 `/api/...`**：HTTP 端点才替换成 `/eapi/...`；签成 `/eapi/...` 会 404。
3. **完整 Cookie 指纹**：只发 `os=pc` 会 `-462`。
4. **WebAudio 宿主在侧边栏**：主界面关闭不应停播；侧边栏 `retainContextWhenHidden`。原生路径由宿主输出，更可靠。
5. **CDN 无 CORS**：原生路径必须宿主下载到缓存，再用 `webview.asWebviewUri()`；WebAudio 用 `<audio>` 且不要设 `crossOrigin`。
6. **原生 PCM 永远 f32le**：`bits/sampleFormat` 只描述设备输出；不要在前端改 16/24 bit。
7. **不做重采样**：手动采样率 ≠ 音源时明确报错。
8. **原生失败不静默回退**：`output.mode=native` 必须报错；`auto` 才回退并 toast。
9. **组件目录独立于 node_modules**：用 `ComponentStore`。
10. **Webview 无框架**：模板字符串 + 事件委托；所有文本 `esc()`。
11. **评论 id 是 `commentId`**：不是 `id`；`normalizeComment` 已兼容。
12. **歌单详情没有 `privileges`**：需要 `/api/song/enhance/privilege` 补 `maxBrLevel`。
13. **排行榜封面字段是 `cover`**：不是 `coverImgUrl`；`normalizeToplist` 已兼容。
14. **设置标签命令要区分 surface**：`App.dispatch` 的 `tab` 在 `settings` surface 只改 `settingsTab`，不能走主界面的 `setPageTab`。

## 原生引擎协议速查

stdin：`[1 字节 type][4 字节 LE length][payload]`，1=control JSON，2=PCM，3=END。
stdout：每行 JSON，`ready/configured/started/progress/underrun/drained/deviceLost/error`。

## 测试

- `npm test`：组件清单、原生 null 后端、zip 解压、EAPI 加密/解密、归一化。
- jsdom 冒烟（非仓库依赖，可按需 `npm i --no-save jsdom`）：
  - `dist/sidebar.js` + `sidebarInit`
  - `dist/webview.js` + `init`（歌单/评论/推荐）
  - `dist/settings.js` + `settingsInit`（音质/组件）
- 宿主激活冒烟：用 `vscode` stub 加载 `dist/extension.js`，验证 38 个命令、三个面板 init、歌单打开。
- 实网测试不要放进 CI：接口可能限流 / 风控。

## 已知坑

- `qrcode` 是运行时依赖，esbuild 会打进去；不要改成 external。
- `@types/vscode` 版本必须 ≤ `engines.vscode`。
- 请求串行 + 180ms 最小间隔；批量拉歌单不要 `Promise.all` 打满。
- 大型歌单先拿 `trackIds`，再 `/api/v3/song/detail` 500 条分块，最后 privilege 500 条分块。
- `songUrl` 单曲 `data[0].code` 可能非 0；外层 200 不代表成功。
- `expi` 默认 1200 秒；缓存 TTL 用 `expi - 10`。
- 原生路径 `OfflineAudioContext` 解码后采样率必须与请求一致。
- Windows 打包脚本使用 `vsce.cmd`；`--skip-build` 可复用已有 dist 和 components。

## 继续开发建议

1. 用真实账号验证扫码 / 验证码 / 邮箱、SVIP 曲库、评论与收藏者分页。
2. 在 Windows USB DAC 与 Linux PipeWire/ALSA 上验证独占、384 kHz、DSD（如需）。
3. 补主界面歌曲表格虚拟滚动（超长歌单）。
4. 第三方 UI 组件若要动态加载，需要新增资源协议 + CSP 白名单 + 沙箱边界。
5. 打包前跑 `npm run typecheck && npm run build && npm test`。
