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

type Rule = 'scene' | 'model' | 'ui';
type Reader = (file: string) => string | undefined;
type Edge = { kind: 'static' | 'dynamic' | 'computed'; spec: string; names: string[] };
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
const PIXI_PKGS = ['pixi.js', '@pixi/'];

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
      edges.push({ kind: 'static', spec: node.moduleSpecifier.text, names });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const names = clause && ts.isNamedExports(clause) ? namesOf(clause.elements) : [];
      edges.push({ kind: 'static', spec: node.moduleSpecifier.text, names });
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

const RULES: Record<Rule, {
  follow: 'all' | 'static';
  hazards: boolean;
  blocked: (edge: Edge, target: string | undefined) => string | undefined;
}> = {
  // Scene may draw and emit selections only: no API layer, no command hook, no router.
  scene: {
    follow: 'all',
    hazards: false,
    blocked: (edge, target) => {
      if (target && isInside(target, API_DIR)) return 'api/**';
      if (edge.names.includes('useCommands')) return 'useCommands';
      if (matchesPkg(edge.spec, 'react-router')) return 'react-router';
      return undefined;
    },
  },
  // Model is pure: no React, no Pixi, no clock or network access.
  model: {
    follow: 'all',
    hazards: true,
    blocked: edge => {
      const pkg = [...REACT_PKGS, ...PIXI_PKGS].find(name => matchesPkg(edge.spec, name));
      return pkg;
    },
  },
  // UI may reach Pixi only lazily through scene/renderer; any static path is a violation.
  ui: {
    follow: 'static',
    hazards: false,
    blocked: (edge, target) => {
      if (PIXI_PKGS.some(name => matchesPkg(edge.spec, name))) return 'pixi.js';
      if (target && stripExt(target) === RENDERER) return 'scene/renderer (static)';
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
        if (edge.kind === 'dynamic' && spec.follow === 'static') continue;
        const target = isRelative(edge.spec) ? resolveRelative(file, edge.spec, read) : undefined;
        const reason = spec.blocked(edge, target);
        if (reason) report(reason);
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
      'features/office/scene/renderer.ts': "import { Application } from 'pixi.js';\nexport const r = Application;",
      'features/office/scene/bad-api.ts': "import { ApiClient } from '../../../api/client';\nexport const c = ApiClient;",
      'features/office/scene/bad-router.ts': "export { useNavigate } from 'react-router';",
      'features/office/model/bad-react.ts': "import { useState } from 'react';\nexport const s = useState;",
      'features/office/model/bad-clock.ts': 'export const now = () => Date.now();\nexport const fresh = () => new Date();',
      'features/office/model/ok-date.ts': 'export const at = (ms: number) => new Date(ms);',
      'features/office/model/bad-transitive.ts': "import { x } from './helper';\nexport const y = x;",
      'features/office/model/helper.ts': "import 'react-dom';\nexport const x = 1;",
      'features/office/ui/bad-pixi.tsx': "import { Application } from 'pixi.js';\nexport const A = Application;",
      'features/office/ui/bad-renderer.tsx': "import { r } from '../scene/renderer';\nexport const R = r;",
      'features/office/ui/bad-computed.tsx': 'export const load = (p: string) => import(p);',
      'features/office/ui/ok-lazy.tsx': "export const load = () => import('../scene/renderer');",
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
      'model features/office/model/bad-clock.ts Date.now',
      'model features/office/model/bad-clock.ts new Date()',
      'model features/office/model/bad-react.ts react',
      'model features/office/model/helper.ts react-dom',
      'scene features/office/scene/bad-api.ts api/**',
      'scene features/office/scene/bad-router.ts react-router',
      'ui features/office/scene/renderer.ts pixi.js',
      'ui features/office/ui/bad-computed.tsx computed dynamic import',
      'ui features/office/ui/bad-pixi.tsx pixi.js',
      'ui features/office/ui/bad-renderer.tsx scene/renderer (static)',
    ]);
  });
});
