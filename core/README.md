# usage-lens（v0 · 解析层）

从**本地日志**读 AI 客户端的 token 用量。不上传、不联网、不读 API key。

这是「多平台 AI 用量显示」项目的第一步：先把**能读什么、读不到什么**弄清楚，UI 后面再说。

## 三条硬原则（写在代码里，不只是文档里）

1. **只读本地文件**：不联网、不读 API key、不写任何文件。
2. **读不懂就不折算**：形状未核实的来源只报告"发现了什么"，绝不参与合计——宁可不报数，也不报错数。
3. **每个来源显式标状态**：`verified` / `found-unverified` / `not-found` / `not-implemented`，只有 `verified` 进合计。

## 用法

```sh
node core/usage-lens.mjs                # 扫默认位置
node core/usage-lens.mjs --json         # 机器可读（菜单栏 UI 可直接调这个）
node core/usage-lens.mjs --root core/<dir>   # 扫隔离目录（测试夹具用）
node core/usage-lens.mjs --now <ISO>    # 固定"现在"（时间窗确定性测试用）
```

零依赖，只需 Node 18+（实测 Node 24）。

## 支持矩阵

| 来源 | 本地位置 | 状态 | 说明 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | **verified** | 助手消息的 `message.usage` 提供 input / cache_creation / cache_read / output tokens；按 `message.id` 去重 |
| Codex | `~/.codex/**/*.jsonl` | **verified** | 每会话取最后一条 `payload.info.total_token_usage`（累计）。**206 个文件里有 1 个出现计数回退**（同文件含多段会话），故按单调段切开、每段取最大值再求和——这个回退是我核实自己假设时发现的 |
| DeepSeek Harness | `~/.dsh/sessions/<ws>/<id>/*.jsonl.zstd` | **verified** | 多帧 zstd：**按魔数切帧、逐帧解压**（流式解码器会在第二帧报 Unknown frame descriptor）。用量在 `assistant/message` 的 `usage` 里，**逐请求**（实测不单调）故求和；同会话内 `seq` 唯一，用作去重键 |
| Cursor | `~/.cursor/` | **not-found** | 目录里是项目快照，不是用量日志；用量大概率在服务端 |
| Gemini | `~/.gemini/` | **not-found** | 未发现 jsonl / json / db |

**这张表就是产品的一部分。** 一个诚实的"哪些读不到、为什么"，比含糊的"支持多家"有用。

## 隐私

- 脚本**只读**本地文件，**不发起任何网络请求**，**不读环境变量里的 key**。
- 默认输出不含任何凭据、路径以外的个人信息；`--json` 也只含计数与来源状态。
- 测试夹具（`fixtures/`）全部是**合成数据**，不含真实日志。

## 测试

```sh
node test.mjs        # 全部断言，零依赖（断言数以 test.mjs 输出为准）
```

`test.mjs` 覆盖：

| 断言 | 目的 |
|---|---|
| XXH64 官方向量 7/7（`--selftest`） | 回归自检（不参与读账） |
| codex 扣除/隔离 = 1/2、metrics 精确 | 续接会话的基线扣除 |
| dsh 帧数 = 3 | **防"静默 0 帧"回归** |
| dsh 坏行 = 1、记录 = 3、metrics 精确 | 坏行跳过 + 去重 |
| `availability` 三态（ok/unknown/not_installed）| 状态位映射自 status |
| `window.today/week` 结构（start/end ISO、metrics 对象/null） | 时间窗 schema 钉住 |
| 负向：坏帧 → `badFrames=1`、`lowerBound=true`、`frame_decode_failed` | 解压失败必须暴露并标下限 |

夹具全部是**合成数据**（`zstdCompressSync` 生成 + 手改帧头），**不含任何真实用量帧或本机路径**。

## 跨厂商语义（别把 input 相加）

| 厂商 | input 含义 | 正确用法 |
|---|---|---|
| Claude Code | `input_tokens` **不含** cache | 输入侧 = input + cache_write + cache_read |
| Codex（OpenAI 口径） | `input_tokens` **含** `cached_input_tokens`；`total = input + output` | 直接取 input，**不要再加 cached** |
| DeepSeek Harness | `inputTokens` **不含** cache；`totalTokens = input + cache读 + cache写 + output` | 输入侧 = 四项相加（同 Claude Code） |

所以原始 `metrics.input` **跨厂商不可加**。工具另外给出 `normalized.input_side`，那一列才可比。`--json` 的 `warnings` 里也会带这句。

## 消费契约（`--json`）

给 UI 钉的契约（WorkBuddy #128 提，已实现）：

- `schema: "1"` —— **已发布即冻结**，破坏性改动升版本；
- **指标可空**：未核实的来源 `metrics: null`（UI 显示 `—`）。**0 是数据，空是不知道，两者不能同形**；
- 顶层 `as_of`；状态表与合计分开，`totals.verifiedOnly: true` 且只含 `verified` 来源。
- **时间窗** `window.today` / `window.week`：各带 `{start, end, metrics}`（本地时区）。顶层是三家归一合计（"环"的分子），`sources[i].window` 是单家。**分母 = 预算，属 UI 设置项，不进引擎**（没填预算就不画环，只显数字）。
- **状态位** `availability: ok | unknown | not_installed`（UI 用）；另有 `available: true|false` = 数据目录是否存在，区分"没装"与"装了但用量为 0"。两者都不能把"未知"渲染成 0。

## 当前状态

- **已 verified 三家**：Claude Code、Codex、DeepSeek Harness（全部只读本地文件、不联网、不读 API key）。
- 两家未发现本地用量日志：Cursor（目录是项目快照）、Gemini。
- **帧内容校验由 `zstdDecompressSync` 自身完成**（实测：帧尾 XXH64 校验和若不符，解压会抛错 → 计入 `badFrames` 并触发下限）。因此流水线**不重复校验**；自写的 XXH64 实现（零依赖、官方向量 7/7）保留为 `--selftest` 回归自检，**不参与读账**。
- **合计的 `≥` 是什么意思**：表示"**可能**少算"，不是"一定少算"——被跳过的行不一定是用量行（可能是元数据、空行、半行）。`≥` 自带 `=`，正好表达"可能相等、也可能更多"；所以用 `≥` 而不写"少算 N 行"或"不完整"是精确，不是含糊。`totals.lowerBound` 在有**隔离会话**或**坏行**时为 true。
- **`badLines` 是间接信号，不是完整性保证**：>0 表示有行解不开（可能是帧切分问题，也可能是客户端自己写了半行）；此时合计是"已跳过坏行后"的数字。
- Codex 侧：5 个续接会话中 **2 个可精确扣回基线**、3 个隔离（事件时间戳全同，无法排除回放）→ 合计标 lowerBound。

## 下一步

1. **Codex 时间窗**：累计型来源的窗口聚合（当前 `window.*.metrics` 为 `null`，诚实标注）。做法是取"窗口两端累计值之差"，需处理续接基线。
2. **界面层**：macOS 菜单栏（SwiftBar/xbar 原型 → SwiftUI `MenuBarExtra`），直接读 `--json`；界面直接读 `--json`。SwiftBar 原型在 `app/swiftbar/usage-lens.5m.sh`。
