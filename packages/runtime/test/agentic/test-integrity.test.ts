import { describe, expect, it } from "vitest";
import { analyzeTestIntegrity, TestIntegrityReportSchema } from "../../src/agentic/test-integrity.js";

const baseRevision = "a".repeat(40), candidateRevision = "b".repeat(40);
const wrap = (body: string, name = "works") => `import {test, expect} from 'vitest'; test('${name}', () => {${body}});`;
const compare = (base: string, candidate: string, path = "sample.test.ts") => analyzeTestIntegrity({baseRevision, candidateRevision, files:[{path, base, candidate}]});
const rules = (base: string, candidate: string, path?: string) => compare(base,candidate,path).findings.map(f=>f.ruleId);

describe("revision-relative test integrity AST analysis", () => {
  it("does not rewrite matcher-looking text inside string literals into oracle equivalence",()=>{
    expect(rules(wrap('expect(result).toBe("toBe(5)");'),wrap('expect(result).toBe("toEqual(5)");'))).toContain("TI_ASSERTION_CHANGED");
  });

  it("fails explicitly instead of truncating excessive findings into a clean report",()=>{
    expect(()=>compare(wrap("run();"),wrap("expect(1).toBe(1);".repeat(2001)))).toThrow(/report bounds/);
  });

  it("requires review for coverage unit changes between percent and uncovered count",()=>{
    expect(rules("export default {coverageThreshold:{global:{lines:90}}};","export default {coverageThreshold:{global:{lines:-100}}};","jest.config.ts")).toContain("TI_COVERAGE_RELAXED");
  });

  it("bounds report expansion from many removed assertions in one test", () => {
    const base=wrap(Array.from({length:1600},(_,i)=>`expect(x${i}).toBe(${i});`).join(""));
    const candidate=wrap(Array.from({length:1600},(_,i)=>`runProductScenario(${i});`).join(""));
    const report=compare(base,candidate);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(2_097_152);
    expect(report.findings).toHaveLength(1600);
    expect(report.findings.every(f=> (f.before?.length??0)<=512 && (f.after?.length??0)<=512)).toBe(true);
  });

  it("reports a same-subject oracle weakening with pinned revisions and source location", () => {
    const report=compare(wrap("expect(result).toBe(5);"),wrap("expect(result).toBeTruthy();"));
    expect(report.findings).toEqual([expect.objectContaining({ruleId:"TI_ASSERTION_WEAKENED", classification:"review_required", path:"sample.test.ts",side:"candidate",baseRevision,candidateRevision})]);
    expect(report.findings[0]!.line).toBe(1); expect(report.findings[0]!.column).toBeGreaterThan(0);
    expect(report.findings[0]!.before).toContain("toBe(5)"); expect(report.findings[0]!.reason).toContain("result");
    expect(TestIntegrityReportSchema.parse(report)).toEqual(report);
    expect(compare(wrap("expect(result).toBe(5);"),wrap("expect(result).toBeTruthy();"))).toEqual(report);
  });
  it("does not ban useful truthiness, existing legacy checks, comments or equivalent primitive matchers", () => {
    expect(rules(wrap("expect(result).toBe(5);"),wrap("expect(result).toEqual(5);"))).toEqual([]);
    expect(rules(wrap("expect(result).toBeTruthy();"),wrap("// changed comment\nexpect(result).toBeTruthy();"))).toEqual([]);
    expect(rules(wrap("expect(result).toBe(5);"),wrap("expect(result).toBeTruthy(); expect(result).toBe(5);"))).toEqual([]);
    expect(rules(wrap("expect(result).toBe(5);"),wrap("expect(result).toBe(5); const text='test.skip toBeTruthy'; // force: true\n"))).toEqual([]);
  });
  it("detects removed assertions and literal tautologies but never proves variable self equality", () => {
    expect(rules(wrap("expect(result).toBe(5);"),wrap("run();"))).toContain("TI_ASSERTION_REMOVED");
    const report=compare(wrap("expect(result).toBe(5);"),wrap("expect(1).toBe(1);"));
    expect(report.findings).toContainEqual(expect.objectContaining({ruleId:"TI_LITERAL_TAUTOLOGY",classification:"proven_violation"}));
    expect(compare(wrap("run();"),wrap("expect(result).toBe(result);" )).findings.every(f=>f.classification!=="proven_violation")).toBe(true);
  });
  it.each(["skip","todo","fixme","fail","failing"])("reports introduced %s without allowing comment waivers", modifier => {
    const report=compare(wrap("expect(result).toBe(5);"),`import {test,expect} from 'vitest'; // reason: developer says okay\ntest.${modifier}('works',()=>{expect(result).toBe(5);});`);
    expect(report.findings).toContainEqual(expect.objectContaining({ruleId:"TI_TEST_DISABLED",classification:"review_required"}));
  });
  it("retains conditional skip predicates for Reviewer rather than declaring a platform skip invalid", () => {
    const report=compare(wrap("run();"),`import {test} from 'vitest'; test.skipIf(process.platform === 'win32')('works',()=>{run();});`);
    expect(report.findings).toContainEqual(expect.objectContaining({ruleId:"TI_TEST_DISABLED",classification:"review_required", after:expect.stringContaining("process.platform")}));
  });
  it("detects suite disable and aliases, including Playwright runtime expected failures", () => {
    expect(rules(`import {describe,it} from 'vitest'; describe('suite',()=>{it('a',()=>run());});`,`import {describe,it} from 'vitest'; describe.skip('suite',()=>{it('a',()=>run());});`)).toContain("TI_TEST_DISABLED");
    expect(rules(`import {test as check,expect as verify} from 'vitest';check('a',()=>verify(x).toBe(5));`,`import {test as check,expect as verify} from 'vitest';check('a',()=>verify(x).toBeDefined());`)).toContain("TI_ASSERTION_WEAKENED");
    expect(rules(`import {test} from '@playwright/test';test('a',async()=>{run();});`,`import {test} from '@playwright/test';test('a',async()=>{test.fail(true, 'known bug');run();});`)).toContain("TI_TEST_DISABLED");
  });
  it("preserves moved and renamed tests using body equivalence and consumes duplicates once", () => {
    expect(analyzeTestIntegrity({baseRevision,candidateRevision,files:[{path:"old.test.ts",base:wrap("expect(result).toBe(5);","old")},{path:"new.test.ts",candidate:wrap("expect(result).toEqual(5);","new")}]}).findings).toEqual([]);
    const report=compare(wrap("run();","a")+wrap("run();","b"),wrap("run();","a"));
    expect(report.findings.filter(f=>f.ruleId==="TI_TEST_REMOVED")).toHaveLength(1);
  });
  it("reports removed tests on base but deleted fixture functions are not deleted tests", () => {
    const removed=analyzeTestIntegrity({baseRevision,candidateRevision,files:[{path:"old.test.ts",base:wrap("run();")}]}).findings;
    expect(removed).toContainEqual(expect.objectContaining({ruleId:"TI_TEST_REMOVED",side:"base"}));
    expect(analyzeTestIntegrity({baseRevision,candidateRevision,files:[{path:"tests/fixtures.ts",base:"export function fixture() { return 5; }"}]}).findings).toEqual([]);
  });
  it.each([
    ["toBeGreaterThan",10,5], ["toBeGreaterThanOrEqual",10,5], ["toBeLessThan",10,20], ["toBeLessThanOrEqual",10,20]
  ])("reports numeric relaxation %s(%s -> %s) but permits tightening", (matcher,from,to)=>{
    expect(rules(wrap(`expect(result).${matcher}(${from});`),wrap(`expect(result).${matcher}(${to});`))).toContain("TI_ASSERTION_BOUND_RELAXED");
    expect(rules(wrap(`expect(result).${matcher}(${to});`),wrap(`expect(result).${matcher}(${from});`))).toEqual([]);
  });
  it("reports config discovery changes and lower coverage with actual old/new values", () => {
    const before="export default {test:{include:['**/*.test.ts'],coverage:{thresholds:{lines:90}}}};";
    const after="export default {test:{include:['only.test.ts'],coverage:{thresholds:{lines:50}}}};";
    const report=compare(before,after,"vitest.config.ts");
    expect(report.findings).toContainEqual(expect.objectContaining({ruleId:"TI_DISCOVERY_CHANGED",classification:"review_required"}));
    expect(report.findings).toContainEqual(expect.objectContaining({ruleId:"TI_COVERAGE_RELAXED",classification:"review_required",before:"90",after:"50"}));
    expect(rules(before,before,"vitest.config.ts")).toEqual([]);
    expect(rules(after,before,"vitest.config.ts")).not.toContain("TI_COVERAGE_RELAXED");
  });
  it("reports changed package test filters without declaring all script edits invalid", () => {
    expect(rules('{"scripts":{"test":"vitest run"}}','{"scripts":{"test":"vitest run only.test.ts"}}',"package.json")).toContain("TI_DISCOVERY_CHANGED");
    expect(rules('{"scripts":{"build":"tsc"}}','{"scripts":{"build":"tsc -b"}}',"package.json")).toEqual([]);
  });
  it("reports only browser action force:true rather than arbitrary force objects", () => {
    const before="import {test} from '@playwright/test';test('browser',async({page})=>{await page.getByRole('button').click();});";
    const after=before.replace("click()","click({force:true})");
    expect(rules(before,after,"e2e/browser.spec.ts")).toContain("TI_BROWSER_ACTIONABILITY_BYPASS");
    expect(rules(wrap("const options={force:false};"),wrap("const options={force:true};"))).toEqual([]);
    expect(rules(after,after,"e2e/browser.spec.ts")).toEqual([]);
  });
  it("covers node:test and strict assert aliases", () => {
    expect(rules("import test from 'node:test';import assert from 'node:assert/strict';test('x',()=>{assert.equal(result,5);});","import test from 'node:test';import assert from 'node:assert/strict';test('x',()=>{assert.ok(result);});")).toContain("TI_ASSERTION_WEAKENED");
  });
  it("reports unsupported language and malformed source as gaps, never silently clean", () => {
    expect(compare("def test_x(): assert x == 1","def test_x(): pass","tests/test_x.py").findings).toContainEqual(expect.objectContaining({classification:"coverage_gap",ruleId:"TI_UNSUPPORTED_TEST_SYNTAX"}));
    expect(compare(wrap("run();"),"test('x',()=>{", "sample.test.ts").findings).toContainEqual(expect.objectContaining({classification:"coverage_gap",ruleId:"TI_PARSE_ERROR"}));
  });
  it("validates revisions and does not accept candidate supplied authority fields", () => {
    expect(()=>analyzeTestIntegrity({baseRevision:"HEAD",candidateRevision,files:[]})).toThrow();
    expect(()=>TestIntegrityReportSchema.parse({...compare(wrap("run();"),wrap("run();")),waivedBy:"developer"})).toThrow();
  });
  it("reports altered expected values as review-required rather than silently accepting an unproved oracle change", () => {
    expect(rules(wrap("expect(result).toBe(5);"),wrap("expect(result).toBe(6);"))).toContain("TI_ASSERTION_CHANGED");
  });
  it("does not label locally shadowed expect implementations as proven tautologies", () => {
    const report=compare(wrap("run();"),wrap("const expect=(x:number)=>({toBe:(y:number)=>save(x,y)}); expect(1).toBe(1);"));
    expect(report.findings.some(f=>f.classification==="proven_violation")).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({classification:"coverage_gap"}));
  });
  it("tracks Node strict assert named imports", () => {
    expect(rules("import test from 'node:test';import {strictEqual as equal} from 'node:assert';test('x',()=>equal(result,5));","import test from 'node:test';import {ok as check} from 'node:assert';test('x',()=>check(result));")).toContain("TI_ASSERTION_WEAKENED");
  });
  it("does not duplicate one conditional disabling call as both declaration and chained modifier", () => {
    const report=compare(wrap("run();"),"import {test} from 'vitest';test.skipIf(process.platform==='win32')('works',()=>{run();});");
    expect(report.findings.filter(f=>f.ruleId==="TI_TEST_DISABLED")).toHaveLength(1);
  });
  it("reports lost assertions when an entire suite is removed, not fake losses for its retained nested tests", () => {
    const before="import {test,describe,expect} from 'vitest';describe('suite',()=>{test('kept',()=>expect(x).toBe(1));test('lost',()=>expect(y).toBe(2));});";
    const after="import {test,describe,expect} from 'vitest';describe('suite',()=>{test('kept',()=>expect(x).toBe(1));});";
    const report=compare(before,after);
    expect(report.findings).toEqual([expect.objectContaining({ruleId:"TI_TEST_REMOVED",before:expect.stringContaining("lost")})]);
  });
  it("interprets numeric bounds through not rather than reversing tightening and relaxation", () => {
    expect(rules(wrap("expect(result).not.toBeGreaterThan(10);"),wrap("expect(result).not.toBeGreaterThan(20);"))).toContain("TI_ASSERTION_BOUND_RELAXED");
    expect(rules(wrap("expect(result).not.toBeGreaterThan(20);"),wrap("expect(result).not.toBeGreaterThan(10);"))).toEqual([]);
  });
  it("exposes changed parameterized test data as a coverage gap without counting generated test instances", () => {
    const before="import {test,expect} from 'vitest';test.each([1,2])('value %s',(value)=>expect(value).toBeGreaterThan(0));";
    const after=before.replace("[1,2]","[1]");
    expect(compare(before,after).findings).toContainEqual(expect.objectContaining({ruleId:"TI_PARAMETERIZED_TEST_DATA",classification:"coverage_gap"}));
    expect(compare(before,before).findings).toEqual([]);
  });
  it("detects focused only/fit declarations as discovery deltas", () => {
    expect(rules(wrap("run();"),"import {test} from 'vitest';test.only('works',()=>{run();});")).toContain("TI_DISCOVERY_CHANGED");
    expect(rules("it('works',()=>run());","fit('works',()=>run());")).toContain("TI_DISCOVERY_CHANGED");
  });
  it("detects Node test options disabling and retains a conditional reason for review", () => {
    const before="import test from 'node:test';test('works',()=>run());";
    expect(rules(before,"import test from 'node:test';test('works',{skip:process.platform==='win32'},()=>run());")).toContain("TI_TEST_DISABLED");
    expect(rules(before,"import test from 'node:test';test('works',{skip:false},()=>run());")).toEqual([]);
  });
  it("compares discovery and coverage nested in package.json rather than inspecting only scripts", () => {
    const before='{"jest":{"testMatch":["**/*.test.ts"],"coverageThreshold":{"global":{"lines":90}}}}';
    const after='{"jest":{"testMatch":["one.test.ts"],"coverageThreshold":{"global":{"lines":40}}}}';
    expect(rules(before,after,"package.json")).toEqual(expect.arrayContaining(["TI_DISCOVERY_CHANGED","TI_COVERAGE_RELAXED"]));
  });
  it.each([
    "import {expect} from './custom';",
    "import expect from './custom';",
    "import type {expect} from './custom';",
    "import {expect as verify} from './custom';"
  ])("never proves foreign imported assertions solely from a familiar spelling: %s", imported => {
    const identifier=imported.includes("as verify")?"verify":"expect";
    const report=compare("test('works',()=>run());",`${imported} test('works',()=>${identifier}(1).toBe(1));`);
    expect(report.findings.some(f=>f.classification==="proven_violation")).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ruleId:"TI_UNSUPPORTED_ASSERTION_API",classification:"coverage_gap"}));
  });
  it.each([
    "export default makeConfig();",
    "export default {...sharedConfig};",
    "export default {test:{include:selectedTests}};",
    "export default {test:{['include']:selectedTests}};",
    "export default {test:sharedTestConfig};",
    "module.exports = makeConfig();"
  ])("exposes opaque changed runner config rather than silently returning clean: %s", candidate => {
    const report=compare("export default {test:{include:['**/*.test.ts']}};",candidate,"vitest.config.ts");
    expect(report.findings).toContainEqual(expect.objectContaining({ruleId:"TI_OPAQUE_CONFIG",classification:"coverage_gap"}));
  });
  it("preserves supported literal defineConfig and literal configuration as analyzable", () => {
    const source="import {defineConfig} from 'vitest/config';export default defineConfig({test:{include:['**/*.test.ts']}});";
    expect(compare("",source,"vitest.config.ts").findings.some(f=>f.ruleId==="TI_OPAQUE_CONFIG")).toBe(false);
  });
});
