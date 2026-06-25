# codex-cleaner

Guarded local cleanup for bloated Codex state under `~/.codex`.

```powershell
npx codex-cleaner@latest
```

The default TUI always dry-runs first, then offers one apply step after Codex is fully closed.
Its recommended path includes stale thread archiving, orphan rollout archiving, SQLite log cleanup, TUI log trimming, metadata compaction, vacuum, and WAL checkpointing.
You can customize each setting when needed.

Current cleanup:

- archives stale unpinned threads through Codex's own app-server API
- moves old DB-unreferenced rollout JSONL from `sessions` to `archived_sessions`
- caps huge old `threads.title`, `threads.preview`, and `threads.first_user_message` values
- optionally caps recent unprotected metadata too
- vacuums `state_5.sqlite`
- prunes old/noisy rows, caps giant payloads, and vacuums `logs_2.sqlite`
- backs up and trims `log/codex-tui.log`
- checkpoints/truncates `state_5.sqlite-wal`
- scans, prunes, or schedules pruning for old cleaner backups

Noninteractive dry-run:

```powershell
npx codex-cleaner@latest --allow-running-readonly clean --max-chars 1024 --keep-recent-days 14 --archive-orphan-rollouts --compact-recent-metadata --prune-logs --prune-tui-log
```

Noninteractive apply:

```powershell
npx codex-cleaner@latest clean --max-chars 1024 --keep-recent-days 14 --archive-orphan-rollouts --compact-recent-metadata --prune-logs --prune-tui-log --apply
```

Backup cleanup:

```powershell
npx codex-cleaner@latest backups scan
npx codex-cleaner@latest backups prune --older-than-hours 48
npx codex-cleaner@latest backups prune --older-than-hours 48 --apply
npx codex-cleaner@latest backups schedule-prune --after-hours 48 --apply
```

File-only active-session cleanup:

```powershell
npx codex-cleaner@latest archive-orphan-rollouts --allow-running-orphan-rollout-archive --keep-recent-days 14 --apply
```

Safety basics:

- dry-run by default
- apply refuses to run while Codex processes are active
- pinned, heartbeat/open, and active-goal threads are always protected
- recent threads are protected unless `--compact-recent-metadata` is passed
- rollout JSONL is retained; old DB-orphaned files may be moved out of active `sessions`
- `archive-orphan-rollouts` reads SQLite but only moves JSONL files and removes empty dirs
- backups are created in `~/.codex/.codex-cleanup-backups` before mutation
- normal apply schedules old backup pruning automatically
- backup pruning is dry-run unless `--apply` is passed

## Dev

```powershell
npm install
npm run check
npm pack --dry-run
```

Local dogfood:

```powershell
npm run build
node .\dist\cli.js
```

Active-session file-only cleanup:

```powershell
node .\dist\cli.js --allow-running-readonly archive-orphan-rollouts --keep-recent-days 14
node .\dist\cli.js archive-orphan-rollouts --allow-running-orphan-rollout-archive --keep-recent-days 14 --apply
```
