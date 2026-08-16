import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

import {
  collectCompactCandidateStats,
  collectOrphanRolloutArchiveStats,
  collectTuiLogCleanupStats,
  collectStaleArchiveCandidateStats,
  archiveOrphanRollouts,
  archiveStaleThreads,
  checkpointWal,
  cleanCodex,
  cleanTuiLog,
  compactWhere,
  nextFileBackupPath,
  nextBackupPath,
  pruneBackups,
  resolveCodexSpawnCommand,
  resolveStoragePaths,
  rolloutThreadId,
  scanBackups,
  scheduleBackupPrune,
  truncateFileToTail,
  vacuumLogsDatabase,
} from "../src/cleaner.js";
import type { CleanerOptions } from "../src/types.js";
import { buildCleanCommand, recommendedWizardOptions } from "../src/wizard.js";

function defaultOptions(overrides: Partial<CleanerOptions> = {}): CleanerOptions {
  return {
    allowRunningReadonly: false,
    allowRunningOrphanRolloutArchive: false,
    afterHours: 48,
    apply: false,
    archiveOrphanRollouts: false,
    archiveStale: false,
    archivedOnly: false,
    compactRecentMetadata: false,
    includeLogs: false,
    includeRollouts: false,
    json: false,
    keepRecentDays: 14,
    keepTuiLogMib: 16,
    maxChars: 1024,
    olderThanHours: 48,
    pruneTuiLog: false,
    vacuumLogs: false,
    ...overrides,
  };
}

describe("recommendedWizardOptions", () => {
  test("enables the no-flag cleanup path", () => {
    const options = recommendedWizardOptions(defaultOptions());

    expect(options.apply).toBe(false);
    expect(options.allowRunningReadonly).toBe(true);
    expect(options.archiveOrphanRollouts).toBe(false);
    expect(options.archiveStale).toBe(false);
    expect(options.pruneTuiLog).toBe(false);
    expect(options.vacuumLogs).toBe(true);
  });
});

describe("rolloutThreadId", () => {
  test("extracts UUID from rollout filename", () => {
    expect(rolloutThreadId("rollout-2026-05-22T21-59-27-019e5145-7588-72b1-a304-2e190e903357.jsonl")).toBe(
      "019e5145-7588-72b1-a304-2e190e903357",
    );
  });
});

describe("compactWhere", () => {
  test("adds protected ids and archived-only guard", () => {
    const where = compactWhere({
      archivedOnly: true,
      cutoffMs: 123,
      maxChars: 1024,
      protectRecent: true,
      protectedIds: new Set(["thread-b", "thread-a"]),
    });

    expect(where.sql).toContain("length(title) > @maxChars");
    expect(where.sql).toContain("archived = 1");
    expect(where.sql).toContain("id NOT IN (@protected0, @protected1)");
    expect(where.params).toMatchObject({
      cutoffMs: 123,
      maxChars: 1024,
      protected0: "thread-a",
      protected1: "thread-b",
    });
  });
});

describe("resolveCodexSpawnCommand", () => {
  test("runs the Windows npm codex shim through node", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const script = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const shim = path.join(dir, "codex.cmd");
    try {
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, "");
      fs.writeFileSync(shim, "");

      const resolved = await resolveCodexSpawnCommand(shim, ["app-server", "--listen", "stdio://"], "win32");

      expect(resolved).toEqual({
        args: [script, "app-server", "--listen", "stdio://"],
        command: process.execPath,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runs repo-local Windows npm codex shims through node", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const nodeModules = path.join(dir, "node_modules");
    const script = path.join(nodeModules, "@openai", "codex", "bin", "codex.js");
    const shim = path.join(nodeModules, ".bin", "codex.cmd");
    try {
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.mkdirSync(path.dirname(shim), { recursive: true });
      fs.writeFileSync(script, "");
      fs.writeFileSync(shim, "");

      const resolved = await resolveCodexSpawnCommand(shim, ["app-server"], "win32");

      expect(resolved).toEqual({
        args: [script, "app-server"],
        command: process.execPath,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves non-Windows commands untouched", async () => {
    await expect(resolveCodexSpawnCommand("codex", ["app-server"], "linux")).resolves.toEqual({
      args: ["app-server"],
      command: "codex",
    });
  });

  test("refuses non-npm Windows batch commands", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    try {
      const shim = path.join(dir, "custom-codex.cmd");
      fs.writeFileSync(shim, "");

      await expect(resolveCodexSpawnCommand(shim, ["app-server"], "win32")).rejects.toThrow(
        "Refusing to wrap a Windows batch Codex command",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses an executable Windows match before rejecting an unhandled batch shim", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    try {
      const batch = path.join(dir, "codex.cmd");
      const executable = path.join(dir, "codex.exe");
      fs.writeFileSync(batch, "");
      fs.writeFileSync(executable, "");

      const resolved = await resolveCodexSpawnCommand("codex", ["app-server"], "win32", [batch, executable]);

      expect(resolved).toEqual({
        args: ["app-server"],
        command: executable,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps an earlier Windows executable ahead of a later npm shim", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    try {
      const executable = path.join(dir, "codex.exe");
      const shimDir = path.join(dir, "npm-prefix");
      const shim = path.join(shimDir, "codex.cmd");
      const script = path.join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js");
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(executable, "");
      fs.writeFileSync(shim, "");
      fs.writeFileSync(script, "");

      const resolved = await resolveCodexSpawnCommand("codex", ["app-server"], "win32", [executable, shim]);

      expect(resolved).toEqual({
        args: ["app-server"],
        command: executable,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("archiveStaleThreads", () => {
  test("overrides conflicting Codex storage for app-server mutations", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const sqliteHome = path.join(dir, "sqlite");
    const capturePath = path.join(dir, "app-server-env.json");
    const shim = path.join(dir, "codex.cmd");
    const script = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    fs.mkdirSync(sqliteHome, { recursive: true });
    const db = new DatabaseSync(path.join(sqliteHome, "state_5.sqlite"));
    try {
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(shim, "");
      fs.writeFileSync(path.join(dir, "config.toml"), "sqlite_home = 'configured-elsewhere'\n");
      fs.writeFileSync(
        script,
        `const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), sqliteHome: process.env.CODEX_SQLITE_HOME }));
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id) process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
});
`,
      );
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          archived INTEGER NOT NULL DEFAULT 0,
          archived_at INTEGER,
          rollout_path TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          updated_at_ms INTEGER,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL
        );
        CREATE TABLE thread_spawn_edges (
          parent_thread_id TEXT NOT NULL,
          child_thread_id TEXT NOT NULL PRIMARY KEY,
          status TEXT NOT NULL
        );
        INSERT INTO threads VALUES ('old-thread', 0, NULL, '', 1, 1, 'cwd', 'old');
      `);
      db.close();

      const report = await archiveStaleThreads(
        defaultOptions({ apply: true, codexCommand: shim, codexHome: dir, sqliteHome }),
      );

      expect(report.requestedArchiveCalls).toBe(1);
      expect(JSON.parse(fs.readFileSync(capturePath, "utf8"))).toEqual({
        args: ["-c", `sqlite_home=${JSON.stringify(sqliteHome)}`, "app-server", "--listen", "stdio://"],
        sqliteHome,
      });
    } finally {
      if (db.isOpen) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nextBackupPath", () => {
  test("does not reuse an existing backup name in the same millisecond", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    try {
      const now = new Date("2026-05-22T21:41:25.123Z");
      const first = nextBackupPath(path.join(dir, "state_5.sqlite"), dir, now);
      fs.writeFileSync(first, "");

      const second = nextBackupPath(path.join(dir, "state_5.sqlite"), dir, now);

      expect(path.basename(first)).toBe("state_5.sqlite.20260522T214125_123Z.bak.sqlite");
      expect(path.basename(second)).toBe("state_5.sqlite.20260522T214125_123Z.2.bak.sqlite");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("nextFileBackupPath", () => {
  test("uses a regular file backup suffix", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    try {
      const now = new Date("2026-05-22T21:41:25.123Z");
      const first = nextFileBackupPath(path.join(dir, "codex-tui.log"), dir, now);
      fs.writeFileSync(first, "");

      const second = nextFileBackupPath(path.join(dir, "codex-tui.log"), dir, now);

      expect(path.basename(first)).toBe("codex-tui.log.20260522T214125_123Z.bak");
      expect(path.basename(second)).toBe("codex-tui.log.20260522T214125_123Z.2.bak");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("storage paths", () => {
  test("uses CLI paths before config and config before CODEX_SQLITE_HOME", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    try {
      fs.writeFileSync(path.join(dir, "config.toml"), "sqlite_home = 'config-state'\nlog_dir = 'config-logs'\n");

      expect(resolveStoragePaths(defaultOptions({ codexHome: dir }), { CODEX_SQLITE_HOME: "env-state" })).toEqual({
        codexHome: dir,
        logDir: path.join(dir, "config-logs"),
        sqliteHome: path.join(dir, "config-state"),
      });

      expect(
        resolveStoragePaths(
          defaultOptions({
            codexHome: dir,
            logDir: path.join(dir, "cli-logs"),
            sqliteHome: path.join(dir, "cli-state"),
          }),
          { CODEX_SQLITE_HOME: "env-state" },
        ),
      ).toEqual({
        codexHome: dir,
        logDir: path.join(dir, "cli-logs"),
        sqliteHome: path.join(dir, "cli-state"),
      });

      fs.writeFileSync(
        path.join(dir, "config.toml"),
        "sqlite_home = { unsupported = 'value' }\nlog_dir = 'config-logs'\n",
      );
      expect(resolveStoragePaths(defaultOptions({ codexHome: dir, sqliteHome: path.join(dir, "cli-state") }))).toEqual({
        codexHome: dir,
        logDir: path.join(dir, "config-logs"),
        sqliteHome: path.join(dir, "cli-state"),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps absolute storage targets in deferred PowerShell commands", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    try {
      const sqliteHome = path.join(dir, "state's");
      const command = buildCleanCommand(
        defaultOptions({ codexHome: dir, logDir: path.join(dir, "logs"), sqliteHome, vacuumLogs: true }),
        true,
        "win32",
      );

      expect(command).toContain(`--codex-home '${dir}'`);
      expect(command).toContain(`--sqlite-home '${sqliteHome.replaceAll("'", "''")}'`);
      expect(command).toContain(`--log-dir '${path.join(dir, "logs")}'`);
      expect(command).toContain("--vacuum-logs");
      expect(command).toMatch(/ --apply$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("logs vacuum", () => {
  test("reclaims free pages without changing Codex-owned log rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const dbPath = path.join(dir, "logs_2.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
      const insert = db.prepare("INSERT INTO logs (body) VALUES (?)");
      for (let index = 0; index < 20; index += 1) insert.run("x".repeat(50_000));
      db.exec("DELETE FROM logs WHERE id > 1");
      const sizeBefore = fs.statSync(dbPath).size;
      db.close();

      const report = await vacuumLogsDatabase(defaultOptions({ apply: true, codexHome: dir }));

      const after = new DatabaseSync(dbPath);
      try {
        expect(after.prepare("SELECT count(*) AS rows FROM logs").get()).toEqual({ rows: 1 });
        expect(fs.statSync(dbPath).size).toBeLessThan(sizeBefore);
        expect(fs.existsSync(String(report.backupPath))).toBe(true);
      } finally {
        after.close();
      }
    } finally {
      if (db.isOpen) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TUI log cleanup", () => {
  test("estimates and keeps only the newest log tail", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const logDir = path.join(dir, "log");
    const logPath = path.join(logDir, "codex-tui.log");
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(logPath, "0123456789");

      const stats = collectTuiLogCleanupStats(logPath, 1);
      expect(stats.current_bytes).toBe(10);
      expect(stats.reclaimable_bytes).toBe(0);

      truncateFileToTail(logPath, 4);
      expect(fs.readFileSync(logPath, "utf8")).toBe("6789");

      fs.writeFileSync(logPath, Buffer.concat([Buffer.alloc(1024 * 1024, "a"), Buffer.from("tail")]));
      const report = await cleanTuiLog(
        defaultOptions({
          apply: true,
          codexHome: dir,
          keepTuiLogMib: 1,
          pruneTuiLog: true,
        }),
      );

      expect(fs.statSync(logPath).size).toBe(1024 * 1024);
      expect(fs.readFileSync(logPath).subarray(-4).toString()).toBe("tail");
      expect(fs.existsSync(String(report.backupPath))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkpointWal", () => {
  test("backs up state_5.sqlite before applying checkpoint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const dbPath = path.join(dir, "state_5.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE state (id INTEGER PRIMARY KEY)");
      db.close();

      const report = await checkpointWal(defaultOptions({ apply: true, codexHome: dir }));

      expect(typeof report.backupPath).toBe("string");
      expect(fs.existsSync(String(report.backupPath))).toBe(true);
    } finally {
      if (db.isOpen) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("backup pruning", () => {
  test("rejects scheduled prune timings that cannot delete backups", async () => {
    await expect(scheduleBackupPrune(defaultOptions({ afterHours: 1, olderThanHours: 48 }))).rejects.toThrow(
      "--after-hours must be greater than or equal to --older-than-hours",
    );
  });

  test("scheduled backup pruning applies without extra confirmation flags", async () => {
    const report = await scheduleBackupPrune(defaultOptions());

    expect(report.command).toContain("--apply");
    expect(report.command).not.toContain("--confirm-");
  });

  test("clean apply schedules pruning when only the checkpoint creates a backup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const dbPath = path.join(dir, "state_5.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          archived INTEGER NOT NULL DEFAULT 0,
          archived_at INTEGER,
          rollout_path TEXT,
          created_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          updated_at_ms INTEGER,
          source TEXT,
          agent_role TEXT,
          cwd TEXT,
          title TEXT,
          preview TEXT,
          first_user_message TEXT
        )
      `);
      db.close();

      const report = await cleanCodex(
        defaultOptions({
          afterHours: 1,
          apply: true,
          archiveStale: false,
          codexHome: dir,
          olderThanHours: 48,
        }),
      );

      expect((report.checkpoint as Record<string, unknown>).backupPath).toEqual(expect.any(String));
      expect(report.backupPruneSchedule).toMatchObject({
        action: "backups-schedule-prune",
        mode: "apply",
        scheduled: false,
      });
      expect(String((report.backupPruneSchedule as Record<string, unknown>).error)).toContain(
        "--after-hours must be greater than or equal to --older-than-hours",
      );
    } finally {
      if (db.isOpen) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dry-runs and deletes only old codex-cleaner backup files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const backupDir = path.join(dir, ".codex-cleanup-backups");
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const oldBackup = path.join(backupDir, "state_5.sqlite.20260522T214125_123Z.bak.sqlite");
      const oldManifest = path.join(backupDir, "orphan-rollouts.20260522T214125_123Z.manifest.bak");
      const newBackup = path.join(backupDir, "codex-tui.log.20260522T214125_123Z.bak");
      const ignored = path.join(backupDir, "notes.txt");
      fs.writeFileSync(oldBackup, "old backup");
      fs.writeFileSync(oldManifest, "old manifest");
      fs.writeFileSync(newBackup, "new backup");
      fs.writeFileSync(ignored, "not ours");
      const oldDate = new Date(Date.now() - 50 * 60 * 60 * 1000);
      fs.utimesSync(oldBackup, oldDate, oldDate);
      fs.utimesSync(oldManifest, oldDate, oldDate);

      const scan = scanBackups(
        defaultOptions({
          backupDir,
          codexHome: dir,
        }),
      );

      expect((scan.files as Record<string, unknown>).count).toBe(3);
      expect((scan.pruneCandidates as Record<string, unknown>).count).toBe(2);

      const report = pruneBackups(
        defaultOptions({
          apply: true,
          backupDir,
          codexHome: dir,
        }),
      );

      expect((report.deleted as Record<string, unknown>).count).toBe(2);
      expect(fs.existsSync(oldBackup)).toBe(false);
      expect(fs.existsSync(oldManifest)).toBe(false);
      expect(fs.existsSync(newBackup)).toBe(true);
      expect(fs.existsSync(ignored)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectCompactCandidateStats", () => {
  test("ignores recent, protected, and already-small rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const dbPath = path.join(dir, "state_5.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          archived INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          updated_at_ms INTEGER,
          source TEXT,
          agent_role TEXT,
          cwd TEXT,
          title TEXT,
          preview TEXT,
          first_user_message TEXT
        )
      `);
      const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      insert.run("old-big", 0, 1, 1000, "cli", null, "cwd", "x".repeat(20), "y".repeat(5), "z".repeat(30));
      insert.run("old-protected", 0, 1, 1000, "cli", null, "cwd", "x".repeat(20), "y", "z");
      insert.run("recent-big", 0, 1, 999999, "cli", null, "cwd", "x".repeat(20), "y", "z");
      insert.run("old-short", 0, 1, 1000, "cli", null, "cwd", "x", "y", "z");

      const stats = collectCompactCandidateStats(db, {
        archivedOnly: false,
        cutoffMs: 5000,
        maxChars: 10,
        protectRecent: true,
        protectedIds: new Set(["old-protected"]),
      });

      expect(stats.rows).toBe(1);
      expect(stats.max_field_chars).toBe(30);

      const statsWithRecent = collectCompactCandidateStats(db, {
        archivedOnly: false,
        cutoffMs: 5000,
        maxChars: 10,
        protectRecent: false,
        protectedIds: new Set(["old-protected"]),
      });

      expect(statsWithRecent.rows).toBe(2);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectStaleArchiveCandidateStats", () => {
  test("plans safe archive roots without pulling in recent descendants", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const sessions = path.join(dir, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const dbPath = path.join(dir, "state_5.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          archived INTEGER NOT NULL DEFAULT 0,
          archived_at INTEGER,
          rollout_path TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          updated_at_ms INTEGER,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL
        );
        CREATE TABLE thread_spawn_edges (
          parent_thread_id TEXT NOT NULL,
          child_thread_id TEXT NOT NULL PRIMARY KEY,
          status TEXT NOT NULL
        );
      `);
      const writeRollout = (id: string, size: number): string => {
        const file = path.join(sessions, `rollout-2026-05-01T00-00-00-${id}.jsonl`);
        fs.writeFileSync(file, "x".repeat(size));
        return file;
      };
      const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      insert.run("old-root", 0, null, writeRollout("old-root", 100), 1, 1000, "cwd", "old root");
      insert.run("old-child", 0, null, writeRollout("old-child", 50), 1, 1000, "cwd", "old child");
      insert.run("recent-child", 0, null, writeRollout("recent-child", 25), 1, 9000, "cwd", "recent child");
      insert.run("old-leaf", 0, null, writeRollout("old-leaf", 10), 1, 1000, "cwd", "old leaf");
      insert.run("protected-old", 0, null, writeRollout("protected-old", 10), 1, 1000, "cwd", "protected");
      insert.run("archived-old", 1, 2, writeRollout("archived-old", 10), 1, 1000, "cwd", "archived");
      db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run("old-root", "recent-child", "closed");
      db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run("old-root", "old-child", "closed");

      const stats = collectStaleArchiveCandidateStats(db, dir, {
        cutoffMs: 5000,
        protectedIds: new Set(["protected-old"]),
        statRollouts: true,
      });

      expect(stats.rows).toBe(3);
      expect(stats.archive_call_rows).toBe(2);
      expect(stats.expected_archived_rows).toBe(2);
      expect(stats.blocked_by_descendant_safety).toBe(1);
      expect(stats.missing_rollout_files).toBe(0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("orphan rollout archiving", () => {
  test("moves only old DB-unreferenced session rollouts into archived_sessions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const sessions = path.join(dir, "sessions", "2026", "03", "26");
    const archived = path.join(dir, "archived_sessions");
    const dbPath = path.join(dir, "state_5.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      fs.mkdirSync(sessions, { recursive: true });
      fs.mkdirSync(archived, { recursive: true });
      const emptySessionDir = path.join(dir, "sessions", "2026", "02", "01");
      const emptyArchivedDir = path.join(archived, "empty-child");
      fs.mkdirSync(emptySessionDir, { recursive: true });
      fs.mkdirSync(emptyArchivedDir, { recursive: true });
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");

      const referencedId = "00000000-0000-4000-8000-000000000001";
      const oldOrphanId = "00000000-0000-4000-8000-000000000002";
      const recentOrphanId = "00000000-0000-4000-8000-000000000003";
      const collisionOrphanId = "00000000-0000-4000-8000-000000000004";
      const indexedOrphanId = "00000000-0000-4000-8000-000000000005";
      const protectedOrphanId = "00000000-0000-4000-8000-000000000006";
      const rollout = (id: string): string => path.join(sessions, `rollout-2026-03-26T00-00-00-${id}.jsonl`);
      const referenced = rollout(referencedId);
      const oldOrphan = rollout(oldOrphanId);
      const recentOrphan = rollout(recentOrphanId);
      const collisionOrphan = rollout(collisionOrphanId);
      const indexedOrphan = rollout(indexedOrphanId);
      const protectedOrphan = rollout(protectedOrphanId);
      for (const file of [referenced, oldOrphan, recentOrphan, collisionOrphan, indexedOrphan, protectedOrphan]) {
        fs.writeFileSync(file, `{"type":"session_meta","payload":{"id":"${rolloutThreadId(file)}"}}\n`);
      }
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      for (const file of [referenced, oldOrphan, collisionOrphan, indexedOrphan, protectedOrphan]) {
        fs.utimesSync(file, oldDate, oldDate);
      }
      fs.writeFileSync(
        path.join(dir, ".codex-global-state.json"),
        JSON.stringify({ "pinned-thread-ids": [protectedOrphanId] }),
      );
      fs.writeFileSync(path.join(archived, path.basename(collisionOrphan)), "already archived");
      fs.writeFileSync(
        path.join(dir, "session_index.jsonl"),
        `${JSON.stringify({ id: indexedOrphanId, thread_name: "indexed orphan", updated_at: oldDate.toISOString() })}\n`,
      );
      db.prepare("INSERT INTO threads VALUES (?, ?)").run(referencedId, referenced);

      const cutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const stats = collectOrphanRolloutArchiveStats(db, dir, { cutoffMs, protectedIds: new Set([protectedOrphanId]) });
      expect(stats.files).toBe(1);
      expect(stats.indexed_files).toBe(0);
      expect(stats.skipped_recent_files).toBe(1);
      expect(stats.skipped_protected_files).toBe(1);
      expect(stats.skipped_session_indexed_files).toBe(1);
      expect(stats.skipped_destination_exists_files).toBe(1);
      expect(Number(stats.empty_dir_candidates)).toBeGreaterThanOrEqual(1);
      db.close();

      const report = archiveOrphanRollouts(
        defaultOptions({
          apply: true,
          archiveOrphanRollouts: true,
          codexHome: dir,
        }),
      );

      expect(report.movedFiles).toBe(1);
      expect(fs.existsSync(oldOrphan)).toBe(false);
      expect(fs.existsSync(path.join(archived, path.basename(oldOrphan)))).toBe(true);
      expect(fs.existsSync(recentOrphan)).toBe(true);
      expect(fs.existsSync(collisionOrphan)).toBe(true);
      expect(fs.existsSync(indexedOrphan)).toBe(true);
      expect(fs.existsSync(protectedOrphan)).toBe(true);
      expect(fs.existsSync(emptySessionDir)).toBe(false);
      expect(fs.existsSync(emptyArchivedDir)).toBe(true);
      expect(Number(report.prunedEmptyDirs)).toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(String(report.manifestPath))).toBe(true);
    } finally {
      if (db.isOpen) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
