import { createHash } from "node:crypto";
import ts from "typescript";
import { z } from "zod";

const RevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const PathSchema = z.string().min(1).max(4096).refine(value => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && value.split("/").every(part => part !== "." && part !== ".." && part !== ""), "Expected repository-relative path");
export const TestIntegrityFindingSchema = z.object({
  id: z.string().min(1), ruleId: z.string().min(1), classification: z.enum(["proven_violation", "review_required", "coverage_gap"]),
  path: PathSchema, line: z.number().int().positive(), column: z.number().int().positive(), side: z.enum(["base", "candidate"]),
  baseRevision: RevisionSchema, candidateRevision: RevisionSchema, before: z.string().optional(), after: z.string().optional(), reason: z.string().min(1)
}).strict();
export type TestIntegrityFinding = z.infer<typeof TestIntegrityFindingSchema>;
export const TestIntegrityReportSchema = z.object({version:z.literal(1),baseRevision:RevisionSchema,candidateRevision:RevisionSchema,
  findings:z.array(TestIntegrityFindingSchema),limitations:z.array(z.string())}).strict();
export type TestIntegrityReport = z.infer<typeof TestIntegrityReportSchema>;
const InputSchema = z.object({baseRevision:RevisionSchema,candidateRevision:RevisionSchema,files:z.array(z.object({path:PathSchema,previousPath:PathSchema.optional(),
  base:z.string().max(4_194_304).optional(),candidate:z.string().max(4_194_304).optional()}).strict()).max(2000)}).strict();
type Input = z.infer<typeof InputSchema>;
type Source = {path:string; side:"base"|"candidate"; file:ts.SourceFile; aliases:Map<string,string>; unsupportedImports:Set<string>; configWrappers:Set<string>; playwright:boolean; browserNames:Set<string>};
type Located = {source:Source; node:ts.Node};
type Assertion = Located & {subject:string; matcher:string; args:string[]; modifiers:string; signature:string; literal?:string; numeric?:number};
type TestCase = Located & {name:string; body:string; assertions:Assertion[]};
type Marker = Located & {key:string; ruleId:string; classification:TestIntegrityFinding["classification"]; reason:string};
type Property = Located & {key:string; value:string; numeric?:number};
type Snapshot = {tests:TestCase[];markers:Marker[];properties:Property[]};
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|e2e|playwright|cypress)\/|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go|rb|dart|exs)$|(?:Test|Tests|Spec)\.(?:java|kt|cs|php|swift|cpp|cc|cxx)$/;
const JS_PATH = /\.[cm]?[jt]sx?$/;
const CONFIG_PATH = /(?:^|\/)(?:(?:vitest|vite|jest|playwright|nyc)[^/]*(?:config|workspace)[^/]*|package\.json|\.nycrc(?:\.json)?)$/i;
const DISABLERS = new Set(["skip","skipIf","runIf","todo","fixme","fail","failing"]);
const DISCOVERY = new Set(["include","exclude","testMatch","testRegex","testPathIgnorePatterns","testNamePattern","testPathPattern","grep","grepInvert","passWithNoTests","testDir","testIgnore","testFiles","specPattern","excludeSpecPattern"]);
const BROWSER_ACTIONS = new Set(["click","dblclick","tap","check","uncheck","setChecked","fill","hover","dragTo","selectOption"]);
const STRONG = new Set(["toBe","toEqual","toStrictEqual","toMatch","toMatchObject","toContain","toContainEqual","toHaveLength","toHaveProperty","toBeGreaterThan","toBeGreaterThanOrEqual","toBeLessThan","toBeLessThanOrEqual","toBeCloseTo","toThrow","toThrowError","toBeInstanceOf","equal","strictEqual","deepEqual","deepStrictEqual","match","throws"]);
const WEAK = new Set(["toBeTruthy","toBeDefined","ok"]);
const printer = ts.createPrinter({removeComments:true});
const hash = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0,24);

/** Token normalization ignores trivia, quote style and known import aliases; it never evaluates source. */
function normalized(node:ts.Node, source:Source):string {
  const text=printer.printNode(ts.EmitHint.Unspecified,node,source.file);
  const scanner=ts.createScanner(ts.ScriptTarget.Latest,true,source.file.languageVariant,text);
  const result:string[]=[];
  for(let token=scanner.scan();token!==ts.SyntaxKind.EndOfFileToken;token=scanner.scan()) {
    let value=scanner.getTokenText();
    if(token===ts.SyntaxKind.Identifier) value=source.aliases.get(value)??value;
    if(token===ts.SyntaxKind.StringLiteral) value=JSON.stringify(scanner.getTokenValue());
    result.push(value);
  }
  return result.join(" ");
}
function primitive(node:ts.Node|undefined):string|undefined {
  if(!node) return undefined;
  if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)) return `string:${node.text}`;
  if(ts.isNumericLiteral(node)) return `number:${Number(node.text)}`;
  if(node.kind===ts.SyntaxKind.TrueKeyword) return "boolean:true";
  if(node.kind===ts.SyntaxKind.FalseKeyword) return "boolean:false";
  if(node.kind===ts.SyntaxKind.NullKeyword) return "null";
  if(ts.isPrefixUnaryExpression(node)&&node.operator===ts.SyntaxKind.MinusToken&&ts.isNumericLiteral(node.operand)) return `number:${-Number(node.operand.text)}`;
  return undefined;
}
function numeric(node:ts.Node|undefined):number|undefined { const value=primitive(node);return value?.startsWith("number:")?Number(value.slice(7)):undefined; }
function boundDelta(prior:Assertion,next:Assertion):number {
  if(prior.matcher!==next.matcher||prior.numeric===undefined||next.numeric===undefined)return 0;
  const direction=["toBeGreaterThan","toBeGreaterThanOrEqual"].includes(prior.matcher)?1:["toBeLessThan","toBeLessThanOrEqual"].includes(prior.matcher)?-1:0;
  return (next.numeric-prior.numeric)*direction*(prior.modifiers.split(".").includes("not")?-1:1);
}
function nameOf(node:ts.PropertyName):string|undefined {return ts.isIdentifier(node)||ts.isStringLiteralLike(node)||ts.isNumericLiteral(node)?node.text:undefined;}
function chain(node:ts.Expression,source:Source):{root:string;members:string[];calls:ts.CallExpression[]}|undefined {
  if(ts.isIdentifier(node)) return {root:source.aliases.get(node.text)??node.text,members:[],calls:[]};
  if(ts.isPropertyAccessExpression(node)) { const value=chain(node.expression,source);return value?{...value,members:[...value.members,node.name.text]}:undefined; }
  if(ts.isCallExpression(node)) {const value=chain(node.expression,source);return value?{...value,calls:[...value.calls,node]}:undefined;}
  return undefined;
}
function rootIdentifier(node:ts.Expression):ts.Identifier|undefined {
  if(ts.isIdentifier(node))return node;
  if(ts.isCallExpression(node)||ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node))return rootIdentifier(node.expression);
  return undefined;
}
function bindingHas(node:ts.BindingName|undefined,name:string):boolean {
  if(!node)return false;if(ts.isIdentifier(node))return node.text===name;
  return node.elements.some(element=>!ts.isOmittedExpression(element)&&bindingHas(element.name,name));
}
function locallyShadowed(name:string,node:ts.Node):boolean {
  for(let scope:ts.Node|undefined=node.parent;scope;scope=scope.parent) {
    if(ts.isFunctionLike(scope)&&scope.parameters.some(parameter=>bindingHas(parameter.name,name)))return true;
    if(ts.isBlock(scope)||ts.isSourceFile(scope))for(const statement of scope.statements) {
      if(ts.isVariableStatement(statement)&&statement.declarationList.declarations.some(declaration=>bindingHas(declaration.name,name)))return true;
      if((ts.isFunctionDeclaration(statement)||ts.isClassDeclaration(statement))&&statement.name?.text===name)return true;
    }
  }
  return false;
}
function assertion(node:ts.CallExpression,source:Source):Assertion|undefined {
  const root=rootIdentifier(node.expression);if(root&&locallyShadowed(root.text,node))return undefined;
  if(ts.isPropertyAccessExpression(node.expression)) {
    const matcher=node.expression.name.text, target=node.expression.expression;
    const identity=chain(target,source);
    if(identity?.root==="expect"&&identity.calls.length===1) {
      const expectCall=identity.calls[0]!, subjectNode=expectCall.arguments[0];if(!subjectNode) return undefined;
      const subject=normalized(subjectNode,source), args=node.arguments.map(arg=>normalized(arg,source)), modifiers=identity.members.join(".");
      const literal=primitive(node.arguments[0]), canonicalMatcher=["toBe","toEqual","toStrictEqual"].includes(matcher)&&literal!==undefined?"primitiveEqual":matcher;
      return {source,node,subject,matcher,args,modifiers,signature:JSON.stringify([subject,canonicalMatcher,args,modifiers]),...(literal===undefined?{}:{literal}),...(numeric(node.arguments[0])===undefined?{}:{numeric:numeric(node.arguments[0])!})};
    }
    if(identity?.root==="assert"&&identity.members.length===0) {
      const subjectNode=node.arguments[0];if(!subjectNode) return undefined;
      const subject=normalized(subjectNode,source), args=node.arguments.slice(1).map(arg=>normalized(arg,source));
      return {source,node,subject,matcher,args,modifiers:"",signature:JSON.stringify([subject,matcher,args]),...(primitive(node.arguments[1])===undefined?{}:{literal:primitive(node.arguments[1])!})};
    }
  }
  if(ts.isIdentifier(node.expression)) {
    const canonical=source.aliases.get(node.expression.text)??node.expression.text;
    if(canonical==="assert"||canonical.startsWith("assert.")) {
      const subjectNode=node.arguments[0];if(!subjectNode)return undefined;
      const subject=normalized(subjectNode,source), matcher=canonical==="assert"?"ok":canonical.slice(7),args=node.arguments.slice(1).map(arg=>normalized(arg,source));
      return {source,node,subject,matcher,args,modifiers:"",signature:JSON.stringify([subject,matcher,args]),...(primitive(node.arguments[1])===undefined?{}:{literal:primitive(node.arguments[1])!})};
    }
  }
  return undefined;
}
function aliases(file:ts.SourceFile):{names:Map<string,string>;unsupported:Set<string>;configWrappers:Set<string>;playwright:boolean} {
  const names=new Map<string,string>(),unsupported=new Set<string>(),configWrappers=new Set<string>();let playwright=false;
  for(const statement of file.statements) {
    if(!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier)||!statement.importClause) continue;
    const module=statement.moduleSpecifier.text, clause=statement.importClause;
    const known=["vitest","@jest/globals","@playwright/test","node:test","node:assert","node:assert/strict","assert","assert/strict"].includes(module);
    const reject=(local:string,original:string)=>{unsupported.add(local);names.set(local,`unsupported:${module}:${original}`);};
    if(module==="@playwright/test") playwright=true;
    if(clause.name) {
      if(!clause.isTypeOnly&&known&&(module.includes("assert")||module==="node:test"))names.set(clause.name.text,module.includes("assert")?"assert":"test");
      else reject(clause.name.text,"default");
    }
    if(clause.namedBindings&&ts.isNamespaceImport(clause.namedBindings))reject(clause.namedBindings.name.text,"namespace");
    if(clause.namedBindings&&ts.isNamedImports(clause.namedBindings)) for(const element of clause.namedBindings.elements) {
      const original=(element.propertyName??element.name).text;
      if(!clause.isTypeOnly&&!element.isTypeOnly&&original==="defineConfig"&&["vitest/config","vite","@playwright/test"].includes(module)) {configWrappers.add(element.name.text);names.set(element.name.text,"defineConfig");}
      else if(!known||clause.isTypeOnly||element.isTypeOnly)reject(element.name.text,original);
      else if(["test","it","describe","expect"].includes(original)) names.set(element.name.text,original);
      else if(module.includes("assert")) names.set(element.name.text,`assert.${original}`);
      else reject(element.name.text,original);
    }
  }
  return {names,unsupported,configWrappers,playwright};
}
function canonicalBody(body:ts.Node,source:Source):string {
  // These primitive equality matchers have the same oracle for the supported literal RHS.
  const text=normalized(body,source);
  return text.replace(/\b(?:toBe|toEqual|toStrictEqual)\s*\(\s*((?:-\s*)?\d+(?:\.\d+)?|true|false|null|"(?:[^"\\]|\\.)*")\s*\)/g,"primitiveEqual ( $1 )");
}
function parse(path:string,text:string,side:Source["side"]):Source {
  const kind=/\.json$/.test(path)?ts.ScriptKind.JSON:/\.tsx$/.test(path)?ts.ScriptKind.TSX:/\.jsx$/.test(path)?ts.ScriptKind.JSX:/\.[cm]?js$/.test(path)?ts.ScriptKind.JS:ts.ScriptKind.TS;
  const file=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,kind), imported=aliases(file);
  return {path,side,file,aliases:imported.names,unsupportedImports:imported.unsupported,configWrappers:imported.configWrappers,playwright:imported.playwright,browserNames:new Set(["page","browser","context"])};
}
function staticConfigValue(node:ts.Expression):boolean {
  if(primitive(node)!==undefined)return true;
  if(ts.isRegularExpressionLiteral(node))return true;
  if(ts.isArrayLiteralExpression(node))return node.elements.every(value=>!ts.isSpreadElement(value)&&staticConfigValue(value));
  if(ts.isObjectLiteralExpression(node))return node.properties.every(property=>ts.isPropertyAssignment(property)&&!ts.isComputedPropertyName(property.name)&&staticConfigValue(property.initializer));
  return false;
}
function scan(source:Source,snapshot:Snapshot):void {
  const isTestPath=TEST_PATH.test(source.path), isConfig=CONFIG_PATH.test(source.path);
  const visit=(node:ts.Node,suites:string[])=>{
    if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer) {
      const identity=chain(node.initializer,source);if(identity&&source.browserNames.has(identity.root)) source.browserNames.add(node.name.text);
    }
    let nestedSuites=suites;
    if(ts.isCallExpression(node)) {
      const identity=chain(node.expression,source);
      const calleeOfAnotherCall=ts.isCallExpression(node.parent)&&node.parent.expression===node;
      const root=rootIdentifier(node.expression), shadowed=root&&locallyShadowed(root.text,node);
      if(root&&source.unsupportedImports.has(root.text)&&identity&&
        (/:(?:expect|assert)$/.test(identity.root)||["expect","assert"].includes(root.text)||identity.members.some(member=>member==="expect"||member==="assert"))) {
        snapshot.markers.push({source,node,key:normalized(node,source),ruleId:"TI_UNSUPPORTED_ASSERTION_API",classification:"coverage_gap",reason:"The assertion-like API is imported from an unsupported module or through a type-only/namespace binding. A familiar matcher spelling does not establish runtime assertion semantics."});
      }
      const isTestApi=!calleeOfAnotherCall&&!shadowed&&identity&&["test","it","describe","xtest","xit","xdescribe","fit","ftest","fdescribe"].includes(identity.root)&&(isTestPath||source.aliases.has(identity.root)||[...source.aliases.values()].includes(identity.root));
      if(isTestApi&&identity) {
        const callback=node.arguments.find(arg=>ts.isArrowFunction(arg)||ts.isFunctionExpression(arg));
        const first=node.arguments[0], name=first&&ts.isStringLiteralLike(first)?first.text:undefined;
        if(callback&&(ts.isArrowFunction(callback)||ts.isFunctionExpression(callback))) {
          if(name!==undefined) {
            if(identity.root.endsWith("describe")) nestedSuites=[...suites,name];
            else {
              const found:Assertion[]=[];
              const walk=(child:ts.Node)=>{if(ts.isCallExpression(child)){const value=assertion(child,source);if(value)found.push(value);}ts.forEachChild(child,walk);};walk(callback.body);
              snapshot.tests.push({source,node,name:[...suites,name].join(" / "),body:canonicalBody(callback.body,source),assertions:found});
            }
          } else snapshot.markers.push({source,node,key:normalized(node,source),ruleId:"TI_DYNAMIC_TEST_IDENTITY",classification:"coverage_gap",reason:"Test name is computed; static matching cannot establish a stable test identity."});
        }
        const optionDisablers=node.arguments.flatMap(arg=>ts.isObjectLiteralExpression(arg)?arg.properties.filter((property):property is ts.PropertyAssignment=>ts.isPropertyAssignment(property)&&["skip","todo"].includes(nameOf(property.name)??"")&&property.initializer.kind!==ts.SyntaxKind.FalseKeyword):[]);
        const disabling=[...identity.members.filter(member=>DISABLERS.has(member)),...optionDisablers.map(property=>nameOf(property.name)!)];
        if(identity.root.startsWith("x")) disabling.push(identity.root);
        if(disabling.length) {
          const modifiers=[...identity.calls.map(call=>normalized(call,source)),...optionDisablers.map(property=>normalized(property,source))];
          const body=callback&&(ts.isArrowFunction(callback)||ts.isFunctionExpression(callback))?canonicalBody(callback.body,source):node.arguments.map(arg=>normalized(arg,source)).join(", ");
          snapshot.markers.push({source,node,key:JSON.stringify([disabling,modifiers,body]),ruleId:"TI_TEST_DISABLED",classification:"review_required",reason:`Introduced ${identity.root}.${disabling.join(".")} changes execution or expected-failure policy; predicate/arguments: ${modifiers.join("; ")||node.arguments.map(arg=>normalized(arg,source)).join(", ")}. Reviewer must check platform intent and coverage.`});
        }
        if(identity.members.includes("only")||identity.root.startsWith("f"))snapshot.markers.push({source,node,key:JSON.stringify([identity.root,identity.members,callback&&(ts.isArrowFunction(callback)||ts.isFunctionExpression(callback))?canonicalBody(callback.body,source):normalized(node,source)]),ruleId:"TI_DISCOVERY_CHANGED",classification:"review_required",reason:"Focused test/suite declaration (.only/fit/fdescribe) may exclude other tests from the runner's discovery. Reviewer must establish that required checks still run."});
        if(identity.members.some(member=>member==="each"||member==="for")) snapshot.markers.push({source,node,key:JSON.stringify([identity.root,identity.members,identity.calls.map(call=>normalized(call,source))]),ruleId:"TI_PARAMETERIZED_TEST_DATA",classification:"coverage_gap",reason:"Parameterized test inputs or generation changed. Static syntax analysis does not expand generated instances; Reviewer must verify retained scenario coverage."});
      }
      const value=assertion(node,source);
      if(shadowed&&identity&&(identity.root==="expect"&&identity.members.length>0||identity.root==="assert"||identity.root.startsWith("assert."))) snapshot.markers.push({source,node,key:normalized(node,source),ruleId:"TI_SHADOWED_TEST_API",classification:"coverage_gap",reason:"A local binding shadows the recognized assertion API; its semantics cannot be inferred from the matcher spelling."});
      if(value&&["toBe","toEqual","toStrictEqual","equal","strictEqual"].includes(value.matcher)&&value.modifiers==="") {
        const expected=value.literal;
        const actualNode=identity?.root==="assert"||identity?.root.startsWith("assert.")?node.arguments[0]:chain(ts.isPropertyAccessExpression(node.expression)?node.expression.expression:node.expression,source)?.calls[0]?.arguments[0];
        const actual=primitive(actualNode);
        if(actual!==undefined&&actual===expected) snapshot.markers.push({source,node,key:value.signature,ruleId:"TI_LITERAL_TAUTOLOGY",classification:"proven_violation",reason:`Both assertion operands are the same primitive literal (${actual}); this assertion cannot detect a product regression.`});
      }
      if(source.playwright&&ts.isPropertyAccessExpression(node.expression)&&BROWSER_ACTIONS.has(node.expression.name.text)) {
        const target=chain(node.expression.expression,source);
        const forced=node.arguments.some(arg=>ts.isObjectLiteralExpression(arg)&&arg.properties.some(prop=>ts.isPropertyAssignment(prop)&&nameOf(prop.name)==="force"&&prop.initializer.kind===ts.SyntaxKind.TrueKeyword));
        if(target&&source.browserNames.has(target.root)&&forced) snapshot.markers.push({source,node,key:normalized(node,source),ruleId:"TI_BROWSER_ACTIONABILITY_BYPASS",classification:"review_required",reason:`New force:true on Playwright ${node.expression.name.text} bypasses non-essential actionability checks; Reviewer must verify it does not hide an interaction defect.`});
      }
    }
    if(isConfig&&ts.isPropertyAssignment(node)) {
      const key=nameOf(node.name), value=normalized(node.initializer,source);
      if(key&&DISCOVERY.has(key)) snapshot.properties.push({source,node,key:`discovery:${key}`,value});
      if((key&&DISCOVERY.has(key)&&!staticConfigValue(node.initializer))||ts.isComputedPropertyName(node.name))snapshot.markers.push({source,node,key:normalized(node,source),ruleId:"TI_OPAQUE_CONFIG",classification:"coverage_gap",reason:"Changed discovery/configuration uses a computed property or runtime expression; effective test selection cannot be established by this static parser."});
      if(key&&["test","coverage","thresholds","coverageThreshold","projects"].includes(key)&&!staticConfigValue(node.initializer))snapshot.markers.push({source,node,key:normalized(node,source),ruleId:"TI_OPAQUE_CONFIG",classification:"coverage_gap",reason:`Configuration envelope '${key}' includes opaque values; static analysis cannot establish all effective discovery and threshold settings.`});
      if(key&&["lines","branches","functions","statements"].includes(key)) {
        let parent:ts.Node|undefined=node.parent;let coverage=false;
        while(parent) {if(ts.isPropertyAssignment(parent)&&["coverage","coverageThreshold","thresholds"].includes(nameOf(parent.name)??""))coverage=true;parent=parent.parent;}
        const number=numeric(node.initializer);if(coverage&&number!==undefined) snapshot.properties.push({source,node,key:`coverage:${key}`,value:node.initializer.getText(source.file),numeric:number});
      }
    }
    if(isConfig&&ts.isSpreadAssignment(node))snapshot.markers.push({source,node,key:normalized(node,source),ruleId:"TI_OPAQUE_CONFIG",classification:"coverage_gap",reason:"Changed runner configuration spreads another value; imported or computed discovery/threshold overrides cannot be established without executing configuration."});
    if(isConfig&&ts.isExportAssignment(node)) {
      const expression=node.expression;
      const wrapper=ts.isCallExpression(expression)&&ts.isIdentifier(expression.expression)&&source.configWrappers.has(expression.expression.text)&&expression.arguments.length===1&&ts.isObjectLiteralExpression(expression.arguments[0]!);
      if(!ts.isObjectLiteralExpression(expression)&&!wrapper)snapshot.markers.push({source,node,key:normalized(node,source),ruleId:"TI_OPAQUE_CONFIG",classification:"coverage_gap",reason:"Default runner configuration is generated by an expression outside supported literal/defineConfig forms; static comparison cannot establish effective test policy."});
    }
    if(isConfig&&ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(node.left)&&node.left.expression.getText(source.file)==="module"&&node.left.name.text==="exports"&&!ts.isObjectLiteralExpression(node.right))snapshot.markers.push({source,node,key:normalized(node,source),ruleId:"TI_OPAQUE_CONFIG",classification:"coverage_gap",reason:"CommonJS runner configuration is generated by an opaque expression; effective discovery and threshold policy require independent review."});
    ts.forEachChild(node,child=>visit(child,nestedSuites));
  };
  visit(source.file,[]);
}

/** Pure revision-to-revision analysis. Findings are evidence deltas, never source-controlled waivers. */
export function analyzeTestIntegrity(raw:Input):TestIntegrityReport {
  const input=InputSchema.parse(raw), findings:TestIntegrityFinding[]=[];
  let findingBytes=0;
  const before:Snapshot={tests:[],markers:[],properties:[]},after:Snapshot={tests:[],markers:[],properties:[]};
  const emit=(ruleId:string,classification:TestIntegrityFinding["classification"],where:Located,reason:string,old?:Located|string,newer?:Located|string)=>{
    const position=where.source.file.getLineAndCharacterOfPosition(where.node.getStart(where.source.file));
    const excerpt=(value:Located|string|undefined)=>(typeof value==="string"?value:value?.node.getText(value.source.file))?.slice(0,256);
    const oldText=excerpt(old),newText=excerpt(newer);
    const value={ruleId,classification,path:where.source.path,line:position.line+1,column:position.character+1,side:where.source.side,
      baseRevision:input.baseRevision,candidateRevision:input.candidateRevision,reason:reason.slice(0,512),...(oldText===undefined?{}:{before:oldText}),...(newText===undefined?{}:{after:newText})};
    findingBytes+=Buffer.byteLength(JSON.stringify(value))+64;
    if(findings.length>=2000||findingBytes>2_000_000)throw new Error("Test integrity report bounds exceeded; split the candidate for independent review");
    findings.push({...value,id:`ti-${hash(value)}`});
  };
  for(const file of input.files) {
    for(const side of ["base","candidate"] as const) {
      const text=side==="base"?file.base:file.candidate;if(text===undefined)continue;
      const path=side==="base"?(file.previousPath??file.path):file.path;
      if(text===(side==="base"?file.candidate:file.base)&&!file.previousPath)continue;
      if(path.endsWith("package.json")) {
        try {
          const decoded:unknown=JSON.parse(text),source=parse(path,text,side);
          if(decoded&&typeof decoded==="object"&&"scripts" in decoded&&decoded.scripts&&typeof decoded.scripts==="object")for(const [key,value]of Object.entries(decoded.scripts)) {
            if(/^(?:test|e2e)(?::|$)/.test(key)&&typeof value==="string") (side==="base"?before:after).properties.push({source,node:source.file,key:`discovery:script:${key}`,value});
          }
          scan(source,side==="base"?before:after);
        }catch {const source=parse(path,text,side);emit("TI_PARSE_ERROR","coverage_gap",{source,node:source.file},"Changed package manifest is not valid JSON; discovery configuration could not be compared.");}
        continue;
      }
      if(!JS_PATH.test(path)&&!(CONFIG_PATH.test(path)&&path.endsWith(".json"))) {
        if(TEST_PATH.test(path)&&side==="candidate") {const source=parse(path,text,side);emit("TI_UNSUPPORTED_TEST_SYNTAX","coverage_gap",{source,node:source.file},"This test language has no assertion-integrity parser. Existing behavioral-runner support does not establish static oracle coverage.");}
        else if(TEST_PATH.test(path)&&file.candidate===undefined) {const source=parse(path,text,side);emit("TI_UNSUPPORTED_TEST_SYNTAX","coverage_gap",{source,node:source.file},"Removed test uses a language without an assertion-integrity parser; Reviewer must establish replacement coverage.");}
        continue;
      }
      if(!TEST_PATH.test(path)&&!CONFIG_PATH.test(path))continue;
      const source=parse(path,text,side), diagnostics=(source.file as ts.SourceFile&{parseDiagnostics?:readonly ts.Diagnostic[]}).parseDiagnostics??[];
      if(diagnostics.length) {emit("TI_PARSE_ERROR","coverage_gap",{source,node:source.file},`Cannot parse ${side} test/configuration: ${ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText," ")}`);continue;}
      scan(source,side==="base"?before:after);
    }
  }
  // Exact body matches consume each candidate once, so moving/renaming tests cannot create a count-based deletion.
  const unmatchedAfter=new Set(after.tests), pairs:Array<[TestCase,TestCase]>=[],unmatchedBefore:TestCase[]=[];
  for(const test of before.tests) {const match=[...unmatchedAfter].find(candidate=>candidate.body===test.body);if(match){unmatchedAfter.delete(match);pairs.push([test,match]);}else unmatchedBefore.push(test);}
  for(const test of unmatchedBefore) {
    const renamed=input.files.find(file=>(file.previousPath??file.path)===test.source.path)?.path??test.source.path;
    const matches=[...unmatchedAfter].filter(candidate=>candidate.name===test.name);
    const match=matches.find(candidate=>candidate.source.path===renamed)??(matches.length===1?matches[0]:undefined);
    if(match){unmatchedAfter.delete(match);pairs.push([test,match]);}
    else emit("TI_TEST_REMOVED","review_required",test,`Base test '${test.name}' has no body-equivalent or same-identity candidate among the changed files. Check whether its behavior moved or was intentionally retired.`,test);
  }
  for(const [old,test]of pairs) {
    const remaining=new Set(test.assertions);
    for(const prior of old.assertions) {const exact=[...remaining].find(value=>value.signature===prior.signature);if(exact){remaining.delete(exact);continue;}
      const replacement=[...remaining].find(value=>value.subject===prior.subject&&value.modifiers===prior.modifiers);
      if(replacement&&STRONG.has(prior.matcher)&&WEAK.has(replacement.matcher)) {
        remaining.delete(replacement);emit("TI_ASSERTION_WEAKENED","review_required",replacement,`Assertion on ${prior.subject} changed from ${prior.matcher} to ${replacement.matcher}; the candidate accepts values rejected by the base oracle. Check equivalent coverage elsewhere.`,prior,replacement);
      } else if(replacement&&boundDelta(prior,replacement)<0) {
        remaining.delete(replacement);emit("TI_ASSERTION_BOUND_RELAXED","review_required",replacement,`Numeric ${prior.matcher} bound on ${prior.subject} changed from ${prior.numeric} to ${replacement.numeric}, admitting additional values.`,prior,replacement);
      } else if(replacement) {
        remaining.delete(replacement);
        const tighter=boundDelta(prior,replacement)>0;
        if(!tighter)emit("TI_ASSERTION_CHANGED","review_required",replacement,`The expected value or matcher for ${prior.subject} changed from ${prior.matcher}(${prior.args.join(", ")}) to ${replacement.matcher}(${replacement.args.join(", ")}); static analysis does not prove equivalence or a legitimate requirement change.`,prior,replacement);
      } else emit("TI_ASSERTION_REMOVED","review_required",test,`Base assertion on ${prior.subject} (${prior.matcher}) is absent from candidate test '${test.name}'; replacement helper or different subject requires Reviewer confirmation.`,prior,test);
    }
  }
  const markerCounts=new Map<string,number>();for(const marker of before.markers){const key=JSON.stringify([marker.ruleId,marker.key]);markerCounts.set(key,(markerCounts.get(key)??0)+1);}
  for(const marker of after.markers) {const key=JSON.stringify([marker.ruleId,marker.key]),count=markerCounts.get(key)??0;if(count){markerCounts.set(key,count-1);continue;}emit(marker.ruleId,marker.classification,marker,marker.reason,undefined,marker);}
  for(const property of after.properties) {
    const prior=before.properties.find(old=>old.source.path===property.source.path&&old.key===property.key);
    if(prior?.value===property.value)continue;
    if(property.key.startsWith("discovery:"))emit("TI_DISCOVERY_CHANGED","review_required",property,`Test discovery setting ${property.key.slice(10)} changed. Static comparison cannot determine whether the new selection preserves required coverage.`,prior?.value,property.value);
    else if(prior?.numeric!==undefined&&property.numeric!==undefined&&((prior.numeric>=0)!==(property.numeric>=0)||(prior.numeric>=0&&property.numeric>=0&&property.numeric<prior.numeric)||(prior.numeric<0&&property.numeric<prior.numeric)))emit("TI_COVERAGE_RELAXED","review_required",property,`Coverage ${property.key.slice(9)} threshold changed from ${prior.numeric} to ${property.numeric}; a reduced percent, increased uncovered-count budget or unit change requires Reviewer confirmation.`,prior.value,property.value);
  }
  for(const property of before.properties)if(!after.properties.some(candidate=>candidate.source.path===property.source.path&&candidate.key===property.key))emit(property.key.startsWith("coverage:")?"TI_COVERAGE_RELAXED":"TI_DISCOVERY_CHANGED","review_required",property,`Base ${property.key} setting was removed; Reviewer must establish effective candidate configuration.`,property.value);
  return TestIntegrityReportSchema.parse({version:1,baseRevision:input.baseRevision,candidateRevision:input.candidateRevision,findings,limitations:[
    "Static JS/TS syntax analysis for tested Vitest/Jest, Node test/assert and Playwright forms only; other runner languages have no assertion parser.",
    "No general proof of semantic test equivalence, helper assertions, dynamic test generation, computed discovery or intent. Review-required deltas are not conclusive violations.",
    "Only changed Git blobs are compared. Host must provide move counterparts and independently authenticate owner exceptions; source comments never grant waivers."
  ]});
}
