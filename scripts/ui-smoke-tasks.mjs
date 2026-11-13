// Drives the task-graph view end to end in headless Chromium against the offline demo
// (the seeded trading graph, then the phone scenario of architecture §3.1; scripted
// agent, no API key) and saves screenshots.
// Usage: pnpm build && pnpm ui:smoke:tasks [outDir]
// Needs a global Playwright with Chromium (npm i -g playwright && npx playwright install chromium).
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  console.error("playwright not found: npm i -g playwright && npx playwright install chromium");
  process.exit(1);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const out = resolve(process.argv[2] ?? join(tmpdir(), "turtle-ui-smoke-tasks"));
await mkdir(out, { recursive: true });

const child = spawn(
  process.execPath,
  [join(root, "scripts/demo.mjs"), "--ui", "--no-open", "--port", "0"],
  { stdio: ["ignore", "pipe", "inherit"] },
);
const url = await new Promise((ok, fail) => {
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    process.stdout.write(d);
    const m = /turtle ui\s+(http:\/\/\S+)/.exec(buf);
    if (m) ok(m[1]);
  });
  child.on("exit", () => fail(new Error("demo exited early")));
  setTimeout(() => fail(new Error("timeout waiting for turtle ui")), 60_000);
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));
const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`  screenshot ${name}.png`);
};
const step = (s) => console.log(`- ${s}`);
// Map cards (the default layout) and outline cards, by title.
const card = (title) =>
  page.locator(".map-task").filter({ has: page.locator(".map-title", { hasText: title }) });
const open = (title) => card(title).locator(".map-task-main").click();
const badge = (title, label) =>
  card(title).locator(".badge", { hasText: new RegExp(`^${label}$`) });
const tab = (name) =>
  page.locator(".panel-tabs").getByRole("tab", { name: new RegExp(`^${name}`) });
const closePanel = () => page.getByLabel("Close panel").click();
const long = { timeout: 60_000 };

try {
  step("home: the trading goal as a mind map, with the abandoned approach and its lesson");
  await page.goto(url);
  await page.waitForSelector(".map-goal");
  await page.waitForSelector(".map-leaf.leaf-lesson");
  await shot("01-map");

  step("dependencies light up for the card under the pointer");
  await card("Schedule").hover();
  if ((await page.locator(".dep-edge.on").count()) < 1)
    throw new Error("no highlighted dependency");
  await shot("02-dependencies");

  step("approach B starts on its own; tell it something while it works");
  await badge("Approach B", "running").waitFor(long);
  await open("Approach B");
  await page.locator(".tasks-panel textarea").first().fill("Also log every trade to a CSV");
  await page.locator(".tasks-panel button[type=submit]").first().click();
  await page
    .locator(".tasks-panel .kid-list", { hasText: "Following the user's message" })
    .waitFor(long);
  await shot("03-told");

  step("the tasks that depend on B run in turn; the last one asks you; answer by option");
  await page.locator(".need-card", { hasText: "Two options fit" }).waitFor(long);
  await page.locator(".need-card", { hasText: "Two options fit" }).click();
  await page.locator(".ask-box .actions-row button").first().click();
  await badge("Go live", "done").waitFor(long);
  await closePanel();

  step("the lesson's check judged B: it failed once, the agent fixed the work, B passed");
  await page.waitForSelector(".map-leaf.leaf-check");
  await card("Approach B").locator(".badge", { hasText: "✓ checks" }).waitFor(long);
  await open("Approach B");
  await page.locator(".tasks-panel .check-row.ok").waitFor(long);
  await shot("04-check-passed");
  await page.locator(".tasks-panel .check-row .link").first().click();
  await page.locator(".tasks-panel .check-script").waitFor(long);
  await shot("05-check");
  await closePanel();

  step("the phone scenario: a new goal, and the planner splits it into 5 tasks");
  await page.getByRole("button", { name: "New goal" }).first().click();
  await page.locator("#goal-title").fill("Measure power and performance of model A on a phone");
  await page.locator("dialog button[type=submit]").click();
  await card("Measure power and performance").waitFor(long);
  await page
    .locator(".map-task", { hasText: "Measure power and performance" })
    .locator(".map-sub", { hasText: "waiting for" })
    .waitFor(long);
  await shot("06-phone-plan");

  step("setup tasks run in parallel; measuring waits for all three, then asks you");
  await page.locator(".need-card", { hasText: "sampling rate" }).waitFor({ timeout: 120_000 });
  await shot("07-phone-question");
  await page.locator(".need-card", { hasText: "sampling rate" }).click();
  await page.locator(".ask-box .actions-row button", { hasText: "10 kHz" }).click();
  await badge("Measure power and performance", "done").waitFor(long);

  step("the task panel: outputs (the CSV), conversation, checkpoints");
  await open("Measure power and performance");
  await tab("Outputs").click();
  await page.locator("table.csv th", { hasText: "power_mw" }).waitFor(long);
  await shot("08-outputs");
  await tab("Conversation").click();
  await page.locator(".task-live .tool").first().waitFor(long);
  await tab("Code").click();
  await page.locator(".cp-row").first().waitFor(long);
  await shot("09-checkpoints");

  step("the compile step is hardened: its recipe was verified by a clean replay");
  await card("Compile model A").locator(".badge", { hasText: "hardened" }).waitFor(long);
  await open("Compile model A");
  await page.locator(".tasks-panel .recipe-card.state-verified").waitFor(long);
  await shot("09b-recipe");

  step(
    "replay it for model B: the recipe fails, an agent fixes only that, the new recipe verifies",
  );
  await page.getByRole("button", { name: "Replay with…" }).click();
  await page.locator(".tasks-panel input[id$=-MODEL]").fill("B");
  await page.locator(".replay-form button[type=submit]").click();
  await badge("(MODEL=B)", "done").waitFor({ timeout: 120_000 });
  await open("(MODEL=B)");
  await page.locator(".tasks-panel .replay-info.replay-bad").waitFor(long);
  await page.locator(".tasks-panel .recipe-card.state-verified").waitFor(long);
  await shot("09c-replay-repaired");
  await closePanel();

  step("model B from the environment: a new task that starts from a checkpoint");
  await open(/^Compile model A for the phone$/);
  await page
    .locator(".tasks-panel input[id^=here-]")
    .fill("Compile model B with the new toolchain");
  await page.locator(".tasks-panel input[id^=here-] + button").click();
  await card("Compile model B").locator(".mono-badge").waitFor(long);
  await badge("Compile model B", "done").waitFor(long);
  await shot("10-model-b");

  step("abandon a task and keep the lesson");
  await open("Compile model B");
  await page.getByRole("button", { name: "Abandon…" }).click();
  await page
    .locator(".tasks-panel textarea[id^=lesson-]")
    .fill("The new toolchain needs the vendor's NPU driver; check the driver first.");
  await page.getByRole("button", { name: "Abandon and keep the lesson" }).click();
  await badge("Compile model B", "abandoned.*").waitFor(long);
  await page.locator(".map-leaf.leaf-lesson", { hasText: "NPU driver" }).waitFor(long);
  await closePanel();
  await shot("11-abandoned");

  step("harden that lesson into a check from the browser");
  await page.locator(".map-leaf.leaf-lesson", { hasText: "NPU driver" }).click();
  await page.getByRole("button", { name: "Enforce with a check…" }).click();
  await page
    .locator(".tasks-panel textarea[id^=check-script-]")
    .fill('import pathlib, sys\nsys.exit(0 if pathlib.Path("notes").is_dir() else 1)\n');
  await page.getByRole("button", { name: "Add check" }).click();
  await page.locator(".tasks-panel .check-script").waitFor(long);
  if ((await page.locator(".map-leaf.leaf-check").count()) < 2)
    throw new Error("the new check is not on the map");
  await shot("12-enforced");
  await closePanel();

  step("share the phone goal as a file and judge it; the gate");
  await page.locator(".map-goal", { hasText: "Measure power and performance" }).click();
  await page.getByRole("button", { name: "Share as a file…" }).click();
  await page.locator(".share-dialog a.button", { hasText: "Download" }).waitFor(long);
  for (const box of await page.locator(".share-dialog .judge input[type=checkbox]").all())
    await box.check();
  await shot("12b-share");
  await page.getByRole("button", { name: "Record my judgment" }).click();
  await page.locator(".share-dialog").waitFor({ state: "detached", timeout: 10_000 });
  await closePanel();
  await page.getByRole("button", { name: "Gate", exact: true }).click();
  await page.locator(".gate-dialog .gate-group").first().waitFor(long);
  await page.waitForFunction(
    () =>
      /Exports judged clear[\s\S]*?1 of 1/.test(
        document.querySelector(".gate-dialog")?.textContent ?? "",
      ),
    undefined,
    long,
  );
  await shot("12c-gate");
  await page.keyboard.press("Escape");

  step("the outline layout, dark mode and a phone-sized screen");
  await page.getByRole("button", { name: "Outline" }).click();
  await page.waitForSelector(".outline-row");
  await shot("13-outline");
  await page.getByRole("button", { name: "Map" }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("14-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForSelector(".outline-row");
  await shot("15-phone");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (overflow > 0) throw new Error(`page scrolls horizontally by ${overflow}px on a phone`);

  if (errors.length) throw new Error(`browser errors:\n${errors.join("\n")}`);
  console.log(`ok: screenshots in ${out}`);
} catch (err) {
  await page.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser.close();
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5000).unref();
}
