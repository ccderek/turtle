import { setTimeout as sleep } from "node:timers/promises";
import { fakeLauncher, type RunnerLauncher } from "@turtle/core";

/**
 * A scripted agent for `turtle ui --demo-agent`: no model, no credentials. It works slowly
 * enough to watch, and its prompt picks the ending: a question ("?", "ask", "which") ends
 * in need_decision, "fail" ends blocked with failing tests, anything else ends done.
 */
export function demoLauncher(stepMs = 900): RunnerLauncher {
  return fakeLauncher(async (a) => {
    const pause = () => Promise.race([sleep(stepMs), a.waitForInterrupt()]);
    const task = (a.prompt.trim().split("\n").at(-1) ?? "task").trim();
    const short = task.length > 50 ? `${task.slice(0, 49)}…` : task;
    const slug =
      task
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 30) || "task";

    await a.say(`(demo agent, no model is called) Working on: ${short}`);
    await pause();
    await a.tool("Glob", { pattern: "**/*" }, { response: "README.md\nsrc/" });
    await pause();
    await a.edit(`notes/${slug}.md`, `# ${task}\n\n1. Outline the change.\n`);
    await pause();
    await a.tool("Bash", { command: "npm test" }, { response: { stdout: "3 passed" } });
    await pause();
    await a.checkpoint(`Outline: ${short}\n\nWrote notes/${slug}.md with a first plan.`);
    await pause();
    await a.say("Now the implementation.");
    await a.edit(
      `src/${slug}.js`,
      `export function run() {\n  return ${JSON.stringify(task)};\n}\n`,
    );
    await pause();
    await a.edit(
      `notes/${slug}.md`,
      `# ${task}\n\n1. Outline the change.\n2. Implemented in src/${slug}.js.\n`,
    );
    await pause();
    if (/fail/i.test(task)) {
      await a.tool("Bash", { command: "npm test" }, { response: "1 failed", failed: true });
      await pause();
      await a.checkpoint(`Tests fail after ${short}`, "blocked");
      await a.finish("I'm blocked: the tests fail and I need help.");
    } else if (/\?|\bask\b|\bwhich\b|\bshould\b/i.test(task)) {
      await a.checkpoint("Should the output be JSON or plain text?", "need_decision");
      await a.finish("Should the output be JSON or plain text? Answer to continue.");
    } else {
      await a.tool("Bash", { command: "npm test" }, { response: { stdout: "4 passed" } });
      await pause();
      await a.checkpoint(`Implement ${short}\n\nAdded src/${slug}.js; tests pass.`, "done");
      await a.finish("Done.");
    }
  });
}
