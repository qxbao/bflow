import ts from 'typescript';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// Import-boundary lock for features/office (ADR-level table "Ranh giới [P]" in section-2-arch.md).
// The walk follows relative static and dynamic imports with the TypeScript parser, so comments and
// strings never create false edges. A dynamic import with a computed specifier is reported, because it
// is a blind spot the walk cannot analyse.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const OFFICE = join(SRC, 'features/office');
const API_DIR = join(SRC, 'api');
const RENDERER = join(OFFICE, 'scene/renderer');
// Shared Director/issue controllers and the command layer: they read or write the API, so scene and model reach them only as UI-supplied props.
const WRITERS = ['features/director', 'features/issues', 'features/operations'].map(dir => join(SRC, dir));
const inWriter = (target: string | undefined): string | undefined => {
  const dir = target ? WRITERS.find(d => isInside(target, d)) : undefined;
  return dir ? `${relative(SRC, dir).split(sep).join('/')}/**` : undefined;
};

type Rule = 'scene' | 'model' | 'ui';
type Reader = (file: string) => string | undefined;
type Edge = { kind: 'static' | 'dynamic' | 'computed'; spec: string; names: string[]; typeOnly?: boolean };
type Facts = { edges: Edge[]; hazards: string[] };
type Violation = { rule: Rule; file: string; reason: string };

const readFile: Reader = file => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

const listSources = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
};

const isRelative = (spec: string): boolean => spec.startsWith('.') || spec.startsWith('/');
const stripExt = (file: string): string => file.replace(/\.tsx?$/, '');
const isInside = (file: string, dir: string): boolean => file.startsWith(dir + sep);
const matchesPkg = (spec: string, name: string): boolean =>
  spec === name || spec.startsWith(name.endsWith('/') ? name : `${name}/`);
const rel = (file: string): string => relative(SRC, file).split(sep).join('/');

const REACT_PKGS = ['react', 'react-dom', 'react-router', 'react-router-dom'];
const THREE_PKGS = ['three', '@types/three'];

function resolveRelative(from: string, spec: string, read: Reader): string | undefined {
  const base = resolve(dirname(from), spec);
  const stem = base.replace(/\.[mc]?jsx?$/, '');
  const candidates = [
    `${stem}.ts`,
    `${stem}.tsx`,
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return candidates.find(c => /\.tsx?$/.test(c) && read(c) !== undefined);
}

function scan(file: string, source: string): Facts {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const edges: Edge[] = [];
  const hazards: string[] = [];
  const namesOf = (elements: readonly { propertyName?: ts.Identifier | ts.StringLiteral; name: ts.Identifier }[]) =>
    elements.map(el => (el.propertyName ?? el.name).text);

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      const names = bindings && ts.isNamedImports(bindings) ? namesOf(bindings.elements) : [];
      // `import type ...` and `import { type A }` are erased at build: no runtime edge.
      const clause = node.importClause;
      const typeOnly = Boolean(clause && (clause.isTypeOnly || (!clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(el => el.isTypeOnly))));
      edges.push({ kind: 'static', spec: node.moduleSpecifier.text, names, ...(typeOnly ? { typeOnly } : {}) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const names = clause && ts.isNamedExports(clause) ? namesOf(clause.elements) : [];
      edges.push({ kind: 'static', spec: node.moduleSpecifier.text, names, ...(node.isTypeOnly ? { typeOnly: true } : {}) });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      edges.push({ kind: 'static', spec: node.moduleReference.expression.text, names: [] });
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      const literal = arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : undefined;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        edges.push(literal === undefined
          ? { kind: 'computed', spec: '', names: [] }
          : { kind: 'dynamic', spec: literal, names: [] });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && literal !== undefined) {
        edges.push({ kind: 'static', spec: literal, names: [] });
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch') hazards.push('fetch()');
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'fetch') hazards.push('fetch()');
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      // `import('x').T` as a type query is erased too.
      edges.push({ kind: 'static', spec: node.argument.literal.text, names: [], typeOnly: true });
    } else if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'Date' && node.name.text === 'now') {
        hazards.push('Date.now');
      }
    } else if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'Date' && !node.arguments?.length) {
        hazards.push('new Date()');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { edges, hazards };
}

// `scene/renderer` may be a file or a directory with an index; both name the same module.
const isRendererModule = (file: string): boolean => stripExt(file).replace(/\/index$/, '') === RENDERER;

const RULES: Record<Rule, {
  // Dynamic edges the rule accepts as lazy entry points; they are neither followed nor reported.
  lazyOk?: (target: string | undefined) => boolean;
  hazards: boolean;
  blocked: (edge: Edge, target: string | undefined) => string | undefined;
}> = {
  // Scene may draw and emit selections only: no API layer, no command hook, no router.
  scene: {
    hazards: false,
    blocked: (edge, target) => {
      if (target && isInside(target, API_DIR)) return 'api/**';
      if (edge.names.includes('useCommands')) return 'useCommands';
      const writer = inWriter(target);
      if (writer) return writer;
      if (matchesPkg(edge.spec, 'react-router')) return 'react-router';
      return undefined;
    },
  },
  // Model is pure: no React, no three.js, no clock or network access.
  model: {
    hazards: true,
    blocked: (edge, target) => {
      const pkg = [...REACT_PKGS, ...THREE_PKGS].find(name => matchesPkg(edge.spec, name));
      if (pkg) return pkg;
      if (target && isInside(target, API_DIR)) return 'api/**';
      return inWriter(target);
    },
  },
  // UI may reach three.js only through a dynamic import of scene/renderer; every other path to three.js
  // (static or dynamic, direct or transitive) is a violation.
  ui: {
    lazyOk: target => target !== undefined && isRendererModule(target),
    hazards: false,
    blocked: (edge, target) => {
      // Type-only imports and type queries of the renderer are permitted explicitly; any value import is not.
      if (edge.typeOnly && target !== undefined && isRendererModule(target)) return undefined;
      if (THREE_PKGS.some(name => matchesPkg(edge.spec, name))) return 'three';
      if (edge.kind === 'static' && target !== undefined && isRendererModule(target)) {
        return 'scene/renderer (static)';
      }
      return undefined;
    },
  },
};

/** Walks each rule's roots transitively and returns every offending edge, de-duplicated. */
export function collectViolations(read: Reader, roots: Record<Rule, string[]>): Violation[] {
  const found = new Map<string, Violation>();
  const cache = new Map<string, Facts>();
  const factsOf = (file: string): Facts => {
    let facts = cache.get(file);
    if (!facts) {
      facts = scan(file, read(file) ?? '');
      cache.set(file, facts);
    }
    return facts;
  };

  for (const rule of Object.keys(RULES) as Rule[]) {
    const spec = RULES[rule];
    const seen = new Set<string>(roots[rule]);
    const queue = [...roots[rule]];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      const facts = factsOf(file);
      const report = (reason: string): void => {
        found.set(`${rule}|${rel(file)}|${reason}`, { rule, file: rel(file), reason });
      };
      if (spec.hazards) facts.hazards.forEach(report);
      for (const edge of facts.edges) {
        if (edge.kind === 'computed') {
          report('computed dynamic import');
          continue;
        }
        const target = isRelative(edge.spec) ? resolveRelative(file, edge.spec, read) : undefined;
        if (edge.kind === 'dynamic' && spec.lazyOk?.(target)) continue;
        const reason = spec.blocked(edge, target);
        if (reason) report(reason);
        // A permitted type-only renderer edge is not followed, or the walk would reach three.js through erased code.
        if (rule === 'ui' && edge.typeOnly && target && isRendererModule(target)) continue;
        if (target && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
  }
  return [...found.values()];
}

const describeViolations = (violations: Violation[]): string[] =>
  violations.map(v => `${v.rule} ${v.file} ${v.reason}`).sort();

describe('features/office import boundaries', () => {
  const roots: Record<Rule, string[]> = {
    scene: listSources(join(OFFICE, 'scene')),
    model: listSources(join(OFFICE, 'model')),
    ui: listSources(join(OFFICE, 'ui')),
  };

  test('model and ui roots are discovered, so the walk is not vacuous', () => {
    expect(roots.model.length).toBeGreaterThan(0);
    expect(roots.ui.length).toBeGreaterThan(0);
  });

  test('scene, model and ui respect their import boundaries', () => {
    expect(describeViolations(collectViolations(readFile, roots))).toEqual([]);
  });

  test('detector flags synthetic violations and allows the lazy renderer import in ui', () => {
    const fixture: Record<string, string> = {
      'api/client.ts': 'export const ApiClient = {};',
      'features/office/scene/renderer.ts': "import { WebGLRenderer } from 'three';\nexport const r = WebGLRenderer;",
      'features/office/scene/renderer/index.ts': "import { Scene } from 'three/src/Three.js';\nexport const idx = Scene;",
      'features/office/scene/hud.ts': "import { Scene } from 'three';\nexport const hud = Scene;",
      'features/office/scene/bad-api.ts': "import { ApiClient } from '../../../api/client';\nexport const c = ApiClient;",
      'features/office/scene/bad-router.ts': "export { useNavigate } from 'react-router';",
      'features/issues/index.tsx': 'export const IssueQueuePanel = 1;',
      'features/director/status.tsx': 'export const useDirector = 1;',
      'features/operations/index.tsx': 'export const useCommands = 1;',
      'features/office/scene/bad-issues.ts': "import { IssueQueuePanel } from '../../issues';\nexport const q = IssueQueuePanel;",
      'features/office/scene/bad-director.ts': "import { useDirector } from '../../director/status';\nexport const d = useDirector;",
      'features/office/model/bad-director.ts': "import { useDirector } from '../../director/status';\nexport const d = useDirector;",
      'features/office/model/bad-commands.ts': "import { x } from '../../operations';\nexport const c = x;",
      'features/office/model/bad-api.ts': "import { ApiClient } from '../../../api/client';\nexport const c = ApiClient;",
      'features/office/model/bad-react.ts': "import { useState } from 'react';\nexport const s = useState;",
      'features/office/model/bad-clock.ts': 'export const now = () => Date.now();\nexport const fresh = () => new Date();',
      'features/office/model/ok-date.ts': 'export const at = (ms: number) => new Date(ms);',
      'features/office/model/bad-transitive.ts': "import { x } from './helper';\nexport const y = x;",
      'features/office/model/helper.ts': "import 'react-dom';\nexport const x = 1;",
      'features/office/ui/bad-three.tsx': "import { Scene } from 'three';\nexport const A = Scene;",
      'features/office/ui/bad-three-loader.tsx': "import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';\nexport const L = GLTFLoader;",
      'features/office/model/bad-three.ts': "import { Vector3 } from 'three';\nexport const v = Vector3;",
      'features/office/ui/bad-renderer.tsx': "import { r } from '../scene/renderer';\nexport const R = r;",
      'features/office/ui/bad-computed.tsx': 'export const load = (p: string) => import(p);',
      'features/office/ui/bad-renderer-index.tsx': "import { idx } from '../scene/renderer/index';\nexport const I = idx;",
      'features/office/ui/bad-lazy-hud.tsx': "export const load = () => import('../scene/hud');",
      'features/office/ui/ok-type.tsx': "import type { R } from '../scene/renderer';\nimport { type Q } from '../scene/renderer';\nexport type T = import('../scene/renderer').R;\nexport type { R, Q };",
      'features/office/ui/bad-mixed.tsx': "import { r, type R } from '../scene/renderer';\nexport const x: R = r;",
      'features/office/ui/ok-lazy.tsx': "export const load = () => import('../scene/renderer');",
      'features/office/ui/ok-lazy-index.tsx': "export const load = () => import('../scene/renderer/index');",
    };
    const fixtureRead: Reader = file => fixture[rel(file)];
    const inDir = (dir: string) => Object.keys(fixture)
      .filter(key => key.startsWith(`features/office/${dir}/`))
      .map(key => join(SRC, key));
    const violations = collectViolations(fixtureRead, {
      scene: inDir('scene'),
      model: inDir('model'),
      ui: inDir('ui'),
    });
    expect(describeViolations(violations)).toEqual([
      'model features/office/model/bad-api.ts api/**',
      'model features/office/model/bad-clock.ts Date.now',
      'model features/office/model/bad-clock.ts new Date()',
      'model features/office/model/bad-commands.ts features/operations/**',
      'model features/office/model/bad-director.ts features/director/**',
      'model features/office/model/bad-react.ts react',
      'model features/office/model/bad-three.ts three',
      'model features/office/model/helper.ts react-dom',
      'scene features/office/scene/bad-api.ts api/**',
      'scene features/office/scene/bad-director.ts features/director/**',
      'scene features/office/scene/bad-issues.ts features/issues/**',
      'scene features/office/scene/bad-router.ts react-router',
      'ui features/office/scene/hud.ts three',
      'ui features/office/scene/renderer.ts three',
      'ui features/office/scene/renderer/index.ts three',
      'ui features/office/ui/bad-computed.tsx computed dynamic import',
      'ui features/office/ui/bad-mixed.tsx scene/renderer (static)',
      'ui features/office/ui/bad-renderer-index.tsx scene/renderer (static)',
      'ui features/office/ui/bad-renderer.tsx scene/renderer (static)',
      'ui features/office/ui/bad-three-loader.tsx three',
      'ui features/office/ui/bad-three.tsx three',
    ]);
  });
});
