# codex-cleaner

Guarded local cleanup for bloated Codex state under `~/.codex`.

```powershell
npx codex-cleaner@latest
```

The default TUI always dry-runs first, then offers one apply step after Codex is fully closed.

Current cleanup:

- archives stale unpinned threads through Codex's own app-server API
- caps huge old `threads.title`, `threads.preview`, and `threads.first_user_message` values
- checkpoints/truncates `state_5.sqlite-wal`

Noninteractive dry-run:

```powershell
npx codex-cleaner@latest --allow-running-readonly clean --max-chars 1024 --keep-recent-days 14
```

Noninteractive apply:

```powershell
npx codex-cleaner@latest clean --max-chars 1024 --keep-recent-days 14 --apply --confirm-lossy-metadata --confirm-archive-stale
```

Safety basics:

- dry-run by default
- apply refuses to run while Codex processes are active
- pinned, heartbeat/open, active-goal, and recent threads are protected
- rollout JSONL is retained for history and CodexMeter
- SQLite backups are created before mutation

Still pending:

- guarded `state_5.sqlite` vacuum/rebuild
- `logs_2.sqlite` retention pruning
- `codex-tui.log` rotation/truncation

## Dev

```powershell
npm install
npm run check
npm pack --dry-run
```
