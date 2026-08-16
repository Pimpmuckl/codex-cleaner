#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import type { BackupCommand, CleanerCommand, CleanerOptions } from "./types.js";

const USAGE = `
codex-cleaner [command] [options]

Commands:
  (none)                  Choose Clean up or Full cleanup, scan, then optionally apply
  scan                    Show what cleanup would reclaim
  clean                   Apply with --apply; otherwise dry-run
  backups scan            Inspect codex-cleaner backup files
  backups prune           Delete old codex-cleaner backup files with --apply
  backups schedule-prune  Schedule a one-shot future backups prune job

Cleanup options:
  --full                  Also permanently delete old archived threads and rollout JSONL
  --keep-days <n>         Full cleanup retention; default 90 days (requires --full)
  --apply                 Apply changes; omitted means dry-run

Path and output options:
  --codex-home <path>     Codex home; defaults to CODEX_HOME or ~/.codex
  --sqlite-home <path>    SQLite directory; overrides config.toml and CODEX_SQLITE_HOME
  --backup-dir <path>     Backup destination for database maintenance
  --codex-command <cmd>   Codex executable used for full cleanup
  --json                  Emit JSON

Backup options:
  --older-than-hours <n>  backups prune age threshold; default 48
  --after-hours <n>       backups schedule-prune delay; default 48
  --help                  Show help
`;

const COMMANDS = ["scan", "clean", "backups"] as const;
const BACKUP_COMMANDS = ["scan", "prune", "schedule-prune"] as const;

async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "after-hours": { type: "string", default: "48" },
      apply: { type: "boolean", default: false },
      "backup-dir": { type: "string" },
      "codex-command": { type: "string" },
      "codex-home": { type: "string" },
      full: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      json: { type: "boolean", default: false },
      "keep-days": { type: "string" },
      "older-than-hours": { type: "string", default: "48" },
      "sqlite-home": { type: "string" },
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
  if (parsed.values["keep-days"] && !parsed.values.full) {
    throw new Error("--keep-days requires --full");
  }

  const options: CleanerOptions = {
    afterHours: parsePositiveInt(String(parsed.values["after-hours"]), "--after-hours"),
    apply: Boolean(parsed.values.apply),
    backupDir: parsed.values["backup-dir"],
    codexCommand: parsed.values["codex-command"],
    codexHome: parsed.values["codex-home"],
    json: Boolean(parsed.values.json),
    keepDays: parsePositiveInt(String(parsed.values["keep-days"] ?? "90"), "--keep-days"),
    mode: parsed.values.full ? "full" : "cleanup",
    olderThanHours: parsePositiveInt(String(parsed.values["older-than-hours"]), "--older-than-hours"),
    sqliteHome: parsed.values["sqlite-home"],
  };

  const reexecCode = reexecWithSqliteWarningDisabled(argv);
  if (reexecCode != null) return reexecCode;

  const {
    buildScanReport,
    cleanCodex,
    emitReport,
    pruneBackups,
    requireCodexStopped,
    scanBackups,
    scheduleBackupPrune,
  } = await import("./cleaner.js");

  if (!command) {
    const { runWizard } = await import("./wizard.js");
    return runWizard(options);
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
    return report.ok === false ? 1 : 0;
  }

  if (command === "clean" && options.apply) await requireCodexStopped();
  const report = command === "scan" ? buildScanReport(options) : await cleanCodex(options);
  emitReport(report, options.json);
  return report.ok === false ? 1 : 0;
}

function parseBackupCommand(value: string | undefined): BackupCommand {
  const command = (value ?? "scan") as BackupCommand;
  if (!BACKUP_COMMANDS.includes(command)) {
    throw new Error(`Unknown backups command: ${String(value)}\n${USAGE.trim()}`);
  }
  return command;
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
    { stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function parsePositiveInt(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
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
