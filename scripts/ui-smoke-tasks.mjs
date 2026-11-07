// Drives the task-graph view end to end in headless Chromium against the offline demo
// (seeded trading graph, scripted agent, no API key) and saves screenshots.
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
const card = (title) =>
  page.locator(".task-card").filter({ has: page.locator(".row1 .title", { hasText: title }) });
const badge = (title, label) =>
  card(title).locator(".badge", { hasText: new RegExp(`^${label}$`) });
const long = { timeout: 60_000 };

try {
  step("home: the trading goal with the abandoned approach and its lesson");
  await page.goto(url);
  await page.waitForSelector(".goal-card");
  await page.waitForSelector(".leaf-kind.lesson");
  await shot("01-graph");

  step("the lesson on the investment signal");
  await page.locator(".leaf.leaf-lesson").first().click();
  await page.waitForSelector(".tasks-panel");
  await shot("02-lesson");

  step("approach B starts on its own; tell it something while it works");
  await badge("Approach B", "running").waitFor(long);
  await card("Approach B").click();
  await page.locator(".tasks-panel textarea").first().fill("Also log every trade to a CSV");
  await page.locator(".tasks-panel button[type=submit]").first().click();
  await page.waitForSelector(".leaf-text:text('Following the user\\'s message')", long);
  await shot("03-told");

  step("the tasks that depend on B run in turn; the last one asks you");
  await page.waitForSelector(".need-card", long);
  await shot("04-needs-you");

  step("answer and the agent continues");
  await page.locator(".need-card").first().click();
  await page.locator(".ask-box .actions-row button").first().click();
  await badge("Go live", "done").waitFor(long);
  await shot("05-answered");

  step("a new goal: the planner splits it into tasks");
  await page.getByLabel("Close panel").click();
  await page.getByRole("button", { name: "New goal" }).first().click();
  await page.locator("#goal-title").fill("Measure a model's power on a phone");
  await page.locator("dialog button[type=submit]").click();
  await card("Explore options").waitFor(long);
  await badge("Check the result", "needs you").waitFor({ timeout: 120_000 });
  await shot("06-planned");

  step("abandon a task and keep the lesson; try another way");
  await card("Build a first version").click();
  await page.getByRole("button", { name: "Abandon…" }).click();
  await page.getByRole("button", { name: "Abandon and keep the lesson" }).click();
  await badge("Build a first version", "abandoned.*").waitFor(long);
  await shot("07-abandoned");

  step("dark mode and a phone-sized screen");
  await page.getByLabel("Close panel").click();
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("08-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("09-phone");
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
