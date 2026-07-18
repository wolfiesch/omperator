import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const protocolRoot = join(repoRoot, "packages", "protocol");
const scannedRoots = [join(repoRoot, "apps"), join(repoRoot, "packages")];

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}

function rawAppWireImports(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports: string[] = [];
  const record = (specifier: ts.Expression | ts.TypeNode | undefined): void => {
    if (
      specifier !== undefined &&
      ts.isLiteralTypeNode(specifier) &&
      ts.isStringLiteral(specifier.literal)
    ) {
      record(specifier.literal);
      return;
    }
    if (
      specifier !== undefined &&
      ts.isStringLiteral(specifier) &&
      (specifier.text === "@oh-my-pi/app-wire" ||
        specifier.text.startsWith("@oh-my-pi/app-wire/"))
    ) {
      imports.push(specifier.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      record(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node)) {
      record(node.argument);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      record(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

describe("app-wire ownership boundary", () => {
  it("keeps raw app-wire imports inside @t4-code/protocol", () => {
    const violations = scannedRoots
      .flatMap(sourceFiles)
      .filter((path) => !path.startsWith(`${protocolRoot}/`))
      .flatMap((path) =>
        rawAppWireImports(path).map((specifier) => ({
          path: relative(repoRoot, path),
          specifier,
        })),
      );

    expect(violations).toEqual([]);
  });
});
