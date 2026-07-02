/**
 * Focused unit test for the slot resolver (`expandText`).
 * Drives the pure, exported resolver against real temp files so we validate
 * relative resolution, recursion, missing files and cycle guards without
 * needing a live pi session or model.
 *
 * Run with: bun test ./test/test-resolver.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { expandText } from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "pi-slot-"));
const promptsDir = join(root, "prompts");
const sharedDir = join(root, "shared");
mkdirSync(promptsDir, { recursive: true });
mkdirSync(sharedDir, { recursive: true });

writeFileSync(join(promptsDir, "standards.md"), "## Coding Standards\n- no any\n@{./details.md}");
writeFileSync(join(promptsDir, "details.md"), "- details line");
writeFileSync(join(sharedDir, "glossary.md"), "Glossary: alpha, beta");

test("resolves sibling + nested + parent-dir references relative to prompt file", async () => {
	const prompt = "Review this:\n@{./standards.md}\nTerms: @{../shared/glossary.md}";
	const out = await expandText(prompt, [promptsDir], 0, new Set());
	expect(out.text).toContain("## Coding Standards");
	expect(out.text).toContain("- details line"); // nested @{./details.md} inlined
	expect(out.text).toContain("Glossary: alpha, beta"); // parent-dir ref resolved
	expect(out.expansions.filter((e) => e.error).length).toBe(0);
});

test("leaves unresolved slots untouched and reports not found", async () => {
	const prompt = "Hello @{./missing.md} world";
	const out = await expandText(prompt, [promptsDir], 0, new Set());
	expect(out.text).toContain("@{./missing.md}"); // stays verbatim
	expect(out.expansions[0].error).toBe("not found");
});

test("supports absolute paths", async () => {
	const absFile = join(promptsDir, "standards.md");
	const out = await expandText(`@{${absFile}}`, ["/nonexistent"], 0, new Set());
	expect(out.text).toContain("## Coding Standards");
});

test("breaks reference cycles", async () => {
	const cycleDir = mkdtempSync(join(tmpdir(), "pi-cycle-"));
	writeFileSync(join(cycleDir, "a.md"), "A sees @{./b.md}");
	writeFileSync(join(cycleDir, "b.md"), "B sees @{./a.md}");
	const out = await expandText("@{./a.md}", [cycleDir], 0, new Set());
	expect(out.text).toContain("A sees");
	expect(out.text).toContain("B sees");
	// The cycle back to a.md must NOT be inlined again.
	expect((out.text.match(/A sees/g) || []).length).toBe(1);
	expect(out.expansions.some((e) => e.error === "cycle")).toBe(true);
	rmSync(cycleDir, { recursive: true, force: true });
});

test("does nothing when there are no slots", async () => {
	const out = await expandText("plain text with no references", [promptsDir], 0, new Set());
	expect(out.expansions.length).toBe(0);
	expect(out.text).toBe("plain text with no references");
});

process.on("exit", () => {
	rmSync(root, { recursive: true, force: true });
});
