# @aiwayds/dsh-llm-stats

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的持久化 LLM 用量账本插件，提供纯文本 `/llm-stats` 斜杠命令。插件把每个结束的 agent step 折叠成一行持久化记录——token 四桶（provider 报告）、模型耗时、首 token 延迟、解码吞吐、工具耗时——追加写入 `$DSH_HOME/llm-stats/` 下本进程私有的分片文件。本机所有挂载了本插件的 dsh 进程共用这份整机账本，`/llm-stats` 在任意 surface 上按滚动日历窗口渲染：

```
LLM stats · last 7 days (Aug 26 – Sep 1)

  Sessions 12 · Turns 48 · Requests 156 · Steps 160
  Tokens in 1.2M · cache hit 87% · out 45.3K · total 1.25M
  Time model 18m32s · tools 4m10s · avg TTFT 1.2s · 42.3 tok/s

  By model
    glm-4.6        in 900K  out 30K  cache 88%  req 120
    deepseek-chat  in 300K  out 15K  cache 85%  req 36

  Aug 26 ▇▇▇▇▇▇▇▇ 120K
  Aug 27 ▇▇▇▇▇▇▇▇▇▇▇▇ 180K
  ...
```

## 安装

```bash
dsh plugin add @aiwayds/dsh-llm-stats
```

然后重启 dsh。想让哪些 profile 的用量计入，就把插件装进哪些 profile（账本整机一份，但只有挂载了插件的进程才会记账）。

## 用法

| 命令 | 含义 |
| --- | --- |
| `/llm-stats` | 默认档（可配置，出厂 `week`） |
| `/llm-stats day\|week\|month\|3m\|6m\|12m` | 以现在为终点的滚动日历窗口 |
| `/llm-stats day` | 仅今天 |

范围是滚动语义：`week` = 最近 7 个本地日历日（含今天），输出标注的实际日期区间与口语「最近七天」一致。3 个月及以上的长档，逐日条形自动折叠为周一取齐的逐周条形。

## 配置

```yaml
- id: dsh-llm-stats
  config:
    mode: on              # off 停止记账；/llm-stats 与清理照常工作
    retentionDays: 365    # 超过该天数的记录在 compaction 时清除（最小 7）
    defaultRange: week    # 裸 /llm-stats 显示的档位
```

## 工作原理

- **一个 step 一条记录。** 折叠以 `step/end` 为锚点（step 生命周期的权威事件：完成、失败、取消、max-tokens 的步都恰好落一个），语义对齐上游 `@deepseek-ai/dsh-session-stats` projection——即 dsh web 聊天统计条背后的那份折叠。token 字段可空：没有 provider usage 的步照样计入 Steps 与 Turns，只是不计入 Requests。
- **分片 append-only 账本。** 每个 dsh 进程只追加自己的 `records.<boot-id>.jsonl` 分片，活着的进程绝不重写共享文件——TUI + headless + bot 并发互不践踏。死进程的分片在锁保护下于 compaction 时并入 `baseline.jsonl`，`retentionDays` 的过期清理也在同一时机执行。记录是计费旁路事实而非会话真相：写入尽力而为，失败的行直接丢弃，绝不影响会话。
- **重叠安全的聚合。** 聚合按 `(sid, turn, step)` 去重（last-wins），日志重放或（将来的）历史回填都不会重复计数。
- **不记内容。** 账本里只有数字、模型 id 和会话 id——没有 prompt、没有工具名、没有结果。

## 已知局限

- 进程在 `step/end` 前崩溃的步会从账本丢失（将来的会话日志回填可以补回）。
- 子代理子会话只有在其事件冒泡到 host 监听时才被计入；不冒泡的部署会低估，等回填功能落地后可补齐。

## 开发

```bash
npm install        # devDependencies 解析 @deepseek-ai/* 类型闭包
npm run check      # tsc --noEmit
npm test           # 构建 + node --test（fold / aggregate / render / store / 插件接线）
```

`@deepseek-ai/*` 只进 peerDependencies（devDependencies 仅供本地构建）；把第二份闭包打进 dsh profile 会破坏 cordis 服务同一性。

## 许可

[MIT](./LICENSE)
