import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AdapterRunner } from "../../src/agentic/runner-adapter.js";

type FixtureAdapter = Pick<AdapterRunner, "adapterId" | "mounts">;

async function regularFile(path: string): Promise<boolean> {
  try { const info = await lstat(path); return info.isFile() && info.size > 0; }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
}

async function directories(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return []; throw error; }
}

async function hashedFile(root: string, name: string): Promise<boolean> {
  for (const hash of await directories(root)) if (await regularFile(join(root, hash, name))) return true;
  return false;
}

/**
 * Necessary prerequisites for the pinned offline measurement fixtures, not a generic
 * dependency resolver or proof of successful execution. Check before measurement;
 * failures after this inventory (including uncached transitive dependencies) stay failures.
 * Inspect only the adapter's selected cache/toolchain mounts, never a broader host home.
 */
export async function missingOfflineFixturePrerequisites(adapter: FixtureAdapter): Promise<string[]> {
  const missing: string[] = [];
  const targets: Record<string, string> = { maven: "/bflow-cache/maven", gradle: "/bflow-cache/gradle/caches/modules-2", dotnet: "/bflow-cache/nuget" };
  const cacheTarget = targets[adapter.adapterId];
  if (!cacheTarget) return missing;
  const cache = adapter.mounts.find(mount => mount.target === cacheTarget)?.source;
  if (adapter.adapterId === "maven") {
    const coordinates = [
      ["org/apache/maven/plugins", "maven-resources-plugin", "3.3.1"],
      ["org/apache/maven/plugins", "maven-compiler-plugin", "3.11.0"],
      ["org/apache/maven/plugins", "maven-surefire-plugin", "3.2.5"],
      ["org/apache/maven/surefire", "surefire-junit4", "3.2.5"],
      ["junit", "junit", "4.13.2"],
      ["org/hamcrest", "hamcrest-core", "1.3"]
    ];
    for (const [group, artifact, version] of coordinates) for (const extension of ["pom", "jar"]) {
      const path = `${group}/${artifact}/${version}/${artifact}-${version}.${extension}`;
      if (!cache || !await regularFile(join(cache, path))) missing.push(`Maven offline artifact ${path}`);
    }
  } else if (adapter.adapterId === "gradle") {
    const metadata = cache ? (await directories(cache)).filter(name => /^metadata-\d+(?:\.\d+)*$/.test(name)) : [];
    for (const [group, artifact, version] of [["junit", "junit", "4.13.2"], ["org.hamcrest", "hamcrest-core", "1.3"]]) {
      const path = `${group}/${artifact}/${version}`;
      for (const extension of ["pom", "jar"]) {
        if (!cache || !await hashedFile(join(cache, "files-2.1", path), `${artifact}-${version}.${extension}`)) missing.push(`Gradle offline artifact ${path}/*.${extension}`);
      }
      let descriptor = false;
      for (const directory of metadata) if (cache && await hashedFile(join(cache, directory, "descriptors", path), "descriptor.bin")) { descriptor = true; break; }
      if (!descriptor) missing.push(`Gradle offline descriptor ${path}`);
    }
  } else if (adapter.adapterId === "dotnet") {
    for (const [name, version] of [["microsoft.net.test.sdk", "17.11.1"], ["xunit", "2.9.2"], ["xunit.runner.visualstudio", "2.8.2"]]) {
      for (const file of [`${name}.${version}.nupkg`, `${name}.nuspec`, ".nupkg.metadata"]) {
        const path = `${name}/${version}/${file}`;
        if (!cache || !await regularFile(join(cache, path))) missing.push(`NuGet offline package ${path}`);
      }
    }
    // This fixture targets net8.0, independently of the installed SDK's major version.
    for (const [part, component, file] of [["packs", "Microsoft.NETCore.App.Ref", "ref/net8.0/System.Runtime.dll"], ["shared", "Microsoft.NETCore.App", "System.Private.CoreLib.dll"]]) {
      const mount = adapter.mounts.find(value => value.target.endsWith(`/${part}`));
      let available = false;
      for (const version of mount ? await directories(join(mount.source, component)) : []) {
        if (/^8\.0\.\d+$/.test(version) && mount && await regularFile(join(mount.source, component, version, file))) { available = true; break; }
      }
      if (!available) missing.push(`.NET 8 ${component}`);
    }
  }
  return missing;
}
