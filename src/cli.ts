#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import type { BackupCommand, CleanerCommand, CleanerOptions } from "./types.js";

const USAGE = `
codex-cleaner [command] [options]

Commands:
  (none)            Guided TUI: choose settings, dry-run, then optionally apply
  clean             Unified dry-run/apply for metadata compaction and stale thread archiving
  scan              Read-only size, protection, candidate, and optional rollout-linkage report
  compact-metadata  Cap old threads.title/preview/first_user_message values
  checkpoint-wal    Run PRAGMA wal_checkpoint(TRUNCATE) for state_5.sqlite
  archive-orphan-rollouts
                    Move old DB-unreferenced sessions JSONL into archived_sessions
  backups scan      Inspect codex-cleaner backup files
  backups prune     Delete codex-cleaner backup files after a dry-run
  backups schedule-prune
                    Schedule a one-shot future backups prune job

Options:
  --codex-home <path>             Codex home path; defaults to CODEX_HOME or ~/.codex
  --allow-running-readonly        Allow read-only dry-runs while Codex processes are active
  --allow-running-orphan-rollout-archive
                                  Allow archive-orphan-rollouts --apply while Codex is active
  --skip-archive-stale            Do not include stale thread archiving in clean/TUI flow
  --archive-orphan-rollouts       clean: move old DB-unreferenced sessions JSONL into archived_sessions
  --compact-recent-metadata       Also cap recent unprotected metadata; pinned/open/active stay protected
  --include-logs                  scan: include expensive logs_2.sqlite table stats
  --include-rollouts              scan: include sessions/archived_sessions linkage scan
  --prune-logs                    clean: prune/cap logs_2.sqlite and vacuum it
  --prune-tui-log                 clean: back up and truncate log/codex-tui.log
  --keep-log-days <n>             log rows to keep when --prune-logs is used; default 7
  --keep-tui-log-mib <n>          codex-tui.log tail to retain with --prune-tui-log; default 16
  --older-than-hours <n>          backups prune age threshold; default 48
  --after-hours <n>               backups schedule-prune delay; default 48
  --max-log-body-chars <n>        log feedback_log_body cap; default 4096
  --max-chars <n>                 compact cap; default 1024
  --keep-recent-days <n>          protect recently updated threads; default 14
  --archived-only                 compact only archived threads
  --apply                         write changes; omitted means dry-run
  --backup-dir <path>             backup destination for mutating commands
  --codex-command <cmd>           codex executable/npm shim; arbitrary Windows batch wrappers are rejected
  --confirm-archive-stale         required with clean --apply when archiving stale threads
  --confirm-archive-orphan-rollouts
                                  required with clean --apply --archive-orphan-rollouts
  --confirm-lossy-metadata        required with compact-metadata --apply
  --confirm-prune-logs            required with clean --apply --prune-logs
  --confirm-prune-tui-log         required with clean --apply --prune-tui-log
  --confirm-delete-backups        required with backups prune --apply
  --confirm-schedule-backup-prune required with backups schedule-prune --apply
  --json                          emit JSON
  --help                          show help
`;

const COMMANDS = ["scan", "clean", "compact-metadata", "checkpoint-wal", "archive-orphan-rollouts", "backups"] as const;
const BACKUP_COMMANDS = ["scan", "prune", "schedule-prune"] as const;

async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "allow-running-readonly": { type: "boolean", default: false },
      "allow-running-orphan-rollout-archive": { type: "boolean", default: false },
      "after-hours": { type: "string", default: "48" },
      apply: { type: "boolean", default: false },
      "archive-orphan-rollouts": { type: "boolean", default: false },
      "archived-only": { type: "boolean", default: false },
      "backup-dir": { type: "string" },
      "codex-command": { type: "string" },
      "codex-home": { type: "string" },
      "compact-recent-metadata": { type: "boolean", default: false },
      "confirm-archive-stale": { type: "boolean", default: false },
      "confirm-archive-orphan-rollouts": { type: "boolean", default: false },
      "confirm-delete-backups": { type: "boolean", default: false },
      "confirm-lossy-metadata": { type: "boolean", default: false },
      "confirm-prune-logs": { type: "boolean", default: false },
      "confirm-prune-tui-log": { type: "boolean", default: false },
      "confirm-schedule-backup-prune": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      "include-rollouts": { type: "boolean", default: false },
      "include-logs": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "keep-log-days": { type: "string", default: "7" },
      "keep-recent-days": { type: "string", default: "14" },
      "keep-tui-log-mib": { type: "string", default: "16" },
      "max-log-body-chars": { type: "string", default: "4096" },
      "max-chars": { type: "string", default: "1024" },
      "older-than-hours": { type: "string", default: "48" },
      "prune-logs": { type: "boolean", default: false },
      "prune-tui-log": { type: "boolean", default: false },
      "skip-archive-stale": { type: "boolean", default: false },
    },
  });

  if (parsed.values.help) {
    console.log(USAGE.trim());
    return 0;
  }

  const command = parsed.positionals[0] as CleanerCommand | undefined;
  if (command && !COMMANDS.includes(command)) {
    console.error(USAGE.trim());
    return 2;
  }

  const options: CleanerOptions = {
    allowRunningReadonly: Boolean(parsed.values["allow-running-readonly"]),
    allowRunningOrphanRolloutArchive: Boolean(parsed.values["allow-running-orphan-rollout-archive"]),
    afterHours: parsePositiveInt(String(parsed.values["after-hours"]), "--after-hours"),
    archiveOrphanRollouts: Boolean(parsed.values["archive-orphan-rollouts"]),
    archiveStale: !parsed.values["skip-archive-stale"],
    apply: Boolean(parsed.values.apply),
    archivedOnly: Boolean(parsed.values["archived-only"]),
    backupDir: parsed.values["backup-dir"],
    codexCommand: parsed.values["codex-command"],
    codexHome: parsed.values["codex-home"],
    compactRecentMetadata: Boolean(parsed.values["compact-recent-metadata"]),
    confirmArchiveStale: Boolean(parsed.values["confirm-archive-stale"]),
    confirmArchiveOrphanRollouts: Boolean(parsed.values["confirm-archive-orphan-rollouts"]),
    confirmDeleteBackups: Boolean(parsed.values["confirm-delete-backups"]),
    confirmLossyMetadata: Boolean(parsed.values["confirm-lossy-metadata"]),
    confirmPruneLogs: Boolean(parsed.values["confirm-prune-logs"]),
    confirmPruneTuiLog: Boolean(parsed.values["confirm-prune-tui-log"]),
    confirmScheduleBackupPrune: Boolean(parsed.values["confirm-schedule-backup-prune"]),
    includeLogs: Boolean(parsed.values["include-logs"]),
    includeRollouts: Boolean(parsed.values["include-rollouts"]),
    json: Boolean(parsed.values.json),
    keepLogDays: parsePositiveInt(String(parsed.values["keep-log-days"]), "--keep-log-days"),
    keepRecentDays: parsePositiveInt(String(parsed.values["keep-recent-days"]), "--keep-recent-days"),
    keepTuiLogMib: parsePositiveInt(String(parsed.values["keep-tui-log-mib"]), "--keep-tui-log-mib"),
    maxLogBodyChars: parsePositiveInt(String(parsed.values["max-log-body-chars"]), "--max-log-body-chars"),
    maxChars: parsePositiveInt(String(parsed.values["max-chars"]), "--max-chars"),
    olderThanHours: parsePositiveInt(String(parsed.values["older-than-hours"]), "--older-than-hours"),
    pruneLogs: Boolean(parsed.values["prune-logs"]),
    pruneTuiLog: Boolean(parsed.values["prune-tui-log"]),
  };

  const reexecCode = reexecWithSqliteWarningDisabled(argv);
  if (reexecCode != null) return reexecCode;

  const {
    archiveOrphanRollouts,
    buildScanReport,
    checkpointWal,
    cleanCodex,
    compactMetadata,
    emitReport,
    pruneBackups,
    requireStoppedOrReadonlyAllowed,
    scanBackups,
    scheduleBackupPrune,
  } = await import("./cleaner.js");

  if (!command) {
    const { runWizard } = await import("./wizard.js");
    return runWizard(options);
  }

  if (command !== "backups") {
    const mutating = isMutating(command, options);
    if (!allowsRunningFileOnlyMutation(command, options)) {
      await requireStoppedOrReadonlyAllowed({
        allowRunningReadonly: options.allowRunningReadonly,
        mutating,
      });
    }
  }

  if (command === "backups") {
    const backupCommand = parseBackupCommand(parsed.positionals[1]);
    const report =
      backupCommand === "scan"
        ? scanBackups(options)
        : backupCommand === "prune"
          ? pruneBackups(options)
          : await scheduleBackupPrune(options);
    emitReport(report, options.json);
    return 0;
  }

  const report =
    command === "scan"
      ? buildScanReport(options)
      : command === "clean"
        ? await cleanCodex(options)
        : command === "compact-metadata"
          ? await compactMetadata(options)
          : command === "archive-orphan-rollouts"
            ? archiveOrphanRollouts(options)
            : await checkpointWal(options);

  emitReport(report, options.json);
  return 0;
}

function parseBackupCommand(value: string | undefined): BackupCommand {
  const command = (value ?? "scan") as BackupCommand;
  if (!BACKUP_COMMANDS.includes(command)) {
    throw new Error(`Unknown backups command: ${String(value)}\n${USAGE.trim()}`);
  }
  return command;
}

function isMutating(command: CleanerCommand, options: CleanerOptions): boolean {
  return command !== "scan" && options.apply;
}

function allowsRunningFileOnlyMutation(command: CleanerCommand, options: CleanerOptions): boolean {
  return command === "archive-orphan-rollouts" && options.apply && options.allowRunningOrphanRolloutArchive;
}

function reexecWithSqliteWarningDisabled(argv: string[]): number | null {
  const alreadyDisabled =
    process.env.NODE_NO_WARNINGS === "1" ||
    process.execArgv.includes("--no-warnings") ||
    process.execArgv.includes("--disable-warning=ExperimentalWarning");
  if (alreadyDisabled) return null;
  if (!process.allowedNodeEnvironmentFlags.has("--disable-warning=ExperimentalWarning")) return null;
  if (!process.argv[1]) return null;

  const result = spawnSync(
    process.execPath,
    [...process.execArgv, "--disable-warning=ExperimentalWarning", process.argv[1], ...argv],
    {
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function parsePositiveInt(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
