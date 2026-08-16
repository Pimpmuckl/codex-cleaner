export type BackupCommand = "scan" | "prune" | "schedule-prune";

export type CleanerCommand = "scan" | "clean" | "backups";
export type CleanupMode = "cleanup" | "full";

export type CleanerOptions = {
  afterHours: number;
  apply: boolean;
  backupDir?: string;
  codexCommand?: string;
  codexHome?: string;
  json: boolean;
  keepDays: number;
  mode: CleanupMode;
  olderThanHours: number;
  sqliteHome?: string;
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
