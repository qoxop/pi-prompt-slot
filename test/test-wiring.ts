/**
 * End-to-end wiring test: drives the REAL extension factory with a mock `pi`
 * to exercise the `before_agent_start` system-prompt handler without a live
 * model.
 *
 * Run with: bun test ./test/test-wiring.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

// ----------------------------------------------------------------------
// Host-relative resolution (the key fix): a slot in a nested prompt file
// (e.g. `--system-prompt .pi/build-contract.md`) should resolve relative
// to THAT file's directory, not cwd — even though pi drops the source
// path by the time we see it.
// ----------------------------------------------------------------------
test("resolves a slot inside a nested prompt file relative to that file's dir", async () => {
	// Layout mimics the real-world rpa-coder repo:
	//   <root>/.pi/build-contract.md   (loaded as --system-prompt)
	//     └─ @{./contract/for_agent.md}
	//   <root>/.pi/contract/for_agent.md
	const nestedRoot = mkdtempSync(join(tmpdir(), "pi-nested-"));
	mkdirSync(join(nestedRoot, ".pi", "contract"), { recursive: true });
	const buildContract = "# Role\nYou are X.\n\n@{./contract/for_agent.md}\n";
	writeFileSync(join(nestedRoot, ".pi", "build-contract.md"), buildContract);
	writeFileSync(join(nestedRoot, ".pi", "contract", "for_agent.md"), "# Spec\n- rule 1");

	const pi = createPi();
	factory(pi as any);
	const ctx = ctxWith(nestedRoot);

	// pi already read the --system-prompt file into text; the assembled prompt
	// contains that text verbatim (plus wrapping). Simulate that.
	const assembled = `You are a coding assistant.\n\n${buildContract}\nCurrent working directory: ${nestedRoot}`;

	const out = await pi.handlers.get("before_agent_start")!(
		{ systemPrompt: assembled },
		ctx,
	);

	expect(out).toBeDefined();
	// The slot was `@{./contract/for_agent.md}` — relative to cwd this would be
	// `<root>/contract/for_agent.md` (missing). Only host-relative resolution
	// (relative to `<root>/.pi/build-contract.md`) reaches the real file.
	expect(out.systemPrompt).toContain("# Spec");
	expect(out.systemPrompt).toContain("- rule 1");
	expect(out.systemPrompt).not.toContain("@{./contract/for_agent.md}");
	rmSync(nestedRoot, { recursive: true, force: true });
});

test("uses contextFiles metadata (AGENTS.md-style) as an authoritative source index", async () => {
	// AGENTS.md lives at <root>/subproj/AGENTS.md and references a sibling file.
	const cxRoot = mkdtempSync(join(tmpdir(), "pi-cx-"));
	mkdirSync(join(cxRoot, "subproj"), { recursive: true });
	const agentsMd = "# Agents\n\nSee @{./guide.md} for details.\n";
	writeFileSync(join(cxRoot, "subproj", "AGENTS.md"), agentsMd);
	writeFileSync(join(cxRoot, "subproj", "guide.md"), "guide body text");

	const pi = createPi();
	factory(pi as any);
	const ctx = ctxWith(cxRoot);

	// Simulate pi's system prompt: the AGENTS.md content is embedded verbatim
	// inside a <project_instructions path=...> wrapper.
	const assembled =
		`You are a coding assistant.\n\n<project_context>\n\n` +
		`<project_instructions path="${join(cxRoot, "subproj", "AGENTS.md")}">\n` +
		`${agentsMd}\n</project_instructions>\n\n</project_context>\n`;

	const out = await pi.handlers.get("before_agent_start")!(
		{
			systemPrompt: assembled,
			systemPromptOptions: {
				cwd: cxRoot,
				contextFiles: [{ path: join(cxRoot, "subproj", "AGENTS.md"), content: agentsMd }],
			},
		},
		ctx,
	);

	expect(out).toBeDefined();
	expect(out.systemPrompt).toContain("guide body text");
	expect(out.systemPrompt).not.toContain("@{./guide.md}");
	rmSync(cxRoot, { recursive: true, force: true });
});

test("falls back to cwd for slots not attributable to any host file", async () => {
	// A slot injected via --append-system-prompt from an inline string has no
	// physical source file — it must fall back to cwd resolution.
	const fbRoot = mkdtempSync(join(tmpdir(), "pi-fb-"));
	writeFileSync(join(fbRoot, "notes.md"), "notes body");

	const pi = createPi();
	factory(pi as any);
	const ctx = ctxWith(fbRoot);

	const out = await pi.handlers.get("before_agent_start")!(
		{ systemPrompt: `Header only\n\nRefs: @{./notes.md}` },
		ctx,
	);
	expect(out.systemPrompt).toContain("notes body");
	rmSync(fbRoot, { recursive: true, force: true });
});

process.on("exit", () => {
	rmSync(root, { recursive: true, force: true });
});
