# Changelog

All notable changes to dsh-llm-stats are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- **dsh closure moved to 0.1.5-rc.2** (dev pins, peer floors, locks).
- **TTFT is read from the embedded attempt streams.** V3 `assistant/attempt` and `assistant/message` settlements carry `AssistantStreamRecord[]` with the original chunk timestamps; the fold delegates to the official `assistantStreamFirstTokenTime` reader. The legacy synthetic-chunk path remains for pre-V3 packed-run logs.
- Backfill passes `assistant/attempt` rows through and discovers `session.v3.jsonl[.zstd]` artifacts (current generation first).


## [0.5.1] - 2026-09-05

### Fixed
- **Orphaned crash leftovers no longer accumulate forever** — `compact.lock.stale-*` takeover dirs (renamed aside and never revisited) and `.baseline.jsonl.tmp-<pid>` staging files whose writer pid is dead are swept at store open; live-pid tmp files and a healthy lock are left untouched.

### Changed
- Clean-uninstall documentation (Uninstall sections in both READMEs) and an uninstall leg in the boot smoke asserting `dsh plugin remove` reconciles the profile tree back to stock.
