# codex-cleaner

Guarded local cleanup for bloated Codex state under `~/.codex`.

```powershell
npx codex-cleaner@latest
```

The default TUI always dry-runs first, then offers one apply step after Codex is fully closed.

Current cleanup:

- archives stale unpinned threads through Codex's own app-server API
- caps huge old `threads.title`, `threads.preview`, and `threads.first_user_message` values
- optionally caps recent unprotected metadata too
- vacuums `state_5.sqlite`
- optionally prunes/caps and vacuums `logs_2.sqlite`
- checkpoints/truncates `state_5.sqlite-wal`

Noninteractive dry-run:

```powershell
npx codex-cleaner@latest --allow-running-readonly clean --max-chars 1024 --keep-recent-days 14 --compact-recent-metadata --prune-logs
```

Noninteractive apply:

```powershell
npx codex-cleaner@latest clean --max-chars 1024 --keep-recent-days 14 --compact-recent-metadata --prune-logs --apply --confirm-lossy-metadata --confirm-archive-stale --confirm-prune-logs
```

Safety basics:

- dry-run by default
- apply refuses to run while Codex processes are active
- pinned, heartbeat/open, and active-goal threads are always protected
- recent threads are protected unless `--compact-recent-metadata` is passed
- rollout JSONL is retained for history and CodexMeter
- SQLite backups are created before mutation

## Dev

```powershell
npm install
npm run check
npm pack --dry-run
```
