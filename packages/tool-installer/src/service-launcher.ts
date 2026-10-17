import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ToolLaunchSpecSchema } from "./services.js";
import { fileDigest, readRegular, sha256, withFileLock } from "./files.js";

async function main(): Promise<void> {
  const [specPath, expectedDigest, expectedLauncher] = process.argv.slice(2);
  if (!specPath || !expectedDigest || !expectedLauncher || await fileDigest(fileURLToPath(import.meta.url)) !== expectedLauncher)
    throw new Error("Tool launcher integrity mismatch");
  const spec = ToolLaunchSpecSchema.parse(JSON.parse(await readRegular(specPath)));
  if (sha256(JSON.stringify(spec)) !== expectedDigest || await fileDigest(spec.executable) !== spec.executableDigest)
    throw new Error("Tool launch specification or executable changed");
  for (const file of spec.verifiedFiles ?? []) if (await fileDigest(file.path) !== file.digest)
    throw new Error("Tool entrypoint changed");
  const execute = async () => new Promise<void>((resolve, reject) => {
    const child = spawn(spec.executable, spec.argv, { shell: false, cwd: spec.cwd,
      env: { ...process.env, ...spec.environment }, stdio: ["pipe", "inherit", "inherit"] });
    process.stdin.pipe(child.stdin);
    child.stdin.on("error", () => {});
    let forced: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      child.kill(signal);
      forced ??= setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    const onTerm = () => terminate("SIGTERM");
    const onInt = () => terminate("SIGINT");
    process.on("SIGTERM", onTerm); process.on("SIGINT", onInt);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (forced) clearTimeout(forced);
      process.off("SIGTERM", onTerm); process.off("SIGINT", onInt);
      process.stdin.unpipe(child.stdin); process.stdin.pause();
      process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
      resolve();
    });
  });
  if (spec.lockPath) await withFileLock(spec.lockPath, execute); else await execute();
}

main().catch(() => { process.stderr.write("Bflow tool launch failed: configuration, executable or resource lock is invalid\n"); process.exitCode = 1; });
