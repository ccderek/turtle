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
    const plan = /phone|power|device/i.test(goal) ? PHONE_PLAN : GENERIC_PLAN(goal);
    const ids: string[] = [];
    for (const t of plan.tasks) {
      const r = await a.graph("task", {
        op: "create",
        title: t.title,
        body: t.body,
        ...(t.after.length ? { dependsOn: t.after.map((i) => ids[i]) } : {}),
      });
      ids.push(r.id ?? "");
      await pause();
    }
    await a.graph("decision", { text: plan.decision, rationale: plan.rationale });
    await a.graph("brief", { text: plan.brief });
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
  const measuring = /measure/i.test(title);
  await a.writeFile(
    `results/${slug}.csv`,
    measuring
      ? "run,power_mw,latency_ms,fps\n1,812,23.4,41.2\n2,798,23.1,41.6\n3,805,23.6,40.9\n"
      : "metric,value\nruns,3\nscore,0.87\n",
  );
  await a.edit(
    `notes/${slug}.md`,
    `# ${title}\n\nStep 1: looked at what exists.\nStep 2: measured it (results/${slug}.csv).\n`,
  );
  await a.graph("finding", {
    text: measuring
      ? "Average 805 mW and 23.4 ms per frame over 3 runs"
      : `Measured a score of 0.87 over 3 runs for "${title}"`,
    evidence: [{ path: `results/${slug}.csv` }],
  });
  await listen();
  await pause();

  // The task's own text (before the first "## " section) may say what to ask.
  const own = a.prompt.split("\n\n## ")[0] ?? "";
  const ask = /Ask the user: (.+?)(?: \((.+)\))?$/m.exec(own);
  if (!continuing && (ask || /\?|\bwhich\b|\bshould\b/i.test(title))) {
    const text = ask?.[1] ?? "Two options fit. Keep the simple one, or try the faster one?";
    const options = ask
      ? (ask[2]?.split(" / ") ?? [])
      : ["Keep the simple one", "Try the faster one"];
    await a.checkpoint(`First pass on ${title}`, "progress");
    await a.graph("brief", {
      text: `Status: waiting for your decision. First results are in (evidence: results CSV). Open: ${text}`,
    });
    await a.graph("question", { text, ...(options.length ? { options } : {}) });
    await a.finish(text);
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

interface Plan {
  tasks: { title: string; body: string; after: number[] }[];
  decision: string;
  rationale: string;
  brief: string;
}

function GENERIC_PLAN(goal: string): Plan {
  return {
    tasks: [
      {
        title: `Explore options for: ${goal}`,
        body: "List 2–3 ways to do it, with trade-offs.",
        after: [],
      },
      {
        title: "Build a first version",
        body: "Pick the simplest option and make it work end to end.",
        after: [0],
      },
      {
        title: "Check the result: which parts should we keep?",
        body: "Compare the result with the goal and ask what to keep.",
        after: [1],
      },
    ],
    decision: "Plan: explore, build the simplest version, then check it",
    rationale: "Small steps keep the cost low and the record readable.",
    brief: "Planned 3 tasks: explore → build → check. They start as their dependencies finish.",
  };
}

/** The phone measurement scenario (architecture §3.1). */
const PHONE_PLAN: Plan = {
  tasks: [
    {
      title: "Connect the phone and set up the environment",
      body: "Write a script that connects to the phone over adb, checks the battery and thermal state, and installs the benchmark app.",
      after: [],
    },
    {
      title: "Compile model A for the phone",
      body: "Compile model A with the phone's toolchain and keep the build script.",
      after: [],
    },
    {
      title: "Write the test plan",
      body: "Which inputs, how many runs, warm-up, and what counts as a result.",
      after: [],
    },
    {
      title: "Record a trace during a run",
      body: "Capture a system trace of one benchmark run with the environment script.",
      after: [0],
    },
    {
      title: "Measure power and performance on the phone",
      body: "Run the plan on the phone, read the power rail and parse the data into a CSV.\nAsk the user: Which sampling rate should the power monitor use? (1 kHz / 10 kHz)",
      after: [0, 1, 2],
    },
  ],
  decision: "Plan: environment, compile and test plan in parallel, then trace and measure",
  rationale: "The three setup tasks do not depend on each other; measuring needs all of them.",
  brief:
    "Planned 5 tasks. Environment, compile and test plan run in parallel; the trace waits for the environment; measuring waits for all three.",
};
