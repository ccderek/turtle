import { mkdir } from "node:fs/promises";
import { childProcessTransport, type RunnerLauncher } from "./transport.js";

/**
 * `none` sandbox: the runner is a child process on the host with the workspace as cwd
 * (docs/phase0-spec.md §11). `runnerCommand` is e.g. ["node", "/path/to/runner/main.js"].
 */
export function noneLauncher(runnerCommand: readonly string[]): RunnerLauncher {
  const [command, ...args] = runnerCommand;
  if (!command) throw new Error("runner command is empty");
  return async (spec) => {
    await mkdir(spec.claudeConfigDir, { recursive: true });
    return childProcessTransport(command, args, {
      cwd: spec.workspace,
      env: { ...process.env, ...spec.env, CLAUDE_CONFIG_DIR: spec.claudeConfigDir },
      logFile: spec.logFile,
    });
  };
}
