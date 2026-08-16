# codex-cleaner

Guarded cleanup for local Codex state.

```powershell
npx codex-cleaner@latest
```

The guided flow dry-runs first. Its recommended cleanup:

- caps large metadata on old, unprotected threads
- vacuums `state_5.sqlite` and `logs_2.sqlite`
- checkpoints `state_5.sqlite-wal`
- creates backups before database changes

Codex owns log retention. The cleaner only reclaims free SQLite pages; it does not delete or rewrite log rows.

Expensive or uncommon work is opt-in:

- `--archive-stale` archives old threads through Codex's app-server API
- `--archive-orphan-rollouts` moves old DB-unreferenced session JSONL into `archived_sessions`
- `--prune-tui-log` backs up and trims an explicitly enabled `codex-tui.log`
- `--include-rollouts` adds the slower rollout-linkage scan

The cleaner follows root-level `sqlite_home` and `log_dir` values in `config.toml`, plus `CODEX_SQLITE_HOME`. Use `--sqlite-home` or `--log-dir` for an explicit override.

Noninteractive dry-run and apply:

```powershell
npx codex-cleaner@latest --allow-running-readonly clean --vacuum-logs
npx codex-cleaner@latest clean --vacuum-logs --apply
```

Backup cleanup:

```powershell
npx codex-cleaner@latest backups scan
npx codex-cleaner@latest backups prune --older-than-hours 48
npx codex-cleaner@latest backups prune --older-than-hours 48 --apply
```

Safety:

- mutations require `--apply` and refuse to run while Codex is active
- pinned, heartbeat/open, active-goal, and recent threads are protected
- rollout JSONL is never deleted by the cleanup flow
- backups default to `~/.codex/.codex-cleanup-backups`

## Dev

```powershell
npm install
npm run check
npm publish --dry-run
```
