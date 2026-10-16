import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const workspaceRoots = ["packages", "apps"];
const manifests = [];

for (const root of workspaceRoots) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "package.json");
    try {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifests.push({ root, entryName: entry.name, path, manifest });
    } catch {
      // Ignore directories without package.json
    }
  }
}

const workspaceNames = new Set(manifests.map(({ manifest }) => manifest.name));
const graph = new Map(
  manifests.map(({ manifest }) => {
    const dependencyNames = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies
    }).filter((name) => workspaceNames.has(name));
    return [manifest.name, dependencyNames];
  })
);

// Check 1: Enforce leaf package boundaries
// Leaf packages under packages/* (all except @bflow/contracts and @bflow/runtime)
// only depend on @bflow/contracts in dependencies.
for (const { root, manifest } of manifests) {
  if (root === "packages" && manifest.name !== "@bflow/contracts" && manifest.name !== "@bflow/runtime") {
    const internalDeps = Object.keys(manifest.dependencies ?? {}).filter((dep) => workspaceNames.has(dep));
    for (const dep of internalDeps) {
      if (dep !== "@bflow/contracts") {
        throw new Error(
          `Leaf package rule violation: "${manifest.name}" must not depend on workspace package "${dep}". Only "@bflow/contracts" is permitted in dependencies.`
        );
      }
    }
  }
}

// Check 2: Enforce no relative import escaping package root in src files
async function findTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findTsFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

const importRegex = /(?:import|export)\s+.*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

for (const { root, entryName } of manifests) {
  const pkgRoot = resolve(root, entryName);
  const srcDir = join(pkgRoot, "src");
  let tsFiles = [];
  try {
    tsFiles = await findTsFiles(srcDir);
  } catch {
    continue;
  }

  for (const file of tsFiles) {
    const content = await readFile(file, "utf8");
    for (const match of content.matchAll(importRegex)) {
      const specifier = match[1] || match[2];
      if (!specifier || !specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      const rel = relative(pkgRoot, target);
      if (rel.startsWith("..") || isAbsolute(rel) || specifier.startsWith("../..") || specifier.includes("/../..")) {
        throw new Error(
          `Escaping relative import violation in ${file}: "${specifier}" escapes package root ${pkgRoot}`
        );
      }
    }
  }
}

const visiting = new Set();
const visited = new Set();

function visit(name, path = []) {
  if (visiting.has(name)) {
    const cycleStart = path.indexOf(name);
    throw new Error(`Workspace dependency cycle: ${[...path.slice(cycleStart), name].join(" -> ")}`);
  }
  if (visited.has(name)) return;

  visiting.add(name);
  for (const dependency of graph.get(name) ?? []) visit(dependency, [...path, name]);
  visiting.delete(name);
  visited.add(name);
}

for (const name of graph.keys()) visit(name);

const edges = [...graph.entries()].flatMap(([from, dependencies]) =>
  dependencies.map((to) => `${from} -> ${to}`)
);
console.log(`Workspace dependency graph is acyclic (${graph.size} packages, ${edges.length} internal edges).`);
console.log("Leaf package dependency boundaries and non-escaping relative import rules verified.");
