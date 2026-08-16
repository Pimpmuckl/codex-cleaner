# codex-cleaner

Simple cleanup for local Codex storage.

```powershell
npx codex-cleaner@latest
```

The guided flow has two modes. Both scan first and ask once before applying:

- **Clean up** vacuums free pages in `state_5.sqlite` and `logs_2.sqlite`, then checkpoints the state WAL. It keeps all threads and rollout JSONL.
- **Full cleanup** also permanently deletes archived threads older than 90 days through Codex's `thread/delete` API. Pinned, active-goal, heartbeat/app-permission, recent, and unsafe descendant trees stay protected.

Noninteractive use:

```powershell
npx codex-cleaner@latest scan
npx codex-cleaner@latest clean --apply
npx codex-cleaner@latest scan --full
npx codex-cleaner@latest clean --full --keep-days 90 --apply
```

Applying cleanup refuses to run while Codex is active. Database mutations create backups in `~/.codex/.codex-cleanup-backups` and schedule them for removal after 48 hours. The apply summary shows how to cancel that removal. A database backup cannot restore rollout JSONL deleted by Full cleanup.

Backup inspection and removal remain separate:

```powershell
npx codex-cleaner@latest backups scan
npx codex-cleaner@latest backups prune --older-than-hours 48 --apply
```

Version 0.2 removes metadata capping, stale archiving, orphan rollout moving, TUI log trimming, and their flags. SQLite paths still resolve from `--sqlite-home`, root-level `sqlite_home` in `config.toml`, `CODEX_SQLITE_HOME`, then `CODEX_HOME`.

## Dev

```powershell
npm install
npm run check
npm publish --dry-run
```
