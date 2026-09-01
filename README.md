# @aiwayds/dsh-llm-stats

English | [中文](README.zh.md)

Persistent LLM usage ledger for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with a `/llm-stats` slash command that reports usage as a markdown report (GFM tables + emoji). The plugin folds every closed agent step into one durable record line — tokens (four provider buckets), model wall time, first-token latency, decode throughput, tool wall time — appended to a process-private shard under `$DSH_HOME/llm-stats/`. Every dsh process on the machine that mounts the plugin feeds the same machine-wide ledger, and `/llm-stats` renders it over rolling calendar-day windows on any surface:

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
| deepseek-v4-flash | 78.1M | 1.1M | 94% | 1304 |
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

dsh-tui-pi detects the table separators and renders the report through its markdown component as boxed tables; other surfaces (such as headless runs) show the raw markdown as-is.

## Install

```bash
dsh plugin add @aiwayds/dsh-llm-stats
```

Then restart dsh. Install it into **every profile** whose usage you want counted (the ledger is machine-wide, but recording only happens where the plugin is mounted).

## Usage

| Command | Meaning |
| --- | --- |
| `/llm-stats` | Help: usage, active config, ledger coverage |
| `/llm-stats day\|week\|month\|3m\|6m\|12m` | Rolling calendar-day windows ending now |
| `/llm-stats d\|w\|m` | Shorthand for day / week / month |
| `/llm-stats backfill` | Import past usage from the stored session logs |

Ranges are rolling: `week` covers the last 7 local calendar days including today, so the rendered date range always matches what you would call "the last 7 days". Windows of 3 months and longer fold the per-day bars into Monday-aligned weeks.

## Configuration

```yaml
- id: dsh-llm-stats
  config:
    mode: on              # off stops recording; /llm-stats and cleanup keep working
    retentionDays: 365    # records older than this are dropped at compaction (min 7)
```

## How it works

- **One record per step.** The fold anchors on `step/end` (the step lifecycle authority: completed, failed, cancelled, and max-tokens steps all land exactly one) and mirrors the fold semantics of the upstream `@deepseek-ai/dsh-session-stats` projection that powers the web chat stats strip. Token fields are nullable — steps without provider-reported usage still count as steps and turns, just not as requests.
- **Sharded append-only ledger.** Each dsh process appends to its own `records.<boot-id>.jsonl` shard and never rewrites a shared file while alive — concurrent TUI + headless + bot processes can never clobber each other. Dead shards are merged into `baseline.jsonl` under a lock during compaction, which is also where `retentionDays` drops expired records. Records are billing side facts, not session truth: writes are best-effort and a failed line is dropped, never surfaced into the session.
- **Overlap-safe aggregation.** Aggregation dedupes on `(sid, turn, step)` last-wins, so replayed or (future) backfilled history cannot double count.
- **No content recorded.** The ledger stores numbers, model ids, and session ids — never prompts, tool names, or results.

## Backfill

The ledger starts when the plugin starts; everything before that is invisible until you run:

```text
/llm-stats backfill
```

That scans `$DSH_HOME/sessions/` (all projects), decodes each stored log (concatenated zstd frames — the production format, including packed-chunk rows), folds it with the same step semantics as live recording, and appends the records to the ledger. Respects `retentionDays` (sessions last written before the cutoff are skipped), skips fork/subagent seed history so parent work is never counted twice, marks processed sessions in a done-ledger so repeat runs are fast, and can be aborted mid-run and resumed.

## Known limitations

- A step whose process crashes before `step/end` is not recorded live; backfill recovers it from the session log on the next run.
- Subagent child sessions are recorded live only when their events bubble to the host listener; any that slip through are picked up by backfill.

## Development

```bash
npm install                          # devDependencies resolve the @deepseek-ai/* type closure
node scripts/link-dsh-closure.mjs    # re-point local @deepseek-ai/* at the global closure (rerun after every install)
npm run check                        # tsc --noEmit
npm test                             # build + node --test (fold / aggregate / render / store / plugin wiring)
```

`@deepseek-ai/*` packages are peer dependencies only (devDependencies carry them for local builds); bundling a second closure into a dsh profile breaks cordis service identity. When the repo is link-mounted into a live dsh profile, the link step above is what keeps the plugin resolving against the same closure the profile runs on — do not skip it.

## License

[MIT](./LICENSE)
