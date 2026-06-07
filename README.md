# 算盘桌面端

![算盘 logo](assets/suanpan-logo.svg)

算盘是一个 macOS Electron 桌面端 A 股研究终端。当前产品边界是研究和观察：行情、自选股、公式、选股、研究计划，以及只读 Codex 辅助分析；不包含账户、下单、撤单、自动交易或模拟盘。

## 当前能力

- 行情：启动后自动加载全 A 真实/延迟报价，失败时保留本地/缓存数据。
- 图表：个股日 K、分时、MA、BOLL、MACD、KDJ、RSI，多副图十字光标和标签。
- 自选股：本机持久化自选、分组和批量导入。
- 公式：通达信风格公式 DSL，支持内置公式、自建公式、校验和单标的测试。
- 选股：内置条件、公式选股、策略保存、结果过滤、加入自选和生成研究计划。
- 研究计划：只做观察、复盘和失效线记录，不生成交易指令。
- AI：只走 Codex。每次提问注入行情、自选股、公式、选股结果、研究计划、AI 历史和共识。

## 数据接入

行情来自公开网络数据源，主路径为东方财富，按需补充腾讯分时/日 K，必要时使用新浪全 A 作为报价补充。应用显示为：

- `真实/延迟数据`：外部行情源成功返回。
- `本地/缓存数据`：外部源失败、离线或仅有本机缓存。

同步策略不是等用户手动刷新：

- 启动后先拉全 A 快速页，再后台补全后续分页。
- 交易时段内优先刷新当前个股、自选股和正在看的列表，默认约 3 秒调度一次。
- 全市场大列表采用后台分片补齐，避免一次性请求阻塞界面。
- 休市或非活跃时段降低刷新频率。

外部行情不等同于交易所直连行情，存在上游延迟、限流和网络失败风险。

## Codex 设置

点击顶部 `AI设置` 可以录入：

- `API Key`
- `Base URL`

这些设置只保存在本机 AI 设置文件中，不写入行情、自选、公式或 Codex 数据快照。Codex 不可用时，界面只说明数据已准备和 Codex 未就绪，不生成另一套本地 AI 回复。

## 运行

当前仓库不强制安装项目依赖。运行机需要可执行的 Electron：

```bash
npm start
```

如果 Electron 不在 PATH：

```bash
ELECTRON_BIN=/path/to/electron npm start
```

窄 PATH 环境检查：

```bash
PATH=/usr/bin:/bin /opt/homebrew/bin/node scripts/doctor-runtime.cjs
```

## 验证

```bash
npm run check
npm run doctor:runtime
npm run test:electron-smoke
npm run test:electron-persistence
```

`npm run check` 包含语法检查、行情解析/调度、Codex 数据注入、AI 设置、用户状态和更新检测单元测试。

## 打包

macOS 本机打包：

```bash
npm run package:mac
```

输出：

- `dist/mac/算盘.app`
- `dist/suanpan-desktop-v<version>-macos-<arch>.zip`
- `dist/latest-mac.json`

打包脚本复用本机 Electron.app，把仓库运行文件写入 `Contents/Resources/app`，并写入 bundle 名称、版本和应用标识。没有代码签名和 notarization；公开分发前需要另行接入 Apple 开发者证书。

## CI/CD 发布

仓库包含两个 GitHub Actions workflow：

- `.github/workflows/ci.yml`：push / pull request 时安装 Electron runtime，运行 `npm run check` 和 `npm run doctor:runtime`。
- `.github/workflows/release.yml`：推送 `v*` tag 时运行检查、打包 macOS zip，并把 zip 与 `latest-mac.json` 上传到 GitHub Release。

发布命令示例：

```bash
git tag v0.1.0
git push origin v0.1.0
```

## 自动检测更新

应用启动约 6 秒后自动请求 GitHub Releases 的 latest release，之后默认每 6 小时检测一次。检测结果显示在 `数据 / Codex / 版本状态` 弹窗中；发现新版本时会提示并提供发布页入口。

当前实现只做自动检测和提示，不做自动下载、覆盖安装或后台替换应用。

## 产品边界

以 [SPEC.md](SPEC.md) 和 [DESIGN.md](DESIGN.md) 为准。不要在没有明确需求时加入交易、账户、模拟盘、新业务模块或新前端栈。

## 开源协议

本项目使用 [MIT License](LICENSE)。代码按原样提供，不承诺行情准确性、实时性、投资收益或特定用途适配；使用者需要自行确认数据授权、分发合规和投资风险。
