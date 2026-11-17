#!/usr/bin/env node
// A Model Context Protocol server over stdio with one tool, verify, which runs this package's
// own `swarm-verify verify --json` and returns its result. It implements nothing of the
// verifier: a client gets exactly what the command line would print, and nothing else.
//
//   node mcp.mjs            (an MCP client starts it; messages are newline-delimited JSON-RPC)

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const cli =
  process.env.SWARM_VERIFY_MCP_CLI ??
  fileURLToPath(new URL("./dist/swarm-verify.js", import.meta.url));

/** Protocol revisions this server speaks, newest first; a client asking for another gets the newest. */
export const supportedProtocols = ["2025-06-18", "2025-03-26", "2024-11-05"];
/** What one verification may print before it is stopped and reported as an error. */
const maxOutputBytes = 32 * 1024 * 1024;
/** Verifications run at once; later calls wait their turn. */
const maxConcurrent = 2;
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const tool = {
  name: "verify",
  description:
    "Measure a change against the repository's own checks in a clean checkout of its base, test by test, and sign the result. Returns the swarm-verify result: the state (complete, incomplete or blocked), requirement outcomes, regressions, every check, the base run, coverage, mutation, execution assurance, integrity and what was not measured.",
  inputSchema: {
    type: "object",
    properties: {
      workspace: {
        type: "string",
        description: "The repository; the server's directory if left out.",
      },
      base: { type: "string", description: "The base ref; HEAD if left out." },
      patch: { type: "string", description: "A patch file to verify instead of the working tree." },
      range: {
        type: "string",
        description: "A ref range such as main..feature to verify instead.",
      },
      isolation: {
        type: "string",
        enum: ["isolated", "host"],
        description:
          "isolated (the default) runs the checks in a container; host runs them on this machine and is reported as not isolated.",
      },
    },
    additionalProperties: false,
  },
};

let running = 0;
const waiting = [];
const children = new Map();

async function turn() {
  if (running < maxConcurrent) {
    running += 1;
    return;
  }
  await new Promise((settle) => waiting.push(settle));
  running += 1;
}

function release() {
  running -= 1;
  waiting.shift()?.();
}

/** One `swarm-verify verify --json`, stopped when the client cancels the request or it prints too much. */
async function runVerify(input, requestId) {
  const args = [cli, "verify", "--json"];
  for (const name of ["workspace", "base", "patch", "range", "isolation"]) {
    if (typeof input[name] === "string") args.push(`--${name}`, input[name]);
  }
  await turn();
  try {
    return await new Promise((settle) => {
      const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      children.set(requestId, child);
      let stdout = "";
      let stderr = "";
      let overflow = false;
      const take = (chunk, into) => {
        if (stdout.length + stderr.length + chunk.length > maxOutputBytes) {
          overflow = true;
          child.kill("SIGTERM");
          return into;
        }
        return into + chunk;
      };
      child.stdout.on("data", (chunk) => {
        stdout = take(chunk, stdout);
      });
      child.stderr.on("data", (chunk) => {
        stderr = take(chunk, stderr);
      });
      child.on("close", (code) => {
        children.delete(requestId);
        settle({ code, stdout, stderr, overflow });
      });
    });
  } finally {
    release();
  }
}

async function callTool(params, requestId) {
  if (params?.name !== tool.name)
    throw Object.assign(new Error(`no tool named ${params?.name}`), { code: -32602 });
  const input = params.arguments ?? {};
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw Object.assign(new Error("arguments must be an object"), { code: -32602 });
  for (const [name, value] of Object.entries(input))
    if (!(name in tool.inputSchema.properties) || typeof value !== "string")
      throw Object.assign(new Error(`${name} is not a string argument of verify`), {
        code: -32602,
      });
  if (input.isolation !== undefined && !["isolated", "host"].includes(input.isolation))
    throw Object.assign(new Error("isolation is isolated or host"), { code: -32602 });
  const ran = await runVerify(input, requestId);
  if (ran.overflow) {
    const text = `swarm-verify printed more than ${maxOutputBytes} bytes and was stopped`;
    return { content: [{ type: "text", text }], isError: true };
  }
  if (ran.code === 3) {
    const text = "the verification was cancelled; no evidence was published";
    return { content: [{ type: "text", text }], isError: true };
  }
  let printed = null;
  try {
    printed = JSON.parse(ran.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    // No result came back: reported below as a tool error with what the command printed.
  }
  if (printed === null) {
    const text = `swarm-verify exited ${ran.code} without a result:\n${`${ran.stderr}${ran.stdout}`.trim()}`;
    return { content: [{ type: "text", text }], isError: true };
  }
  const delivery = printed.delivery?.status ?? "unknown";
  const summary = `state ${printed.state}; delivery ${delivery}; run ${printed.evidence?.runId ?? "unknown"}; manifest ${printed.evidence?.manifest ?? "none"}`;
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(printed) },
    ],
    structuredContent: printed,
    // The verification ran; a task that is not complete is its answer, not a tool error. Evidence
    // that was not delivered as required is.
    isError: delivery === "failed",
  };
}

const handlers = {
  initialize: async (params) => ({
    protocolVersion: supportedProtocols.includes(params?.protocolVersion)
      ? params.protocolVersion
      : supportedProtocols[0],
    capabilities: { tools: {} },
    serverInfo: { name: "swarm-verify", version },
  }),
  ping: async () => ({}),
  "tools/list": async () => ({ tools: [tool] }),
  "tools/call": callTool,
};

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (line.trim() === "") return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "the line is not JSON" } });
    return;
  }
  // A notification gets no answer; a cancellation stops the verification it names.
  if (message.id === undefined) {
    if (message.method === "notifications/cancelled")
      children.get(message.params?.requestId)?.kill("SIGTERM");
    return;
  }
  const handler = handlers[message.method];
  if (handler === undefined) {
    send({ id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
    return;
  }
  try {
    send({ id: message.id, result: await handler(message.params, message.id) });
  } catch (error) {
    send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});
