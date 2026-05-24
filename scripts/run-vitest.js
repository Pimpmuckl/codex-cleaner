import { spawnSync } from "node:child_process";

const sqliteWarningFlag = "--disable-warning=ExperimentalWarning";
const nodeOptions = process.env.NODE_OPTIONS ?? "";
const env = {
  ...process.env,
  NODE_OPTIONS: nodeOptions.includes(sqliteWarningFlag) ? nodeOptions : `${sqliteWarningFlag} ${nodeOptions}`.trim(),
};

const result = spawnSync(process.execPath, ["./node_modules/vitest/vitest.mjs", "run"], {
  env,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
