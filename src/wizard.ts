import { confirm, select } from "@inquirer/prompts";
import pc from "picocolors";

import {
  buildScanReport,
  cleanCodex,
  findBlockingProcesses,
  requireCodexStopped,
  resolveStoragePaths,
} from "./cleaner.js";
import type { CleanerOptions, CleanupMode } from "./types.js";

export async function runWizard(options: CleanerOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("The guided TUI needs an interactive terminal. Use `codex-cleaner scan` for noninteractive runs.");
  }

  console.log(pc.bold("codex-cleaner"));
  const mode = await select<CleanupMode>({
    choices: [
      {
        description: "Reclaim free database space. Keeps every thread and rollout file.",
        name: "Clean up",
        value: "cleanup",
      },
      {
        description: `Also permanently delete archived threads older than ${String(options.keepDays)} days.`,
        name: "Full cleanup",
        value: "full",
      },
    ],
    default: options.mode,
    message: "Choose a cleanup mode",
  });
  const dryRunOptions = { ...options, apply: false, json: false, mode };

  const blockers = await findBlockingProcesses();
  if (blockers.length) {
    console.log(
      pc.yellow(
        `\nCodex is running (${blockers.length} matching processes). Scanning is safe; apply needs Codex closed.`,
      ),
    );
  }

  console.log(pc.dim("\nScanning..."));
  const report = buildScanReport(dryRunOptions);
  printScanSummary(report);
  if (!hasWork(report)) {
    console.log(pc.green("\nNothing to clean up."));
    return 0;
  }

  const deleteRows = numberAt(report, "deletePlan", "expectedDeletedThreads");
  const proceed = await confirm({
    default: false,
    message:
      mode === "full" && deleteRows > 0
        ? `Permanently delete ${String(deleteRows)} archived threads and apply database cleanup?`
        : "Apply this database cleanup?",
  });
  if (!proceed) {
    console.log(pc.dim(`\nNo changes made. Apply later with:\n  ${buildCleanCommand(dryRunOptions, true)}`));
    return 0;
  }

  await requireCodexStopped();
  console.log(pc.dim("\nApplying cleanup..."));
  const applyReport = await cleanCodex({ ...dryRunOptions, apply: true });
  printApplySummary(applyReport);
  return applyReport.ok === false ? 1 : 0;
}

function hasWork(report: Record<string, unknown>): boolean {
  return (
    numberAt(report, "maintenance", "state", "free_mib") >= 1 ||
    numberAt(report, "maintenance", "logs", "free_mib") >= 1 ||
    numberAt(report, "files", "state_5.sqlite", "wal", "bytes") > 0 ||
    numberAt(report, "deletePlan", "expectedDeletedThreads") > 0
  );
}

function printScanSummary(report: Record<string, unknown>): void {
  const files = recordAt(report, "files");
  const state = recordAt(files, "state_5.sqlite");
  const stateMain = recordAt(state, "main");
  const stateWal = recordAt(state, "wal");
  const maintenance = recordAt(report, "maintenance");
  const stateSpace = recordAt(maintenance, "state");
  const logsSpace = recordAt(maintenance, "logs");

  console.log(pc.bold("\nDry-run summary"));
  console.log(`  Mode: ${report.cleanupMode === "full" ? "Full cleanup" : "Clean up"}`);
  console.log(`  Codex home: ${String(report.codexHome)}`);
  console.log(`  SQLite home: ${String(report.sqliteHome)}`);
  console.log(`  State database: ${formatMib(stateMain.mib)} plus ${formatMib(stateWal.mib)} WAL`);
  console.log(`  State free pages: ${formatMib(stateSpace.free_mib)}`);
  console.log(`  Logs free pages: ${formatMib(logsSpace.free_mib)}`);

  const deletePlan = recordAt(report, "deletePlan");
  if (Object.keys(deletePlan).length) {
    console.log(
      pc.yellow(
        `  Permanent history deletion: ${String(deletePlan.expectedDeletedThreads)} archived threads, about ${formatMib(deletePlan.rolloutSizeMib)} of rollout JSONL`,
      ),
    );
    const blocked = Number(deletePlan.blockedByDescendantSafety ?? 0);
    if (blocked > 0) console.log(pc.dim(`  Protected unsafe trees: ${String(blocked)}`));
    console.log(pc.dim("  The database backup does not restore deleted rollout JSONL."));
  } else {
    console.log(pc.green("  Thread history and rollout JSONL stay unchanged."));
  }
}

function printApplySummary(report: Record<string, unknown>): void {
  console.log(pc.bold(report.ok === false ? "\nCleanup incomplete" : "\nCleanup complete"));
  const deletion = recordAt(report, "deleteApply");
  if (Object.keys(deletion).length) {
    console.log(`  Deleted thread roots: ${String(deletion.succeeded ?? 0)}`);
    if (Number(deletion.failed ?? 0) > 0) console.log(pc.yellow(`  Delete failures: ${String(deletion.failed)}`));
  }
  printVacuum("State database", recordAt(report, "vacuum"));
  printVacuum("Logs database", recordAt(report, "logs"));
  const checkpoint = recordAt(report, "checkpoint");
  const beforeWal = recordAt(checkpoint, "before", "wal");
  const afterWal = recordAt(checkpoint, "after", "wal");
  console.log(`  State WAL: ${formatMib(beforeWal.mib)} -> ${formatMib(afterWal.mib)}`);
  if (report.stateBackupPath) console.log(`  State backup: ${String(report.stateBackupPath)}`);
  const backupSchedule = recordAt(report, "backups");
  if (backupSchedule.error) {
    console.log(pc.yellow(`  Backup cleanup was not scheduled: ${String(backupSchedule.error)}`));
  } else if (Object.keys(backupSchedule).length) {
    console.log(`  Backup cleanup: ${String(recordAt(backupSchedule, "policy").runAtUtc)}`);
    if (backupSchedule.cancelCommand) console.log(`  Cancel backup cleanup: ${String(backupSchedule.cancelCommand)}`);
  }
}

function printVacuum(label: string, report: Record<string, unknown>): void {
  if (!Object.keys(report).length || report.exists === false) return;
  const before = recordAt(report, "before", "main");
  const after = recordAt(report, "after", "main");
  console.log(`  ${label}: ${formatMib(before.mib)} -> ${formatMib(after.mib)}`);
}

export function buildCleanCommand(
  options: CleanerOptions,
  apply: boolean,
  platform: NodeJS.Platform = process.platform,
): string {
  const storage = resolveStoragePaths(options);
  const flags = [
    `--codex-home ${shellQuote(storage.codexHome, platform)}`,
    `--sqlite-home ${shellQuote(storage.sqliteHome, platform)}`,
    options.backupDir ? `--backup-dir ${shellQuote(options.backupDir, platform)}` : "",
    options.codexCommand ? `--codex-command ${shellQuote(options.codexCommand, platform)}` : "",
    options.mode === "full" ? "--full" : "",
    options.mode === "full" ? `--keep-days ${String(options.keepDays)}` : "",
    apply ? "--apply" : "",
  ].filter(Boolean);
  return `npx codex-cleaner@latest clean ${flags.join(" ")}`;
}

function shellQuote(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function recordAt(source: unknown, ...keys: string[]): Record<string, unknown> {
  let current = source;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return {};
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
}

function numberAt(source: unknown, ...keys: string[]): number {
  const parent = recordAt(source, ...keys.slice(0, -1));
  const value = parent[keys.at(-1) ?? ""];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatMib(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString()} MiB` : "unknown";
}
