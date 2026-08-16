export type BackupCommand = "scan" | "prune" | "schedule-prune";

export type CleanerCommand =
  | "scan"
  | "clean"
  | "compact-metadata"
  | "checkpoint-wal"
  | "archive-orphan-rollouts"
  | "backups";

export type CleanerOptions = {
  allowRunningOrphanRolloutArchive: boolean;
  allowRunningReadonly: boolean;
  afterHours: number;
  archiveOrphanRollouts: boolean;
  archiveStale: boolean;
  apply: boolean;
  archivedOnly: boolean;
  backupDir?: string;
  codexCommand?: string;
  codexHome?: string;
  compactRecentMetadata: boolean;
  includeLogs: boolean;
  includeRollouts: boolean;
  json: boolean;
  keepRecentDays: number;
  keepTuiLogMib: number;
  logDir?: string;
  maxChars: number;
  olderThanHours: number;
  pruneTuiLog: boolean;
  sqliteHome?: string;
  vacuumLogs: boolean;
};

export type BlockingProcess = {
  pid: number;
  name: string;
  commandLine: string;
};

export type ThreadProtection = {
  pinnedIds: Set<string>;
  heartbeatIds: Set<string>;
  activeGoalIds: Set<string>;
};

export type CompactWhere = {
  sql: string;
  params: Record<string, string | number>;
};
