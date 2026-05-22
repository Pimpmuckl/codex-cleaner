export type CleanerCommand = "scan" | "clean" | "compact-metadata" | "checkpoint-wal";

export type CleanerOptions = {
  allowRunningReadonly: boolean;
  archiveStale: boolean;
  apply: boolean;
  archivedOnly: boolean;
  backupDir?: string;
  codexCommand?: string;
  codexHome?: string;
  compactRecentMetadata: boolean;
  confirmArchiveStale: boolean;
  confirmLossyMetadata: boolean;
  confirmPruneLogs: boolean;
  includeLogs: boolean;
  includeRollouts: boolean;
  json: boolean;
  keepLogDays: number;
  keepRecentDays: number;
  maxLogBodyChars: number;
  maxChars: number;
  pruneLogs: boolean;
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
