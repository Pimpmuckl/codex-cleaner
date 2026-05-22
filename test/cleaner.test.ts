import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  collectCompactCandidateStats,
  collectLogCleanupStats,
  collectStaleArchiveCandidateStats,
  compactWhere,
  nextBackupPath,
  resolveCodexSpawnCommand,
  rolloutThreadId,
} from "../src/cleaner.js";

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

describe("collectLogCleanupStats", () => {
  test("counts old rows separately from oversized retained log bodies", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const db = new Database(path.join(dir, "logs_2.sqlite"));
    try {
      db.exec(`
        CREATE TABLE logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          ts_nanos INTEGER NOT NULL,
          level TEXT NOT NULL,
          target TEXT NOT NULL,
          feedback_log_body TEXT,
          module_path TEXT,
          file TEXT,
          line INTEGER,
          thread_id TEXT,
          process_uuid TEXT,
          estimated_bytes INTEGER NOT NULL DEFAULT 0
        )
      `);
      const insert = db.prepare(
        "INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, estimated_bytes) VALUES (?, 0, 'INFO', 'target', ?, ?)",
      );
      insert.run(100, "old body".repeat(100), 1000);
      insert.run(Math.floor(Date.now() / 1000), "x".repeat(50), 50);
      insert.run(Math.floor(Date.now() / 1000), "y".repeat(200000), 200000);

      const stats = collectLogCleanupStats(db, {
        allowRunningReadonly: false,
        apply: false,
        archiveStale: true,
        archivedOnly: false,
        confirmArchiveStale: false,
        compactRecentMetadata: false,
        confirmLossyMetadata: false,
        confirmPruneLogs: false,
        includeLogs: true,
        includeRollouts: false,
        json: false,
        keepLogDays: 7,
        keepRecentDays: 14,
        maxChars: 1024,
        maxLogBodyChars: 100,
        pruneLogs: true,
      });

      expect(stats.delete_rows).toBe(1);
      expect(stats.cap_rows).toBe(1);
      expect(stats.cap_estimated_savings_mib).toBeGreaterThan(0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("collectCompactCandidateStats", () => {
  test("ignores recent, protected, and already-small rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cleaner-"));
    const dbPath = path.join(dir, "state_5.sqlite");
    const db = new Database(dbPath);
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
    const db = new Database(dbPath);
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
