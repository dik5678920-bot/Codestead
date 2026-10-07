import ts from "typescript";

type Target = "process" | "exec" | "spawn" | "eval" | "global";
const processModule = (value: string) => value === "child_process" || value === "node:child_process";
const processMember = (value: string): Target | undefined =>
  value === "exec" || value === "execSync" ? "exec" : value === "spawn" || value === "spawnSync" ? "spawn" : undefined;

function javascriptExecutionLines(text: string, extension: string): number[] {
  const filename = `review${extension}`;
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true,
    extension === ".tsx" ? ts.ScriptKind.TSX : extension === ".jsx" ? ts.ScriptKind.JSX : ts.ScriptKind.TS);
  // Resolve lexical bindings without loading libraries, resolving imports, or
  // reading any repository file. Submitted code is parsed, never executed.
  const host: ts.CompilerHost = {
    getSourceFile: (name) => name === filename ? source : undefined,
    getDefaultLibFileName: () => "",
    writeFile: () => undefined,
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => name === filename,
    readFile: (name) => name === filename ? text : undefined,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const checker = ts.createProgram([filename], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
  function unwrap(expression: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)
      || ts.isSatisfiesExpression(expression) || ts.isAwaitExpression(expression)) expression = expression.expression;
    return expression;
  }
  function importedModule(node: ts.Node): string | undefined {
    for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
      if (ts.isImportDeclaration(parent) && ts.isStringLiteral(parent.moduleSpecifier)) return parent.moduleSpecifier.text;
    }
  }
  function target(expression: ts.Expression, seen = new Set<ts.Symbol>()): Target | undefined {
    expression = unwrap(expression);
    if (ts.isIdentifier(expression)) {
      const symbol = ts.isShorthandPropertyAssignment(expression.parent)
        ? checker.getShorthandAssignmentValueSymbol(expression.parent) : checker.getSymbolAtLocation(expression);
      if (!symbol?.declarations?.length) return expression.text === "eval" || expression.text === "Function" ? "eval"
        : ["globalThis", "global", "window"].includes(expression.text) ? "global" : undefined;
      if (seen.has(symbol)) return;
      seen.add(symbol);
      for (const declaration of symbol.declarations ?? []) {
        if (ts.isImportSpecifier(declaration) && processModule(importedModule(declaration) ?? "")) {
          return processMember((declaration.propertyName ?? declaration.name).text);
        }
        if ((ts.isNamespaceImport(declaration) || ts.isImportClause(declaration))
          && processModule(importedModule(declaration) ?? "")) return "process";
        if (ts.isImportEqualsDeclaration(declaration) && ts.isExternalModuleReference(declaration.moduleReference)
          && declaration.moduleReference.expression && ts.isStringLiteral(declaration.moduleReference.expression)
          && processModule(declaration.moduleReference.expression.text)) return "process";
        if (ts.isVariableDeclaration(declaration) && declaration.initializer) return target(declaration.initializer, seen);
        if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
          const variable = declaration.parent.parent;
          if (ts.isVariableDeclaration(variable) && variable.initializer && target(variable.initializer, seen) === "process") {
            const name = declaration.propertyName ?? declaration.name;
            if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return processMember(name.text);
          }
        }
      }
      return;
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const name = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
      const receiver = target(expression.expression, seen);
      if (receiver === "process" && name) return processMember(name);
      if (receiver === "global" && (name === "eval" || name === "Function")) return "eval";
      if ((name === "call" || name === "apply") && (receiver === "exec" || receiver === "eval")) return receiver;
      return;
    }
    if (ts.isCallExpression(expression) && expression.arguments.length === 1
      && ts.isStringLiteralLike(expression.arguments[0]) && processModule(expression.arguments[0].text)
      && (expression.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(expression.expression) && expression.expression.text === "require"
          && !checker.getSymbolAtLocation(expression.expression)))) return "process";
  }
  function initializer(expression: ts.Expression, seen = new Set<ts.Symbol>()): ts.Expression {
    expression = unwrap(expression);
    if (ts.isIdentifier(expression)) {
      const symbol = ts.isShorthandPropertyAssignment(expression.parent)
        ? checker.getShorthandAssignmentValueSymbol(expression.parent) : checker.getSymbolAtLocation(expression);
      if (symbol && !seen.has(symbol)) {
        seen.add(symbol);
        const variable = symbol.valueDeclaration;
        if (variable && ts.isVariableDeclaration(variable) && variable.initializer) return initializer(variable.initializer, seen);
      }
    }
    return expression;
  }
  function shellEnabled(expression: ts.Expression, seen = new Set<ts.Expression>()): boolean | undefined {
    expression = initializer(expression);
    if (!ts.isObjectLiteralExpression(expression) || seen.has(expression)) return undefined;
    seen.add(expression);
    let shell: boolean | undefined;
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spreadShell = shellEnabled(property.expression, new Set(seen));
        if (spreadShell !== undefined) shell = spreadShell;
        continue;
      }
      const name = property.name;
      if (!name || (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) || name.text !== "shell") continue;
      const value = ts.isPropertyAssignment(property) ? initializer(property.initializer)
        : ts.isShorthandPropertyAssignment(property) ? initializer(property.name) : undefined;
      shell = value?.kind === ts.SyntaxKind.TrueKeyword || Boolean(value && ts.isStringLiteralLike(value) && value.text);
    }
    return shell;
  }
  const lines = new Set<number>();
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = target(node.expression);
      if (callee === "eval" || (ts.isCallExpression(node) && (callee === "exec"
        || (callee === "spawn" && node.arguments.slice(1).some((argument) => shellEnabled(argument) === true))))) {
        lines.add(source.getLineAndCharacterOfPosition(node.expression.getStart(source)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...lines].sort((a, b) => a - b);
}

/** Mask non-code while retaining offsets/newlines for accurate finding lines. */
function maskNonCode(text: string, python: boolean): string {
  const output = text.split("");
  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) if (text[i] !== "\n" && text[i] !== "\r") output[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const start = i;
    if ((python && text[i] === "#") || (!python && text.startsWith("//", i))) {
      while (i < text.length && text[i] !== "\n") i++;
      blank(start, i);
    } else if (!python && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      blank(start, i);
    } else if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      const delimiter = text.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
      i += delimiter.length;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text.startsWith(delimiter, i)) { i += delimiter.length; break; }
        i++;
      }
      blank(start, Math.min(i, text.length));
    } else i++;
  }
  return output.join("");
}

function pythonShellArgument(code: string, start: number): boolean {
  let depth = 0;
  let argumentStart = start;
  for (let i = start; i < code.length; i++) {
    const character = code[i];
    if ((character === "," || character === ")") && depth === 0) {
      if (/^\s*shell\s*=\s*True\s*$/.test(code.slice(argumentStart, i))) return true;
      if (character === ")") return false;
      argumentStart = i + 1;
    } else if ("([{".includes(character)) depth++;
    else if (")]}".includes(character)) depth--;
  }
  return false;
}

export function dynamicExecutionLines(pathname: string, text: string): number[] {
  const extension = pathname.slice(pathname.lastIndexOf(".")).toLowerCase();
  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"].includes(extension)) {
    return javascriptExecutionLines(text, extension);
  }
  if (extension !== ".py" && extension !== ".java") return [];
  const code = maskNonCode(text, extension === ".py");
  const lines = new Set<number>();
  const add = (offset: number) => lines.add(code.slice(0, offset).split("\n").length);
  if (extension === ".java") {
    for (const match of code.matchAll(/\b(?:java\s*\.\s*lang\s*\.\s*)?Runtime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec\s*\(/g)) add(match.index);
  } else {
    for (const match of code.matchAll(/\bos\s*\.\s*system\s*\(|\b(?:eval|exec)\s*\(/g)) {
      if (!code.slice(0, match.index).trimEnd().endsWith(".")) add(match.index);
    }
    for (const match of code.matchAll(/\bsubprocess\s*(?:\.\s*(?:run|call|Popen|check_call|check_output))?\s*\(/g)) {
      if (pythonShellArgument(code, match.index + match[0].length)) add(match.index);
    }
  }
  return [...lines].sort((a, b) => a - b);
}
