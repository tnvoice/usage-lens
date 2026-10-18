# usage-lens

只读本地日志，汇总 Claude Code、Codex、DeepSeek Harness 的用量。不联网，不读 API key。

- 引擎和测试在 `core/`。在仓库根目录运行：`node core/usage-lens.mjs --json`
- 测试：`cd core && node test.mjs`
- 菜单栏原型：`app/swiftbar/usage-lens.5m.sh`（SwiftBar，每 5 分钟）。把 `USAGE_LENS_CLI` 指到 `node core/usage-lens.mjs`。没填预算时不画环，只显示数字。

夹具是合成数据。说明见 `core/README.md`。
