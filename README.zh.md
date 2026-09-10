# @aiwayds/dsh-llm-stats

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的持久化 LLM 用量账本插件，提供 `/llm-stats` 斜杠命令，以 markdown 报告（GFM 表格 + emoji）呈现用量。插件把每个结束的 agent step 折叠成一行持久化记录——token 四桶（provider 报告）、模型耗时、首 token 延迟、解码吞吐、工具耗时——追加写入 `$DSH_HOME/llm-stats/` 下本进程私有的分片文件。本机所有挂载了本插件的 dsh 进程共用这份整机账本，`/llm-stats` 在任意 surface 上按滚动日历窗口渲染：

**要求 dsh >= 0.1.5-rc.1** — 本插件只跟随 dsh RC/stable 线（CI 与发版在运行时解析 latest/next 中更新的 dist-tag）。**不再支持 alpha 线。**

```
## 📊 LLM stats · last 30 days (Aug 3 – Sep 1)

| ⚡ Sessions | 💬 Turns | 📡 Requests | 👣 Steps |
| --- | --- | --- | --- |
| 132 | 196 | 2710 | 2742 |

| 📥 In | 🔥 Cache hit | 📤 Out | 🧮 Total |
| --- | --- | --- | --- |
| 141M | 93% | 2.5M | 144M |

⏱ Model 13h15m · 🔧 Tools 18h35m · 🚀 TTFT 4.5s · ⚡ 69.2 tok/s

## 🤖 By model

| Model | 📥 In | 📤 Out | 🔥 Cache | 📡 Req |
| --- | --- | --- | --- | --- |
| glm-5.3-flash | 46.8M | 930K | 90% | 1053 |
| deepseek-flash | 78.1M | 1.1M | 94% | 1304 |
| glm-5.3 | 14.6M | 369K | 93% | 301 |
| MiniMax-M3 | 186K | 15.3K | 45% | 7 |
| kimi | 393K | 6.8K | 79% | 10 |
| minimax/minimax-m3:free | 1.2M | 14.2K | 96% | 35 |

## 📈 Activity

| 📅 Date | 📊 Tokens | 📈 |
| --- | --- | --- |
| Aug 28 | 168K | ▇ |
| Aug 31 | 4.6M | ▇▇▇▇▇▇▇▇▇▇▇▇▇▇ |
| Sep 1 | 8M | ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇ |
```

dsh-tui-pi 会识别表格分隔行，把报告经 markdown 组件渲染成框线表格；其他 surface（如 headless）显示原始 markdown。

## 安装

```bash
dsh plugin add @aiwayds/dsh-llm-stats
```

然后重启 dsh。想让哪些 profile 的用量计入，就把插件装进哪些 profile（账本整机一份，但只有挂载了插件的进程才会记账）。

## 卸载

```sh
dsh plugin --profile <name> remove @aiwayds/dsh-llm-stats
```

宿主会自动收敛（bundles 条目移除、patch 层随包消失）。`~/.dsh/llm-stats/` 的账本（`baseline.jsonl`、`records.*.jsonl` 分片、回填文件）有意保留 —— 这是用量历史，重装后继续累计。0.5.1 起插件启动时会清扫遗留的 `compact.lock.stale-*` 接管目录和已死进程的 `.baseline.jsonl.tmp-*` 暂存文件。彻底清除：先备份，再 `rm -rf ~/.dsh/llm-stats`。

## 用法

| 命令 | 含义 |
| --- | --- |
| `/llm-stats` | 帮助：用法、当前配置、账本覆盖情况 |
| `/llm-stats day\|week\|month\|3m\|6m\|12m` | 以现在为终点的滚动日历窗口 |
| `/llm-stats d\|w\|m` | day / week / month 的短别名 |
| `/llm-stats backfill` | 从落盘会话日志回填历史用量 |

范围是滚动语义：`week` = 最近 7 个本地日历日（含今天），输出标注的实际日期区间与口语「最近七天」一致。3 个月及以上的长档，逐日条形自动折叠为周一取齐的逐周条形。

## 配置

```yaml
- id: dsh-llm-stats
  config:
    mode: on              # off 停止记账；/llm-stats 与清理照常工作
    retentionDays: 365    # 超过该天数的记录在 compaction 时清除（最小 7）
```

## 工作原理

- **一个 step 一条记录。** 折叠以 `step/end` 为锚点（step 生命周期的权威事件：完成、失败、取消、max-tokens 的步都恰好落一个），语义对齐上游 `@deepseek-ai/dsh-session-stats` projection——即 dsh web 聊天统计条背后的那份折叠。token 字段可空：没有 provider usage 的步照样计入 Steps 与 Turns，只是不计入 Requests。
- **分片 append-only 账本。** 每个 dsh 进程只追加自己的 `records.<boot-id>.jsonl` 分片，活着的进程绝不重写共享文件——TUI + headless + bot 并发互不践踏。死进程的分片在锁保护下于 compaction 时并入 `baseline.jsonl`，`retentionDays` 的过期清理也在同一时机执行。记录是计费旁路事实而非会话真相：写入尽力而为，失败的行直接丢弃，绝不影响会话。
- **重叠安全的聚合。** 聚合按 `(sid, turn, step)` 去重（last-wins），日志重放或（将来的）历史回填都不会重复计数。
- **不记内容。** 账本里只有数字、模型 id 和会话 id——没有 prompt、没有工具名、没有结果。

## 回填

账本从插件启动才开始记；之前的历史跑一次：

```text
/llm-stats backfill
```

它会扫描 `$DSH_HOME/sessions/`（全部项目），解码每个落盘日志（拼接 zstd 帧的生产格式，含打包 chunk 行），用与实时记账完全相同的 step 语义折叠，然后把记录并入账本。全程遵守 `retentionDays`（最后写入早于窗口的会话整体跳过）；fork/subagent 的种子历史按 header `seedLength` 跳过，父会话的用量绝不会被重复计入；已处理的会话记入 done-ledger，重复执行很快；中途被打断也可以续跑。

## 已知局限

- 进程在 `step/end` 前崩溃的步实时记账不会记录；下一次 backfill 会从会话日志补回。
- 子代理子会话只有在其事件冒泡到 host 监听时才被实时计入；漏掉的由 backfill 兜底。

## 开发

```bash
npm install                          # devDependencies 解析 @deepseek-ai/* 类型闭包
node scripts/link-dsh-closure.mjs    # 把本地 @deepseek-ai/* 重新指向全局闭包（每次 install 后重跑）
npm run check                        # tsc --noEmit
npm test                             # 构建 + node --test（fold / aggregate / render / store / 插件接线）
```

`@deepseek-ai/*` 只进 peerDependencies（devDependencies 仅供本地构建）；把第二份闭包打进 dsh profile 会破坏 cordis 服务同一性。仓库以 link 挂进 live profile 时，正是上面这步 link 保证插件与 profile 解析到同一份闭包——不要跳过。

## 许可

[MIT](./LICENSE)
