import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startGatewayControl, type GatewayControl } from "../src/gateway-control.js";

let root: string;
let stateRoot: string;
let controls: GatewayControl[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "bflow-control-replace-")));
  stateRoot = join(root, "state");
});
afterEach(async () => {
  for (const control of controls) await control.stop();
  controls = [];
  await rm(root, { recursive: true, force: true });
});

// The control never reaches its Gateway in these tests: only the socket lifecycle is under test.
const start = async () => {
  const control = await startGatewayControl({ gateway: {} as never, stateRoot, machineId: "machine", configDigest: "a".repeat(64),
    endpoint: "http://127.0.0.1:9/mcp", services: [] });
  controls.push(control);
  return control;
};
const answers = (path: string) => new Promise<boolean>(resolve => {
  const socket = createConnection(path);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

it("does not displace a live Gateway control that is answering on its socket", async () => {
  const live = await start();
  await expect(start()).rejects.toThrow("Another Gateway control is running");
  expect(await answers(live.locator.socketPath)).toBe(true);
});

it("replaces a stale socket left behind by a dead daemon", async () => {
  await rm(stateRoot, { recursive: true, force: true });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const socketPath = join(stateRoot, "gateway-control.sock");
  // A child that binds the socket and is killed without unlinking leaves a dead socket file behind.
  const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => console.log("bound"))`],
    { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>(resolve => child.stdout!.once("data", () => resolve()));
  child.kill("SIGKILL");
  await new Promise(resolve => child.once("exit", resolve));
  await access(socketPath);
  expect(await answers(socketPath)).toBe(false);

  const replacement = await start();
  expect(replacement.locator.socketPath).toBe(socketPath);
  expect(await answers(socketPath)).toBe(true);
});
