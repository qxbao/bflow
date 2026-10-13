import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const workspaceRoots = ["packages", "apps"];
const manifests = [];

for (const root of workspaceRoots) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifests.push({ path, manifest });
  }
}

const workspaceNames = new Set(manifests.map(({ manifest }) => manifest.name));
const graph = new Map(
  manifests.map(({ manifest }) => {
    const dependencyNames = Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies
    }).filter((name) => workspaceNames.has(name));
    return [manifest.name, dependencyNames];
  })
);

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
