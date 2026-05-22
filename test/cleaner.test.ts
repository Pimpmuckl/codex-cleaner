import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  collectCompactCandidateStats,
  collectStaleArchiveCandidateStats,
  compactWhere,
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
        protectedIds: new Set(["old-protected"]),
      });

      expect(stats.rows).toBe(1);
      expect(stats.max_field_chars).toBe(30);
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
