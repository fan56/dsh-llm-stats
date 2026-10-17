# Changelog

All notable changes to dsh-llm-stats are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- **0.2.1 wave verification**: devDeps `@deepseek-ai/dsh-commands` / `dsh-llm` / `dsh-session` exact pins moved `0.2.0-rc.2` → `0.2.1-rc.2`; the dev-only `@deepseek-ai/cordis`/`@deepseek-ai/schemastery` pins moved `4.0.4`/`3.18.4` → `4.0.5`/`3.18.5` (the versions the rc.2 host closure ships, and what the rc.2 packages peer-demand); peer floors (`^3.18.2` / `>=0.2.0-rc.2`) untouched. Added the family-standard `.npmrc` (`legacy-peer-deps=true`, same as dsh-topics-memory/dsh-vault). CI dsh install restored to newest-of(latest/next) runtime resolution (reverting the 2026-10-17 pin); publish.yml already resolves at runtime. Zero source changes — tsc check clean, 57 tests pass / 0 fail against the 0.2.1-rc.2 closure, real-host smoke boot PASS.
- **Raise dsh host floor to 0.2.0-rc.2** (dev pins on `dsh-commands` / `dsh-llm` / `dsh-session`, peer floor `dsh-llm >= 0.2.0-rc.2`, lockfile regenerated against registry.npmjs.org). cordis 4.0.4 / schemastery 3.18.4 pins stay put; zero source changes — 0.2.0 is a digestion wave (no export removals, no compile-level breaks).
- **dsh closure moved to 0.1.7-rc.1** (dev pins on `dsh-commands` / `dsh-llm` / `dsh-session`, peer floor `dsh-llm >= 0.1.7-rc.1`, READMEs updated). cordis 4.0.4 / schemastery 3.18.4 ride along in devDependencies to satisfy the new line's peers. No source changes were needed; the `estimate` adoption is intentionally out of scope for this round.
- **Plugin Manager metadata.** Added `icon.svg` and `locale/{en,zh}.json` (`meta.title`/`meta.description` per the official `readPluginMeta` contract); `package.json` now declares the `icon` and ships both in the tarball.

## [0.6.0] - 2026-09-11

### Changed
- **dsh closure moved to 0.1.5-rc.2** (dev pins, peer floors, locks).
- **TTFT is read from the embedded attempt streams.** V3 `assistant/attempt` and `assistant/message` settlements carry `AssistantStreamRecord[]` with the original chunk timestamps; the fold delegates to the official `assistantStreamFirstTokenTime` reader. The legacy synthetic-chunk path remains for pre-V3 packed-run logs.
- Backfill passes `assistant/attempt` rows through and discovers `session.v3.jsonl[.zstd]` artifacts (current generation first).


## [0.5.1] - 2026-09-05

### Fixed
- **Orphaned crash leftovers no longer accumulate forever** — `compact.lock.stale-*` takeover dirs (renamed aside and never revisited) and `.baseline.jsonl.tmp-<pid>` staging files whose writer pid is dead are swept at store open; live-pid tmp files and a healthy lock are left untouched.

### Changed
- Clean-uninstall documentation (Uninstall sections in both READMEs) and an uninstall leg in the boot smoke asserting `dsh plugin remove` reconciles the profile tree back to stock.
