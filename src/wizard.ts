import { confirm, input, select } from "@inquirer/prompts";
import path from "node:path";
import pc from "picocolors";

import {
  buildScanReport,
  cleanCodex,
  findBlockingProcesses,
  requireStoppedOrReadonlyAllowed,
} from "./cleaner.js";
import type { CleanerOptions } from "./types.js";

type Choice<T> = {
  description?: string;
  name: string;
  value: T;
};

type KeepRecentChoice = 7 | 14 | 30 | "custom";
type MaxCharsChoice = 1024 | 2048 | 4096 | "custom";
type WizardMode = "recommended" | "custom";

export async function runWizard(options: CleanerOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("The guided TUI needs an interactive terminal. Use `codex-cleaner scan` for noninteractive runs.");
  }

  printIntro();
  const initialBlockers = await findBlockingProcesses();
  if (initialBlockers.length) {
    console.log(pc.yellow(`Codex appears to be running (${initialBlockers.length} matching processes).`));
    console.log(pc.dim("This wizard can still dry-run, but apply will be disabled until Codex is fully closed.\n"));
  }

  const wizardMode = await askWizardMode();
  const dryRunOptions =
    wizardMode === "recommended" ? recommendedWizardOptions(options) : await customWizardOptions(options);
  const runDryRun = await confirm({
    default: true,
    message: "Run the dry-run scan now?",
  });

  if (!runDryRun) {
    printDryRunCommand(dryRunOptions);
    return 0;
  }

  console.log(pc.dim("\nScanning Codex metadata..."));
  const report = buildScanReport(dryRunOptions);
  printDryRunSummary(report);

  const compactRows = numberAt(report, "compactMetadataCandidates", "rows");
  const archiveRows = numberAt(report, "staleArchiveCandidates", "archive_call_rows");
  const orphanRolloutRows = numberAt(report, "orphanRolloutArchiveCandidates", "files");
  const logRows =
    numberAt(report, "logCleanupCandidates", "delete_rows") +
    numberAt(report, "logCleanupCandidates", "target_prune_rows") +
    numberAt(report, "logCleanupCandidates", "cap_rows");
  const tuiLogMib = numberAt(report, "tuiLogCleanupCandidates", "reclaimable_mib");
  const vacuumMib = numberAt(report, "databaseSpace", "state_5.sqlite", "free_mib");
  if (!compactRows && !archiveRows && !orphanRolloutRows && !logRows && !tuiLogMib && vacuumMib < 1) {
    console.log(pc.green("\nNo cleanup candidates found under this policy."));
    return 0;
  }

  const proceed = await waitForApplyConfirmation();
  if (!proceed) {
    console.log(pc.dim("\nNo changes made. To apply later, run:"));
    printApplyCommand(dryRunOptions);
    return 0;
  }

  await requireStoppedOrReadonlyAllowed({ allowRunningReadonly: false, mutating: true });
  console.log(pc.dim("\nApplying cleanup..."));
  const applyReport = await cleanCodex({
    ...dryRunOptions,
    apply: true,
  });
  printApplySummary(
    recordAt(applyReport, "compact"),
    nullableRecordAt(applyReport, "archive"),
    nullableRecordAt(applyReport, "orphanRollouts"),
    recordAt(applyReport, "vacuum"),
    nullableRecordAt(applyReport, "logs"),
    nullableRecordAt(applyReport, "tuiLog"),
    recordAt(applyReport, "checkpoint"),
    nullableRecordAt(applyReport, "backupPruneSchedule"),
  );
  return 0;
}

export function recommendedWizardOptions(options: CleanerOptions): CleanerOptions {
  return {
    ...options,
    allowRunningReadonly: true,
    archiveOrphanRollouts: true,
    archiveStale: true,
    apply: false,
    archivedOnly: false,
    compactRecentMetadata: false,
    includeLogs: false,
    includeRollouts: false,
    json: false,
    pruneLogs: true,
    pruneTuiLog: true,
  };
}

async function customWizardOptions(options: CleanerOptions): Promise<CleanerOptions> {
  const keepRecentDays = await askKeepRecentDays(options.keepRecentDays);
  const maxChars = await askMaxChars(options.maxChars);
  const compactRecentMetadata = await askCompactRecentMetadata();
  const archiveStale = await askArchiveStale();
  const archiveOrphanRollouts = await askArchiveOrphanRollouts();
  const pruneLogs = await askPruneLogs();
  const pruneTuiLog = await askPruneTuiLog();
  const includeRollouts = await confirm({
    default: false,
    message: "Also scan orphan rollout files? This is slower and stays dry-run only.",
  });

  return {
    ...options,
    allowRunningReadonly: true,
    archiveOrphanRollouts,
    archiveStale,
    apply: false,
    archivedOnly: false,
    compactRecentMetadata,
    includeLogs: false,
    includeRollouts,
    json: false,
    keepRecentDays,
    maxChars,
    pruneLogs,
    pruneTuiLog,
  };
}

async function waitForApplyConfirmation(): Promise<boolean> {
  while (true) {
    const applyNow = await confirm({
      default: false,
      message: "Apply this cleanup now? Backups will be created first.",
    });
    if (!applyNow) return false;

    const blockers = await findBlockingProcesses();
    if (!blockers.length) return true;

    console.log(
      pc.yellow(`\nCodex is still running (${blockers.length} matching processes). No changes were applied.`),
    );
    console.log(pc.dim("Close Codex completely before applying DB or WAL cleanup."));
    const retry = await confirm({
      default: true,
      message: "Check again after closing Codex?",
    });
    if (!retry) return false;
  }
}

async function askWizardMode(): Promise<WizardMode> {
  return select<WizardMode>({
    choices: [
      {
        description: "Use the normal safe defaults, then dry-run before apply.",
        name: "Run recommended cleanup",
        value: "recommended",
      },
      {
        description: "Choose retention windows, metadata cap, log cleanup, and archive behavior.",
        name: "Customize settings",
        value: "custom",
      },
    ],
    default: "recommended",
    message: "How do you want to run codex-cleaner?",
  });
}

async function askKeepRecentDays(currentDefault: number): Promise<number> {
  console.log(pc.bold("\nRecent thread protection"));
  console.log(
    pc.dim(
      "Threads updated inside this window are always kept untouched. Pinned, heartbeat/app-permission, and active-goal threads are also protected.",
    ),
  );
  const choices: Choice<KeepRecentChoice>[] = [
    { name: "14 days (recommended)", value: 14 },
    { name: "30 days", value: 30 },
    { name: "7 days", value: 7 },
    { name: `Current flag default (${currentDefault} days)`, value: currentDefault as KeepRecentChoice },
    { name: "Custom", value: "custom" },
  ];
  const selected = await select<KeepRecentChoice>({
    choices: dedupeChoiceValues(choices),
    default: choices.some((choice) => choice.value === currentDefault) ? (currentDefault as KeepRecentChoice) : 14,
    message: "How far back should active/recent threads be protected?",
  });
  if (selected !== "custom") return selected;
  return askPositiveInteger("Days to protect", String(currentDefault));
}

async function askMaxChars(currentDefault: number): Promise<number> {
  console.log(pc.bold("\nMetadata cap"));
  console.log(
    pc.dim(
      "This caps only old thread display/search metadata: title, preview, first_user_message. It does not delete threads or rollout JSONL used by CodexMeter.",
    ),
  );
  const choices: Choice<MaxCharsChoice>[] = [
    { name: "1024 chars (recommended)", value: 1024 },
    { name: "2048 chars", value: 2048 },
    { name: "4096 chars", value: 4096 },
    { name: `Current flag default (${currentDefault} chars)`, value: currentDefault as MaxCharsChoice },
    { name: "Custom", value: "custom" },
  ];
  const selected = await select<MaxCharsChoice>({
    choices: dedupeChoiceValues(choices),
    default: choices.some((choice) => choice.value === currentDefault) ? (currentDefault as MaxCharsChoice) : 1024,
    message: "How much old metadata should each field keep?",
  });
  if (selected !== "custom") return selected;
  return askPositiveInteger("Characters to keep per metadata field", String(currentDefault));
}

async function askCompactRecentMetadata(): Promise<boolean> {
  console.log(pc.bold("\nRecent metadata compaction"));
  console.log(
    pc.dim(
      "This also caps recent unprotected thread display/search metadata. Pinned, app/heartbeat, and active-goal threads still stay untouched, and rollout JSONL context is not changed.",
    ),
  );
  return confirm({
    default: false,
    message: "Also compact recent unprotected metadata?",
  });
}

async function askArchiveStale(): Promise<boolean> {
  console.log(pc.bold("\nStale thread archiving"));
  console.log(
    pc.dim(
      "Old unpinned threads outside the recent window can be moved from sessions to archived_sessions using Codex's own archive API. Rollout JSONL is retained for history and CodexMeter.",
    ),
  );
  return confirm({
    default: true,
    message: "Include stale thread archiving in this cleanup?",
  });
}

async function askArchiveOrphanRollouts(): Promise<boolean> {
  console.log(pc.bold("\nOrphan rollout archiving"));
  console.log(
    pc.dim(
      "Old rollout JSONL files in sessions that are not referenced by SQLite can be moved to archived_sessions. This keeps active session scans lean and does not delete the files.",
    ),
  );
  return confirm({
    default: true,
    message: "Move old DB-unreferenced rollout files out of sessions?",
  });
}

async function askPruneLogs(): Promise<boolean> {
  console.log(pc.bold("\nLog cleanup"));
  console.log(
    pc.dim(
      "This prunes old logs_2.sqlite rows and caps giant feedback_log_body payloads. It does not touch threads or rollout JSONL.",
    ),
  );
  return confirm({
    default: true,
    message: "Include logs_2.sqlite cleanup in this cleanup?",
  });
}

async function askPruneTuiLog(): Promise<boolean> {
  console.log(pc.bold("\nTUI log file cleanup"));
  console.log(
    pc.dim(
      "This backs up log/codex-tui.log, then keeps only the newest log tail. It does not touch SQLite, threads, or rollout JSONL.",
    ),
  );
  return confirm({
    default: true,
    message: "Trim codex-tui.log to the newest log tail?",
  });
}

async function askPositiveInteger(message: string, defaultValue: string): Promise<number> {
  const value = await input({
    default: defaultValue,
    message,
    validate: (raw) => {
      const parsed = Number(raw);
      return Number.isInteger(parsed) && parsed > 0 ? true : "Enter a positive integer.";
    },
  });
  return Number(value);
}

function printIntro(): void {
  console.log(pc.bold("codex-cleaner"));
  console.log("Guided dry-run first. Apply only after you see exactly what would change.\n");
}

function printDryRunSummary(report: Record<string, unknown>): void {
  console.log(pc.bold("\nDry-run summary"));
  const policy = recordAt(report, "policy");
  const files = recordAt(report, "files");
  const stateFile = recordAt(files, "state_5.sqlite");
  const stateMain = recordAt(stateFile, "main");
  const stateWal = recordAt(stateFile, "wal");
  const protection = recordAt(report, "protection");
  const threads = recordAt(report, "threads");
  const candidates = recordAt(report, "compactMetadataCandidates");

  console.log(`  Codex home: ${String(report.codexHome)}`);
  console.log(`  Recent window: ${String(policy.keepRecentDays)} days`);
  console.log(`  Metadata cap: ${String(policy.maxChars)} chars`);
  console.log(`  Compact recent metadata: ${policy.compactRecentMetadata ? "yes" : "no"}`);
  console.log(`  state_5.sqlite: ${formatMib(stateMain.mib)} main, ${formatMib(stateWal.mib)} WAL`);
  console.log(
    `  Protected threads: ${String(protection.totalUniqueProtectedThreads)} (${String(protection.pinnedThreads)} pinned, ${String(
      protection.heartbeatThreads,
    )} app/heartbeat, ${String(protection.activeGoalThreads)} active goals)`,
  );
  console.log(`  Thread rows: ${String(threads.rows)}`);
  console.log(
    pc.green(
      `  Recommended metadata compaction: ${String(candidates.rows)} rows, about ${formatMib(
        candidates.estimated_savings_mib,
      )} old metadata payload reduction`,
    ),
  );

  const archive = recordAt(report, "staleArchiveCandidates");
  if (Object.keys(archive).length) {
    console.log(
      pc.green(
        `  Stale archiving: ${String(archive.expected_archived_rows)} threads via ${String(
          archive.archive_call_rows,
        )} Codex archive calls, moving about ${formatMib(archive.expected_archived_rollout_size_mib)} of rollout JSONL`,
      ),
    );
    if (Number(archive.blocked_by_descendant_safety) > 0) {
      console.log(
        pc.yellow(
          `  Skipped ${String(
            archive.blocked_by_descendant_safety,
          )} stale roots because their spawned descendants are still recent or protected.`,
        ),
      );
    }
  }
  const orphanRollouts = recordAt(report, "orphanRolloutArchiveCandidates");
  if (Object.keys(orphanRollouts).length) {
    console.log(
      pc.green(
        `  Orphan rollout archiving: move ${String(orphanRollouts.files)} old DB-unreferenced JSONL files (${formatMib(
          orphanRollouts.size_mib,
        )}) from sessions to archived_sessions; remove ${String(orphanRollouts.empty_dir_candidates ?? 0)} empty dirs`,
      ),
    );
    if (Number(orphanRollouts.skipped_recent_files) > 0) {
      console.log(
        pc.yellow(`  Skipped ${String(orphanRollouts.skipped_recent_files)} orphan rollouts inside the recent window.`),
      );
    }
    if (Number(orphanRollouts.skipped_protected_files) > 0) {
      console.log(pc.yellow(`  Skipped ${String(orphanRollouts.skipped_protected_files)} protected orphan rollouts.`));
    }
    if (Number(orphanRollouts.skipped_session_indexed_files) > 0) {
      console.log(
        pc.yellow(
          `  Skipped ${String(
            orphanRollouts.skipped_session_indexed_files,
          )} DB-orphaned rollouts still present in session_index.jsonl.`,
        ),
      );
    }
  }
  const stateSpace = recordAt(report, "databaseSpace", "state_5.sqlite");
  if (Number(stateSpace.free_mib) >= 1) {
    console.log(pc.green(`  State vacuum: reclaim about ${formatMib(stateSpace.free_mib)} from SQLite freelist`));
  }
  const logCleanup = recordAt(report, "logCleanupCandidates");
  if (Object.keys(logCleanup).length) {
    console.log(
      pc.green(
        `  Logs cleanup: delete ${String(logCleanup.delete_rows)} old rows, delete ${String(
          logCleanup.target_prune_rows ?? 0,
        )} noisy rows, and cap ${String(
          logCleanup.cap_rows,
        )} oversized log payloads`,
      ),
    );
  }
  const tuiLogCleanup = recordAt(report, "tuiLogCleanupCandidates");
  if (Object.keys(tuiLogCleanup).length) {
    console.log(
      pc.green(
        `  TUI log cleanup: reclaim about ${formatMib(tuiLogCleanup.reclaimable_mib)} while keeping newest ${formatMib(
          tuiLogCleanup.keep_mib,
        )}`,
      ),
    );
  }
  console.log(pc.dim("  Preserves thread rows and rollout JSONL; orphan rollout files are moved, not deleted."));

  const rollouts = recordAt(report, "rollouts");
  if (Object.keys(rollouts).length) {
    console.log(
      pc.dim(
        `  Rollout scan: ${String(rollouts.orphanFiles)} orphan files (${formatMib(
          rollouts.orphanSizeMib,
        )}); deletion is not part of this apply flow.`,
      ),
    );
  }
}

function printApplySummary(
  report: Record<string, unknown>,
  archiveReport: Record<string, unknown> | null,
  orphanRolloutsReport: Record<string, unknown> | null,
  vacuumReport: Record<string, unknown>,
  logsReport: Record<string, unknown> | null,
  tuiLogReport: Record<string, unknown> | null,
  checkpointReport: Record<string, unknown>,
  backupPruneSchedule: Record<string, unknown> | null,
): void {
  const before = recordAt(report, "before");
  const after = recordAt(report, "after");
  console.log(pc.bold("\nApply complete"));
  if (archiveReport) {
    const archiveBefore = recordAt(archiveReport, "before");
    const appServer = recordAt(archiveReport, "appServerResult");
    console.log(
      `  Archived stale threads: ${String(appServer.succeeded ?? 0)} archive calls for up to ${String(
        archiveBefore.expected_archived_rows ?? 0,
      )} threads`,
    );
    if (Number(appServer.failed ?? 0) > 0) {
      console.log(
        pc.yellow(`  Archive errors: ${String(appServer.failed)}; rerun dry-run to inspect remaining candidates.`),
      );
    }
    console.log(`  Archive backup: ${String(archiveReport.backupPath)}`);
  }
  if (orphanRolloutsReport) {
    console.log(
      `  Archived orphan rollouts: moved ${String(orphanRolloutsReport.movedFiles ?? 0)} files (${formatMib(
        orphanRolloutsReport.movedMib,
      )})`,
    );
    if (orphanRolloutsReport.manifestPath) {
      console.log(`  Orphan rollout manifest: ${String(orphanRolloutsReport.manifestPath)}`);
    }
    console.log(`  Empty session/archive dirs removed: ${String(orphanRolloutsReport.prunedEmptyDirs ?? 0)}`);
  }
  console.log(`  Changed rows: ${String(report.changedRows)}`);
  if (report.backupPath) console.log(`  Metadata backup: ${String(report.backupPath)}`);
  console.log(`  Remaining eligible rows: ${String(after.rows)} (was ${String(before.rows)})`);
  if (Object.keys(vacuumReport).length) {
    const vacuumBefore = recordAt(vacuumReport, "before", "main");
    const vacuumAfter = recordAt(vacuumReport, "after", "main");
    console.log(`  State vacuum: ${formatMib(vacuumBefore.mib)} -> ${formatMib(vacuumAfter.mib)}`);
  }
  if (logsReport) {
    console.log(
      `  Logs cleanup: deleted ${String(logsReport.deletedRows ?? 0)} rows, capped ${String(
        logsReport.cappedRows ?? 0,
      )} rows`,
    );
  }
  if (tuiLogReport) {
    const tuiBefore = recordAt(tuiLogReport, "before");
    const tuiAfter = recordAt(tuiLogReport, "after");
    console.log(`  TUI log cleanup: ${formatMib(tuiBefore.current_mib)} -> ${formatMib(tuiAfter.current_mib)}`);
  }
  const checkpointBefore = recordAt(checkpointReport, "before", "wal");
  const checkpointAfter = recordAt(checkpointReport, "after", "wal");
  console.log(`  WAL checkpoint: ${formatMib(checkpointBefore.mib)} -> ${formatMib(checkpointAfter.mib)}`);
  printBackupPruneSchedule(backupPruneSchedule);
  const backupPaths = [archiveReport, vacuumReport, logsReport, tuiLogReport, report]
    .map((entry) => entry?.backupPath)
    .filter((value) => typeof value === "string");
  if (backupPaths.length) {
    console.log(
      pc.dim(
        `  Backups are in ${path.dirname(String(backupPaths[0]))}. Keep them until Codex looks right, then delete them to reclaim disk.`,
      ),
    );
  }
}

function printBackupPruneSchedule(report: Record<string, unknown> | null): void {
  if (!report) return;
  console.log(pc.bold("\nBackup cleanup scheduled"));
  if (report.error) {
    console.log(pc.yellow(`  Could not schedule automatically: ${String(report.error)}`));
    return;
  }
  console.log(`  Runs: ${String(recordAt(report, "policy").runAtUtc)}`);
  console.log(`  Command: ${String(report.command)}`);
  if (report.taskName) console.log(`  Task: ${String(report.taskName)}`);
  if (report.jobId) console.log(`  Job: ${String(report.jobId)}`);
  console.log(`  Cancel: ${String(report.cancelCommand)}`);
}

function printDryRunCommand(options: CleanerOptions): void {
  const archiveFlag = options.archiveStale ? "" : " --skip-archive-stale";
  const orphanFlag = options.archiveOrphanRollouts ? " --archive-orphan-rollouts" : "";
  const logsFlag = options.pruneLogs ? " --prune-logs" : "";
  const tuiLogFlag = options.pruneTuiLog ? " --prune-tui-log" : "";
  const recentFlag = options.compactRecentMetadata ? " --compact-recent-metadata" : "";
  console.log(
    `  npx codex-cleaner@latest --allow-running-readonly clean --max-chars ${options.maxChars} --keep-recent-days ${options.keepRecentDays}${archiveFlag}${orphanFlag}${logsFlag}${tuiLogFlag}${recentFlag}`,
  );
}

function printApplyCommand(options: CleanerOptions): void {
  const archiveFlags = options.archiveStale ? "" : " --skip-archive-stale";
  const orphanFlags = options.archiveOrphanRollouts ? " --archive-orphan-rollouts" : "";
  const logsFlags = options.pruneLogs ? " --prune-logs" : "";
  const tuiLogFlags = options.pruneTuiLog ? " --prune-tui-log" : "";
  const recentFlag = options.compactRecentMetadata ? " --compact-recent-metadata" : "";
  console.log(
    `  npx codex-cleaner@latest clean --max-chars ${options.maxChars} --keep-recent-days ${options.keepRecentDays} --apply${archiveFlags}${orphanFlags}${logsFlags}${tuiLogFlags}${recentFlag}`,
  );
}

function recordAt(source: unknown, ...keys: string[]): Record<string, unknown> {
  let current = source;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return {};
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
}

function nullableRecordAt(source: unknown, ...keys: string[]): Record<string, unknown> | null {
  const value = recordAt(source, ...keys);
  return Object.keys(value).length ? value : null;
}

function numberAt(source: unknown, ...keys: string[]): number {
  const parent = recordAt(source, ...keys.slice(0, -1));
  const value = parent[keys[keys.length - 1] ?? ""];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatMib(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString()} MiB` : "unknown";
}

function dedupeChoiceValues<T>(choices: Choice<T>[]): Choice<T>[] {
  const seen = new Set<T>();
  const result: Choice<T>[] = [];
  for (const choice of choices) {
    if (seen.has(choice.value)) continue;
    seen.add(choice.value);
    result.push(choice);
  }
  return result;
}
