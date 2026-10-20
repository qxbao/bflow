import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { validateNpmWarmManifests, npmWarmInvocation, warmNpmDependencies, slirpWarmInvocation, parseWarmChildPid, probeNpmWarmNetwork, runNpmWarmSandbox, NPM_WARM_RESOLVER } from "../../src/agentic/dependency-warming.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });
const manifest = { name: "fixture", version: "1.0.0", dependencies: { example: "^1.0.0" }, scripts: { postinstall: "touch /tmp/MUST_NOT_RUN" } };
const entry = { version: "1.0.0", resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz", integrity: "sha512-" + Buffer.alloc(64).toString("base64") };
const lock = () => ({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": manifest, "node_modules/example": entry } });
it("accepts exact integrity-pinned npm registry lockfiles while scripts stay data", () => {
  expect(() => validateNpmWarmManifests(manifest, lock())).not.toThrow();
});
it.each([
  { ...manifest, workspaces: ["packages/*"] }, { ...manifest, overrides: { example: "2.0.0" } },
  { ...manifest, dependencies: { example: "file:../secret" } }, { ...manifest, dependencies: { example: "git+https://example.test/a" } },
  { ...manifest, dependencies: { example: "https://example.test/a.tgz" } }, { ...manifest, dependencies: { example: "npm:other@1" } }
])("rejects dependency resolution outside frozen registry locks: %j", value => expect(() => validateNpmWarmManifests(value, lock())).toThrow());
it.each([
  { ...entry, resolved: "http://registry.npmjs.org/example/-/example-1.tgz" },
  { ...entry, resolved: "https://registry.npmjs.org@evil.test/example.tgz" },
  { ...entry, resolved: "https://evil.test/example.tgz" },
  { ...entry, resolved: "https://registry.npmjs.org/example.tgz?token=secret" },
  { ...entry, integrity: "sha1-weak" }, { ...entry, integrity: undefined }, { ...entry, link: true },
  { ...entry, resolved: undefined }, { ...entry, version: "https://evil.test/package" }
])("rejects unsafe lock entry: %j", value => expect(() => validateNpmWarmManifests(manifest, { ...lock(), packages: { "": manifest, "node_modules/example": value } })).toThrow());
it("validates nested lock entries and paths, including npm v2 legacy resolution records", () => {
  expect(() => validateNpmWarmManifests(manifest, { ...lock(), packages: { "": manifest, "../escape": entry } })).toThrow();
  expect(() => validateNpmWarmManifests(manifest, { ...lock(), lockfileVersion: 1 })).toThrow();
  expect(() => validateNpmWarmManifests(manifest, { ...lock(), lockfileVersion: 2, dependencies: { example: { ...entry, resolved: "file:/etc/passwd" } } })).toThrow();
});
it("network warming mounts only Runtime cache, public system files and narrow toolchain paths", () => {
  const invocation = npmWarmInvocation("/tmp/bflow-cache-owned", "/usr/bin/bwrap", "/opt/node/bin/node", "/opt/node/lib/node_modules/npm");
  expect(invocation.executable).toBe("/usr/bin/bwrap");
  expect(invocation.args).not.toContain("--share-net");
  expect(invocation.args).toContain("--info-fd");
  expect(invocation.args).toContain("--block-fd");
  expect(invocation.args.join(" ")).toContain("/tmp/bflow-cache-owned/resolv.conf /etc/resolv.conf");
  expect(invocation.args).toContain("--unshare-all");
  expect(invocation.args.slice(-7)).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress", "--registry=https://registry.npmjs.org", "--cache=/cache/npm-cache"]);
  expect(invocation.env).toMatchObject({ HOME: "/tmp/home", NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_GLOBALCONFIG: "/dev/null", NPM_CONFIG_IGNORE_SCRIPTS: "true" });
  expect(Object.keys(invocation.env)).not.toContain("NPM_TOKEN");
  expect(invocation.args.join(" ")).not.toMatch(/\/home\/|\/run\/|\.npmrc|\.ssh|\.netrc/);
  const writes = invocation.args.flatMap((arg, index) => arg === "--bind" ? [invocation.args.slice(index + 1, index + 3)] : []);
  expect(writes).toEqual([["/tmp/bflow-cache-owned", "/cache"]]);
});
it("avoids devpts setup so the helper can enter the user namespace that owns the network", () => {
  const invocation = npmWarmInvocation("/tmp/bflow-cache-owned", "/usr/bin/bwrap", "/opt/node/bin/node", "/opt/node/lib/node_modules/npm");
  // bwrap --dev creates devpts, then a second user namespace that cannot administer
  // the network namespace owned by its parent. Noninteractive npm needs no PTY.
  expect(invocation.args).not.toContain("--dev");
  const devices = invocation.args.flatMap((arg, index) => arg === "--dev-bind" ? [invocation.args.slice(index + 1, index + 3)] : []);
  expect(devices).toEqual([["/dev/null", "/dev/null"], ["/dev/zero", "/dev/zero"], ["/dev/random", "/dev/random"], ["/dev/urandom", "/dev/urandom"]]);
  expect(invocation.args.join(" ")).toContain("--tmpfs /dev");
});
it("rejects a symlinked manifest instead of reading files outside the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-warm-test-")); cleanups.push(root);
  await writeFile(join(root, "actual.json"), JSON.stringify(manifest));
  await symlink("actual.json", join(root, "package.json"));
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lock()));
  expect((await warmNpmDependencies(root)).status).toBe("unsupported");
});
it("fails unsupported before side effects when no supported frozen lockfile exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-warm-test-")); cleanups.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  expect((await warmNpmDependencies(root)).status).toBe("unsupported");
  expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual(manifest);
});
const readiness = await probeBehavioralSandbox();
const networkReadiness = await probeNpmWarmNetwork();
it.skipIf(process.platform !== "linux" || readiness.status !== "ready" || networkReadiness.status !== "ready")("real isolated no-dependency npm ci leaves the checkout unchanged", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-warm-live-"))); cleanups.push(root);
  const noDependencies = { name: "fixture", version: "1.0.0", scripts: { postinstall: "node -e \"process.exit(99)\"" } };
  await writeFile(join(root, "package.json"), JSON.stringify(noDependencies));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ ...noDependencies, lockfileVersion: 3, packages: { "": noDependencies } }));
  const result = await warmNpmDependencies(root);
  expect(result.status).toBe("ready");
  if (result.status === "ready") { cleanups.push(result.dependencySource); expect(result.dependencySource).not.toBe(root); }
  expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toEqual(noDependencies);
});

it("accepts nested npm v2 records without interpreting nested records as dependency ranges", () => {
  const nested = { ...lock(), lockfileVersion: 2, dependencies: { example: { ...entry, requires: { nested: "^1.0.0" }, dependencies: { nested: entry } } } };
  expect(() => validateNpmWarmManifests(manifest, nested)).not.toThrow();
});
it("rejects nested dependency source changes, weak/malformed SRI and embedded shrinkwrap", () => {
  for (const change of [ {dependencies:{nested:"file:/secret"}}, {hasShrinkwrap:true}, {inBundle:true}, {integrity:"sha512-AAAA"}, {resolved:"https://user:pass@registry.npmjs.org/example.tgz"} ]) expect(() => validateNpmWarmManifests(manifest, {...lock(), packages:{"":manifest,"node_modules/example":{...entry,...change}}})).toThrow();
});

it("rejects broad home/config directories as toolchain mount sources", () => {
  for (const npmRoot of ["/home/user", "/home/user/.config/npm", "/usr", "/"]) expect(() => npmWarmInvocation("/tmp/bflow-owned-cache", "/usr/bin/bwrap", "/opt/node/bin/node", npmRoot)).toThrow();
});

it("slirp networking disables host loopback and the host DNS proxy before releasing npm", () => {
  const invocation = slirpWarmInvocation("/usr/bin/slirp4netns", 123);
  expect(invocation.args).toEqual(["--configure", "--disable-host-loopback", "--disable-dns", "--ready-fd=3", "--exit-fd=4", "--userns-path=/proc/123/ns/user", "123", "tap0"]);
  expect(invocation.env).toEqual({PATH:"/usr/bin:/bin", LANG:"C", LC_ALL:"C", HOME:"/nonexistent"});
  expect(() => slirpWarmInvocation("/usr/bin/slirp4netns", 0)).toThrow();
});
it.each(["{}", '{"child-pid":0}', '{"child-pid":-1}', '{"child-pid":"123"}', '{"child-pid":1.2}', "{}\n{}"]) ("rejects malformed namespace handshake %s", value => expect(() => parseWarmChildPid(value)).toThrow());
it("accepts the bounded documented bwrap child-pid handshake", () => {
  expect(parseWarmChildPid('{"child-pid":123,"user-namespace":1234}')).toBe(123);
  expect(() => parseWarmChildPid(" ".repeat(4097))).toThrow();
});

it("uses fixed public DNS without a host resolver/proxy fallback", () => {
  expect(NPM_WARM_RESOLVER).toBe("nameserver 1.1.1.1\noptions timeout:2 attempts:2\n");
});
async function processFixture(helperSource: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-warm-supervision-"))); cleanups.push(root);
  const program = (name: string, source: string) => writeFile(join(root, name), `#!${process.execPath}\n${source}`, {mode:0o700});
  await program("bwrap", `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(join(root,"sandbox-pid"))},String(process.pid));const info=fs.createWriteStream(null,{fd:3});info.end(JSON.stringify({'child-pid':process.pid}));const block=fs.createReadStream(null,{fd:4});block.once('data',()=>{fs.writeFileSync(${JSON.stringify(join(root,"started"))},'started');process.exit(0)});`);
  await program("slirp", `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(join(root,"helper-pid"))},String(process.pid));${helperSource}`);
  return {root, invocation:{executable:join(root,"bwrap"),args:["--unshare-all"],env:{PATH:"/usr/bin:/bin"}}, helper:join(root,"slirp")};
}
it("waits for the helper readiness byte before unblocking the sandbox and reaps the helper", async () => {
  // Match slirp's write(readyfd, "1", 1); close(readyfd), with the helper alive.
  const f=await processFixture("fs.writeSync(3,Buffer.from([0x31]));fs.closeSync(3);fs.createReadStream(null,{fd:4}).resume();");
  await runNpmWarmSandbox(f.invocation,f.helper,f.root,5000);
  expect(await readFile(join(f.root,"started"),"utf8")).toBe("started");
  const pid=Number(await readFile(join(f.root,"helper-pid"),"utf8"));
  expect(()=>process.kill(pid,0)).toThrow();
});
it.each([{bytes:[0x00]}, {bytes:[0x01]}, {bytes:[0xb1]}, {bytes:[0x32]}, {bytes:[0x31, 0x31]}])("rejects malformed helper readiness bytes $bytes without releasing npm", async ({bytes}) => {
  const f=await processFixture(`fs.writeSync(3,Buffer.from(${JSON.stringify(bytes)}));fs.closeSync(3);fs.createReadStream(null,{fd:4}).resume();`);
  await expect(runNpmWarmSandbox(f.invocation,f.helper,f.root,5000)).rejects.toThrow(/handshake exceeds bound|did not attest readiness/);
  await expect(readFile(join(f.root,"started"))).rejects.toMatchObject({code:"ENOENT"});
  const pid=Number(await readFile(join(f.root,"helper-pid"),"utf8"));
  expect(()=>process.kill(pid,0)).toThrow();
});
it("rejects an empty helper readiness pipe without releasing the sandbox", async () => {
  const f=await processFixture("process.exit(0);");
  await expect(runNpmWarmSandbox(f.invocation,f.helper,f.root,5000)).rejects.toThrow();
  await expect(readFile(join(f.root,"started"))).rejects.toMatchObject({code:"ENOENT"});
});
it("bounds a hung bootstrap and kills both process trees", async () => {
  const f=await processFixture("setInterval(()=>{},1000);");
  await expect(runNpmWarmSandbox(f.invocation,f.helper,f.root,1000)).rejects.toThrow(/deadline/);
  const pid=Number(await readFile(join(f.root,"sandbox-pid"),"utf8"));
  expect(()=>process.kill(pid,0)).toThrow();
  await expect(readFile(join(f.root,"started"))).rejects.toMatchObject({code:"ENOENT"});
});
it("rejects accidental shared-host networking before spawning a process", async () => {
  await expect(runNpmWarmSandbox({executable:"/not/run",args:["--unshare-all","--share-net"],env:{}},"/not/run","/",1)).rejects.toThrow(/policy/);
});
it.skipIf(process.platform !== "linux" || readiness.status!=="ready" || networkReadiness.status!=="ready")("real warming network cannot connect to host abstract sockets or loopback listeners", async () => {
  if(readiness.status!=="ready" || networkReadiness.status!=="ready")return;
  const root=await realpath(await mkdtemp(join(tmpdir(),"bflow-warm-socket-test-")));cleanups.push(root);
  await Promise.all([writeFile(join(root,"package.json"),"{}"),writeFile(join(root,"package-lock.json"),"{}"),writeFile(join(root,"resolv.conf"),NPM_WARM_RESOLVER)]);
  const abstractName="\0bflow-warm-"+process.pid+"-"+Date.now(), abstract=createServer(),tcp=createServer();
  abstract.listen(abstractName);await once(abstract,"listening");tcp.listen(0,"127.0.0.1");await once(tcp,"listening");
  try{
    const address=tcp.address();if(!address || typeof address==="string")throw new Error("missing port");
    const node=await realpath(process.execPath),npmRoot=await realpath(join(dirname(dirname(node)),"lib/node_modules/npm"));
    const invocation=npmWarmInvocation(root,readiness.executable,node,npmRoot),marker=invocation.args.indexOf("--");
    const code=`const net=require('node:net');const endpoints=[{path:${JSON.stringify(abstractName)}},{host:'127.0.0.1',port:${address.port}},{host:'10.0.2.2',port:${address.port}},{host:'10.0.2.3',port:${address.port}}];Promise.all(endpoints.map(options=>new Promise((resolve,reject)=>{const socket=net.connect(options);socket.setTimeout(1000,()=>{socket.destroy();resolve()});socket.on('connect',()=>{socket.destroy();reject(new Error('host reachable'))});socket.on('error',()=>resolve())}))).then(()=>process.exit(0),()=>process.exit(20));`;
    invocation.args.splice(marker+1,invocation.args.length-marker-1,"/runtime/bin/node","-e",code);
    await runNpmWarmSandbox(invocation,networkReadiness.executable,root,15000);
  }finally{await Promise.all([new Promise(resolve=>abstract.close(resolve)),new Promise(resolve=>tcp.close(resolve))]);}
});

it("requires actual helper capability output including disable-dns", async () => {
  const root=await realpath(await mkdtemp(join(tmpdir(),"bflow-slirp-probe-")));cleanups.push(root);
  const previous=process.env.PATH;
  try{
    process.env.PATH=root;
    expect((await probeNpmWarmNetwork()).status).toBe("unsupported");
    const writeHelper=(flags:string)=>writeFile(join(root,"slirp4netns"),`#!${process.execPath}\nconsole.log(process.argv.includes('--version')?'slirp4netns version 1.3.2':${JSON.stringify(flags)});`,{mode:0o700});
    const flags="--configure --disable-host-loopback --ready-fd --exit-fd --userns-path";
    await writeHelper(flags);expect((await probeNpmWarmNetwork()).status).toBe("unsupported");
    await writeHelper(flags+" --disable-dns");expect((await probeNpmWarmNetwork()).status).toBe("ready");
  }finally{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;}
});
