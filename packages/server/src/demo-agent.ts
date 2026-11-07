import { setTimeout as sleep } from "node:timers/promises";
import { type FakeAgent, fakeLauncher, type RunnerLauncher } from "@turtle/core";

/**
 * A scripted agent for `turtle ui --demo-agent`: no model, no credentials. It works slowly
 * enough to watch. For a plain run, the prompt picks the ending: a question ("?", "ask",
 * "which") ends in need_decision, "fail" ends blocked with failing tests, anything else
 * ends done. For a task run it uses the task-graph tools (see graphDemo).
 */
export function demoLauncher(stepMs = 900): RunnerLauncher {
  return fakeLauncher(async (a) => {
    const pause = () => Promise.race([sleep(stepMs), a.waitForInterrupt()]);
    if (a.options.graphTools) return graphDemo(a, pause);
    const task = (a.prompt.trim().split("\n").at(-1) ?? "task").trim();
    const short = task.length > 50 ? `${task.slice(0, 49)}…` : task;
    const slug = slugify(task);

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

/**
 * The demo agent on a task: plans (for a planner task), or works in small steps,
 * recording findings with evidence, decisions and a brief, asking when the title asks,
 * and following any message the human sends while it works.
 */
async function graphDemo(a: FakeAgent, pause: () => Promise<unknown>): Promise<void> {
  // A continued run gets an instruction or the answers instead of the task prompt; the
  // graph tool still names the task.
  const view = await a.graph("read");
  const title =
    /^# Your task: (.+)$/m.exec(a.prompt)?.[1]?.trim() ??
    /^Your task: (.+?) \[/m.exec(view.message)?.[1]?.trim() ??
    "the task";
  const goal = /^## Goal\n(.+)$/m.exec(a.prompt)?.[1]?.trim() ?? "the goal";
  const slug = slugify(title);
  let heard = 0;
  const listen = async () => {
    while (heard < a.instructions.length) {
      const msg = a.instructions[heard++] as string;
      await a.say(`(demo agent) Got your message: "${msg}". Adjusting.`);
      await a.graph("decision", { text: `Following the user's message: ${msg}` });
      await a.writeFile(`notes/${slug}-followup.md`, `Asked for: ${msg}\n`);
      await a.edit(`notes/${slug}-followup.md`, `Asked for: ${msg}\nDone in the demo.\n`);
    }
  };

  await a.say(`(demo agent, no model is called) Working on: ${title}`);
  await pause();

  if (/Split the goal into tasks/.test(a.prompt)) {
    const explore = await a.graph("task", {
      op: "create",
      title: `Explore options for: ${goal}`,
      body: "List 2–3 ways to do it, with trade-offs.",
    });
    await pause();
    const build = await a.graph("task", {
      op: "create",
      title: "Build a first version",
      body: "Pick the simplest option and make it work end to end.",
      dependsOn: [explore.id],
    });
    await pause();
    await a.graph("task", {
      op: "create",
      title: "Check the result: which parts should we keep?",
      body: "Compare the result with the goal and ask what to keep.",
      dependsOn: [build.id],
    });
    await a.graph("decision", {
      text: "Plan: explore, build the simplest version, then check it",
      rationale: "Small steps keep the cost low and the record readable.",
    });
    await a.graph("brief", {
      text: "Planned 3 tasks: explore → build → check. They start as their dependencies finish.",
    });
    await a.finish("Planned.");
    return;
  }

  const continuing = !a.prompt.trimStart().startsWith("# Your task");
  await a.edit(`notes/${slug}.md`, `# ${title}\n\nStep 1: looked at what exists.\n`);
  await listen();
  await pause();
  await a.tool(
    "Bash",
    { command: `ls notes && wc -l notes/${slug}.md` },
    { response: { stdout: "1 file" } },
  );
  await listen();
  await pause();
  await a.writeFile(`results/${slug}.csv`, "metric,value\nruns,3\nscore,0.87\n");
  await a.edit(
    `notes/${slug}.md`,
    `# ${title}\n\nStep 1: looked at what exists.\nStep 2: measured it (results/${slug}.csv).\n`,
  );
  await a.graph("finding", {
    text: `Measured a score of 0.87 over 3 runs for "${title}"`,
    evidence: [{ path: `results/${slug}.csv` }],
  });
  await listen();
  await pause();

  if (!continuing && /\?|\bwhich\b|\bshould\b/i.test(title)) {
    await a.checkpoint(`First pass on ${title}`, "progress");
    await a.graph("brief", {
      text: "Status: waiting for your decision. Measured 0.87 (evidence: results CSV). Open: which option to keep.",
    });
    await a.graph("question", {
      text: "Two options fit. Keep the simple one, or try the faster one?",
      options: ["Keep the simple one", "Try the faster one"],
    });
    await a.finish("Which option should I keep?");
    return;
  }
  if (/fail|wrong/i.test(title)) {
    await a.graph("finding", {
      text: "This approach does not hold up: the result does not repeat on new data",
    });
    await a.checkpoint(`${title}: does not work`, "blocked");
    await a.graph("brief", {
      text: "Status: blocked. The approach does not repeat on new data. Consider abandoning it and keeping the lesson.",
    });
    await a.finish("This approach does not work.");
    return;
  }
  await a.graph("decision", { text: `Keep the simple version of ${title}` });
  await a.edit(`notes/${slug}.md`, `# ${title}\n\nDone. Score 0.87 over 3 runs.\n`);
  await listen();
  await pause();
  await a.checkpoint(`${title}: done`, "done");
  await a.graph("brief", {
    text: `Status: done. Score 0.87 over 3 runs (evidence: results/${slug}.csv). No open questions.`,
  });
  let more = await a.finish("Done.");
  while (more) {
    await listen();
    await a.checkpoint(`Follow-up on ${title}`, "done");
    more = await a.finish("Done, including your follow-up.");
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30) || "task"
  );
}
