import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import type { BlockingProcess, CleanerOptions, ThreadProtection } from "./types.js";

const execFileAsync = promisify(execFile);
const APP_SERVER_REQUEST_TIMEOUT_MS = 60_000;
const APP_SERVER_WINDOWS_TERMINATE_DELAY_MS = 1000;
const APP_SERVER_SHUTDOWN_TIMEOUT_MS = 3000;
const BACKUP_FILE_SUFFIXES = [".manifest.bak", ".bak.sqlite", ".bak"] as const;
const MIN_VACUUM_FREE_MIB = 1;
const PINNED_THREAD_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";
const WINDOWS_BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);

type CodexSpawnCommand = { args: string[]; command: string };

export type StoragePaths = {
  codexHome: string;
  sqliteHome: string;
};

type BackupFile = {
  ageHours: number;
  bytes: number;
  lastModified: string;
  mib: number;
  name: string;
  path: string;
};

type BackupPrunePlan = {
  backupDir: string;
  candidates: BackupFile[];
  codexHome: string;
  cutoffMs: number;
  files: BackupFile[];
};

type ThreadRow = {
  archived: number;
  archived_at: number | null;
  cwd: string;
  id: string;
  rollout_path: string;
  title: string;
};

type SpawnEdgeRow = {
  child_thread_id: string;
  parent_thread_id: string;
};

type RolloutFileInfo = {
  exists: boolean;
  path: string;
  sizeBytes: number;
  sizeMib: number;
};

type ArchivedDeletePlan = {
  stats: Record<string, unknown>;
  threadIds: string[];
};

type CleanupPlan = {
  deleteThreadIds: string[];
  report: Record<string, unknown>;
};

export async function requireCodexStopped(): Promise<void> {
  const blockers = await findBlockingProcesses();
  if (!blockers.length) return;
  const details = blockers
    .map((process) => `  - pid=${process.pid} name=${process.name} command=${process.commandLine.slice(0, 240)}`)
    .join("\n");
  throw new Error(`Refusing to apply while Codex is active. Close Codex completely, then retry.\n${details}`);
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
    { windowsHide: true },
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
      return match ? { pid: Number(match[1]), name: match[2] ?? "", commandLine: match[3] ?? "" } : null;
    })
    .filter((row): row is BlockingProcess => Boolean(row))
    .filter((row) => {
      const name = row.name.toLowerCase();
      const command = row.commandLine.toLowerCase();
      return (
        name === "codex" || name === "node_repl" || (name === "node" && /@openai[\\/]codex|app-server/.test(command))
      );
    });
}

export async function mutateThreadsViaCodexAppServer(
  method: "thread/delete",
  threadIds: string[],
  codexCommand: string,
  codexHome: string,
  sqliteHome: string,
): Promise<Record<string, unknown>> {
  const spawnCommand = await resolveCodexSpawnCommand(codexCommand, [
    "-c",
    `sqlite_home=${JSON.stringify(sqliteHome)}`,
    "app-server",
    "--listen",
    "stdio://",
  ]);
  const child = spawn(spawnCommand.command, spawnCommand.args, {
    env: { ...process.env, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome },
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
    { reject: (error: Error) => void; resolve: (value: Record<string, unknown>) => void }
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
  child.on("error", (error) => rejectPending(pending, error));
  child.on("exit", (code) => {
    if (!pending.size) return;
    rejectPending(pending, new Error(`codex app-server exited with code ${String(code)}: ${stderrBuffer.trim()}`));
  });

  const request = (requestMethod: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${requestMethod}`));
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
      child.stdin.write(`${JSON.stringify({ id, method: requestMethod, params })}\n`, (error) => {
        if (!error) return;
        pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      });
    });
  };

  const errors: Record<string, string>[] = [];
  let succeeded = 0;
  try {
    await request("initialize", {
      clientInfo: { name: "codex_cleaner", title: "Codex Cleaner", version: "0.2.1" },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

    for (const threadId of threadIds) {
      try {
        await request(method, { threadId });
        succeeded += 1;
      } catch (error) {
        errors.push({ threadId, error: error instanceof Error ? error.message : String(error) });
      }
      printDeleteProgress(succeeded + errors.length, threadIds.length);
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

function printDeleteProgress(completed: number, total: number): void {
  if (total < 1000 || (completed < total && completed % 1000 !== 0)) return;
  process.stderr.write(
    `\rDeleting archived thread trees: ${String(completed)}/${String(total)}${completed === total ? "\n" : ""}`,
  );
}

function rejectPending(
  pending: Map<number, { reject: (error: Error) => void; resolve: (value: Record<string, unknown>) => void }>,
  error: Error,
): void {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

export async function resolveCodexSpawnCommand(
  codexCommand: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  windowsMatches?: string[],
): Promise<CodexSpawnCommand> {
  if (platform !== "win32") return { args, command: codexCommand };
  const matches = windowsMatches ?? (await resolveWindowsCommandMatches(codexCommand));
  let firstBatchMatch: string | null = null;
  for (const match of matches) {
    const npmScript = codexNpmScriptPath(match);
    if (npmScript) return { args: [npmScript, ...args], command: process.execPath };
    if ([".com", ".exe"].includes(path.extname(match).toLowerCase())) return { args, command: match };
    if (WINDOWS_BATCH_EXTENSIONS.has(path.extname(match).toLowerCase())) firstBatchMatch ??= match;
  }
  if (firstBatchMatch) {
    throw new Error(
      `Refusing to wrap a Windows batch Codex command because child app-server cleanup would not own the process tree: ${firstBatchMatch}`,
    );
  }
  return { args, command: matches[0] ?? codexCommand };
}

async function resolveWindowsCommandMatches(command: string): Promise<string[]> {
  if (command.includes("/") || command.includes("\\")) return [path.resolve(command)];
  try {
    const { stdout } = await execFileAsync("where.exe", [command], { windowsHide: true });
    const matches = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return matches.length ? matches : [command];
  } catch {
    return [command];
  }
}

function codexNpmScriptPath(command: string): string | null {
  if (!["codex", "codex.bat", "codex.cmd"].includes(path.basename(command).toLowerCase())) return null;
  const commandDir = path.dirname(command);
  return (
    [
      path.join(commandDir, "node_modules", "@openai", "codex", "bin", "codex.js"),
      path.join(commandDir, "..", "@openai", "codex", "bin", "codex.js"),
    ].find((candidate) => fs.existsSync(candidate)) ?? null
  );
}

function handleAppServerLine(
  line: string,
  pending: Map<number, { reject: (error: Error) => void; resolve: (value: Record<string, unknown>) => void }>,
): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const id = typeof message.id === "number" ? message.id : null;
  if (id == null) return;
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  if (message.error) {
    request.reject(new Error(String(asRecord(message.error).message ?? JSON.stringify(message.error))));
  } else {
    request.resolve(asRecord(message.result));
  }
}

async function stopAppServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const done = (): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      resolve();
    };
    const terminate = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
    };
    if (process.platform === "win32") timers.push(setTimeout(terminate, APP_SERVER_WINDOWS_TERMINATE_DELAY_MS));
    else terminate();
    timers.push(
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already exited.
        }
        done();
      }, APP_SERVER_SHUTDOWN_TIMEOUT_MS),
    );
    child.once("exit", done);
  });
}

export function buildScanReport(options: CleanerOptions): Record<string, unknown> {
  return planCleanup(options).report;
}

function planCleanup(options: CleanerOptions): CleanupPlan {
  const { codexHome, sqliteHome } = resolveStoragePaths(options);
  const stateDb = path.join(sqliteHome, "state_5.sqlite");
  const logsDb = path.join(sqliteHome, "logs_2.sqlite");
  const protection = loadThreadProtection(sqliteHome, loadGlobalState(codexHome), options.mode === "full");
  const protectedIds = allProtectedIds(protection);

  const state = openReadonlyDb(stateDb);
  let stateSpace: Record<string, unknown>;
  let deletePlan: ArchivedDeletePlan | null = null;
  try {
    stateSpace = collectSqliteSpaceStats(state);
    if (options.mode === "full") {
      deletePlan = buildArchivedDeletePlan(state, codexHome, {
        cutoffMs: recentCutoffMs(options.keepDays),
        protectedIds,
      });
    }
  } finally {
    state.close();
  }

  let logsSpace: Record<string, unknown> = { exists: false, free_mib: 0 };
  if (fs.existsSync(logsDb)) {
    const logs = openReadonlyDb(logsDb);
    try {
      logsSpace = { exists: true, ...collectSqliteSpaceStats(logs) };
    } finally {
      logs.close();
    }
  }

  return {
    deleteThreadIds: deletePlan?.threadIds ?? [],
    report: {
      action: "scan",
      mode: "dry-run",
      cleanupMode: options.mode,
      codexHome,
      sqliteHome,
      generatedAt: new Date().toISOString(),
      files: {
        "state_5.sqlite": fileTripletSizes(stateDb),
        "logs_2.sqlite": fileTripletSizes(logsDb),
      },
      maintenance: { state: stateSpace, logs: logsSpace },
      protection: {
        pinnedThreads: protection.pinnedIds.size,
        heartbeatThreads: protection.heartbeatIds.size,
        activeGoalThreads: protection.activeGoalIds.size,
        totalUniqueProtectedThreads: protectedIds.size,
      },
      deletePlan: deletePlan?.stats ?? null,
    },
  };
}

export async function cleanCodex(options: CleanerOptions): Promise<Record<string, unknown>> {
  const plan = planCleanup(options);
  if (!options.apply) return { ...plan.report, action: "clean" };

  const { codexHome, sqliteHome } = resolveStoragePaths(options);
  const stateDb = path.join(sqliteHome, "state_5.sqlite");
  const backupDir = resolveBackupDir(options, codexHome);
  let stateBackupPath: string | null = null;
  let deleteApply: Record<string, unknown> | null = null;

  if (options.mode === "full" && plan.deleteThreadIds.length) {
    stateBackupPath = await backupSqliteDatabase(stateDb, backupDir);
    deleteApply = await mutateThreadsViaCodexAppServer(
      "thread/delete",
      plan.deleteThreadIds,
      options.codexCommand ?? "codex",
      codexHome,
      sqliteHome,
    );
  }

  const vacuum = await vacuumStateDatabase(options, !stateBackupPath);
  stateBackupPath ??= asStringOrNull(vacuum.backupPath);
  const logs = await vacuumLogsDatabase(options);
  const checkpoint = await checkpointWal(options, !stateBackupPath);
  stateBackupPath ??= asStringOrNull(checkpoint.backupPath);
  const backups = await scheduleBackupPruneAfterApply(options, [{ backupPath: stateBackupPath }, logs]);
  const ok = Number(asRecord(deleteApply).failed ?? 0) === 0 && !asRecord(backups).error;

  return {
    action: "clean",
    mode: "apply",
    cleanupMode: options.mode,
    codexHome,
    sqliteHome,
    generatedAt: new Date().toISOString(),
    maintenance: plan.report.maintenance,
    deletePlan: plan.report.deletePlan,
    deleteApply,
    vacuum,
    logs,
    checkpoint,
    backups,
    stateBackupPath,
    ok,
  };
}

export function collectArchivedDeleteCandidateStats(
  db: DatabaseSync,
  codexHome: string,
  args: { cutoffMs: number; protectedIds: Set<string> },
): Record<string, unknown> {
  return buildArchivedDeletePlan(db, codexHome, args).stats;
}

export function archivedDeleteThreadIds(
  db: DatabaseSync,
  codexHome: string,
  args: { cutoffMs: number; protectedIds: Set<string> },
): string[] {
  return buildArchivedDeletePlan(db, codexHome, args).threadIds;
}

function buildArchivedDeletePlan(
  db: DatabaseSync,
  codexHome: string,
  args: { cutoffMs: number; protectedIds: Set<string> },
): ArchivedDeletePlan {
  const rows = queryAll(
    db,
    `SELECT id, archived, archived_at, rollout_path,
            substr(cwd, 1, 160) AS cwd, substr(title, 1, 160) AS title
     FROM threads`,
  ) as unknown as ThreadRow[];
  const edges = queryAll(
    db,
    "SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges",
  ) as unknown as SpawnEdgeRow[];
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const childrenByParent = new Map<string, string[]>();
  const parentByChild = new Map<string, string>();
  for (const edge of edges) {
    childrenByParent.set(edge.parent_thread_id, [
      ...(childrenByParent.get(edge.parent_thread_id) ?? []),
      edge.child_thread_id,
    ]);
    parentByChild.set(edge.child_thread_id, edge.parent_thread_id);
  }

  const candidates = rows.filter(
    (row) => row.archived === 1 && threadArchivedAtMs(row) < args.cutoffMs && !args.protectedIds.has(row.id),
  );
  const safeIds = new Set<string>();
  const blockedIds = new Set<string>();
  for (const row of candidates) {
    const unsafe = descendantThreadIds(row.id, childrenByParent).some((id) => {
      const descendant = rowById.get(id);
      return (
        !descendant ||
        descendant.archived !== 1 ||
        threadArchivedAtMs(descendant) >= args.cutoffMs ||
        args.protectedIds.has(id)
      );
    });
    if (unsafe) blockedIds.add(row.id);
    else safeIds.add(row.id);
  }

  const selectedIds: string[] = [];
  const selectedSet = new Set<string>();
  for (const row of [...candidates].sort(
    (left, right) => candidateDepth(left.id, parentByChild) - candidateDepth(right.id, parentByChild),
  )) {
    if (!safeIds.has(row.id) || hasSelectedCandidateAncestor(row.id, parentByChild, selectedSet)) continue;
    selectedIds.push(row.id);
    selectedSet.add(row.id);
  }

  const expectedIds = new Set<string>();
  for (const id of selectedIds) {
    expectedIds.add(id);
    for (const descendantId of descendantThreadIds(id, childrenByParent)) expectedIds.add(descendantId);
  }
  const expectedRows = [...expectedIds].map((id) => rowById.get(id)).filter(isDefined);
  const fileInfo = new Map(expectedRows.map((row) => [row.id, rolloutFileInfo(row.rollout_path, codexHome)]));
  const newest = maxNumberOrNull(candidates.map(threadArchivedAtMs));
  const oldest = minNumberOrNull(candidates.map(threadArchivedAtMs));

  return {
    threadIds: selectedIds,
    stats: {
      candidates: candidates.length,
      deleteCalls: selectedIds.length,
      expectedDeletedThreads: expectedIds.size,
      rolloutSizeMib: roundMib([...fileInfo.values()].reduce((sum, file) => sum + file.sizeBytes, 0)),
      missingRolloutFiles: [...fileInfo.values()].filter((file) => !file.exists).length,
      blockedByDescendantSafety: blockedIds.size,
      oldestCandidateArchivedUtc: millisToIso(oldest),
      newestCandidateArchivedUtc: millisToIso(newest),
      retentionDays: Math.round((Date.now() - args.cutoffMs) / 86_400_000),
      sample: topDeleteSample(expectedRows, fileInfo),
    },
  };
}

function rolloutFileInfo(file: string, codexHome: string): RolloutFileInfo {
  const filePath = path.isAbsolute(file) ? file : path.resolve(codexHome, file);
  if (!file || !fs.existsSync(filePath)) return { exists: false, path: filePath, sizeBytes: 0, sizeMib: 0 };
  const sizeBytes = fs.statSync(filePath).size;
  return { exists: true, path: filePath, sizeBytes, sizeMib: roundMib(sizeBytes) };
}

function topDeleteSample(
  rows: ThreadRow[],
  fileInfo: Map<string, RolloutFileInfo>,
  limit = 10,
): Record<string, unknown>[] {
  return [...rows]
    .sort((left, right) => (fileInfo.get(right.id)?.sizeBytes ?? 0) - (fileInfo.get(left.id)?.sizeBytes ?? 0))
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      archivedUtc: millisToIso(threadArchivedAtMs(row)),
      rolloutPath: fileInfo.get(row.id)?.path,
      rolloutSizeMib: fileInfo.get(row.id)?.sizeMib ?? 0,
    }));
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
    current = parent;
    depth += 1;
  }
  return depth;
}

function hasSelectedCandidateAncestor(
  threadId: string,
  parentByChild: Map<string, string>,
  selected: Set<string>,
): boolean {
  let current = threadId;
  const seen = new Set<string>();
  while (parentByChild.has(current) && !seen.has(current)) {
    seen.add(current);
    const parent = parentByChild.get(current);
    if (!parent) return false;
    if (selected.has(parent)) return true;
    current = parent;
  }
  return false;
}

function threadArchivedAtMs(row: Pick<ThreadRow, "archived_at">): number {
  return row.archived_at == null ? Number.POSITIVE_INFINITY : row.archived_at * 1000;
}

export async function checkpointWal(
  options: CleanerOptions,
  backupBeforeCheckpoint = true,
): Promise<Record<string, unknown>> {
  const { codexHome, sqliteHome } = resolveStoragePaths(options);
  const stateDb = path.join(sqliteHome, "state_5.sqlite");
  const before = fileTripletSizes(stateDb);
  const walBytes = Number(asRecord(before.wal).bytes ?? 0);
  let checkpointResult: unknown = null;
  let backupPath: string | null = null;
  if (options.apply && walBytes > 0) {
    if (backupBeforeCheckpoint) backupPath = await backupSqliteDatabase(stateDb, resolveBackupDir(options, codexHome));
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
    before,
    after: fileTripletSizes(stateDb),
    checkpointResult,
    backupPath,
  };
}

export async function vacuumStateDatabase(
  options: CleanerOptions,
  backupBeforeVacuum = true,
): Promise<Record<string, unknown>> {
  const { codexHome, sqliteHome } = resolveStoragePaths(options);
  return vacuumSqliteDatabase({
    action: "vacuum-state",
    apply: options.apply,
    backupBeforeVacuum,
    backupDir: resolveBackupDir(options, codexHome),
    codexHome,
    dbPath: path.join(sqliteHome, "state_5.sqlite"),
    sqliteHome,
  });
}

export async function vacuumLogsDatabase(options: CleanerOptions): Promise<Record<string, unknown>> {
  const { codexHome, sqliteHome } = resolveStoragePaths(options);
  const dbPath = path.join(sqliteHome, "logs_2.sqlite");
  if (!fs.existsSync(dbPath)) {
    return { action: "vacuum-logs", mode: options.apply ? "apply" : "dry-run", exists: false };
  }
  return vacuumSqliteDatabase({
    action: "vacuum-logs",
    apply: options.apply,
    backupBeforeVacuum: true,
    backupDir: resolveBackupDir(options, codexHome),
    codexHome,
    dbPath,
    sqliteHome,
  });
}

async function vacuumSqliteDatabase(args: {
  action: string;
  apply: boolean;
  backupBeforeVacuum: boolean;
  backupDir: string;
  codexHome: string;
  dbPath: string;
  sqliteHome: string;
}): Promise<Record<string, unknown>> {
  const before = fileTripletSizes(args.dbPath);
  const db = openWritableDb(args.dbPath);
  let backupPath: string | null = null;
  try {
    const beforeSpace = collectSqliteSpaceStats(db);
    if (args.apply && Number(beforeSpace.free_mib ?? 0) >= MIN_VACUUM_FREE_MIB) {
      if (args.backupBeforeVacuum) backupPath = await backupOpenSqliteDatabase(db, args.dbPath, args.backupDir);
      db.exec("VACUUM");
      queryAll(db, "PRAGMA wal_checkpoint(TRUNCATE)");
    }
    return {
      action: args.action,
      mode: args.apply ? "apply" : "dry-run",
      before,
      after: fileTripletSizes(args.dbPath),
      beforeSpace,
      afterSpace: collectSqliteSpaceStats(db),
      backupPath,
    };
  } finally {
    db.close();
  }
}

export function scanBackups(options: CleanerOptions): Record<string, unknown> {
  const plan = buildBackupPrunePlan(options);
  return {
    action: "backups-scan",
    mode: "dry-run",
    codexHome: plan.codexHome,
    generatedAt: new Date().toISOString(),
    backupDir: plan.backupDir,
    policy: { olderThanHours: options.olderThanHours, cutoffUtc: new Date(plan.cutoffMs).toISOString() },
    files: backupFileStats(plan.files),
    pruneCandidates: backupFileStats(plan.candidates),
  };
}

export function pruneBackups(options: CleanerOptions): Record<string, unknown> {
  const plan = buildBackupPrunePlan(options);
  const deleted: BackupFile[] = [];
  const errors: Record<string, string>[] = [];
  if (options.apply) {
    for (const file of plan.candidates) {
      try {
        fs.rmSync(file.path);
        deleted.push(file);
      } catch (error) {
        errors.push({ path: file.path, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return {
    action: "backups-prune",
    mode: options.apply ? "apply" : "dry-run",
    codexHome: plan.codexHome,
    generatedAt: new Date().toISOString(),
    backupDir: plan.backupDir,
    policy: { olderThanHours: options.olderThanHours, cutoffUtc: new Date(plan.cutoffMs).toISOString() },
    before: backupFileStats(plan.files),
    candidates: backupFileStats(plan.candidates),
    deleted: backupFileStats(deleted),
    errors,
    ok: errors.length === 0,
  };
}

export async function scheduleBackupPrune(options: CleanerOptions): Promise<Record<string, unknown>> {
  if (options.afterHours < options.olderThanHours) {
    throw new Error("--after-hours must be greater than or equal to --older-than-hours");
  }
  const { codexHome } = resolveStoragePaths(options);
  const backupDir = resolveBackupDir(options, codexHome);
  const runAt = new Date(Date.now() + options.afterHours * 60 * 60 * 1000);
  const schedule = await schedulePruneCommand({
    afterHours: options.afterHours,
    apply: options.apply,
    backupDir,
    codexHome,
    olderThanHours: options.olderThanHours,
    runAt,
  });
  return {
    action: "backups-schedule-prune",
    mode: options.apply ? "apply" : "dry-run",
    codexHome,
    generatedAt: new Date().toISOString(),
    backupDir,
    policy: { afterHours: options.afterHours, olderThanHours: options.olderThanHours, runAtUtc: runAt.toISOString() },
    ...schedule,
  };
}

async function scheduleBackupPruneAfterApply(
  options: CleanerOptions,
  reports: Record<string, unknown>[],
): Promise<Record<string, unknown> | null> {
  if (!reports.some((report) => typeof report.backupPath === "string")) return null;
  try {
    return await scheduleBackupPrune({ ...options, apply: true });
  } catch (error) {
    return {
      action: "backups-schedule-prune",
      mode: "apply",
      scheduled: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveBackupDir(options: CleanerOptions, codexHome: string): string {
  return path.resolve(options.backupDir ?? path.join(codexHome, ".codex-cleanup-backups"));
}

function listBackupFiles(backupDir: string): BackupFile[] {
  if (!fs.existsSync(backupDir)) return [];
  const now = Date.now();
  return fs
    .readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)))
    .map((entry) => {
      const filePath = path.resolve(backupDir, entry.name);
      const stat = fs.statSync(filePath);
      return {
        ageHours: Math.round(((now - stat.mtimeMs) / 3_600_000) * 100) / 100,
        bytes: stat.size,
        lastModified: stat.mtime.toISOString(),
        mib: roundMib(stat.size),
        name: entry.name,
        path: filePath,
      };
    })
    .sort((left, right) => Date.parse(left.lastModified) - Date.parse(right.lastModified));
}

function buildBackupPrunePlan(options: CleanerOptions): BackupPrunePlan {
  const { codexHome } = resolveStoragePaths(options);
  const backupDir = resolveBackupDir(options, codexHome);
  const cutoffMs = Date.now() - options.olderThanHours * 3_600_000;
  const files = listBackupFiles(backupDir);
  return {
    backupDir,
    candidates: files.filter((file) => Date.parse(file.lastModified) < cutoffMs),
    codexHome,
    cutoffMs,
    files,
  };
}

function backupFileStats(files: BackupFile[]): Record<string, unknown> {
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return {
    count: files.length,
    files,
    newestUtc: files.at(-1)?.lastModified ?? null,
    oldestUtc: files[0]?.lastModified ?? null,
    totalBytes,
    totalMib: roundMib(totalBytes),
  };
}

async function backupSqliteDatabase(dbPath: string, backupDir: string): Promise<string> {
  const db = openWritableDb(dbPath);
  try {
    return await backupOpenSqliteDatabase(db, dbPath, backupDir);
  } finally {
    db.close();
  }
}

async function backupOpenSqliteDatabase(db: DatabaseSync, dbPath: string, backupDir: string): Promise<string> {
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = nextBackupPath(dbPath, backupDir);
  await sqliteBackup(db, backupPath);
  return backupPath;
}

export function nextBackupPath(dbPath: string, backupDir: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(".", "_");
  const base = `${path.basename(dbPath)}.${stamp}`;
  let candidate = path.join(backupDir, `${base}.bak.sqlite`);
  let collision = 2;
  while (fs.existsSync(candidate)) candidate = path.join(backupDir, `${base}.${String(collision++)}.bak.sqlite`);
  return candidate;
}

async function schedulePruneCommand(args: {
  afterHours: number;
  apply: boolean;
  backupDir: string;
  codexHome: string;
  olderThanHours: number;
  runAt: Date;
}): Promise<Record<string, unknown>> {
  const command = buildBackupPruneCommand(args.codexHome, args.backupDir, args.olderThanHours);
  const taskName = `codex-cleaner-prune-backups-${timestampForName(new Date())}`;
  if (process.platform === "win32") {
    const cancelCommand = `schtasks /Delete /TN ${quoteWindowsArgument(taskName)} /F`;
    if (!args.apply) {
      return {
        cancelCommand,
        command: windowsCommandLine(command),
        runAtUtc: args.runAt.toISOString(),
        scheduler: "windows-scheduled-task",
        scheduled: false,
        taskName,
      };
    }
    const script = [
      `$action = New-ScheduledTaskAction -Execute ${powershellSingleQuote(command.command)} -Argument ${powershellSingleQuote(command.args.map(quoteWindowsArgument).join(" "))}`,
      `$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(${String(args.afterHours)})`,
      `Register-ScheduledTask -TaskName ${powershellSingleQuote(taskName)} -Action $action -Trigger $trigger -Description 'Delete old codex-cleaner backups.' -Force | Out-Null`,
    ].join("\n");
    const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`Failed to schedule backup cleanup: ${result.stderr || result.stdout}`);
    return {
      cancelCommand,
      command: windowsCommandLine(command),
      runAtUtc: args.runAt.toISOString(),
      scheduler: "windows-scheduled-task",
      scheduled: true,
      taskName,
    };
  }

  const shellCommand = posixCommandLine(command);
  if (spawnSync("sh", ["-c", "command -v at"], { encoding: "utf8" }).status !== 0) {
    throw new Error("Cannot schedule backup cleanup: POSIX `at` is not available.");
  }
  if (!args.apply)
    return { command: shellCommand, runAtUtc: args.runAt.toISOString(), scheduler: "at", scheduled: false };
  const result = spawnSync("at", ["now", "+", String(args.afterHours), "hours"], {
    encoding: "utf8",
    input: `${shellCommand}\n`,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) throw new Error(`Failed to schedule backup cleanup: ${combined.trim()}`);
  const jobId = combined.match(/\bjob\s+(\d+)\b/i)?.[1];
  if (!jobId) throw new Error(`Scheduled backup cleanup, but could not parse a cancelable job id: ${combined.trim()}`);
  return {
    cancelCommand: `atrm ${jobId}`,
    command: shellCommand,
    jobId,
    runAtUtc: args.runAt.toISOString(),
    scheduler: "at",
    scheduled: true,
  };
}

function buildBackupPruneCommand(codexHome: string, backupDir: string, olderThanHours: number): CodexSpawnCommand {
  const npxCommand = {
    args: [
      "--yes",
      "codex-cleaner@latest",
      "backups",
      "prune",
      "--codex-home",
      codexHome,
      "--backup-dir",
      backupDir,
      "--older-than-hours",
      String(olderThanHours),
      "--apply",
    ],
    command: "npx",
  };
  return process.platform === "win32"
    ? { args: ["/d", "/s", "/c", windowsCommandLine(npxCommand)], command: "cmd.exe" }
    : npxCommand;
}

function posixCommandLine(command: CodexSpawnCommand): string {
  return [command.command, ...command.args].map(shellQuote).join(" ");
}

function windowsCommandLine(command: CodexSpawnCommand): string {
  return [command.command, ...command.args].map(quoteWindowsArgument).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function powershellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteWindowsArgument(value: string): string {
  if (!/[ \t"]/.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
    } else if (char === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      result += "\\".repeat(backslashes) + char;
      backslashes = 0;
    }
  }
  return result + "\\".repeat(backslashes * 2) + '"';
}

function timestampForName(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function loadThreadProtection(
  sqliteHome: string,
  globalState: Record<string, unknown>,
  requireActiveGoals: boolean,
): ThreadProtection {
  const atom = asRecord(globalState["electron-persisted-atom-state"]);
  return {
    activeGoalIds: loadActiveGoalThreadIds(path.join(sqliteHome, "goals_1.sqlite"), requireActiveGoals),
    heartbeatIds: new Set(Object.keys(asRecord(atom["heartbeat-thread-permissions-by-id"]))),
    pinnedIds: new Set([
      ...asStringArray(globalState["pinned-thread-ids"]),
      ...loadPinnedThreadIds(path.join(sqliteHome, "state_5.sqlite")),
    ]),
  };
}

function loadGlobalState(codexHome: string): Record<string, unknown> {
  const file = path.join(codexHome, ".codex-global-state.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>) : {};
}

function loadActiveGoalThreadIds(file: string, required: boolean): Set<string> {
  if (!fs.existsSync(file)) return new Set();
  try {
    const db = openReadonlyDb(file);
    try {
      return new Set(
        queryAll(db, "SELECT thread_id FROM thread_goals WHERE status = 'active'").map((row) => String(row.thread_id)),
      );
    } finally {
      db.close();
    }
  } catch (error) {
    if (required) {
      throw new Error(
        `Cannot verify active-goal protection in ${file}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return new Set();
  }
}

function loadPinnedThreadIds(file: string): Set<string> {
  const db = openReadonlyDb(file);
  try {
    return new Set(
      queryAll(
        db,
        `SELECT id FROM threads
         WHERE is_pinned = 1 OR thread_section_id = '${PINNED_THREAD_SECTION_ID}'`,
      ).map((row) => String(row.id)),
    );
  } finally {
    db.close();
  }
}

function allProtectedIds(protection: ThreadProtection): Set<string> {
  return new Set([...protection.pinnedIds, ...protection.heartbeatIds, ...protection.activeGoalIds]);
}

function openReadonlyDb(file: string): DatabaseSync {
  if (!fs.existsSync(file)) throw new Error(`SQLite database not found: ${file}`);
  return new DatabaseSync(file, { readOnly: true });
}

function openWritableDb(file: string): DatabaseSync {
  if (!fs.existsSync(file)) throw new Error(`SQLite database not found: ${file}`);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function queryAll(db: DatabaseSync, sql: string, params?: Record<string, string | number>): Record<string, unknown>[] {
  return prepareStatement(db, sql).all(params ?? {}) as Record<string, unknown>[];
}

function queryOne(db: DatabaseSync, sql: string): Record<string, unknown> {
  return (prepareStatement(db, sql).get() as Record<string, unknown> | undefined) ?? {};
}

function prepareStatement(db: DatabaseSync, sql: string): ReturnType<DatabaseSync["prepare"]> {
  const statement = db.prepare(sql);
  statement.setAllowUnknownNamedParameters(true);
  return statement;
}

export function resolveStoragePaths(
  options: CleanerOptions,
  env: NodeJS.ProcessEnv = process.env,
  userHome = os.homedir(),
): StoragePaths {
  const codexHome = resolveUserPath(options.codexHome ?? env.CODEX_HOME ?? path.join(userHome, ".codex"), userHome);
  const configured = readStorageConfig(codexHome, !options.sqliteHome);
  const sqliteHome = options.sqliteHome
    ? resolveUserPath(options.sqliteHome, userHome)
    : configured.sqliteHome
      ? resolveConfigPath(configured.sqliteHome, codexHome, userHome)
      : env.CODEX_SQLITE_HOME
        ? resolveUserPath(env.CODEX_SQLITE_HOME, userHome)
        : codexHome;
  return { codexHome, sqliteHome };
}

function readStorageConfig(codexHome: string, requested: boolean): { sqliteHome?: string } {
  if (!requested) return {};
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return {};
  const result: { sqliteHome?: string } = {};
  for (const line of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    if (!/^\s*sqlite_home\s*=/.test(line)) continue;
    const value = line.match(/^\s*sqlite_home\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/)?.[1];
    if (!value) throw new Error(`Unsupported sqlite_home syntax in ${configPath}; use --sqlite-home to override it`);
    const parsed = value.startsWith("'") ? value.slice(1, -1) : (JSON.parse(value) as string);
    result.sqliteHome = parsed;
  }
  return result;
}

function resolveConfigPath(value: string, codexHome: string, userHome: string): string {
  return path.resolve(codexHome, expandTilde(value, userHome));
}

function resolveUserPath(value: string, userHome: string): string {
  return path.resolve(expandTilde(value, userHome));
}

function expandTilde(value: string, userHome: string): string {
  if (value === "~") return userHome;
  return /^~[\\/]/.test(value) ? path.join(userHome, value.slice(2)) : value;
}

function fileTripletSizes(dbPath: string): Record<string, unknown> {
  return { main: fileSize(dbPath), path: dbPath, shm: fileSize(`${dbPath}-shm`), wal: fileSize(`${dbPath}-wal`) };
}

function collectSqliteSpaceStats(db: DatabaseSync): Record<string, unknown> {
  const pageCount = Number(queryOne(db, "PRAGMA page_count").page_count ?? 0);
  const freelistCount = Number(queryOne(db, "PRAGMA freelist_count").freelist_count ?? 0);
  const pageSize = Number(queryOne(db, "PRAGMA page_size").page_size ?? 0);
  const freeBytes = freelistCount * pageSize;
  const totalBytes = pageCount * pageSize;
  return {
    free_mib: roundMib(freeBytes),
    freelist_count: freelistCount,
    page_count: pageCount,
    page_size: pageSize,
    total_mib: roundMib(totalBytes),
    used_mib: roundMib(totalBytes - freeBytes),
  };
}

function fileSize(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return { bytes: 0, exists: false, mib: 0, path: file };
  const stat = fs.statSync(file);
  return { bytes: stat.size, exists: true, mib: roundMib(stat.size), path: file };
}

function recentCutoffMs(days: number): number {
  return Date.now() - days * 86_400_000;
}

function millisToIso(millis: number | null): string | null {
  return millis == null ? null : new Date(millis).toISOString();
}

function maxNumberOrNull(values: number[]): number | null {
  return values.length ? Math.max(...values) : null;
}

function minNumberOrNull(values: number[]): number | null {
  return values.length ? Math.min(...values) : null;
}

function roundMib(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value != null;
}

export function emitReport(report: Record<string, unknown>, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`codex-cleaner: ${String(report.action)} (${String(report.mode)})`);
  if (report.codexHome) console.log(`Codex home: ${String(report.codexHome)}`);
  if (report.sqliteHome) console.log(`SQLite home: ${String(report.sqliteHome)}`);
  if (String(report.action).startsWith("backups-")) {
    if (report.action === "backups-schedule-prune") {
      console.log(`Scheduled: ${String(report.scheduled)}`);
      console.log(`Runs: ${String(asRecord(report.policy).runAtUtc ?? report.runAtUtc)}`);
      console.log(`Command: ${String(report.command)}`);
      if (report.taskName) console.log(`Task: ${String(report.taskName)}`);
      if (report.jobId) console.log(`Job: ${String(report.jobId)}`);
      if (report.cancelCommand) console.log(`Cancel: ${String(report.cancelCommand)}`);
      return;
    }
    console.log(
      JSON.stringify(
        {
          files: report.files ?? report.before,
          candidates: report.pruneCandidates ?? report.candidates,
          deleted: report.deleted ?? null,
          errors: report.errors ?? [],
        },
        null,
        2,
      ),
    );
    return;
  }
  const maintenance = asRecord(report.maintenance);
  const state = asRecord(maintenance.state);
  const logs = asRecord(maintenance.logs);
  console.log(`State free pages: ${String(state.free_mib ?? 0)} MiB`);
  console.log(`Logs free pages: ${String(logs.free_mib ?? 0)} MiB`);
  const deletion = asRecord(report.deletePlan);
  if (Object.keys(deletion).length) {
    console.log(
      `Archived history: ${String(deletion.expectedDeletedThreads ?? 0)} threads, ${String(deletion.rolloutSizeMib ?? 0)} MiB`,
    );
  } else {
    console.log("Archived history: unchanged");
  }
  if (report.mode === "apply") {
    const applied = asRecord(report.deleteApply);
    if (Object.keys(applied).length)
      console.log(`Delete calls: ${String(applied.succeeded ?? 0)} succeeded, ${String(applied.failed ?? 0)} failed`);
    if (report.stateBackupPath) console.log(`State backup: ${String(report.stateBackupPath)}`);
    const backups = asRecord(report.backups);
    if (backups.error) {
      console.log(`Backup cleanup was not scheduled: ${String(backups.error)}`);
    } else if (Object.keys(backups).length) {
      console.log(`Backup cleanup: ${String(asRecord(backups.policy).runAtUtc)}`);
      if (backups.cancelCommand) console.log(`Cancel backup cleanup: ${String(backups.cancelCommand)}`);
    }
  }
}
