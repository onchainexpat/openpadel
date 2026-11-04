// Each app ships only the keys wording.ts finds in its code. Here the type checker reads every t() call in
// each app and checks the keys it can ask for are all shipped, so no screen ever shows a bare key, and that a call
// on the first screen asks only for keys in the first part (the rest arrives after it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { en } from "../src/en.ts";
import { firstScreenFiles, keysUsed, sourceFiles } from "../src/wording.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ALL = Object.keys(en);
const STATE = join(ROOT, "packages/ui/src/state.ts");

/** The keys a t() argument can be, or null when the checker can't tell (a plain `Key`, say). */
function keysOf(arg: ts.Expression, checker: ts.TypeChecker): string[] | null {
  let e = arg;
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) {
    const p = e.head.text;
    return p.includes(".") ? ALL.filter((k) => k.startsWith(p)) : null;
  }
  if (ts.isConditionalExpression(e)) {
    const a = keysOf(e.whenTrue, checker), b = keysOf(e.whenFalse, checker);
    return a && b ? [...a, ...b] : null;
  }
  const type = checker.getTypeAtLocation(e), parts = type.isUnion() ? type.types : [type];
  if (parts.length >= ALL.length || !parts.every((x) => x.isStringLiteral())) return null;
  return parts.map((x) => (x as ts.StringLiteralType).value);
}

for (const app of ["member", "manager"]) {
  test(`${app}: every key a t() call can ask for is in the app's wording`, () => {
    const dirs = [join(ROOT, `apps/${app}/src`), join(ROOT, "packages/ui/src")];
    const shipped = new Set(keysUsed(sourceFiles(dirs), ALL).keys);
    const firstFiles = new Set(firstScreenFiles(join(ROOT, `apps/${app}/src/main.tsx`), dirs)), first = new Set(keysUsed([...firstFiles], ALL).keys);
    const config = ts.getParsedCommandLineOfConfigFile(join(ROOT, `apps/${app}/tsconfig.json`), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(String(d.messageText)); } })!;
    const program = ts.createProgram(config.fileNames, config.options), checker = program.getTypeChecker();
    const problems: string[] = [];
    let calls = 0, firstCalls = 0;
    for (const sf of program.getSourceFiles()) {
      if (!dirs.some((d) => sf.fileName.startsWith(d))) continue;
      const onFirst = firstFiles.has(sf.fileName);
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "t" && n.arguments[0]) {
          let s = checker.getSymbolAtLocation(n.expression);
          if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
          if (s?.declarations?.some((d) => d.getSourceFile().fileName === STATE)) {
            calls++;
            const where = `${sf.fileName.slice(ROOT.length)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
            const keys = keysOf(n.arguments[0], checker);
            if (!keys) problems.push(`${where}: can't tell which keys "${n.arguments[0].getText().slice(0, 60)}" can be; use a string, a ternary of strings or \`prefix.\${x}\``);
            else if (!keys.length) problems.push(`${where}: no key starts with "${n.arguments[0].getText().slice(0, 60)}"`);
            else for (const k of keys) {
              if (!shipped.has(k)) problems.push(`${where}: "${k}" isn't in the app's wording`);
              else if (onFirst && !first.has(k)) problems.push(`${where}: "${k}" is on the first screen but only in the rest of the wording`);
            }
            if (onFirst) firstCalls++;
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    assert.ok(calls > 100, `found only ${calls} t() calls; the check isn't seeing the code`);
    assert.ok(firstCalls > 50 && firstCalls < calls, `${firstCalls} of ${calls} t() calls on the first screen; the first screen's files aren't being found`);
    assert.deepEqual(problems, []);
  });
}
