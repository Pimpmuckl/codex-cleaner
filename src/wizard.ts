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
  const reclaimableMib = estimateReclaimableMib(report);
  printScanSummary(report, reclaimableMib);
  if (!hasWork(report)) {
    console.log(pc.green("\nNothing to clean up."));
    return 0;
  }

  const deleteRows = numberAt(report, "deletePlan", "expectedDeletedThreads");
  const reclaimable = formatSizeMib(reclaimableMib);
  const proceed = await confirm({
    default: false,
    message:
      mode === "full" && deleteRows > 0
        ? `Permanently delete ${String(deleteRows)} archived threads and reclaim about ${reclaimable}?`
        : `Apply cleanup and reclaim about ${reclaimable}?`,
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

function printScanSummary(report: Record<string, unknown>, reclaimableMib: number): void {
  const deletePlan = recordAt(report, "deletePlan");
  const deleteRows = Number(deletePlan.expectedDeletedThreads ?? 0);
  console.log(pc.bold(`\nDry run — ${report.cleanupMode === "full" ? "Full cleanup" : "Clean up"}`));
  console.log(`  Could reclaim: about ${formatSizeMib(reclaimableMib)}`);
  if (deleteRows > 0) {
    console.log(
      pc.yellow(
        `  Permanently deletes ${String(deleteRows)} archived threads older than ${String(deletePlan.retentionDays)} days.`,
      ),
    );
  } else if (report.cleanupMode === "full") {
    console.log(pc.green("  No archived threads are old enough for deletion."));
  } else {
    console.log(pc.green("  Threads and rollout files stay unchanged."));
  }
}

export function estimateReclaimableMib(report: Record<string, unknown>): number {
  const stateFree = numberAt(report, "maintenance", "state", "free_mib");
  const logsFree = numberAt(report, "maintenance", "logs", "free_mib");
  return (
    (stateFree >= 1 ? stateFree : 0) + (logsFree >= 1 ? logsFree : 0) + numberAt(report, "deletePlan", "rolloutSizeMib")
  );
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
  console.log(`  State WAL: ${formatSizeMib(beforeWal.mib)} -> ${formatSizeMib(afterWal.mib)}`);
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
  console.log(`  ${label}: ${formatSizeMib(before.mib)} -> ${formatSizeMib(after.mib)}`);
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

export function formatSizeMib(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  const units = ["MiB", "GiB", "TiB"];
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${Number(size.toPrecision(3)).toString()} ${units[unit]}`;
}
