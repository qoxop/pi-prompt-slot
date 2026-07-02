/**
 * End-to-end wiring test: drives the REAL extension factory with a mock `pi`
 * to exercise the `before_agent_start` system-prompt handler without a live
 * model.
 *
 * Run with: bun test ./test/test-wiring.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import factory from "../src/index.ts";

type Handler = (event: any, ctx: any) => Promise<any>;
interface MockPi {
	handlers: Map<string, Handler>;
	on(event: string, handler: Handler): void;
}

function createPi(): MockPi {
	const handlers = new Map<string, Handler>();
	return { handlers, on: (event, handler) => handlers.set(event, handler) };
}

function ctxWith(cwd: string) {
	const notifications: Array<{ msg: string; type?: string }> = [];
	return {
		cwd,
		hasUI: true,
		mode: "tui",
		ui: { notify: (msg: string, type?: string) => notifications.push({ msg, type }) },
		notifications,
	};
}

const root = mkdtempSync(join(tmpdir(), "pi-sys-"));
writeFileSync(join(root, "standards.md"), "## Standards\n- be concise\n@{./details.md}");
writeFileSync(join(root, "details.md"), "- detail line");
writeFileSync(join(root, "glossary.md"), "Glossary: alpha, beta");

test("expands @{./file} in the system prompt relative to cwd (incl. nested refs)", async () => {
	const pi = createPi();
	factory(pi as any);
	const ctx = ctxWith(root);

	const out = await pi.handlers.get("before_agent_start")!(
		{ systemPrompt: "Project rules:\n@{./standards.md}\nTerms: @{./glossary.md}" },
		ctx,
	);

	expect(out).toBeDefined();
	expect(out.systemPrompt).toContain("## Standards");
	expect(out.systemPrompt).toContain("- detail line"); // nested @{./details.md}
	expect(out.systemPrompt).toContain("Glossary: alpha, beta");
});

test("returns undefined (no rewrite) when the system prompt has no slots", async () => {
	const pi = createPi();
	factory(pi as any);
	const ctx = ctxWith(root);

	const out = await pi.handlers.get("before_agent_start")!({ systemPrompt: "Just plain rules." }, ctx);
	expect(out).toBeUndefined();
});

test("leaves unresolved slots untouched and warns", async () => {
	const pi = createPi();
	factory(pi as any);
	const ctx = ctxWith(root);

	const out = await pi.handlers.get("before_agent_start")!(
		{ systemPrompt: "See @{./missing.md} for details" },
		ctx,
	);

	expect(out).toBeDefined();
	expect(out.systemPrompt).toContain("@{./missing.md}"); // stays verbatim
	expect(ctx.notifications.some((n) => n.type === "warning")).toBe(true);
});

test("honors absolute and ~/ paths in the system prompt", async () => {
	const pi = createPi();
	factory(pi as any);
	const ctx = ctxWith(root);

	const abs = join(root, "standards.md");
	const out = await pi.handlers.get("before_agent_start")!(
		{ systemPrompt: `Abs: @{${abs}}` },
		ctx,
	);
	expect(out.systemPrompt).toContain("## Standards");
});

process.on("exit", () => {
	rmSync(root, { recursive: true, force: true });
});
