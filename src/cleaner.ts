import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import Database from "better-sqlite3";

import type { BlockingProcess, CleanerOptions, CompactWhere, ThreadProtection } from "./types.js";

const execFileAsync = promisify(execFile);

const THREAD_COLUMNS_TO_CAP = ["title", "preview", "first_user_message"] as const;
const APP_SERVER_REQUEST_TIMEOUT_MS = 60_000;
const APP_SERVER_WINDOWS_TERMINATE_DELAY_MS = 1000;
const APP_SERVER_SHUTDOWN_TIMEOUT_MS = 3000;
const BACKUP_FILE_SUFFIXES = [".bak", ".bak.sqlite"] as const;
const STATE_VACUUM_MIN_FREE_MIB = 1;
const TUI_LOG_COPY_CHUNK_BYTES = 8 * 1024 * 1024;
const WINDOWS_BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);

type CodexSpawnCommand = {
  args: string[];
  command: string;
};

type BackupFile = {
  ageHours: number;
  bytes: number;
  lastModified: string;
  mib: number;
  name: string;
  path: string;
};

type OrphanRolloutMove = {
  destination: string;
  indexed: boolean;
  modifiedMs: number;
  path: string;
  reason?: string;
  sizeBytes: number;
  threadId: string | null;
};

type OrphanRolloutPlan = {
  candidates: OrphanRolloutMove[];
  emptyDirs: string[];
  skipped: OrphanRolloutMove[];
  stats: Record<string, unknown>;
};

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
  codexHome: string,
): Promise<Record<string, unknown>> {
  const spawnCommand = await resolveCodexSpawnCommand(codexCommand, ["app-server", "--listen", "stdio://"]);
  const child = spawn(spawnCommand.command, spawnCommand.args, {
    env: { ...process.env, CODEX_HOME: codexHome },
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
    codexHome,
    stderrTail: stderrBuffer.trim(),
  };
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
    if (npmScript) {
      return { args: [npmScript, ...args], command: process.execPath };
    }
    if (isWindowsExecutableMatch(match)) return { args, command: match };
    if (WINDOWS_BATCH_EXTENSIONS.has(path.extname(match).toLowerCase())) {
      firstBatchMatch ??= match;
    }
  }

  if (firstBatchMatch) {
    throw new Error(
      `Refusing to wrap a Windows batch Codex command because child app-server cleanup would not own the process tree: ${firstBatchMatch}`,
    );
  }
  return { args, command: matches[0] ?? codexCommand };
}

async function resolveWindowsCommandMatches(command: string): Promise<string[]> {
  if (hasPathSeparator(command)) return [path.resolve(command)];

  const matches = await findWindowsCommandMatches(command);
  return matches.length ? matches : [command];
}

async function findWindowsCommandMatches(command: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("where.exe", [command], { windowsHide: true });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function codexNpmScriptPath(command: string): string | null {
  const basename = path.basename(command).toLowerCase();
  if (!["codex", "codex.bat", "codex.cmd"].includes(basename)) return null;

  const commandDir = path.dirname(command);
  const candidates = [
    path.join(commandDir, "node_modules", "@openai", "codex", "bin", "codex.js"),
    path.join(commandDir, "..", "@openai", "codex", "bin", "codex.js"),
  ];
  return candidates.find((script) => fs.existsSync(script)) ?? null;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function isWindowsExecutableMatch(command: string): boolean {
  return [".com", ".exe"].includes(path.extname(command).toLowerCase());
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
        // Process already exited.
      }
    };
    if (process.platform === "win32") {
      // Windows kill() is forceful; give stdin EOF a brief chance to flush SQLite first.
      timers.push(setTimeout(terminate, APP_SERVER_WINDOWS_TERMINATE_DELAY_MS));
    } else {
      terminate();
    }
    timers.push(setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
      done();
    }, APP_SERVER_SHUTDOWN_TIMEOUT_MS));
    child.once("exit", done);
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
      archiveOrphanRollouts: options.archiveOrphanRollouts,
      compactRecentMetadata: options.compactRecentMetadata,
      keepLogDays: options.keepLogDays,
      keepRecentDays: options.keepRecentDays,
      keepTuiLogMib: options.keepTuiLogMib,
      maxLogBodyChars: options.maxLogBodyChars,
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
    report.databaseSpace = {
      "state_5.sqlite": collectSqliteSpaceStats(db),
    };
    report.threads = collectThreadStats(db);
    report.compactMetadataCandidates = collectCompactCandidateStats(db, {
      archivedOnly: false,
      cutoffMs,
      maxChars: options.maxChars,
      protectRecent: !options.compactRecentMetadata,
      protectedIds: allProtectedIds(protection),
    });
    report.compactMetadataCandidatesArchivedOnly = collectCompactCandidateStats(db, {
      archivedOnly: true,
      cutoffMs,
      maxChars: options.maxChars,
      protectRecent: !options.compactRecentMetadata,
      protectedIds: allProtectedIds(protection),
    });
    if (options.archiveStale) {
      report.staleArchiveCandidates = collectStaleArchiveCandidateStats(db, codexHome, {
        cutoffMs,
        protectedIds: allProtectedIds(protection),
        statRollouts: options.includeRollouts,
      });
    }
    if (options.archiveOrphanRollouts) {
      report.orphanRolloutArchiveCandidates = collectOrphanRolloutArchiveStats(db, codexHome, { cutoffMs });
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

  if ((options.includeLogs || options.pruneLogs) && fs.existsSync(logsDb)) {
    const logs = openReadonlyDb(logsDb);
    try {
      report.logs = collectLogStats(logs);
      report.logCleanupCandidates = collectLogCleanupStats(logs, options);
      const databaseSpace = asRecord(report.databaseSpace);
      databaseSpace["logs_2.sqlite"] = collectSqliteSpaceStats(logs);
      report.databaseSpace = databaseSpace;
    } finally {
      logs.close();
    }
  }

  if (options.pruneTuiLog) {
    report.tuiLogCleanupCandidates = collectTuiLogCleanupStats(
      path.join(codexHome, "log", "codex-tui.log"),
      options.keepTuiLogMib,
    );
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
      protectRecent: !options.compactRecentMetadata,
      protectedIds,
    });

    if (options.apply && Number(before.rows) > 0 && !options.confirmLossyMetadata) {
      throw new Error("--apply requires --confirm-lossy-metadata");
    }

    if (options.apply && Number(before.rows) > 0) {
      backupPath = await backupSqliteDatabase(
        stateDb,
        options.backupDir ?? path.join(codexHome, ".codex-cleanup-backups"),
      );
      const where = compactWhere({
        archivedOnly: options.archivedOnly,
        cutoffMs,
        maxChars: options.maxChars,
        protectRecent: !options.compactRecentMetadata,
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
      protectRecent: !options.compactRecentMetadata,
      protectedIds,
    });

    return {
      action: "compact-metadata",
      mode: options.apply ? "apply" : "dry-run",
      codexHome,
      generatedAt: new Date().toISOString(),
      policy: {
        archivedOnly: options.archivedOnly,
        compactRecentMetadata: options.compactRecentMetadata,
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
  if (options.apply && options.archiveStale && !options.confirmArchiveStale) {
    throw new Error("--apply with stale archiving requires --confirm-archive-stale");
  }
  if (options.apply && options.archiveOrphanRollouts && !options.confirmArchiveOrphanRollouts) {
    throw new Error("--apply with orphan rollout archiving requires --confirm-archive-orphan-rollouts");
  }
  if (options.apply && options.pruneLogs && !options.confirmPruneLogs) {
    throw new Error("--apply with log cleanup requires --confirm-prune-logs");
  }
  if (options.apply && options.pruneTuiLog && !options.confirmPruneTuiLog) {
    throw new Error("--apply with TUI log cleanup requires --confirm-prune-tui-log");
  }

  const scan = buildScanReport({ ...options, apply: false });
  const compactCandidateRows = Number(asRecord(scan.compactMetadataCandidates).rows ?? 0);
  if (options.apply && compactCandidateRows > 0 && !options.confirmLossyMetadata) {
    throw new Error("--apply requires --confirm-lossy-metadata");
  }

  if (!options.apply) {
    return {
      action: "clean",
      mode: "dry-run",
      ...scan,
    };
  }

  const archive = options.archiveStale ? await archiveStaleThreads(options) : null;
  const orphanRollouts = options.archiveOrphanRollouts ? archiveOrphanRollouts(options) : null;
  const compact = await compactMetadata(options);
  const hasStateBackup = Boolean(asRecord(archive).backupPath || asRecord(compact).backupPath);
  const stateSpace = asRecord(asRecord(scan.databaseSpace)["state_5.sqlite"]);
  const shouldVacuumState =
    Boolean(asRecord(archive).backupPath) ||
    Number(asRecord(compact).changedRows ?? 0) > 0 ||
    Number(stateSpace.free_mib ?? 0) >= STATE_VACUUM_MIN_FREE_MIB;
  const vacuum = shouldVacuumState ? await vacuumStateDatabase(options, !hasStateBackup) : null;
  const logs = options.pruneLogs ? await cleanLogs(options) : null;
  const tuiLog = options.pruneTuiLog ? await cleanTuiLog(options) : null;
  const checkpoint = await checkpointWal(options);

  return {
    action: "clean",
    mode: "apply",
    codexHome: scan.codexHome,
    generatedAt: new Date().toISOString(),
    policy: scan.policy,
    scan,
    archive,
    orphanRollouts,
    compact,
    vacuum,
    logs,
    tuiLog,
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
    appServerResult = await archiveThreadsViaCodexAppServer(
      beforePlan.archiveCallIds,
      options.codexCommand ?? "codex",
      codexHome,
    );
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

export function archiveOrphanRollouts(options: CleanerOptions): Record<string, unknown> {
  if (options.apply && !options.confirmArchiveOrphanRollouts) {
    throw new Error("--apply requires --confirm-archive-orphan-rollouts");
  }

  const codexHome = resolveCodexHome(options);
  const stateDb = path.join(codexHome, "state_5.sqlite");
  const cutoffMs = recentCutoffMs(options.keepRecentDays);
  const beforeDb = openReadonlyDb(stateDb);
  let beforePlan: OrphanRolloutPlan;
  try {
    beforePlan = buildOrphanRolloutPlan(beforeDb, codexHome, { cutoffMs });
  } finally {
    beforeDb.close();
  }

  let manifestPath: string | null = null;
  const moved: OrphanRolloutMove[] = [];
  const errors: Record<string, unknown>[] = [];
  let prunedEmptyDirs: string[] = [];

  if (options.apply && beforePlan.candidates.length) {
    const backupDir = resolveBackupDir(options, codexHome);
    manifestPath = nextOrphanRolloutManifestPath(backupDir);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeJsonFile(manifestPath, {
      action: "archive-orphan-rollouts",
      generatedAt: new Date().toISOString(),
      codexHome,
      policy: {
        keepRecentDays: options.keepRecentDays,
        recentCutoffMs: cutoffMs,
        recentCutoffUtc: millisToIso(cutoffMs),
      },
      candidates: beforePlan.candidates,
    });

    fs.mkdirSync(path.join(codexHome, "archived_sessions"), { recursive: true });
    for (const move of beforePlan.candidates) {
      try {
        assertSafeRolloutMove(codexHome, move.path, move.destination);
        if (fs.existsSync(move.destination)) {
          errors.push({ error: "destination exists", path: move.path, destination: move.destination });
          continue;
        }
        fs.renameSync(move.path, move.destination);
        moved.push(move);
      } catch (error) {
        errors.push({
          error: error instanceof Error ? error.message : String(error),
          path: move.path,
          destination: move.destination,
        });
      }
    }
    prunedEmptyDirs = pruneEmptyDirectories(path.join(codexHome, "sessions"));
    writeJsonFile(manifestPath, {
      action: "archive-orphan-rollouts",
      generatedAt: new Date().toISOString(),
      codexHome,
      policy: {
        keepRecentDays: options.keepRecentDays,
        recentCutoffMs: cutoffMs,
        recentCutoffUtc: millisToIso(cutoffMs),
      },
      moved,
      skipped: beforePlan.skipped,
      prunedEmptyDirs,
      errors,
    });
  }

  const afterDb = openReadonlyDb(stateDb);
  let afterPlan: OrphanRolloutPlan;
  try {
    afterPlan = buildOrphanRolloutPlan(afterDb, codexHome, { cutoffMs });
  } finally {
    afterDb.close();
  }

  return {
    action: "archive-orphan-rollouts",
    mode: options.apply ? "apply" : "dry-run",
    codexHome,
    generatedAt: new Date().toISOString(),
    policy: {
      keepRecentDays: options.keepRecentDays,
      recentCutoffMs: cutoffMs,
      recentCutoffUtc: millisToIso(cutoffMs),
    },
    before: beforePlan.stats,
    after: afterPlan.stats,
    movedFiles: moved.length,
    movedMib: fileMoveListSizeMib(moved),
    prunedEmptyDirs: prunedEmptyDirs.length,
    prunedEmptyDirSample: prunedEmptyDirs.slice(0, 10),
    errors: errors.slice(0, 10),
    manifestPath,
  };
}

export async function checkpointWal(options: CleanerOptions): Promise<Record<string, unknown>> {
  const codexHome = resolveCodexHome(options);
  const stateDb = path.join(codexHome, "state_5.sqlite");
  const before = fileTripletSizes(stateDb);
  let checkpointResult: unknown = null;

  if (options.apply) {
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
    backupPath: null,
  };
}

export async function vacuumStateDatabase(
  options: CleanerOptions,
  backupBeforeVacuum = true,
): Promise<Record<string, unknown>> {
  const codexHome = resolveCodexHome(options);
  const stateDb = path.join(codexHome, "state_5.sqlite");
  return vacuumSqliteDatabase({
    action: "vacuum-state",
    apply: options.apply,
    backupBeforeVacuum,
    backupDir: options.backupDir ?? path.join(codexHome, ".codex-cleanup-backups"),
    codexHome,
    dbPath: stateDb,
  });
}

export async function cleanLogs(options: CleanerOptions): Promise<Record<string, unknown>> {
  if (options.apply && !options.confirmPruneLogs) {
    throw new Error("--apply requires --confirm-prune-logs");
  }

  const codexHome = resolveCodexHome(options);
  const logsDb = path.join(codexHome, "logs_2.sqlite");
  if (!fs.existsSync(logsDb)) {
    return {
      action: "clean-logs",
      mode: options.apply ? "apply" : "dry-run",
      codexHome,
      generatedAt: new Date().toISOString(),
      exists: false,
    };
  }

  const db = openWritableDb(logsDb);
  let backupPath: string | null = null;
  let cappedRows = 0;
  let deletedRows = 0;
  try {
    const beforeFiles = fileTripletSizes(logsDb);
    const before = collectLogCleanupStats(db, options);
    const beforeSpace = collectSqliteSpaceStats(db);
    const hasRowChanges = Number(before.cap_rows) > 0 || Number(before.delete_rows) > 0;
    const shouldVacuum = Number(beforeSpace.freelist_count) > 0 || hasRowChanges;
    if (options.apply && shouldVacuum) {
      backupPath = await backupSqliteDatabase(
        logsDb,
        options.backupDir ?? path.join(codexHome, ".codex-cleanup-backups"),
      );
      const cutoffSeconds = logCutoffSeconds(options.keepLogDays);
      if (hasRowChanges) {
        const tx = db.transaction(() => {
          deletedRows = Number(
            db.prepare("DELETE FROM logs WHERE ts < @cutoffSeconds").run({ cutoffSeconds }).changes,
          );
          cappedRows = Number(
            db
              .prepare(
                `
                UPDATE logs
                SET estimated_bytes = max(0, estimated_bytes - (length(feedback_log_body) - @maxLogBodyChars)),
                    feedback_log_body = substr(feedback_log_body, 1, @maxLogBodyChars)
                WHERE ts >= @cutoffSeconds
                  AND feedback_log_body IS NOT NULL
                  AND length(feedback_log_body) > @maxLogBodyChars
              `,
              )
              .run({ cutoffSeconds, maxLogBodyChars: options.maxLogBodyChars }).changes,
          );
        });
        tx();
      }
      db.exec("VACUUM");
      queryAll(db, "PRAGMA wal_checkpoint(TRUNCATE)");
    }
    const after = collectLogCleanupStats(db, options);
    const afterSpace = collectSqliteSpaceStats(db);
    return {
      action: "clean-logs",
      mode: options.apply ? "apply" : "dry-run",
      codexHome,
      generatedAt: new Date().toISOString(),
      policy: {
        keepLogDays: options.keepLogDays,
        maxLogBodyChars: options.maxLogBodyChars,
        cutoffSeconds: logCutoffSeconds(options.keepLogDays),
        cutoffUtc: secondsToIso(logCutoffSeconds(options.keepLogDays)),
      },
      beforeFiles,
      afterFiles: fileTripletSizes(logsDb),
      before,
      after,
      beforeSpace,
      afterSpace,
      cappedRows,
      deletedRows,
      backupPath,
    };
  } finally {
    db.close();
  }
}

export async function cleanTuiLog(options: CleanerOptions): Promise<Record<string, unknown>> {
  if (options.apply && !options.confirmPruneTuiLog) {
    throw new Error("--apply requires --confirm-prune-tui-log");
  }

  const codexHome = resolveCodexHome(options);
  const logPath = path.join(codexHome, "log", "codex-tui.log");
  const before = collectTuiLogCleanupStats(logPath, options.keepTuiLogMib);
  let backupPath: string | null = null;
  let truncatedBytes = 0;

  if (options.apply && before.exists && Number(before.reclaimable_bytes) > 0) {
    backupPath = backupRegularFile(logPath, options.backupDir ?? path.join(codexHome, ".codex-cleanup-backups"));
    truncateFileToTail(logPath, Number(before.keep_bytes));
    truncatedBytes = Number(before.reclaimable_bytes);
  }

  return {
    action: "clean-tui-log",
    mode: options.apply ? "apply" : "dry-run",
    codexHome,
    generatedAt: new Date().toISOString(),
    policy: {
      keepTuiLogMib: options.keepTuiLogMib,
    },
    before,
    after: collectTuiLogCleanupStats(logPath, options.keepTuiLogMib),
    truncatedBytes,
    truncatedMib: roundMib(truncatedBytes),
    backupPath,
  };
}

export function scanBackups(options: CleanerOptions): Record<string, unknown> {
  const codexHome = resolveCodexHome(options);
  const backupDir = resolveBackupDir(options, codexHome);
  const cutoffMs = Date.now() - options.olderThanHours * 60 * 60 * 1000;
  const files = listBackupFiles(backupDir);
  const candidates = files.filter((file) => Date.parse(file.lastModified) < cutoffMs);

  return {
    action: "backups-scan",
    mode: "dry-run",
    codexHome,
    generatedAt: new Date().toISOString(),
    policy: {
      olderThanHours: options.olderThanHours,
      cutoffMs,
      cutoffUtc: millisToIso(cutoffMs),
    },
    backupDir,
    files: backupFileStats(files),
    pruneCandidates: backupFileStats(candidates),
    sample: candidates.slice(0, 10),
  };
}

export function pruneBackups(options: CleanerOptions): Record<string, unknown> {
  if (options.apply && !options.confirmDeleteBackups) {
    throw new Error("--apply requires --confirm-delete-backups");
  }

  const before = scanBackups(options);
  const candidates = backupFilesFromReport(before.pruneCandidates);
  const deleted: BackupFile[] = [];
  if (options.apply) {
    const backupDir = String(before.backupDir);
    for (const file of candidates) {
      const resolved = path.resolve(file.path);
      if (path.dirname(resolved) !== backupDir) {
        throw new Error(`Refusing to delete backup outside backup dir: ${file.path}`);
      }
      fs.unlinkSync(resolved);
      deleted.push(file);
    }
  }

  const after = scanBackups(options);
  return {
    action: "backups-prune",
    mode: options.apply ? "apply" : "dry-run",
    codexHome: before.codexHome,
    generatedAt: new Date().toISOString(),
    policy: before.policy,
    backupDir: before.backupDir,
    before: before.files,
    candidates: before.pruneCandidates,
    after: after.files,
    deleted: backupFileStats(deleted),
  };
}

export async function scheduleBackupPrune(options: CleanerOptions): Promise<Record<string, unknown>> {
  if (options.apply && !options.confirmScheduleBackupPrune) {
    throw new Error("--apply requires --confirm-schedule-backup-prune");
  }

  const codexHome = resolveCodexHome(options);
  const backupDir = resolveBackupDir(options, codexHome);
  const runAt = new Date(Date.now() + options.afterHours * 60 * 60 * 1000);
  const scheduled = await schedulePruneCommand({
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
    policy: {
      afterHours: options.afterHours,
      olderThanHours: options.olderThanHours,
      runAtUtc: runAt.toISOString(),
    },
    backupDir,
    ...scheduled,
  };
}

export function compactWhere(args: {
  archivedOnly: boolean;
  cutoffMs: number;
  maxChars: number;
  protectRecent: boolean;
  protectedIds: Set<string>;
}): CompactWhere {
  const clauses = [
    `(${THREAD_COLUMNS_TO_CAP.map((column) => `length(${column}) > @maxChars`).join(" OR ")})`,
  ];
  const params: Record<string, string | number> = {
    cutoffMs: args.cutoffMs,
    maxChars: args.maxChars,
  };

  if (args.archivedOnly) {
    clauses.push("archived = 1");
  }

  if (args.protectRecent) {
    clauses.push("(updated_at_ms < @cutoffMs OR (updated_at_ms IS NULL AND updated_at * 1000 < @cutoffMs))");
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
  args: {
    archivedOnly: boolean;
    cutoffMs: number;
    maxChars: number;
    protectRecent: boolean;
    protectedIds: Set<string>;
  },
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

export function collectLogCleanupStats(db: Database.Database, options: CleanerOptions): Record<string, unknown> {
  const params = {
    cutoffSeconds: logCutoffSeconds(options.keepLogDays),
    maxLogBodyChars: options.maxLogBodyChars,
  };
  const stats = queryOne(
    db,
    `
    SELECT
      count(*) AS rows,
      coalesce(sum(CASE WHEN ts < @cutoffSeconds THEN 1 ELSE 0 END), 0) AS delete_rows,
      coalesce(round(sum(CASE WHEN ts < @cutoffSeconds THEN estimated_bytes ELSE 0 END) / 1048576.0, 2), 0)
        AS delete_estimated_payload_mib,
      coalesce(sum(
        CASE
          WHEN ts >= @cutoffSeconds
            AND feedback_log_body IS NOT NULL
            AND length(feedback_log_body) > @maxLogBodyChars
          THEN 1
          ELSE 0
        END
      ), 0) AS cap_rows,
      coalesce(round(sum(
        CASE
          WHEN ts >= @cutoffSeconds
            AND feedback_log_body IS NOT NULL
            AND length(feedback_log_body) > @maxLogBodyChars
          THEN length(feedback_log_body) - @maxLogBodyChars
          ELSE 0
        END
      ) / 1048576.0, 2), 0) AS cap_estimated_savings_mib,
      min(ts) AS min_ts,
      max(ts) AS max_ts
    FROM logs
  `,
    params,
  );
  return {
    ...stats,
    cutoffUtc: secondsToIso(params.cutoffSeconds),
    rangeUtc: {
      max: secondsToIso(asNumberOrNull(stats.max_ts)),
      min: secondsToIso(asNumberOrNull(stats.min_ts)),
    },
  };
}

export function collectTuiLogCleanupStats(logPath: string, keepMib: number): Record<string, unknown> {
  const size = fileSize(logPath);
  const currentBytes = Number(size.bytes ?? 0);
  const keepBytes = keepMib * 1024 * 1024;
  const reclaimableBytes = Math.max(0, currentBytes - keepBytes);
  return {
    current_bytes: currentBytes,
    current_mib: roundMib(currentBytes),
    exists: Boolean(size.exists),
    keep_bytes: keepBytes,
    keep_mib: keepMib,
    path: logPath,
    reclaimable_bytes: reclaimableBytes,
    reclaimable_mib: roundMib(reclaimableBytes),
    target_mib: roundMib(currentBytes - reclaimableBytes),
  };
}

export function collectOrphanRolloutArchiveStats(
  db: Database.Database,
  codexHome: string,
  args: { cutoffMs: number },
): Record<string, unknown> {
  return buildOrphanRolloutPlan(db, codexHome, args).stats;
}

function buildOrphanRolloutPlan(
  db: Database.Database,
  codexHome: string,
  args: { cutoffMs: number },
): OrphanRolloutPlan {
  const refs = queryAll(
    db,
    "SELECT rollout_path FROM threads WHERE rollout_path IS NOT NULL AND rollout_path != ''",
  );
  const referencedPaths = new Set(refs.map((row) => normalizePath(String(row.rollout_path))));
  const sessionFiles = listRolloutFiles(path.join(codexHome, "sessions"));
  const sessionIndexIds = loadSessionIndexIds(codexHome);
  const archivedRoot = path.join(codexHome, "archived_sessions");
  const sessionsRoot = path.join(codexHome, "sessions");
  const candidates: OrphanRolloutMove[] = [];
  const skipped: OrphanRolloutMove[] = [];

  for (const file of sessionFiles) {
    if (referencedPaths.has(normalizePath(file))) continue;
    const stat = fs.statSync(file);
    const threadId = rolloutThreadId(file);
    const move: OrphanRolloutMove = {
      destination: path.join(archivedRoot, path.basename(file)),
      indexed: sessionIndexIds.has(threadId ?? ""),
      modifiedMs: stat.mtimeMs,
      path: file,
      sizeBytes: stat.size,
      threadId,
    };
    if (stat.mtimeMs >= args.cutoffMs) {
      skipped.push({ ...move, reason: "recent" });
      continue;
    }
    if (fs.existsSync(move.destination)) {
      skipped.push({ ...move, reason: "destination-exists" });
      continue;
    }
    candidates.push(move);
  }

  const candidatePaths = new Set(candidates.map((move) => normalizePath(move.path)));
  const emptyDirs = collectEmptyDirectories(sessionsRoot, candidatePaths);
  const indexed = candidates.filter((move) => move.indexed);
  const unindexed = candidates.filter((move) => !move.indexed);
  const modifiedValues = candidates.map((move) => move.modifiedMs);
  return {
    candidates,
    emptyDirs,
    skipped,
    stats: {
      empty_dir_candidates: emptyDirs.length,
      empty_dir_sample: emptyDirs.slice(0, 10),
      rows: candidates.length,
      files: candidates.length,
      size_mib: fileMoveListSizeMib(candidates),
      indexed_files: indexed.length,
      indexed_size_mib: fileMoveListSizeMib(indexed),
      unindexed_files: unindexed.length,
      unindexed_size_mib: fileMoveListSizeMib(unindexed),
      skipped_files: skipped.length,
      skipped_recent_files: skipped.filter((move) => move.reason === "recent").length,
      skipped_destination_exists_files: skipped.filter((move) => move.reason === "destination-exists").length,
      oldest_candidate_modified_utc: millisToIso(minNumberOrNull(modifiedValues)),
      newest_candidate_modified_utc: millisToIso(maxNumberOrNull(modifiedValues)),
      sample: topMoveSample(candidates),
    },
  };
}

function collectRolloutLinkage(db: Database.Database, codexHome: string): Record<string, unknown> {
  const refs = queryAll(
    db,
    "SELECT id, archived, rollout_path FROM threads WHERE rollout_path IS NOT NULL AND rollout_path != ''",
  );
  const referencedPaths = new Set(refs.map((row) => normalizePath(String(row.rollout_path))));
  const sessionFiles = listRolloutFiles(path.join(codexHome, "sessions"));
  const archivedFiles = listRolloutFiles(path.join(codexHome, "archived_sessions"));
  const diskFiles = [...sessionFiles, ...archivedFiles];
  const diskPaths = new Set(diskFiles.map((file) => normalizePath(file)));
  const missing = refs.filter((row) => !diskPaths.has(normalizePath(String(row.rollout_path))));
  const missingActive = missing.filter((row) => Number(row.archived ?? 0) !== 1);
  const missingArchived = missing.filter((row) => Number(row.archived ?? 0) === 1);
  const orphans = diskFiles.filter((file) => !referencedPaths.has(normalizePath(file)));
  const sessionOrphans = sessionFiles.filter((file) => !referencedPaths.has(normalizePath(file)));
  const archivedOrphans = archivedFiles.filter((file) => !referencedPaths.has(normalizePath(file)));
  const sessionIndexIds = loadSessionIndexIds(codexHome);
  const indexedOrphans = orphans.filter((file) => sessionIndexIds.has(rolloutThreadId(file) ?? ""));
  const unindexedOrphans = orphans.filter((file) => !sessionIndexIds.has(rolloutThreadId(file) ?? ""));
  const indexedSessionOrphans = sessionOrphans.filter((file) => sessionIndexIds.has(rolloutThreadId(file) ?? ""));
  const unindexedSessionOrphans = sessionOrphans.filter((file) => !sessionIndexIds.has(rolloutThreadId(file) ?? ""));
  return {
    archivedOrphanFiles: archivedOrphans.length,
    archivedOrphanSizeMib: fileListSizeMib(archivedOrphans),
    archivedRolloutFiles: archivedFiles.length,
    diskRolloutFiles: diskFiles.length,
    missingReferencedFiles: missing.length,
    missingActiveReferencedFiles: missingActive.length,
    missingArchivedReferencedFiles: missingArchived.length,
    missingActiveSample: missingActive.slice(0, 10),
    missingArchivedSample: missingArchived.slice(0, 10),
    missingSample: missing.slice(0, 10),
    orphanFiles: orphans.length,
    orphanIndexedFiles: indexedOrphans.length,
    orphanIndexedSizeMib: fileListSizeMib(indexedOrphans),
    orphanSizeMib: fileListSizeMib(orphans),
    orphanUnindexedFiles: unindexedOrphans.length,
    orphanUnindexedSizeMib: fileListSizeMib(unindexedOrphans),
    sessionOrphanFiles: sessionOrphans.length,
    sessionOrphanIndexedFiles: indexedSessionOrphans.length,
    sessionOrphanIndexedSizeMib: fileListSizeMib(indexedSessionOrphans),
    sessionOrphanSizeMib: fileListSizeMib(sessionOrphans),
    sessionOrphanUnindexedFiles: unindexedSessionOrphans.length,
    sessionOrphanUnindexedSizeMib: fileListSizeMib(unindexedSessionOrphans),
    sessionRolloutFiles: sessionFiles.length,
    threadRolloutRefs: refs.length,
    topOrphanSample: topFileSample(orphans),
    topSessionOrphanSample: topFileSample(sessionOrphans),
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
        ageHours: Math.round(((now - stat.mtimeMs) / 60 / 60 / 1000) * 100) / 100,
        bytes: stat.size,
        lastModified: stat.mtime.toISOString(),
        mib: roundMib(stat.size),
        name: entry.name,
        path: filePath,
      };
    })
    .sort((left, right) => Date.parse(left.lastModified) - Date.parse(right.lastModified));
}

function backupFileStats(files: BackupFile[]): Record<string, unknown> {
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return {
    count: files.length,
    files,
    newestUtc: files.length ? files[files.length - 1]?.lastModified : null,
    oldestUtc: files.length ? files[0]?.lastModified : null,
    totalBytes,
    totalMib: roundMib(totalBytes),
  };
}

function backupFilesFromReport(value: unknown): BackupFile[] {
  const files = asRecord(value).files;
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => asRecord(file))
    .filter((file) => typeof file.path === "string")
    .map((file) => ({
      ageHours: Number(file.ageHours ?? 0),
      bytes: Number(file.bytes ?? 0),
      lastModified: String(file.lastModified ?? ""),
      mib: Number(file.mib ?? 0),
      name: String(file.name ?? path.basename(String(file.path))),
      path: String(file.path),
    }));
}

async function backupSqliteDatabase(dbPath: string, backupDir: string): Promise<string> {
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = nextBackupPath(dbPath, backupDir);
  const db = openWritableDb(dbPath);
  try {
    await db.backup(backupPath);
  } finally {
    db.close();
  }
  return backupPath;
}

function backupRegularFile(filePath: string, backupDir: string): string {
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = nextFileBackupPath(filePath, backupDir);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

async function vacuumSqliteDatabase(args: {
  action: string;
  apply: boolean;
  backupBeforeVacuum: boolean;
  backupDir: string;
  codexHome: string;
  dbPath: string;
}): Promise<Record<string, unknown>> {
  const before = fileTripletSizes(args.dbPath);
  const db = openWritableDb(args.dbPath);
  let backupPath: string | null = null;
  try {
    const beforeSpace = collectSqliteSpaceStats(db);
    if (args.apply && Number(beforeSpace.freelist_count) > 0) {
      if (args.backupBeforeVacuum) {
        backupPath = await backupSqliteDatabase(args.dbPath, args.backupDir);
      }
      db.exec("VACUUM");
      queryAll(db, "PRAGMA wal_checkpoint(TRUNCATE)");
    }
    return {
      action: args.action,
      mode: args.apply ? "apply" : "dry-run",
      codexHome: args.codexHome,
      generatedAt: new Date().toISOString(),
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

export function nextBackupPath(dbPath: string, backupDir: string, now = new Date()): string {
  return nextTimestampedPath(backupDir, path.basename(dbPath), ".bak.sqlite", now);
}

export function nextFileBackupPath(filePath: string, backupDir: string, now = new Date()): string {
  return nextTimestampedPath(backupDir, path.basename(filePath), ".bak", now);
}

function nextOrphanRolloutManifestPath(backupDir: string, now = new Date()): string {
  return nextTimestampedPath(backupDir, "orphan-rollouts", ".manifest.bak", now);
}

function nextTimestampedPath(backupDir: string, name: string, suffix: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(".", "_");
  const base = `${name}.${stamp}`;
  let candidate = path.join(backupDir, `${base}${suffix}`);
  let collision = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(backupDir, `${base}.${String(collision)}${suffix}`);
    collision += 1;
  }
  return candidate;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function truncateFileToTail(filePath: string, keepBytes: number): void {
  const currentBytes = fs.statSync(filePath).size;
  if (currentBytes <= keepBytes) return;

  const fd = fs.openSync(filePath, "r+");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(TUI_LOG_COPY_CHUNK_BYTES, keepBytes));
    let readOffset = currentBytes - keepBytes;
    let writeOffset = 0;
    let remaining = keepBytes;

    while (remaining > 0) {
      const wanted = Math.min(buffer.length, remaining);
      const bytesRead = fs.readSync(fd, buffer, 0, wanted, readOffset);
      if (bytesRead <= 0) throw new Error(`Could not read log tail from ${filePath}`);
      fs.writeSync(fd, buffer, 0, bytesRead, writeOffset);
      readOffset += bytesRead;
      writeOffset += bytesRead;
      remaining -= bytesRead;
    }

    fs.ftruncateSync(fd, keepBytes);
  } finally {
    fs.closeSync(fd);
  }
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
      `$action = New-ScheduledTaskAction -Execute ${powershellSingleQuote(command.command)} -Argument ${powershellSingleQuote(
        command.args.map(quoteWindowsArgument).join(" "),
      )}`,
      `$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(${String(args.afterHours)})`,
      `Register-ScheduledTask -TaskName ${powershellSingleQuote(taskName)} -Action $action -Trigger $trigger -Description 'Delete old codex-cleaner backups by running codex-cleaner backups prune.' -Force | Out-Null`,
    ].join("\n");
    const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(`Failed to schedule backup cleanup: ${result.stderr || result.stdout}`);
    }
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
  const atAvailable = spawnSync("sh", ["-c", "command -v at"], { encoding: "utf8" }).status === 0;
  if (!atAvailable) {
    throw new Error("Cannot schedule backup cleanup: POSIX `at` is not available.");
  }
  if (!args.apply) {
    return {
      cancelCommand: "Apply the schedule command to get an atrm <job-id> cancel command.",
      command: shellCommand,
      runAtUtc: args.runAt.toISOString(),
      scheduler: "at",
      scheduled: false,
    };
  }

  const result = spawnSync("at", ["now", "+", String(args.afterHours), "hours"], {
    encoding: "utf8",
    input: `${shellCommand}\n`,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) {
    throw new Error(`Failed to schedule backup cleanup: ${combined.trim()}`);
  }
  const jobId = combined.match(/\bjob\s+(\d+)\b/i)?.[1];
  if (!jobId) {
    throw new Error(`Scheduled backup cleanup, but could not parse a cancelable at job id: ${combined.trim()}`);
  }
  return {
    cancelCommand: `atrm ${jobId}`,
    command: shellCommand,
    jobId,
    runAtUtc: args.runAt.toISOString(),
    scheduler: "at",
    scheduled: true,
  };
}

function buildBackupPruneCommand(
  codexHome: string,
  backupDir: string,
  olderThanHours: number,
): { args: string[]; command: string } {
  return {
    args: [
      currentCliPath(),
      "backups",
      "prune",
      "--codex-home",
      codexHome,
      "--backup-dir",
      backupDir,
      "--older-than-hours",
      String(olderThanHours),
      "--apply",
      "--confirm-delete-backups",
    ],
    command: process.execPath,
  };
}

function currentCliPath(): string {
  if (!process.argv[1]) throw new Error("Cannot schedule backup cleanup: current CLI path is unavailable.");
  return path.resolve(process.argv[1]);
}

function posixCommandLine(command: { args: string[]; command: string }): string {
  return [command.command, ...command.args].map(shellQuote).join(" ");
}

function windowsCommandLine(command: { args: string[]; command: string }): string {
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
      continue;
    }
    if (char === '"') {
      result += "\\".repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes);
    result += char;
    backslashes = 0;
  }
  result += "\\".repeat(backslashes * 2);
  result += '"';
  return result;
}

function timestampForName(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
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

function collectSqliteSpaceStats(db: Database.Database): Record<string, unknown> {
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

function collectEmptyDirectories(root: string, removedFilePaths = new Set<string>()): string[] {
  if (!fs.existsSync(root)) return [];
  const resolvedRoot = path.resolve(root);
  const output: string[] = [];

  const visit = (dir: string): boolean => {
    let empty = true;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!visit(full)) empty = false;
        continue;
      }
      if (entry.isFile() && removedFilePaths.has(normalizePath(full))) {
        continue;
      }
      empty = false;
    }
    if (empty && path.resolve(dir) !== resolvedRoot) {
      output.push(dir);
    }
    return empty;
  };

  visit(resolvedRoot);
  return output;
}

function pruneEmptyDirectories(root: string): string[] {
  const dirs = collectEmptyDirectories(root);
  const removed: string[] = [];
  for (const dir of dirs) {
    try {
      fs.rmdirSync(dir);
      removed.push(dir);
    } catch {
      // Directory may have been recreated or filled by a live process.
    }
  }
  return removed;
}

function topFileSample(files: string[], limit = 10): Record<string, unknown>[] {
  return [...files]
    .sort((left, right) => fs.statSync(right).size - fs.statSync(left).size)
    .slice(0, limit)
    .map((file) => ({ path: file, sizeMib: roundMib(fs.statSync(file).size), threadId: rolloutThreadId(file) }));
}

function topMoveSample(files: OrphanRolloutMove[], limit = 10): Record<string, unknown>[] {
  return [...files]
    .sort((left, right) => right.sizeBytes - left.sizeBytes)
    .slice(0, limit)
    .map((file) => ({
      destination: file.destination,
      indexed: file.indexed,
      modifiedUtc: millisToIso(file.modifiedMs),
      path: file.path,
      sizeMib: roundMib(file.sizeBytes),
      threadId: file.threadId,
    }));
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

function fileMoveListSizeMib(files: OrphanRolloutMove[]): number {
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

function assertSafeRolloutMove(codexHome: string, source: string, destination: string): void {
  const sessionsRoot = path.resolve(codexHome, "sessions");
  const archivedRoot = path.resolve(codexHome, "archived_sessions");
  const resolvedSource = path.resolve(source);
  const resolvedDestination = path.resolve(destination);
  if (!isPathInside(sessionsRoot, resolvedSource)) {
    throw new Error(`Refusing to move rollout outside sessions: ${source}`);
  }
  if (path.dirname(resolvedDestination) !== archivedRoot) {
    throw new Error(`Refusing to move rollout outside archived_sessions: ${destination}`);
  }
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
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

function logCutoffSeconds(days: number): number {
  return Math.floor(recentCutoffMs(days) / 1000);
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

  if (String(report.action).startsWith("backups-")) {
    printBackupsReport(report);
    return;
  }

  if (report.action === "clean" && report.mode === "apply") {
    printCleanApplySummary(report);
    return;
  }

  if (report.action === "archive-orphan-rollouts") {
    printOrphanRolloutSummary(report);
    return;
  }

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
  printDatabaseSpace(report.databaseSpace);

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
  printOrphanRolloutArchiveCandidate("Orphan rollout archive candidates", report.orphanRolloutArchiveCandidates);
  printLogCleanupCandidate("Log cleanup candidates", report.logCleanupCandidates);
  printTuiLogCleanupCandidate("TUI log cleanup candidate", report.tuiLogCleanupCandidates);
  if (report.action === "checkpoint-wal") {
    printWalCheckpoint(report);
  } else {
    printCandidate("Before", report.before);
    printCandidate("After", report.after);
    printArchiveCandidate("Before", report.before);
    printArchiveCandidate("After", report.after);
    printLogCleanupCandidate("Before", report.before);
    printLogCleanupCandidate("After", report.after);
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
      "missingActiveReferencedFiles",
      "missingArchivedReferencedFiles",
      "sessionRolloutFiles",
      "archivedRolloutFiles",
      "orphanFiles",
      "orphanIndexedFiles",
      "orphanUnindexedFiles",
      "orphanSizeMib",
      "orphanIndexedSizeMib",
      "orphanUnindexedSizeMib",
      "sessionOrphanFiles",
      "sessionOrphanIndexedFiles",
      "sessionOrphanUnindexedFiles",
      "sessionOrphanSizeMib",
      "archivedOrphanFiles",
      "archivedOrphanSizeMib",
    ]) {
      console.log(`  ${key}: ${String(rollouts[key])}`);
    }
  }
}

function printCleanApplySummary(report: Record<string, unknown>): void {
  const archive = asRecord(report.archive);
  const orphanRollouts = asRecord(report.orphanRollouts);
  const compact = asRecord(report.compact);
  const vacuum = asRecord(report.vacuum);
  const logs = asRecord(report.logs);
  const tuiLog = asRecord(report.tuiLog);
  const checkpoint = asRecord(report.checkpoint);

  printArchiveApplySummary(archive);
  printOrphanRolloutSummary(orphanRollouts);
  printCompactApplySummary(compact);
  printVacuumSummary("State vacuum", vacuum);
  printLogsApplySummary(logs);
  printTuiLogApplySummary(tuiLog);
  if (Object.keys(checkpoint).length) printWalCheckpoint(checkpoint);
  printBackupReminder([archive, compact, vacuum, logs, tuiLog]);
}

function printArchiveApplySummary(report: Record<string, unknown>): void {
  if (!Object.keys(report).length) return;
  const before = asRecord(report.before);
  const after = asRecord(report.after);
  const appServer = asRecord(report.appServerResult);
  console.log("\nArchive apply:");
  console.log(
    `  archive calls: requested=${String(report.requestedArchiveCalls ?? 0)} succeeded=${String(
      appServer.succeeded ?? 0,
    )} failed=${String(appServer.failed ?? 0)}`,
  );
  console.log(`  stale rows: before=${String(before.rows ?? 0)} after=${String(after.rows ?? 0)}`);
  if (Number(appServer.failed ?? 0) > 0) {
    const errors = Array.isArray(appServer.errors) ? appServer.errors.slice(0, 5) : [];
    for (const error of errors) {
      const row = asRecord(error);
      console.log(`  error: ${String(row.threadId)} ${String(row.error)}`);
    }
  }
  if (report.backupPath) console.log(`  backup: ${String(report.backupPath)}`);
}

function printOrphanRolloutSummary(report: Record<string, unknown>): void {
  if (!Object.keys(report).length) return;
  const before = asRecord(report.before);
  const after = asRecord(report.after);
  console.log("\nOrphan rollout archive:");
  console.log(`  candidates: ${String(before.files ?? 0)} files (${String(before.size_mib ?? 0)} MiB)`);
  console.log(`  indexed/unindexed: ${String(before.indexed_files ?? 0)}/${String(before.unindexed_files ?? 0)}`);
  console.log(`  skipped recent: ${String(before.skipped_recent_files ?? 0)}`);
  console.log(`  skipped destination exists: ${String(before.skipped_destination_exists_files ?? 0)}`);
  console.log(`  empty dir candidates: ${String(before.empty_dir_candidates ?? 0)}`);
  if (report.mode === "apply") {
    console.log(`  moved files: ${String(report.movedFiles ?? 0)} (${String(report.movedMib ?? 0)} MiB)`);
    console.log(`  empty dirs removed: ${String(report.prunedEmptyDirs ?? 0)}`);
    console.log(`  remaining candidates: ${String(after.files ?? 0)}`);
  }
  if (Number((report.errors as unknown[] | undefined)?.length ?? 0) > 0) {
    console.log(`  errors: ${String((report.errors as unknown[]).length)}`);
  }
  if (report.manifestPath) console.log(`  manifest: ${String(report.manifestPath)}`);
}

function printCompactApplySummary(report: Record<string, unknown>): void {
  if (!Object.keys(report).length) return;
  const before = asRecord(report.before);
  const after = asRecord(report.after);
  console.log("\nCompact apply:");
  console.log(`  changed rows: ${String(report.changedRows ?? 0)}`);
  console.log(`  candidates: before=${String(before.rows ?? 0)} after=${String(after.rows ?? 0)}`);
  console.log(`  estimated payload reduction: ${String(before.estimated_savings_mib ?? 0)} MiB`);
  if (report.backupPath) console.log(`  backup: ${String(report.backupPath)}`);
}

function printVacuumSummary(title: string, report: Record<string, unknown>): void {
  if (!Object.keys(report).length) return;
  const before = asRecord(report.before);
  const after = asRecord(report.after);
  const beforeMain = asRecord(before.main);
  const afterMain = asRecord(after.main);
  const beforeSpace = asRecord(report.beforeSpace);
  const afterSpace = asRecord(report.afterSpace);
  console.log(`\n${title}:`);
  console.log(`  main file: ${String(beforeMain.mib ?? 0)} MiB -> ${String(afterMain.mib ?? 0)} MiB`);
  console.log(`  freelist: ${String(beforeSpace.free_mib ?? 0)} MiB -> ${String(afterSpace.free_mib ?? 0)} MiB`);
  if (report.backupPath) console.log(`  backup: ${String(report.backupPath)}`);
}

function printLogsApplySummary(report: Record<string, unknown>): void {
  if (!Object.keys(report).length) return;
  const before = asRecord(report.before);
  const after = asRecord(report.after);
  const beforeFiles = asRecord(report.beforeFiles);
  const afterFiles = asRecord(report.afterFiles);
  const beforeMain = asRecord(beforeFiles.main);
  const afterMain = asRecord(afterFiles.main);
  const beforeSpace = asRecord(report.beforeSpace);
  const afterSpace = asRecord(report.afterSpace);
  console.log("\nLogs cleanup:");
  console.log(`  deleted rows: ${String(report.deletedRows ?? 0)}`);
  console.log(`  capped rows: ${String(report.cappedRows ?? 0)}`);
  console.log(`  remaining cleanup candidates: delete=${String(after.delete_rows ?? 0)} cap=${String(after.cap_rows ?? 0)}`);
  console.log(
    `  estimated savings before apply: delete=${String(before.delete_estimated_payload_mib ?? 0)} MiB cap=${String(
      before.cap_estimated_savings_mib ?? 0,
    )} MiB`,
  );
  console.log(`  logs file: ${String(beforeMain.mib ?? 0)} MiB -> ${String(afterMain.mib ?? 0)} MiB`);
  console.log(`  logs freelist: ${String(beforeSpace.free_mib ?? 0)} MiB -> ${String(afterSpace.free_mib ?? 0)} MiB`);
  if (report.backupPath) console.log(`  backup: ${String(report.backupPath)}`);
}

function printTuiLogApplySummary(report: Record<string, unknown>): void {
  if (!Object.keys(report).length) return;
  const before = asRecord(report.before);
  const after = asRecord(report.after);
  console.log("\nTUI log cleanup:");
  console.log(`  file: ${String(before.current_mib ?? 0)} MiB -> ${String(after.current_mib ?? 0)} MiB`);
  console.log(`  truncated: ${String(report.truncatedMib ?? 0)} MiB`);
  if (report.backupPath) console.log(`  backup: ${String(report.backupPath)}`);
}

function printWalCheckpoint(report: Record<string, unknown>): void {
  const before = asRecord(report.before);
  const after = asRecord(report.after);
  const beforeWal = asRecord(before.wal);
  const afterWal = asRecord(after.wal);
  console.log("\nWAL checkpoint:");
  console.log(`  wal: ${String(beforeWal.mib ?? 0)} MiB -> ${String(afterWal.mib ?? 0)} MiB`);
  console.log(`  checkpointResult: ${JSON.stringify(report.checkpointResult)}`);
}

function printBackupReminder(reports: Record<string, unknown>[]): void {
  const backupPaths = reports.map((report) => report.backupPath).filter((value) => typeof value === "string");
  if (!backupPaths.length) return;
  console.log(`\nBackups: ${path.dirname(String(backupPaths[0]))}`);
  console.log("  Keep them until Codex looks right, then delete them to reclaim disk.");
}

function printBackupsReport(report: Record<string, unknown>): void {
  console.log(`Backup dir: ${String(report.backupDir)}`);
  if (report.action === "backups-schedule-prune") {
    console.log(`Scheduler: ${String(report.scheduler)}`);
    console.log(`Scheduled: ${String(report.scheduled)}`);
    console.log(`Command: ${String(report.command)}`);
    if (report.taskName) console.log(`Task: ${String(report.taskName)}`);
    if (report.jobId) console.log(`Job: ${String(report.jobId)}`);
    if (report.cancelCommand) console.log(`Cancel: ${String(report.cancelCommand)}`);
    return;
  }

  const files = asRecord(report.files ?? report.before);
  const candidates = asRecord(report.pruneCandidates ?? report.candidates);
  console.log("\nBackups:");
  console.log(`  files: ${String(files.count ?? 0)}`);
  console.log(`  size: ${String(files.totalMib ?? 0)} MiB`);
  console.log(`  oldest: ${String(files.oldestUtc ?? null)}`);
  console.log(`  newest: ${String(files.newestUtc ?? null)}`);
  console.log("\nPrune candidates:");
  console.log(`  files: ${String(candidates.count ?? 0)}`);
  console.log(`  size: ${String(candidates.totalMib ?? 0)} MiB`);
  if (report.action === "backups-prune") {
    const deleted = asRecord(report.deleted);
    console.log("\nDeleted:");
    console.log(`  files: ${String(deleted.count ?? 0)}`);
    console.log(`  size: ${String(deleted.totalMib ?? 0)} MiB`);
  }
}

function printDatabaseSpace(value: unknown): void {
  const databases = asRecord(value);
  if (!Object.keys(databases).length) return;
  console.log("\nSQLite space:");
  for (const [name, stats] of Object.entries(databases)) {
    const record = asRecord(stats);
    console.log(
      `  ${name}: total=${String(record.total_mib ?? 0)} MiB used=${String(record.used_mib ?? 0)} MiB free=${String(
        record.free_mib ?? 0,
      )} MiB`,
    );
  }
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

function printOrphanRolloutArchiveCandidate(title: string, value: unknown): void {
  const object = asRecord(value);
  if (!Object.keys(object).length) return;
  console.log(`\n${title}:`);
  for (const key of [
    "files",
    "size_mib",
    "indexed_files",
    "unindexed_files",
    "empty_dir_candidates",
    "skipped_recent_files",
    "skipped_destination_exists_files",
    "oldest_candidate_modified_utc",
    "newest_candidate_modified_utc",
  ]) {
    if (object[key] !== undefined) console.log(`  ${key}: ${JSON.stringify(object[key])}`);
  }
}

function printLogCleanupCandidate(title: string, value: unknown): void {
  const object = asRecord(value);
  if (!Object.keys(object).length) return;
  console.log(`\n${title}:`);
  for (const key of [
    "rows",
    "delete_rows",
    "delete_estimated_payload_mib",
    "cap_rows",
    "cap_estimated_savings_mib",
    "cutoffUtc",
  ]) {
    if (object[key] !== undefined) console.log(`  ${key}: ${JSON.stringify(object[key])}`);
  }
}

function printTuiLogCleanupCandidate(title: string, value: unknown): void {
  const object = asRecord(value);
  if (!Object.keys(object).length) return;
  console.log(`\n${title}:`);
  for (const key of ["exists", "current_mib", "keep_mib", "reclaimable_mib", "path"]) {
    if (object[key] !== undefined) console.log(`  ${key}: ${JSON.stringify(object[key])}`);
  }
}
