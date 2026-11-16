import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url).href);

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? sourceFiles(path)
			: entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
	});
}

function imports(file: string): string[] {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const specifiers: string[] = [];
	function visit(node: ts.Node): void {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			specifiers.push(node.moduleSpecifier.text);
		}
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
			specifiers.push(node.arguments[0].text);
		}
		if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteral(node.argument.literal)) {
			specifiers.push(node.argument.literal.text);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return specifiers;
}

it("keeps application and domain code independent of transport, persistence and runtime adapters", () => {
	const violations: string[] = [];
	for (const file of sourceFiles(sourceRoot)) {
		const path = relative(sourceRoot, file).replaceAll("\\", "/");
		if (!/^[^/]+\/(application|domain)\//.test(path)) continue;
		for (const specifier of imports(file)) {
			const dependency = specifier.startsWith(".")
				? relative(sourceRoot, resolve(dirname(file), specifier)).replaceAll("\\", "/")
				: specifier;
			const implementation = /(^|\/)(adapters|db|composition|runtime)(\/|$)/.test(dependency);
			const http = /^(app|errors)(\.ts)?$|^platform\/http\//.test(dependency);
			const authAdapter = /^auth\/(?!policies\/)/.test(dependency);
			const framework = /^(node:|cloudflare:)|^(hono|drizzle-orm|better-auth|@better-auth|@hono|@cloudflare|@libsql|@polar-sh|better-sqlite3|ws)(\/|$)/.test(dependency);
			if (implementation || http || authAdapter || framework) {
				violations.push(`${path} -> ${specifier}`);
			}
		}
	}
	expect(violations, "Use an application port; wire its adapter in composition/").toEqual([]);
});
