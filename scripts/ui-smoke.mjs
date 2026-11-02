// Drives the web UI end to end in headless Chromium against the offline demo (scripted
// agent, no API key) and saves screenshots. Usage: pnpm build && pnpm ui:smoke [outDir]
// Needs a global Playwright with Chromium (npm i -g playwright && npx playwright install chromium).
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Playwright is not a dependency of turtle: use a global install (npm i -g playwright).
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  console.error("playwright not found: npm i -g playwright && npx playwright install chromium");
  process.exit(1);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const out = resolve(process.argv[2] ?? join(tmpdir(), "turtle-ui-smoke"));
await mkdir(out, { recursive: true });

const child = spawn(
  process.execPath,
  [join(root, "scripts/demo.mjs"), "--ui", "--no-open", "--port", "0"],
  {
    stdio: ["ignore", "pipe", "inherit"],
  },
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
  setTimeout(() => fail(new Error("timeout waiting for turtle ui")), 30_000);
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));
const shot = async (name) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`  screenshot ${name}.png`);
};
const step = (s) => console.log(`- ${s}`);

try {
  step("home: tree and attention queue");
  await page.goto(url);
  await page.waitForSelector(".row");
  await page.waitForSelector(".conn.live");
  await shot("01-home");

  step("open the blocked checkpoint from the attention queue");
  await page.locator(".card.attn .card-main").first().click();
  await page.waitForSelector(".panel .node-title");
  await page.waitForSelector(".tab-body .diff, .tab-body p:text('No file changes')");
  await shot("02-node-detail");

  step("start a new run from the browser");
  await page.getByRole("button", { name: "New run" }).click();
  await page.locator("dialog textarea").fill("Add a CSV export. Which delimiter should I use?");
  await page.getByRole("button", { name: "Start run" }).click();
  await page.waitForSelector(".panel .live .tool");
  await page.waitForTimeout(2500);
  await shot("03-live-run");

  step("the agent asks a question → attention queue");
  await page.waitForSelector(".card.attn .kind:text('Question')", { timeout: 30_000 });
  await shot("04-question");

  step("answer it");
  await page.locator(".card.attn", { hasText: "Question" }).locator(".card-main").click();
  await page.waitForSelector(".panel .composer textarea");
  await page
    .locator(".panel .composer textarea")
    .fill("Use commas, and quote fields that contain them.");
  await page.locator(".panel .composer button[type=submit]").click();
  await page.waitForSelector(".panel .live .working");
  await page.waitForSelector(".chip.ok", { timeout: 30_000 });
  await shot("05-answered");

  step("fork from an earlier checkpoint");
  await page.locator(".row", { hasText: "Outline: Add a CSV export" }).first().click();
  await page.getByRole("tab", { name: "Fork from here" }).click();
  await page.locator(".panel .composer textarea").fill("Try a TSV export instead");
  await page.locator(".panel .composer button[type=submit]").click();
  await page.waitForSelector(".panel .live .tool");
  await page.waitForFunction(() => document.querySelectorAll(".chip.run").length === 0, undefined, {
    timeout: 30_000,
  });
  await page.keyboard.press("Escape");
  await shot("06-forked-tree");

  step("stop a running agent");
  await page.getByRole("button", { name: "New run" }).click();
  await page.locator("dialog textarea").fill("A long refactor");
  await page.getByRole("button", { name: "Start run" }).click();
  await page.waitForSelector(".panel .live .tool");
  await page.getByRole("button", { name: "Stop agent" }).click();
  await page.waitForSelector(".panel .badge.mute", { timeout: 20_000 });
  await shot("07-stopped");

  step("show every step (micro snapshots)");
  await page.keyboard.press("Escape");
  await page.getByLabel("Show steps").check();
  await page.waitForSelector(".row.kind-micro");
  await shot("08-steps");
  await page.getByLabel("Show steps").uncheck();

  step("dark mode and a phone-sized screen");
  await page.emulateMedia({ colorScheme: "dark" });
  await page
    .locator(".row", { hasText: "Implement A long" })
    .first()
    .click()
    .catch(() => {});
  await page.locator(".row").first().click();
  await shot("09-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press("Escape");
  await shot("10-phone");
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
