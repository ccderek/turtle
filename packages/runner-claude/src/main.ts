#!/usr/bin/env node
/**
 * turtle-runner: speaks the turtle JSONL protocol on stdin/stdout and runs the
 * Claude Agent SDK in the current directory (the workspace). Logs go to stderr.
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { createLineParser, encodeMessage, type ToRunner } from "@turtle/protocol";
import { ClaudeRunner } from "./runner.js";

const runner = new ClaudeRunner({
  cwd: process.cwd(),
  sdk: { query, tool, createSdkMcpServer },
  send: (msg) => {
    process.stdout.write(encodeMessage(msg));
  },
  exit: (code) => {
    // Let stdout drain before exiting.
    process.stdout.write("", () => process.exit(code));
  },
});

process.stdin.on(
  "data",
  createLineParser<ToRunner>(
    (msg) => runner.handle(msg),
    (line) => process.stderr.write(`turtle-runner: invalid input: ${line}\n`),
  ),
);
process.stdin.on("end", () => runner.handle({ t: "shutdown" }));
process.on("SIGINT", () => runner.handle({ t: "interrupt" }));
process.on("SIGTERM", () => runner.handle({ t: "interrupt" }));
runner.ready();
