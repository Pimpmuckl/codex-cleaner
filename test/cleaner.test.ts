import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test, vi } from "vitest";

import {
  archivedDeleteThreadIds,
  buildScanReport,
  checkpointWal,
  cleanCodex,
  collectArchivedDeleteCandidateStats,
  emitReport,
  mutateThreadsViaCodexAppServer,
  nextBackupPath,
  pruneBackups,
  resolveCodexSpawnCommand,
  resolveStoragePaths,
  scanBackups,
  scheduleBackupPrune,
  vacuumLogsDatabase,
} from "../src/cleaner.js";
import type { CleanerOptions } from "../src/types.js";
import { buildCleanCommand } from "../src/wizard.js";

function defaultOptions(overrides: Partial<CleanerOptions> = {}): CleanerOptions {
  return {
    afterHours: 48,
    apply: false,
    json: false,
    keepDays: 90,
    mode: "cleanup",
    olderThanHours: 48,
    ...overrides,
  };
}

function createStateDb(dir: string): DatabaseSync {
  const db = new DatabaseSync(path.join(dir, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      updated_at_ms INTEGER,
      source TEXT,
      agent_role TEXT,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      preview TEXT,
      first_user_message TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      thread_section_id TEXT
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'closed'
    );
  `);
  return db;
}

function createFakeCodex(dir: string): string {
  const scriptBody = `#!/usr/bin/env node
const fs = require("node:fs");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.id) {
        fs.appendFileSync(process.env.CODEX_CLEANER_CAPTURE, JSON.stringify(message) + "\\n");
        const response = message.method === "thread/delete" && process.env.CODEX_CLEANER_FAIL_DELETE === "1"
          ? { id: message.id, error: { message: "forced delete failure" } }
          : { id: message.id, result: {} };
        process.stdout.write(JSON.stringify(response) + "\\n");
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;
  if (process.platform === "win32") {
    const script = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const command = path.join(dir, "codex.cmd");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, scriptBody);
    fs.writeFileSync(command, "");
    return command;
  }
  const command = path.join(dir, "fake-codex");
  fs.writeFileSync(command, scriptBody, { mode: 0o755 });
  return command;
}

describe("resolveCodexSpawnCommand", () => {
  test("runs Windows npm Codex shims through node", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const script = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const shim = path.join(dir, "codex.cmd");
    try {
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, "");
      fs.writeFileSync(shim, "");

      await expect(resolveCodexSpawnCommand(shim, ["app-server"], "win32")).resolves.toEqual({
        args: [script, "app-server"],
        command: process.execPath,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses an executable match before rejecting a batch shim", async () => {
    await expect(
      resolveCodexSpawnCommand("codex", ["app-server"], "win32", ["C:\\tools\\codex.cmd", "C:\\tools\\codex.exe"]),
    ).resolves.toEqual({ args: ["app-server"], command: "C:\\tools\\codex.exe" });
  });

  test("rejects unowned Windows batch wrappers", async () => {
    await expect(
      resolveCodexSpawnCommand("custom", ["app-server"], "win32", ["C:\\tools\\custom.cmd"]),
    ).rejects.toThrow("Refusing to wrap a Windows batch Codex command");
  });

  test("leaves non-Windows commands untouched", async () => {
    await expect(resolveCodexSpawnCommand("codex", ["app-server"], "linux")).resolves.toEqual({
      args: ["app-server"],
      command: "codex",
    });
  });
});

describe("native thread deletion", () => {
  test("sends thread/delete with the documented threadId parameter", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const capture = path.join(dir, "requests.jsonl");
    try {
      const command = createFakeCodex(dir);
      const originalCapture = process.env.CODEX_CLEANER_CAPTURE;
      process.env.CODEX_CLEANER_CAPTURE = capture;
      try {
        const report = await mutateThreadsViaCodexAppServer(
          "thread/delete",
          ["019e5145-7588-72b1-a304-2e190e903357"],
          command,
          dir,
          dir,
        );
        expect(report).toMatchObject({ requested: 1, succeeded: 1, failed: 0 });
      } finally {
        if (originalCapture === undefined) delete process.env.CODEX_CLEANER_CAPTURE;
        else process.env.CODEX_CLEANER_CAPTURE = originalCapture;
      }

      const requests = fs
        .readFileSync(capture, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(requests.at(-1)).toMatchObject({
        method: "thread/delete",
        params: { threadId: "019e5145-7588-72b1-a304-2e190e903357" },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cleanup modes", () => {
  test("normal cleanup never plans or applies history deletion", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const db = createStateDb(dir);
    try {
      db.prepare(
        "INSERT INTO threads (id, archived, archived_at, rollout_path, updated_at, updated_at_ms, cwd, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("archived-old", 1, 1, path.join(dir, "old.jsonl"), 1, 1000, dir, "old");
      db.exec("CREATE TABLE ballast (body TEXT); INSERT INTO ballast VALUES (zeroblob(3000000)); DELETE FROM ballast");
      db.close();

      const options = defaultOptions({ afterHours: 1, apply: true, codexHome: dir, olderThanHours: 48 });
      expect(buildScanReport({ ...options, apply: false }).deletePlan).toBeNull();
      const report = await cleanCodex(options);
      expect(report.deletePlan).toBeNull();
      expect(report.deleteApply).toBeNull();
      expect(report.ok).toBe(false);

      const after = new DatabaseSync(path.join(dir, "state_5.sqlite"), { readOnly: true });
      try {
        expect(after.prepare("SELECT count(*) AS rows FROM threads").get()).toEqual({ rows: 1 });
      } finally {
        after.close();
      }
    } finally {
      if (db.isOpen) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("full cleanup reports failure when a native deletion is rejected", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const db = createStateDb(dir);
    const capture = path.join(dir, "requests.jsonl");
    const originalCapture = process.env.CODEX_CLEANER_CAPTURE;
    const originalFail = process.env.CODEX_CLEANER_FAIL_DELETE;
    try {
      const threadId = "019e5145-7588-72b1-a304-2e190e903357";
      const rollout = path.join(dir, `${threadId}.jsonl`);
      fs.writeFileSync(rollout, "rollout");
      db.prepare(
        "INSERT INTO threads (id, archived, archived_at, rollout_path, updated_at, updated_at_ms, cwd, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(threadId, 1, 1, rollout, 1, 1000, dir, "old");
      db.close();
      process.env.CODEX_CLEANER_CAPTURE = capture;
      process.env.CODEX_CLEANER_FAIL_DELETE = "1";

      const report = await cleanCodex(
        defaultOptions({
          afterHours: 1,
          apply: true,
          codexCommand: createFakeCodex(dir),
          codexHome: dir,
          mode: "full",
          olderThanHours: 48,
        }),
      );

      expect(report.ok).toBe(false);
      expect(report.deleteApply).toMatchObject({ requested: 1, succeeded: 0, failed: 1 });
    } finally {
      if (originalCapture === undefined) delete process.env.CODEX_CLEANER_CAPTURE;
      else process.env.CODEX_CLEANER_CAPTURE = originalCapture;
      if (originalFail === undefined) delete process.env.CODEX_CLEANER_FAIL_DELETE;
      else process.env.CODEX_CLEANER_FAIL_DELETE = originalFail;
      if (db.isOpen) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("full cleanup selects only safe top-level archived trees", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const db = createStateDb(dir);
    const insert = db.prepare(
      "INSERT INTO threads (id, archived, archived_at, rollout_path, updated_at, updated_at_ms, cwd, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const add = (id: string, archived: number, archivedAtSeconds: number, exists = true): void => {
      const rollout = path.join(dir, `${id}.jsonl`);
      if (exists) fs.writeFileSync(rollout, id);
      insert.run(id, archived, archived ? archivedAtSeconds : null, rollout, 1, 1000, dir, id);
    };
    const edge = db.prepare("INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id) VALUES (?, ?)");
    try {
      add("safe-root", 1, 1000);
      add("safe-child", 1, 1000);
      edge.run("safe-root", "safe-child");
      add("missing-root", 1, 1000, false);
      add("recent-root", 1, 1000);
      add("recent-child", 1, Math.floor(Date.now() / 1000));
      edge.run("recent-root", "recent-child");
      add("active-root", 1, 1000);
      add("active-child", 0, 1000);
      edge.run("active-root", "active-child");
      add("protected-root", 1, 1000);
      add("protected-child", 1, 1000);
      db.prepare("UPDATE threads SET is_pinned = 1 WHERE id = ?").run("protected-child");
      edge.run("protected-root", "protected-child");

      const args = { cutoffMs: 5_000_000, protectedIds: new Set(["protected-child"]) };
      expect(archivedDeleteThreadIds(db, dir, args)).toEqual(["safe-root", "missing-root"]);
      expect(collectArchivedDeleteCandidateStats(db, dir, args)).toMatchObject({
        deleteCalls: 2,
        expectedDeletedThreads: 3,
        missingRolloutFiles: 1,
        blockedByDescendantSafety: 3,
      });

      const scan = buildScanReport(defaultOptions({ codexHome: dir, mode: "full" }));
      expect(scan.protection).toMatchObject({ pinnedThreads: 1 });
      expect(scan.deletePlan).toMatchObject({ deleteCalls: 2, expectedDeletedThreads: 3 });

      db.exec("DROP TABLE thread_spawn_edges");
      expect(() => archivedDeleteThreadIds(db, dir, args)).toThrow("no such table: thread_spawn_edges");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("full cleanup fails closed when active goals cannot be read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const state = createStateDb(dir);
    const goals = new DatabaseSync(path.join(dir, "goals_1.sqlite"));
    try {
      state.close();
      goals.exec("CREATE TABLE unexpected (id TEXT)");
      goals.close();

      expect(() => buildScanReport(defaultOptions({ codexHome: dir, mode: "full" }))).toThrow(
        "Cannot verify active-goal protection",
      );
      expect(buildScanReport(defaultOptions({ codexHome: dir })).deletePlan).toBeNull();
    } finally {
      if (state.isOpen) state.close();
      if (goals.isOpen) goals.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deferred commands preserve explicit paths, mode, retention, and apply flags", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    try {
      const normal = buildCleanCommand(defaultOptions({ codexHome: dir }), true, "win32");
      expect(normal).not.toContain("--full");
      expect(normal).not.toContain("--keep-days");
      expect(normal).toMatch(/ --apply$/);

      const backupDir = path.join(dir, "custom backups");
      const full = buildCleanCommand(
        defaultOptions({ backupDir, codexCommand: "custom-codex", codexHome: dir, keepDays: 120, mode: "full" }),
        true,
        "win32",
      );
      expect(full).toContain(`--backup-dir '${backupDir}'`);
      expect(full).toContain("--codex-command 'custom-codex'");
      expect(full).toContain("--full --keep-days 120 --apply");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("storage paths", () => {
  test("uses CLI paths before config and config before CODEX_SQLITE_HOME", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    try {
      fs.writeFileSync(path.join(dir, "config.toml"), "sqlite_home = 'config-state'\n");
      expect(resolveStoragePaths(defaultOptions({ codexHome: dir }), { CODEX_SQLITE_HOME: "env-state" })).toEqual({
        codexHome: dir,
        sqliteHome: path.join(dir, "config-state"),
      });

      const cliState = path.join(dir, "cli-state");
      expect(resolveStoragePaths(defaultOptions({ codexHome: dir, sqliteHome: cliState }))).toEqual({
        codexHome: dir,
        sqliteHome: cliState,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves relative CODEX_SQLITE_HOME from the current directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    try {
      expect(resolveStoragePaths(defaultOptions({ codexHome: dir }), { CODEX_SQLITE_HOME: "relative/sqlite" })).toEqual(
        {
          codexHome: dir,
          sqliteHome: path.resolve("relative/sqlite"),
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("database maintenance", () => {
  test("vacuum reclaims free log pages without changing live rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const dbPath = path.join(dir, "logs_2.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA page_size=65536; CREATE TABLE logs (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
      const insert = db.prepare("INSERT INTO logs (body) VALUES (?)");
      for (let index = 0; index < 18; index += 1) insert.run("x".repeat(50_000));
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
  }, 30_000);

  test("checkpoint backs up state before truncating a real WAL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const dbPath = path.join(dir, "state_5.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE state (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO state (body) VALUES ('live')",
      );
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
      const report = await checkpointWal(defaultOptions({ apply: true, codexHome: dir }));
      expect(fs.existsSync(String(report.backupPath))).toBe(true);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("backups", () => {
  test("does not reuse an existing backup name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    try {
      const now = new Date("2026-05-22T21:41:25.123Z");
      const first = nextBackupPath(path.join(dir, "state_5.sqlite"), dir, now);
      fs.writeFileSync(first, "");
      expect(path.basename(nextBackupPath(path.join(dir, "state_5.sqlite"), dir, now))).toBe(
        "state_5.sqlite.20260522T214125_123Z.2.bak.sqlite",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a schedule that runs before files become eligible", async () => {
    await expect(scheduleBackupPrune(defaultOptions({ afterHours: 1, olderThanHours: 48 }))).rejects.toThrow(
      "--after-hours must be greater than or equal to --older-than-hours",
    );
  });

  test("human output includes backup schedule and cancellation details", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      emitReport(
        {
          action: "backups-schedule-prune",
          mode: "apply",
          scheduled: true,
          policy: { runAtUtc: "2026-08-18T12:00:00.000Z" },
          command: "codex-cleaner backups prune --apply",
          cancelCommand: "schtasks /Delete /TN codex-cleaner-prune /F",
        },
        false,
      );
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("Scheduled: true");
      expect(output).toContain("Runs: 2026-08-18T12:00:00.000Z");
      expect(output).toContain("Cancel: schtasks /Delete");

      emitReport(
        {
          action: "clean",
          mode: "apply",
          maintenance: {},
          backups: {
            policy: { runAtUtc: "2026-08-18T12:00:00.000Z" },
            cancelCommand: "schtasks /Delete /TN codex-cleaner-prune /F",
          },
        },
        false,
      );
      expect(log.mock.calls.flat().join("\n")).toContain("Cancel backup cleanup: schtasks /Delete");
    } finally {
      log.mockRestore();
    }
  });

  test("dry-runs and deletes only old codex-cleaner backup files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const backupDir = path.join(dir, ".codex-cleanup-backups");
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const oldBackup = path.join(backupDir, "state_5.sqlite.20260522T214125_123Z.bak.sqlite");
      const recentBackup = path.join(backupDir, "logs_2.sqlite.20260522T214125_123Z.bak.sqlite");
      const ignored = path.join(backupDir, "notes.txt");
      for (const file of [oldBackup, recentBackup, ignored]) fs.writeFileSync(file, file);
      const oldDate = new Date(Date.now() - 50 * 3_600_000);
      fs.utimesSync(oldBackup, oldDate, oldDate);

      expect(
        (scanBackups(defaultOptions({ backupDir, codexHome: dir })).pruneCandidates as Record<string, unknown>).count,
      ).toBe(1);
      const report = pruneBackups(defaultOptions({ apply: true, backupDir, codexHome: dir }));
      expect((report.deleted as Record<string, unknown>).count).toBe(1);
      expect(fs.existsSync(oldBackup)).toBe(false);
      expect(fs.existsSync(recentBackup)).toBe(true);
      expect(fs.existsSync(ignored)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports failed backup deletion as unsuccessful", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const backupDir = path.join(dir, ".codex-cleanup-backups");
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const oldBackup = path.join(backupDir, "state_5.sqlite.20260522T214125_123Z.bak.sqlite");
      fs.writeFileSync(oldBackup, "backup");
      const oldDate = new Date(Date.now() - 50 * 3_600_000);
      fs.utimesSync(oldBackup, oldDate, oldDate);
      const remove = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
        throw new Error("locked");
      });
      try {
        const report = pruneBackups(defaultOptions({ apply: true, backupDir, codexHome: dir }));
        expect(report.ok).toBe(false);
        expect(report.errors).toEqual([{ path: oldBackup, error: "locked" }]);
      } finally {
        remove.mockRestore();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
