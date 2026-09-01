# @aiwayds/dsh-llm-stats

English | [中文](README.zh.md)

Persistent LLM usage ledger for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with a pure-text `/llm-stats` slash command. The plugin folds every closed agent step into one durable record line — tokens (four provider buckets), model wall time, first-token latency, decode throughput, tool wall time — appended to a process-private shard under `$DSH_HOME/llm-stats/`. Every dsh process on the machine that mounts the plugin feeds the same machine-wide ledger, and `/llm-stats` renders it over rolling calendar-day windows on any surface:

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
