import { confirm, input, select } from "@inquirer/prompts";
import pc from "picocolors";

import {
  archiveStaleThreads,
  buildScanReport,
  checkpointWal,
  compactMetadata,
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

  const keepRecentDays = await askKeepRecentDays(options.keepRecentDays);
  const maxChars = await askMaxChars(options.maxChars);
  const archiveStale = await askArchiveStale();
  const includeRollouts = await confirm({
    default: false,
    message: "Also scan orphan rollout files? This is slower and stays dry-run only.",
  });
  const runDryRun = await confirm({
    default: true,
    message: "Run the dry-run scan now?",
  });

  const dryRunOptions: CleanerOptions = {
    ...options,
    allowRunningReadonly: true,
    archiveStale,
    apply: false,
    archivedOnly: false,
    confirmArchiveStale: false,
    confirmLossyMetadata: false,
    includeLogs: false,
    includeRollouts,
    keepRecentDays,
    maxChars,
    json: false,
  };

  if (!runDryRun) {
    printDryRunCommand(dryRunOptions);
    return 0;
  }

  console.log(pc.dim("\nScanning Codex metadata..."));
  const report = buildScanReport(dryRunOptions);
  printDryRunSummary(report);

  const compactRows = numberAt(report, "compactMetadataCandidates", "rows");
  const archiveRows = numberAt(report, "staleArchiveCandidates", "archive_call_rows");
  if (!compactRows && !archiveRows) {
    console.log(pc.green("\nNo metadata compaction or stale archive candidates found under this policy."));
    return 0;
  }

  const blockers = await findBlockingProcesses();
  if (blockers.length) {
    console.log(pc.yellow("\nCodex is still running, so no changes can be applied from this run."));
    console.log(pc.dim("Close Codex completely, then run:"));
    printApplyCommand(dryRunOptions);
    return 0;
  }

  const applyNow = await confirm({
    default: false,
    message: "Apply this cleanup now? SQLite backups will be created first.",
  });

  if (!applyNow) {
    console.log(pc.dim("\nNo changes made. To apply later, run:"));
    printApplyCommand(dryRunOptions);
    return 0;
  }

  await requireStoppedOrReadonlyAllowed({ allowRunningReadonly: false, mutating: true });
  let archiveReport: Record<string, unknown> | null = null;
  if (archiveRows) {
    console.log(pc.dim("\nArchiving stale threads via Codex app-server..."));
    archiveReport = await archiveStaleThreads({
      ...dryRunOptions,
      apply: true,
      confirmArchiveStale: true,
    });
  }

  console.log(pc.dim("\nCreating backup and compacting metadata..."));
  const compactReport = await compactMetadata({
    ...dryRunOptions,
    apply: true,
    confirmArchiveStale: true,
    confirmLossyMetadata: true,
  });
  console.log(pc.dim("\nCheckpointing state_5.sqlite WAL..."));
  const checkpointReport = await checkpointWal({
    ...dryRunOptions,
    apply: true,
  });
  printApplySummary(compactReport, archiveReport, checkpointReport);
  return 0;
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
  console.log(pc.dim("  Preserves thread rows, rollout JSONL, and CodexMeter usage accounting."));

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
  checkpointReport: Record<string, unknown>,
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
  console.log(`  Changed rows: ${String(report.changedRows)}`);
  console.log(`  Metadata backup: ${String(report.backupPath)}`);
  console.log(`  Remaining eligible rows: ${String(after.rows)} (was ${String(before.rows)})`);
  const checkpointBefore = recordAt(checkpointReport, "before", "wal");
  const checkpointAfter = recordAt(checkpointReport, "after", "wal");
  console.log(`  WAL checkpoint: ${formatMib(checkpointBefore.mib)} -> ${formatMib(checkpointAfter.mib)}`);
  console.log(pc.dim("  Note: returning main SQLite file space to the OS requires a separate vacuum/rebuild step."));
}

function printDryRunCommand(options: CleanerOptions): void {
  const archiveFlag = options.archiveStale ? "" : " --skip-archive-stale";
  console.log(
    `  npx codex-cleaner@latest --allow-running-readonly clean --max-chars ${options.maxChars} --keep-recent-days ${options.keepRecentDays}${archiveFlag}`,
  );
}

function printApplyCommand(options: CleanerOptions): void {
  const archiveFlags = options.archiveStale ? " --confirm-archive-stale" : " --skip-archive-stale";
  console.log(
    `  npx codex-cleaner@latest clean --max-chars ${options.maxChars} --keep-recent-days ${options.keepRecentDays} --apply --confirm-lossy-metadata${archiveFlags}`,
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
