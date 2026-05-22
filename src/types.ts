export type CleanerCommand = "scan" | "clean" | "compact-metadata" | "checkpoint-wal";

export type CleanerOptions = {
  allowRunningReadonly: boolean;
  archiveStale: boolean;
  apply: boolean;
  archivedOnly: boolean;
  backupDir?: string;
  codexCommand?: string;
  codexHome?: string;
  confirmArchiveStale: boolean;
  confirmLossyMetadata: boolean;
  includeLogs: boolean;
  includeRollouts: boolean;
  json: boolean;
  keepRecentDays: number;
  maxChars: number;
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
