import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

/** Locates the repository root from either `tests/` or the compiled `dist/tests/` tree. */
export function findRepoRoot(start: string = __dirname): string {
  let dir = start;
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === "arthur-core") {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Could not locate the arthur-core repository root");
    dir = parent;
  }
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "target", "gen"]);

/** Repo-relative POSIX paths of every .ts/.tsx file under `relativeDir` (empty if it does not exist). */
export function listSourceFiles(root: string, relativeDir: string): string[] {
  const start = path.join(root, relativeDir);
  if (!existsSync(start)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
      }
    }
  };
  walk(start);
  return found.sort();
}

/** Every module specifier a source file imports, re-exports, `require`s or dynamically imports. */
export function extractImports(source: string, fileName: string): string[] {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (ts.isStringLiteralLike(node.moduleReference.expression)) specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamicImport || isRequire) && argument && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

export type ResolvedImport = { kind: "internal"; path: string } | { kind: "package"; name: string };

/** Resolves a specifier found in `fromFile` (repo-relative) to a repo-relative path or a package name. */
export function resolveImport(fromFile: string, specifier: string): ResolvedImport {
  if (specifier === "@arthur/contracts" || specifier.startsWith("@arthur/contracts/")) {
    return { kind: "internal", path: `packages/contracts${specifier.slice("@arthur/contracts".length)}` };
  }
  if (specifier.startsWith(".")) {
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    return { kind: "internal", path: joined.replace(/\.[cm]?[jt]sx?$/, "") };
  }
  return { kind: "package", name: specifier };
}
