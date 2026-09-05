# Changelog

All notable changes to dsh-llm-stats are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.5.1] - 2026-09-05

### Fixed
- **Orphaned crash leftovers no longer accumulate forever** — `compact.lock.stale-*` takeover dirs (renamed aside and never revisited) and `.baseline.jsonl.tmp-<pid>` staging files whose writer pid is dead are swept at store open; live-pid tmp files and a healthy lock are left untouched.

### Changed
- Clean-uninstall documentation (Uninstall sections in both READMEs) and an uninstall leg in the boot smoke asserting `dsh plugin remove` reconciles the profile tree back to stock.
