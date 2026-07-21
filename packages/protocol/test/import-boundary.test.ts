import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const protocolRoot = join(repoRoot, "packages", "protocol");
const hostRoots = [
  join(repoRoot, "packages", "host-wire"),
  join(repoRoot, "packages", "host-service"),
  join(repoRoot, "packages", "cluster-server"),
];
const scannedRoots = [join(repoRoot, "apps"), join(repoRoot, "packages")];

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "dist-electron", ".next", ".turbo", "build", ".artifacts"].includes(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}

function rawHostWireImports(path: string): string[] {
  const content = readFileSync(path, "utf8");
  if (!content.includes("@t4-code/host-wire")) return [];
  const source = ts.createSourceFile(
    path,
    content,
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
      (specifier.text === "@t4-code/host-wire" ||
        specifier.text.startsWith("@t4-code/host-wire/"))
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

describe("host-wire ownership boundary", () => {
  it("keeps raw host-wire imports inside the protocol and host packages", () => {
    const violations = scannedRoots
      .flatMap(sourceFiles)
      .filter((path) => !path.startsWith(`${protocolRoot}/`) && !hostRoots.some((root) => path.startsWith(`${root}/`)))
      .flatMap((path) =>
        rawHostWireImports(path).map((specifier) => ({
          path: relative(repoRoot, path),
          specifier,
        })),
      );

    expect(violations).toEqual([]);
  });
});
