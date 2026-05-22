#!/usr/bin/env node
import { parseArgs } from "node:util";

import {
  buildScanReport,
  checkpointWal,
  cleanCodex,
  compactMetadata,
  emitReport,
  requireStoppedOrReadonlyAllowed,
} from "./cleaner.js";
import type { CleanerCommand, CleanerOptions } from "./types.js";
import { runWizard } from "./wizard.js";

const USAGE = `
codex-cleaner [command] [options]

Commands:
  (none)            Guided TUI: choose settings, dry-run, then optionally apply
  clean             Unified dry-run/apply for metadata compaction and stale thread archiving
  scan              Read-only size, protection, candidate, and optional rollout-linkage report
  compact-metadata  Cap old threads.title/preview/first_user_message values
  checkpoint-wal    Run PRAGMA wal_checkpoint(TRUNCATE) for state_5.sqlite

Options:
  --codex-home <path>             Codex home path; defaults to CODEX_HOME or ~/.codex
  --allow-running-readonly        Allow read-only dry-runs while Codex processes are active
  --skip-archive-stale            Do not include stale thread archiving in clean/TUI flow
  --compact-recent-metadata       Also cap recent unprotected metadata; pinned/open/active stay protected
  --include-logs                  scan: include expensive logs_2.sqlite table stats
  --include-rollouts              scan: include sessions/archived_sessions linkage scan
  --prune-logs                    clean: prune/cap logs_2.sqlite and vacuum it
  --keep-log-days <n>             log rows to keep when --prune-logs is used; default 7
  --max-log-body-chars <n>        log feedback_log_body cap; default 4096
  --max-chars <n>                 compact cap; default 1024
  --keep-recent-days <n>          protect recently updated threads; default 14
  --archived-only                 compact only archived threads
  --apply                         write changes; omitted means dry-run
  --backup-dir <path>             backup destination for mutating commands
  --codex-command <cmd>           codex executable/npm shim; arbitrary Windows batch wrappers are rejected
  --confirm-archive-stale         required with clean --apply when archiving stale threads
  --confirm-lossy-metadata        required with compact-metadata --apply
  --confirm-prune-logs            required with clean --apply --prune-logs
  --json                          emit JSON
  --help                          show help
`;

const COMMANDS = ["scan", "clean", "compact-metadata", "checkpoint-wal"] as const;

async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "allow-running-readonly": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      "archived-only": { type: "boolean", default: false },
      "backup-dir": { type: "string" },
      "codex-command": { type: "string" },
      "codex-home": { type: "string" },
      "compact-recent-metadata": { type: "boolean", default: false },
      "confirm-archive-stale": { type: "boolean", default: false },
      "confirm-lossy-metadata": { type: "boolean", default: false },
      "confirm-prune-logs": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      "include-rollouts": { type: "boolean", default: false },
      "include-logs": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "keep-log-days": { type: "string", default: "7" },
      "keep-recent-days": { type: "string", default: "14" },
      "max-log-body-chars": { type: "string", default: "4096" },
      "max-chars": { type: "string", default: "1024" },
      "prune-logs": { type: "boolean", default: false },
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
    archiveStale: !parsed.values["skip-archive-stale"],
    apply: Boolean(parsed.values.apply),
    archivedOnly: Boolean(parsed.values["archived-only"]),
    backupDir: parsed.values["backup-dir"],
    codexCommand: parsed.values["codex-command"],
    codexHome: parsed.values["codex-home"],
    compactRecentMetadata: Boolean(parsed.values["compact-recent-metadata"]),
    confirmArchiveStale: Boolean(parsed.values["confirm-archive-stale"]),
    confirmLossyMetadata: Boolean(parsed.values["confirm-lossy-metadata"]),
    confirmPruneLogs: Boolean(parsed.values["confirm-prune-logs"]),
    includeLogs: Boolean(parsed.values["include-logs"]),
    includeRollouts: Boolean(parsed.values["include-rollouts"]),
    json: Boolean(parsed.values.json),
    keepLogDays: parsePositiveInt(String(parsed.values["keep-log-days"]), "--keep-log-days"),
    keepRecentDays: parsePositiveInt(String(parsed.values["keep-recent-days"]), "--keep-recent-days"),
    maxLogBodyChars: parsePositiveInt(String(parsed.values["max-log-body-chars"]), "--max-log-body-chars"),
    maxChars: parsePositiveInt(String(parsed.values["max-chars"]), "--max-chars"),
    pruneLogs: Boolean(parsed.values["prune-logs"]),
  };

  if (!command) {
    return runWizard(options);
  }

  await requireStoppedOrReadonlyAllowed({
    allowRunningReadonly: options.allowRunningReadonly,
    mutating: isMutating(command, options),
  });

  const report =
    command === "scan"
      ? buildScanReport(options)
      : command === "clean"
        ? await cleanCodex(options)
        : command === "compact-metadata"
          ? await compactMetadata(options)
          : await checkpointWal(options);

  emitReport(report, options.json);
  return 0;
}

function isMutating(command: CleanerCommand, options: CleanerOptions): boolean {
  return command !== "scan" && options.apply;
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
