import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import Database from "better-sqlite3";

import type { BlockingProcess, CleanerOptions, CompactWhere, ThreadProtection } from "./types.js";

const execFileAsync = promisify(execFile);

const THREAD_COLUMNS_TO_CAP = ["title", "preview", "first_user_message"] as const;
const APP_SERVER_REQUEST_TIMEOUT_MS = 60_000;
const APP_SERVER_SHUTDOWN_TIMEOUT_MS = 3000;

export async function requireStoppedOrReadonlyAllowed(args: {
  allowRunningReadonly: boolean;
  mutating: boolean;
}): Promise<void> {
  const blockers = await findBlockingProcesses();
  if (!blockers.length) return;
  if (!args.mutating && args.allowRunningReadonly) return;

  const details = blockers
    .map((process) => `  - pid=${process.pid} name=${process.name} command=${process.commandLine.slice(0, 240)}`)
    .join("\n");
  throw new Error(
    `Refusing to run while Codex-related processes are active.\nStop Codex/App/TUI/node_repl first.\n${details}`,
  );
}

export async function findBlockingProcesses(): Promise<BlockingProcess[]> {
  return process.platform === "win32" ? findWindowsBlockingProcesses() : findPosixBlockingProcesses();
}

async function findWindowsBlockingProcesses(): Promise<BlockingProcess[]> {
  const script = String.raw`
$rows = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -ieq 'codex.exe' -or
    $_.Name -ieq 'node_repl.exe' -or
    ($_.Name -ieq 'node.exe' -and ($_.CommandLine -match '@openai[\\/]codex|app-server'))
  } |
  Select-Object ProcessId,Name,CommandLine
$rows | ConvertTo-Json -Compress
`;
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      windowsHide: true,
    },
  );
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => {
    const value = row as Record<string, unknown>;
    return {
      pid: Number(value.ProcessId ?? 0),
      name: String(value.Name ?? ""),
      commandLine: String(value.CommandLine ?? ""),
    };
  });
}

async function findPosixBlockingProcesses(): Promise<BlockingProcess[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,comm=,args="]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      return { pid: Number(match[1]), name: match[2] ?? "", commandLine: match[3] ?? "" };
    })
    .filter((row): row is BlockingProcess => Boolean(row))
    .filter((row) => {
      const lowerName = row.name.toLowerCase();
      const lowerCommand = row.commandLine.toLowerCase();
      return (
        lowerName === "codex" ||
        lowerName === "node_repl" ||
        (lowerName === "node" && (lowerCommand.includes("@openai/codex") || lowerCommand.includes("app-server")))
      );
    });
}

async function archiveThreadsViaCodexAppServer(
  threadIds: string[],
  codexCommand: string,
): Promise<Record<string, unknown>> {
  const child = spawn(codexCommand, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let nextId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const pending = new Map<
    number,
    {
      reject: (error: Error) => void;
      resolve: (value: Record<string, unknown>) => void;
    }
  >();

  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) handleAppServerLine(line, pending);
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer = `${stderrBuffer}${chunk}`.slice(-4000);
  });
  child.on("error", (error) => {
    for (const pendingRequest of pending.values()) pendingRequest.reject(error);
    pending.clear();
  });
  child.on("exit", (code) => {
    if (pending.size && code !== 0) {
      const error = new Error(`codex app-server exited with code ${String(code)}: ${stderrBuffer.trim()}`);
      for (const pendingRequest of pending.values()) pendingRequest.reject(error);
      pending.clear();
    }
  });

  const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId;
    nextId += 1;
    const body = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, APP_SERVER_REQUEST_TIMEOUT_MS);
      pending.set(id, {
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
      });
      child.stdin.write(`${body}\n`, (error) => {
        if (!error) return;
        pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      });
    });
  };

  const notify = (method: string, params: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  };

  const errors: Record<string, string>[] = [];
  let succeeded = 0;
  try {
    await request("initialize", {
      clientInfo: {
        name: "codex_cleaner",
        title: "Codex Cleaner",
        version: "0.1.0",
      },
    });
    notify("initialized", {});

    for (const threadId of threadIds) {
      try {
        await request("thread/archive", { threadId });
        succeeded += 1;
      } catch (error) {
        errors.push({ threadId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    child.stdin.end();
    await stopAppServer(child);
  }

  return {
    requested: threadIds.length,
    succeeded,
    failed: errors.length,
    errors: errors.slice(0, 20),
    stderrTail: stderrBuffer.trim(),
  };
}

function handleAppServerLine(
  line: string,
  pending: Map<
    number,
    {
      reject: (error: Error) => void;
      resolve: (value: Record<string, unknown>) => void;
    }
  >,
): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  const id = typeof message.id === "number" ? message.id : null;
  if (id == null || !pending.has(id)) return;
  const request = pending.get(id);
  pending.delete(id);
  if (!request) return;

  if (message.error) {
    const errorObject = asRecord(message.error);
    request.reject(new Error(String(errorObject.message ?? JSON.stringify(message.error))));
    return;
  }
  request.resolve(asRecord(message.result));
}

async function stopAppServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
      resolve();
    }, APP_SERVER_SHUTDOWN_TIMEOUT_MS);
    const done = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", done);
    try {
      child.kill("SIGTERM");
    } catch {
      child.off("exit", done);
      done();
    }
  });
}

export function buildScanReport(options: CleanerOptions): Record<string, unknown> {
  const codexHome = resolveCodexHome(options);
  const stateDb = path.join(codexHome, "state_5.sqlite");
  const logsDb = path.join(codexHome, "logs_2.sqlite");
  const goalsDb = path.join(codexHome, "goals_1.sqlite");
  const globalState = loadGlobalState(codexHome);
  const protection = loadThreadProtection(codexHome, globalState);
  const cutoffMs = recentCutoffMs(options.keepRecentDays);

  const report: Record<string, unknown> = {
    codexHome,
    generatedAt: new Date().toISOString(),
    policy: {
      keepRecentDays: options.keepRecentDays,
      maxChars: options.maxChars,
      recentCutoffMs: cutoffMs,
      recentCutoffUtc: millisToIso(cutoffMs),
    },
    files: {
      "state_5.sqlite": fileTripletSizes(stateDb),
      "logs_2.sqlite": fileTripletSizes(logsDb),
      "goals_1.sqlite": fileTripletSizes(goalsDb),
      "codex-tui.log": fileSize(path.join(codexHome, "log", "codex-tui.log")),
    },
    protection: {
      pinnedThreads: protection.pinnedIds.size,
      heartbeatThreads: protection.heartbeatIds.size,
      activeGoalThreads: protection.activeGoalIds.size,
      totalUniqueProtectedThreads: allProtectedIds(protection).size,
      activeWorkspaceRoots: Array.isArray(globalState["active-workspace-roots"])
        ? globalState["active-workspace-roots"]
        : [],
    },
  };

  const db = openReadonlyDb(stateDb);
  try {
    report.threads = collectThreadStats(db);
    report.compactMetadataCandidates = collectCompactCandidateStats(db, {
      archivedOnly: false,
      cutoffMs,
      maxChars: options.maxChars,
      protectedIds: allProtectedIds(protection),
    });
    report.compactMetadataCandidatesArchivedOnly = collectCompactCandidateStats(db, {
      archivedOnly: true,
      cutoffMs,
      maxChars: options.maxChars,
      protectedIds: allProtectedIds(protection),
    });
    if (options.archiveStale) {
      report.staleArchiveCandidates = collectStaleArchiveCandidateStats(db, codexHome, {
        cutoffMs,
        protectedIds: allProtectedIds(protection),
        statRollouts: options.includeRollouts,
      });
    }
    report.recentSample = queryAll(
      db,
      `
      SELECT id, archived, updated_at, updated_at_ms, source, agent_role,
             substr(cwd, 1, 140) AS cwd,
             length(title) AS title_chars,
             length(preview) AS preview_chars,
             length(first_user_message) AS first_user_message_chars
      FROM threads
      ORDER BY updated_at_ms DESC, updated_at DESC
      LIMIT 10
    `,
    );
  } finally {
    db.close();
  }

  if (options.includeLogs && fs.existsSync(logsDb)) {
    const logs = openReadonlyDb(logsDb);
    try {
      report.logs = collectLogStats(logs);
    } finally {
      logs.close();
    }
  }

  if (options.includeRollouts) {
    const rolloutDb = openReadonlyDb(stateDb);
    try {
      report.rollouts = collectRolloutLinkage(rolloutDb, codexHome);
    } finally {
      rolloutDb.close();
    }
  }

  return report;
}

export async function compactMetadata(options: CleanerOptions): Promise<Record<string, unknown>> {
  if (options.apply && !options.confirmLossyMetadata) {
    throw new Error("--apply requires --confirm-lossy-metadata");
  }

  const codexHome = resolveCodexHome(options);
  const stateDb = path.join(codexHome, "state_5.sqlite");
  const globalState = loadGlobalState(codexHome);
  const protection = loadThreadProtection(codexHome, globalState);
  const protectedIds = allProtectedIds(protection);
  const cutoffMs = recentCutoffMs(options.keepRecentDays);

  const db = openWritableDb(stateDb);
  let changedRows = 0;
  let backupPath: string | null = null;
  try {
    const before = collectCompactCandidateStats(db, {
      archivedOnly: options.archivedOnly,
      cutoffMs,
      maxChars: options.maxChars,
      protectedIds,
    });

    if (options.apply && Number(before.rows) > 0) {
      backupPath = await backupSqliteDatabase(
        stateDb,
        options.backupDir ?? path.join(codexHome, ".codex-cleanup-backups"),
      );
      const where = compactWhere({
        archivedOnly: options.archivedOnly,
        cutoffMs,
        maxChars: options.maxChars,
        protectedIds,
      });
      const assignments = THREAD_COLUMNS_TO_CAP.map(
        (column) =>
          `${column} = CASE WHEN length(${column}) > @maxChars THEN substr(${column}, 1, @maxChars) ELSE ${column} END`,
      ).join(", ");
      const update = db.prepare(`UPDATE threads SET ${assignments} WHERE ${where.sql}`);
      const tx = db.transaction(() => update.run(where.params));
      changedRows = Number(tx().changes);
    }

    const after = collectCompactCandidateStats(db, {
      archivedOnly: options.archivedOnly,
      cutoffMs,
      maxChars: options.maxChars,
      protectedIds,
    });

    return {
      action: "compact-metadata",
      mode: options.apply ? "apply" : "dry-run",
      codexHome,
      generatedAt: new Date().toISOString(),
      policy: {
        archivedOnly: options.archivedOnly,
        keepRecentDays: options.keepRecentDays,
        maxChars: options.maxChars,
        protectedThreads: protectedIds.size,
        recentCutoffMs: cutoffMs,
        recentCutoffUtc: millisToIso(cutoffMs),
      },
      before,
      after,
      changedRows,
      backupPath,
    };
  } finally {
    db.close();
  }
}

export async function cleanCodex(options: CleanerOptions): Promise<Record<string, unknown>> {
  if (options.apply && !options.confirmLossyMetadata) {
    throw new Error("--apply requires --confirm-lossy-metadata");
  }
  if (options.apply && options.archiveStale && !options.confirmArchiveStale) {
    throw new Error("--apply with stale archiving requires --confirm-archive-stale");
  }

  const scan = buildScanReport({ ...options, apply: false });
  if (!options.apply) {
    return {
      action: "clean",
      mode: "dry-run",
      ...scan,
    };
  }

  const archive = options.archiveStale ? await archiveStaleThreads(options) : null;
  const compact = await compactMetadata(options);
  const checkpoint = await checkpointWal(options);

  return {
    action: "clean",
    mode: "apply",
    codexHome: scan.codexHome,
    generatedAt: new Date().toISOString(),
    policy: scan.policy,
    scan,
    archive,
    compact,
    checkpoint,
  };
}

export async function archiveStaleThreads(options: CleanerOptions): Promise<Record<string, unknown>> {
  if (options.apply && !options.confirmArchiveStale) {
    throw new Error("--apply requires --confirm-archive-stale");
  }

  const codexHome = resolveCodexHome(options);
  const stateDb = path.join(codexHome, "state_5.sqlite");
  const globalState = loadGlobalState(codexHome);
  const protection = loadThreadProtection(codexHome, globalState);
  const protectedIds = allProtectedIds(protection);
  const cutoffMs = recentCutoffMs(options.keepRecentDays);

  const beforeDb = openReadonlyDb(stateDb);
  let beforePlan: StaleArchivePlan;
  try {
    beforePlan = buildStaleArchivePlan(beforeDb, codexHome, { cutoffMs, protectedIds, statRollouts: false });
  } finally {
    beforeDb.close();
  }

  let backupPath: string | null = null;
  let appServerResult: Record<string, unknown> | null = null;
  if (options.apply && beforePlan.archiveCallIds.length) {
    backupPath = await backupSqliteDatabase(
      stateDb,
      options.backupDir ?? path.join(codexHome, ".codex-cleanup-backups"),
    );
    appServerResult = await archiveThreadsViaCodexAppServer(beforePlan.archiveCallIds, options.codexCommand ?? "codex");
  }

  const afterDb = openReadonlyDb(stateDb);
  let afterPlan: StaleArchivePlan;
  try {
    afterPlan = buildStaleArchivePlan(afterDb, codexHome, { cutoffMs, protectedIds, statRollouts: false });
  } finally {
    afterDb.close();
  }

  return {
    action: "archive-stale",
    mode: options.apply ? "apply" : "dry-run",
    codexHome,
    generatedAt: new Date().toISOString(),
    policy: {
      keepRecentDays: options.keepRecentDays,
      protectedThreads: protectedIds.size,
      recentCutoffMs: cutoffMs,
      recentCutoffUtc: millisToIso(cutoffMs),
    },
    before: beforePlan.stats,
    after: afterPlan.stats,
    requestedArchiveCalls: beforePlan.archiveCallIds.length,
    appServerResult,
    backupPath,
  };
}

export async function checkpointWal(options: CleanerOptions): Promise<Record<string, unknown>> {
  const codexHome = resolveCodexHome(options);
  const stateDb = path.join(codexHome, "state_5.sqlite");
  const before = fileTripletSizes(stateDb);
  let backupPath: string | null = null;
  let checkpointResult: unknown = null;

  if (options.apply) {
    backupPath = await backupSqliteDatabase(
      stateDb,
      options.backupDir ?? path.join(codexHome, ".codex-cleanup-backups"),
    );
    const db = openWritableDb(stateDb);
    try {
      checkpointResult = queryAll(db, "PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  }

  return {
    action: "checkpoint-wal",
    mode: options.apply ? "apply" : "dry-run",
    codexHome,
    generatedAt: new Date().toISOString(),
    before,
    after: fileTripletSizes(stateDb),
    checkpointResult,
    backupPath,
  };
}

export function compactWhere(args: {
  archivedOnly: boolean;
  cutoffMs: number;
  maxChars: number;
  protectedIds: Set<string>;
}): CompactWhere {
  const clauses = [
    `(${THREAD_COLUMNS_TO_CAP.map((column) => `length(${column}) > @maxChars`).join(" OR ")})`,
    "(updated_at_ms < @cutoffMs OR (updated_at_ms IS NULL AND updated_at * 1000 < @cutoffMs))",
  ];
  const params: Record<string, string | number> = {
    cutoffMs: args.cutoffMs,
    maxChars: args.maxChars,
  };

  if (args.archivedOnly) {
    clauses.push("archived = 1");
  }

  const protectedIds = [...args.protectedIds].sort();
  if (protectedIds.length) {
    const names = protectedIds.map((threadId, index) => {
      const name = `protected${index}`;
      params[name] = threadId;
      return `@${name}`;
    });
    clauses.push(`id NOT IN (${names.join(", ")})`);
  }

  return { sql: clauses.join(" AND "), params };
}

export function collectCompactCandidateStats(
  db: Database.Database,
  args: { archivedOnly: boolean; cutoffMs: number; maxChars: number; protectedIds: Set<string> },
): Record<string, unknown> {
  const where = compactWhere(args);
  const savingsExpr = THREAD_COLUMNS_TO_CAP.map((column) => `max(length(${column}) - @maxChars, 0)`).join(" + ");
  const stats = queryOne(
    db,
    `
    SELECT
      count(*) AS rows,
      coalesce(round(sum(${savingsExpr}) / 1048576.0, 2), 0) AS estimated_savings_mib,
      max(max(length(title), length(preview), length(first_user_message))) AS max_field_chars,
      min(coalesce(updated_at_ms, updated_at * 1000)) AS oldest_candidate_updated_at_ms,
      max(coalesce(updated_at_ms, updated_at * 1000)) AS newest_candidate_updated_at_ms
    FROM threads
    WHERE ${where.sql}
  `,
    where.params,
  );
  return {
    ...stats,
    newestCandidateUpdatedUtc: millisToIso(asNumberOrNull(stats.newest_candidate_updated_at_ms)),
    oldestCandidateUpdatedUtc: millisToIso(asNumberOrNull(stats.oldest_candidate_updated_at_ms)),
  };
}

type ThreadRow = {
  archived: number;
  archived_at: number | null;
  cwd: string;
  id: string;
  rollout_path: string;
  title: string;
  updated_at: number;
  updated_at_ms: number | null;
};

type SpawnEdgeRow = {
  child_thread_id: string;
  parent_thread_id: string;
  status: string;
};

type StaleArchivePlan = {
  archiveCallIds: string[];
  stats: Record<string, unknown>;
};

export function collectStaleArchiveCandidateStats(
  db: Database.Database,
  codexHome: string,
  args: { cutoffMs: number; protectedIds: Set<string>; statRollouts?: boolean },
): Record<string, unknown> {
  return buildStaleArchivePlan(db, codexHome, args).stats;
}

function buildStaleArchivePlan(
  db: Database.Database,
  codexHome: string,
  args: { cutoffMs: number; protectedIds: Set<string>; statRollouts?: boolean },
): StaleArchivePlan {
  const rows = queryAll(
    db,
    `
    SELECT id, archived, archived_at, rollout_path, updated_at, updated_at_ms,
           substr(cwd, 1, 160) AS cwd,
           substr(title, 1, 160) AS title
    FROM threads
  `,
  ) as unknown as ThreadRow[];
  const edgeResult = tryQueryAll(db, "SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges") as
    | SpawnEdgeRow[]
    | { error: string };
  const edges = Array.isArray(edgeResult) ? edgeResult : [];
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const childrenByParent = new Map<string, string[]>();
  const parentByChild = new Map<string, string>();
  for (const edge of edges) {
    const children = childrenByParent.get(edge.parent_thread_id) ?? [];
    children.push(edge.child_thread_id);
    childrenByParent.set(edge.parent_thread_id, children);
    parentByChild.set(edge.child_thread_id, edge.parent_thread_id);
  }

  const statRollouts = Boolean(args.statRollouts);
  const fileInfo = new Map(rows.map((row) => [row.id, rolloutFileInfo(row.rollout_path, statRollouts)]));
  const candidates = rows.filter(
    (row) => row.archived !== 1 && !args.protectedIds.has(row.id) && threadUpdatedAtMs(row) < args.cutoffMs,
  );
  const candidateIds = new Set(candidates.map((row) => row.id));
  const candidateRowsById = new Map(candidates.map((row) => [row.id, row]));
  const unsafeDescendantIds = new Set<string>();
  const missingSubtreeFileIds = new Set<string>();
  const safeToCallIds = new Set<string>();

  for (const row of candidates) {
    const ownFile = fileInfo.get(row.id);
    if (ownFile?.exists === false) {
      missingSubtreeFileIds.add(row.id);
      continue;
    }

    let safe = true;
    for (const descendantId of descendantThreadIds(row.id, childrenByParent)) {
      const descendant = rowById.get(descendantId);
      if (!descendant || descendant.archived === 1) continue;
      if (!candidateIds.has(descendantId)) {
        unsafeDescendantIds.add(row.id);
        safe = false;
        continue;
      }
      if (fileInfo.get(descendantId)?.exists === false) {
        missingSubtreeFileIds.add(row.id);
        safe = false;
      }
    }
    if (safe) safeToCallIds.add(row.id);
  }

  const selectedCallIds: string[] = [];
  const selectedCallSet = new Set<string>();
  const sortedCandidates = [...candidates].sort(
    (left, right) => candidateDepth(left.id, parentByChild) - candidateDepth(right.id, parentByChild),
  );
  for (const row of sortedCandidates) {
    if (!safeToCallIds.has(row.id)) continue;
    if (hasSelectedCandidateAncestor(row.id, parentByChild, selectedCallSet)) continue;
    selectedCallIds.push(row.id);
    selectedCallSet.add(row.id);
  }

  const expectedArchivedIds = new Set<string>();
  for (const id of selectedCallIds) {
    expectedArchivedIds.add(id);
    for (const descendantId of descendantThreadIds(id, childrenByParent)) {
      if (candidateIds.has(descendantId)) expectedArchivedIds.add(descendantId);
    }
  }

  const candidateFileInfos = candidates.map((row) => fileInfo.get(row.id)).filter(isDefined);
  const expectedFileInfos = [...expectedArchivedIds]
    .map((id) => fileInfo.get(id))
    .filter(isDefined)
    .filter((info) => info.exists !== false);
  const newest = maxNumberOrNull(candidates.map(threadUpdatedAtMs));
  const oldest = minNumberOrNull(candidates.map(threadUpdatedAtMs));

  return {
    archiveCallIds: selectedCallIds,
    stats: {
      rows: candidates.length,
      archive_call_rows: selectedCallIds.length,
      expected_archived_rows: expectedArchivedIds.size,
      rollout_size_mib: statRollouts ? fileInfoListSizeMib(candidateFileInfos) : null,
      expected_archived_rollout_size_mib: statRollouts ? fileInfoListSizeMib(expectedFileInfos) : null,
      missing_rollout_files: statRollouts
        ? candidates.filter((row) => fileInfo.get(row.id)?.exists === false).length
        : null,
      blocked_by_descendant_safety: unsafeDescendantIds.size,
      blocked_by_missing_subtree_files: missingSubtreeFileIds.size,
      descendant_edges: edges.length,
      newestCandidateUpdatedUtc: millisToIso(newest),
      oldestCandidateUpdatedUtc: millisToIso(oldest),
      sample: topArchiveSample(candidates, fileInfo),
      archiveCallSample: topArchiveSample(
        selectedCallIds.map((id) => candidateRowsById.get(id)).filter(isDefined),
        fileInfo,
      ),
      codexHome,
    },
  };
}

function collectThreadStats(db: Database.Database): Record<string, unknown> {
  const stats = queryOne(
    db,
    `
    SELECT
      count(*) AS rows,
      sum(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived_rows,
      min(created_at) AS min_created_at,
      max(updated_at) AS max_updated_at
    FROM threads
  `,
  );
  return {
    ...stats,
    createdRangeUtc: {
      maxUpdated: secondsToIso(asNumberOrNull(stats.max_updated_at)),
      min: secondsToIso(asNumberOrNull(stats.min_created_at)),
    },
  };
}

function collectLogStats(db: Database.Database): Record<string, unknown> {
  const stats = queryOne(
    db,
    `
    SELECT count(*) AS rows,
           min(ts) AS min_ts,
           max(ts) AS max_ts,
           round(sum(estimated_bytes) / 1048576.0, 2) AS estimated_payload_mib,
           sum(CASE WHEN thread_id IS NULL THEN 1 ELSE 0 END) AS threadless_rows
    FROM logs
  `,
  );
  return {
    ...stats,
    rangeUtc: {
      max: secondsToIso(asNumberOrNull(stats.max_ts)),
      min: secondsToIso(asNumberOrNull(stats.min_ts)),
    },
    topTargets: queryAll(
      db,
      `
      SELECT target, count(*) AS rows, round(sum(estimated_bytes) / 1048576.0, 2) AS estimated_payload_mib
      FROM logs
      GROUP BY target
      ORDER BY sum(estimated_bytes) DESC
      LIMIT 10
    `,
    ),
  };
}

function collectRolloutLinkage(db: Database.Database, codexHome: string): Record<string, unknown> {
  const refs = queryAll(
    db,
    "SELECT id, rollout_path FROM threads WHERE rollout_path IS NOT NULL AND rollout_path != ''",
  );
  const referencedPaths = new Set(refs.map((row) => normalizePath(String(row.rollout_path))));
  const diskFiles = [
    ...listRolloutFiles(path.join(codexHome, "sessions")),
    ...listRolloutFiles(path.join(codexHome, "archived_sessions")),
  ];
  const diskPaths = new Set(diskFiles.map((file) => normalizePath(file)));
  const missing = refs.filter((row) => !diskPaths.has(normalizePath(String(row.rollout_path))));
  const orphans = diskFiles.filter((file) => !referencedPaths.has(normalizePath(file)));
  const sessionIndexIds = loadSessionIndexIds(codexHome);
  const indexedOrphans = orphans.filter((file) => sessionIndexIds.has(rolloutThreadId(file) ?? ""));
  const unindexedOrphans = orphans.filter((file) => !sessionIndexIds.has(rolloutThreadId(file) ?? ""));
  return {
    diskRolloutFiles: diskFiles.length,
    missingReferencedFiles: missing.length,
    missingSample: missing.slice(0, 10),
    orphanFiles: orphans.length,
    orphanIndexedFiles: indexedOrphans.length,
    orphanIndexedSizeMib: fileListSizeMib(indexedOrphans),
    orphanSizeMib: fileListSizeMib(orphans),
    orphanUnindexedFiles: unindexedOrphans.length,
    orphanUnindexedSizeMib: fileListSizeMib(unindexedOrphans),
    threadRolloutRefs: refs.length,
    topOrphanSample: topFileSample(orphans),
    topUnindexedOrphanSample: topFileSample(unindexedOrphans),
  };
}

function loadThreadProtection(codexHome: string, globalState: Record<string, unknown>): ThreadProtection {
  const atom = asRecord(globalState["electron-persisted-atom-state"]);
  return {
    activeGoalIds: loadActiveGoalThreadIds(path.join(codexHome, "goals_1.sqlite")),
    heartbeatIds: new Set(Object.keys(asRecord(atom["heartbeat-thread-permissions-by-id"]))),
    pinnedIds: new Set(asStringArray(globalState["pinned-thread-ids"])),
  };
}

function loadGlobalState(codexHome: string): Record<string, unknown> {
  const file = path.join(codexHome, ".codex-global-state.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function loadActiveGoalThreadIds(file: string): Set<string> {
  if (!fs.existsSync(file)) return new Set();
  const db = openReadonlyDb(file);
  try {
    return new Set(
      queryAll(db, "SELECT thread_id FROM thread_goals WHERE status = 'active'").map((row) => String(row.thread_id)),
    );
  } catch {
    return new Set();
  } finally {
    db.close();
  }
}

function loadSessionIndexIds(codexHome: string): Set<string> {
  const file = path.join(codexHome, "session_index.jsonl");
  if (!fs.existsSync(file)) return new Set();
  const ids = new Set<string>();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.id) ids.add(String(value.id));
    } catch {
      // Ignore malformed historical lines.
    }
  }
  return ids;
}

async function backupSqliteDatabase(dbPath: string, backupDir: string): Promise<string> {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const backupPath = path.join(backupDir, `${path.basename(dbPath)}.${stamp}.bak.sqlite`);
  const db = openWritableDb(dbPath);
  try {
    await db.backup(backupPath);
  } finally {
    db.close();
  }
  return backupPath;
}

function openReadonlyDb(file: string): Database.Database {
  if (!fs.existsSync(file)) throw new Error(`SQLite database not found: ${file}`);
  return new Database(file, { fileMustExist: true, readonly: true });
}

function openWritableDb(file: string): Database.Database {
  if (!fs.existsSync(file)) throw new Error(`SQLite database not found: ${file}`);
  const db = new Database(file, { fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return db;
}

function queryAll(
  db: Database.Database,
  sql: string,
  params?: Record<string, string | number>,
): Record<string, unknown>[] {
  return db.prepare(sql).all(params ?? {}) as Record<string, unknown>[];
}

function queryOne(
  db: Database.Database,
  sql: string,
  params?: Record<string, string | number>,
): Record<string, unknown> {
  return (db.prepare(sql).get(params ?? {}) as Record<string, unknown> | undefined) ?? {};
}

function tryQueryAll(db: Database.Database, sql: string): Record<string, unknown>[] | { error: string } {
  try {
    return queryAll(db, sql);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function resolveCodexHome(options: CleanerOptions): string {
  return path.resolve(options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
}

function allProtectedIds(protection: ThreadProtection): Set<string> {
  return new Set([...protection.pinnedIds, ...protection.heartbeatIds, ...protection.activeGoalIds]);
}

function fileTripletSizes(dbPath: string): Record<string, unknown> {
  return {
    main: fileSize(dbPath),
    path: dbPath,
    shm: fileSize(`${dbPath}-shm`),
    wal: fileSize(`${dbPath}-wal`),
  };
}

function fileSize(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return { bytes: 0, exists: false, mib: 0, path: file };
  const bytes = fs.statSync(file).size;
  return { bytes, exists: true, mib: roundMib(bytes), path: file };
}

function listRolloutFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const output: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(full);
    }
  }
  return output;
}

function topFileSample(files: string[], limit = 10): Record<string, unknown>[] {
  return [...files]
    .sort((left, right) => fs.statSync(right).size - fs.statSync(left).size)
    .slice(0, limit)
    .map((file) => ({ path: file, sizeMib: roundMib(fs.statSync(file).size), threadId: rolloutThreadId(file) }));
}

type RolloutFileInfo = {
  exists: boolean | null;
  path: string;
  sizeBytes: number;
  sizeMib: number | null;
  threadId: string | null;
};

function rolloutFileInfo(file: string, statFile: boolean): RolloutFileInfo {
  if (!statFile) {
    return { exists: null, path: file, sizeBytes: 0, sizeMib: null, threadId: rolloutThreadId(file) };
  }
  if (!file || !fs.existsSync(file)) {
    return { exists: false, path: file, sizeBytes: 0, sizeMib: 0, threadId: rolloutThreadId(file) };
  }
  const sizeBytes = fs.statSync(file).size;
  return {
    exists: true,
    path: file,
    sizeBytes,
    sizeMib: roundMib(sizeBytes),
    threadId: rolloutThreadId(file),
  };
}

function topArchiveSample(
  rows: ThreadRow[],
  fileInfo: Map<string, RolloutFileInfo>,
  limit = 10,
): Record<string, unknown>[] {
  return [...rows]
    .sort((left, right) => (fileInfo.get(right.id)?.sizeBytes ?? 0) - (fileInfo.get(left.id)?.sizeBytes ?? 0))
    .slice(0, limit)
    .map((row) => ({
      cwd: row.cwd,
      id: row.id,
      rolloutPath: row.rollout_path,
      rolloutSizeMib: fileInfo.get(row.id)?.sizeMib ?? 0,
      title: row.title,
      updatedUtc: millisToIso(threadUpdatedAtMs(row)),
    }));
}

function fileListSizeMib(files: string[]): number {
  return roundMib(files.reduce((total, file) => total + fs.statSync(file).size, 0));
}

function fileInfoListSizeMib(files: RolloutFileInfo[]): number {
  return roundMib(files.reduce((total, file) => total + file.sizeBytes, 0));
}

function descendantThreadIds(threadId: string, childrenByParent: Map<string, string[]>): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const stack = [...(childrenByParent.get(threadId) ?? [])];
  while (stack.length) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    output.push(current);
    stack.push(...(childrenByParent.get(current) ?? []));
  }
  return output;
}

function candidateDepth(threadId: string, parentByChild: Map<string, string>): number {
  let depth = 0;
  let current = threadId;
  const seen = new Set<string>();
  while (parentByChild.has(current) && !seen.has(current)) {
    seen.add(current);
    const parent = parentByChild.get(current);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

function hasSelectedCandidateAncestor(
  threadId: string,
  parentByChild: Map<string, string>,
  selectedCallSet: Set<string>,
): boolean {
  let current = threadId;
  const seen = new Set<string>();
  while (parentByChild.has(current) && !seen.has(current)) {
    seen.add(current);
    const parent = parentByChild.get(current);
    if (!parent) return false;
    if (selectedCallSet.has(parent)) return true;
    current = parent;
  }
  return false;
}

function threadUpdatedAtMs(row: Pick<ThreadRow, "updated_at" | "updated_at_ms">): number {
  return row.updated_at_ms ?? row.updated_at * 1000;
}

export function rolloutThreadId(file: string | path.ParsedPath): string | null {
  const parsed = typeof file === "string" ? path.parse(file) : file;
  const parts = parsed.name.split("-");
  if (parts.length < 7) return null;
  const candidate = parts.slice(-5).join("-");
  return candidate.length === 36 ? candidate : null;
}

function normalizePath(file: string): string {
  const withoutPrefix = file.startsWith("\\\\?\\") ? file.slice(4) : file;
  return path.resolve(withoutPrefix).toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isDefined<T>(value: T | undefined | null): value is T {
  return value != null;
}

function maxNumberOrNull(values: number[]): number | null {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}

function minNumberOrNull(values: number[]): number | null {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.min(...finite) : null;
}

function recentCutoffMs(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function secondsToIso(seconds: number | null): string | null {
  return seconds == null ? null : new Date(seconds * 1000).toISOString();
}

function millisToIso(millis: number | null): string | null {
  return millis == null ? null : new Date(millis).toISOString();
}

function roundMib(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

export function emitReport(report: Record<string, unknown>, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printHumanReport(report);
}

function printHumanReport(report: Record<string, unknown>): void {
  console.log(`codex-cleaner: ${String(report.action ?? "scan")} (${String(report.mode ?? "read-only")})`);
  console.log(`Codex home: ${String(report.codexHome)}`);
  console.log(`Generated: ${String(report.generatedAt)}`);
  if (report.policy) console.log(`Policy: ${JSON.stringify(report.policy)}`);

  const files = asRecord(report.files);
  if (Object.keys(files).length) {
    console.log("\nFiles:");
    for (const [name, value] of Object.entries(files)) {
      const entry = asRecord(value);
      const main = asRecord(entry.main);
      const wal = asRecord(entry.wal);
      if (main.mib !== undefined && wal.mib !== undefined) {
        console.log(`  ${name}: main=${String(main.mib)} MiB wal=${String(wal.mib)} MiB`);
      } else {
        console.log(`  ${name}: ${String(entry.mib)} MiB`);
      }
    }
  }

  printObject("Protection", report.protection);
  printObject("Threads", report.threads, [
    "rows",
    "archived_rows",
    "title_mib",
    "preview_mib",
    "first_user_message_mib",
    "max_title_chars",
    "max_preview_chars",
    "max_first_user_message_chars",
  ]);
  printCandidate("Compact candidates", report.compactMetadataCandidates);
  printCandidate("Compact candidates archived-only", report.compactMetadataCandidatesArchivedOnly);
  printArchiveCandidate("Stale archive candidates", report.staleArchiveCandidates);
  if (report.action === "checkpoint-wal") {
    printWalCheckpoint(report);
  } else if (report.action === "clean") {
    printObject("Archive apply", report.archive);
    printObject("Compact apply", report.compact);
    const checkpoint = asRecord(report.checkpoint);
    if (Object.keys(checkpoint).length) printWalCheckpoint(checkpoint);
  } else {
    printCandidate("Before", report.before);
    printCandidate("After", report.after);
    printArchiveCandidate("Before", report.before);
    printArchiveCandidate("After", report.after);
  }

  if (report.changedRows !== undefined) console.log(`\nChanged rows: ${String(report.changedRows)}`);
  if (report.backupPath !== undefined) console.log(`Backup: ${String(report.backupPath)}`);

  const rollouts = asRecord(report.rollouts);
  if (Object.keys(rollouts).length) {
    console.log("\nRollouts:");
    for (const key of [
      "threadRolloutRefs",
      "diskRolloutFiles",
      "missingReferencedFiles",
      "orphanFiles",
      "orphanIndexedFiles",
      "orphanUnindexedFiles",
      "orphanSizeMib",
      "orphanIndexedSizeMib",
      "orphanUnindexedSizeMib",
    ]) {
      console.log(`  ${key}: ${String(rollouts[key])}`);
    }
  }
}

function printWalCheckpoint(report: Record<string, unknown>): void {
  const before = asRecord(report.before);
  const after = asRecord(report.after);
  console.log("\nWAL checkpoint:");
  console.log(`  before: ${JSON.stringify(before)}`);
  console.log(`  after: ${JSON.stringify(after)}`);
  console.log(`  checkpointResult: ${JSON.stringify(report.checkpointResult)}`);
}

function printObject(title: string, value: unknown, keys?: string[]): void {
  const object = asRecord(value);
  if (!Object.keys(object).length) return;
  console.log(`\n${title}:`);
  for (const key of keys ?? Object.keys(object)) {
    if (object[key] === undefined) continue;
    console.log(`  ${key}: ${JSON.stringify(object[key])}`);
  }
}

function printCandidate(title: string, value: unknown): void {
  const object = asRecord(value);
  if (!Object.keys(object).length) return;
  console.log(`\n${title}:`);
  for (const key of [
    "rows",
    "estimated_savings_mib",
    "max_field_chars",
    "oldestCandidateUpdatedUtc",
    "newestCandidateUpdatedUtc",
  ]) {
    console.log(`  ${key}: ${JSON.stringify(object[key])}`);
  }
}

function printArchiveCandidate(title: string, value: unknown): void {
  const object = asRecord(value);
  if (!Object.keys(object).length) return;
  console.log(`\n${title}:`);
  for (const key of [
    "rows",
    "archive_call_rows",
    "expected_archived_rows",
    "rollout_size_mib",
    "expected_archived_rollout_size_mib",
    "missing_rollout_files",
    "blocked_by_descendant_safety",
    "blocked_by_missing_subtree_files",
    "oldestCandidateUpdatedUtc",
    "newestCandidateUpdatedUtc",
  ]) {
    if (object[key] !== undefined) {
      const value =
        object[key] === null && (key.includes("size_mib") || key.includes("rollout"))
          ? '"not scanned"'
          : JSON.stringify(object[key]);
      console.log(`  ${key}: ${value}`);
    }
  }
}
