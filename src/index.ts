/**
 * pi-prompt-slot
 * --------------
 * A pi extension that inlines `@{<path>}` slot references found in the
 * **system prompt** into the prompt text.
 *
 * When the system prompt contains a slot like `@{./docs/standards.md}` or
 * `@{./glossary.md}`, the referenced file's text is loaded and spliced in,
 * in place of the slot. This covers everything pi assembles into the system
 * prompt: `--system-prompt` / `--append-system-prompt`, `SYSTEM.md` /
 * `APPEND_SYSTEM.md`, and `AGENTS.md` / `CLAUDE.md` context files.
 *
 * Scope (by design):
 *   - ✅ System prompt (system-prompt, append-system-prompt, AGENTS.md, …)
 *   - ❌ User-typed input, prompt templates (`/template`), tool prompts
 *
 * Path resolution:
 *   The system prompt is a concatenation of several files, so after assembly
 *   the origin of any given slot can no longer be recovered. Relative paths
 *   are therefore resolved against the working directory (the project root,
 *   where AGENTS.md typically lives). Absolute paths and `~/`-prefixed paths
 *   are honored as-is. Slots are resolved recursively (a referenced file may
 *   itself contain slots, resolved relative to that file's own directory),
 *   with depth + cycle guards and a per-file size cap.
 *
 * Hook: `before_agent_start` rewrites `event.systemPrompt` once per user
 * prompt (idempotent; an mtime cache keeps it cheap across turns).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative as relativePath } from "node:path";

/** Existence check for slots (non-global => safe to use with .test()). */
const HAS_SLOT = /@\{[^}]+\}/;

/** Max nesting depth for recursive slot resolution. */
const MAX_DEPTH = 10;
/** Skip files larger than this to avoid blowing up the context. */
const MAX_FILE_BYTES = 512 * 1024; // 512 KB

type NotifyLevel = "info" | "warning" | "error";

interface Expansion {
	/** The raw reference text inside `@{...}`. */
	ref: string;
	/** Absolute path that was loaded, or "" if not found. */
	resolved: string;
	/** Error reason when the slot could not be expanded. */
	error?: string;
	/** Loaded size in bytes (0 when nothing loaded). */
	bytes: number;
}

interface ExpandOutcome {
	text: string;
	expansions: Expansion[];
}

/** In-memory file cache (path -> {mtime, text}) so repeated turns stay cheap. */
const fileCache = new Map<string, { mtimeMs: number; text: string }>();

export default function promptSlotExtension(pi: ExtensionAPI) {
	// ------------------------------------------------------------------
	// before_agent_start: expand slots in the system prompt
	// ------------------------------------------------------------------
	pi.on("before_agent_start", async (event, ctx) => {
		const systemPrompt = event.systemPrompt;
		if (!systemPrompt || !HAS_SLOT.test(systemPrompt)) return undefined;

		// System prompt slots resolve relative to the project root (cwd).
		const outcome = await expandText(systemPrompt, [ctx.cwd], 0, new Set());
		if (outcome.expansions.length === 0) return undefined;

		notify(ctx, outcome.expansions);
		return { systemPrompt: outcome.text };
	});

	// ------------------------------------------------------------------
	// helpers
	// ------------------------------------------------------------------

	function notify(
		ctx: { hasUI?: boolean; cwd: string; ui: { notify: (msg: string, type?: NotifyLevel) => void } },
		expansions: Expansion[],
	) {
		if (!ctx.hasUI) return;
		const ok = expansions.filter((e) => !e.error);
		const failed = expansions.filter((e) => e.error);
		const lines: string[] = [];
		if (ok.length) lines.push(`Inlined ${ok.length} system-prompt slot(s):`, ...summarize(ok, ctx.cwd));
		if (failed.length) lines.push(`Could not resolve ${failed.length} slot(s):`, ...summarize(failed, ctx.cwd));
		ctx.ui.notify(lines.join("\n"), failed.length ? "warning" : "info");
	}

	function summarize(expansions: Expansion[], cwd: string): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const e of expansions) {
			const key = e.resolved || e.ref;
			if (seen.has(key)) continue;
			seen.add(key);
			let display: string;
			if (e.resolved) {
				const rel = relativePath(cwd, e.resolved);
				display = rel && !rel.startsWith("..") ? rel : e.resolved;
			} else {
				display = "(not found)";
			}
			out.push(`  • @{${e.ref}}${e.error ? ` [${e.error}]` : ""} → ${display}`);
		}
		return out;
	}
}

// ----------------------------------------------------------------------
// Module-level resolution helpers (pure, no pi state)
// ----------------------------------------------------------------------

/**
 * Resolve every `@{ref}` in `text`. Candidate directories are searched in
 * order; the first existing match wins. Loaded content is scanned again for
 * nested slots, resolved relative to that file's own directory. `visiting`
 * breaks reference cycles and `depth` caps runaway recursion.
 */
export async function expandText(
	text: string,
	candidateDirs: string[],
	depth: number,
	visiting: Set<string>,
): Promise<ExpandOutcome> {
	if (depth > MAX_DEPTH) return { text, expansions: [] };

	// Local /g regex so recursion/parallel calls never share lastIndex state.
	const re = /@\{\s*([^}]+?)\s*\}/g;
	const matches = [...text.matchAll(re)];
	if (matches.length === 0) return { text, expansions: [] };

	const expansions: Expansion[] = [];
	const parts: string[] = [];
	let cursor = 0;

	for (const match of matches) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		parts.push(text.slice(cursor, start));
		cursor = end;

		const rawRef = (match[1] ?? "").trim();
		if (!rawRef) {
			parts.push(match[0]);
			continue;
		}

		const ref = expandTilde(rawRef);

		// Locate the file: absolute path as-is, else search candidate dirs.
		let resolved: string | null = null;
		if (isAbsolute(ref)) {
			resolved = (await pathReadable(ref)) ? ref : null;
		} else {
			for (const base of candidateDirs) {
				const candidate = join(base, ref);
				if (await pathReadable(candidate)) {
					resolved = candidate;
					break;
				}
			}
		}

		if (!resolved) {
			expansions.push({ ref: rawRef, resolved: "", bytes: 0, error: "not found" });
			parts.push(match[0]); // leave the slot untouched in the output
			continue;
		}

		if (visiting.has(resolved)) {
			expansions.push({ ref: rawRef, resolved, bytes: 0, error: "cycle" });
			parts.push(match[0]);
			continue;
		}

		const loaded = await readSlotFile(resolved);
		if (!loaded) {
			expansions.push({ ref: rawRef, resolved, bytes: 0, error: "unreadable/too large" });
			parts.push(match[0]);
			continue;
		}

		// Recurse: nested slots resolve relative to THIS file's directory first.
		const nextDirs = [dirname(resolved), ...candidateDirs];
		const inner = await expandText(loaded.text, nextDirs, depth + 1, new Set(visiting).add(resolved));
		expansions.push({ ref: rawRef, resolved, bytes: loaded.bytes });
		expansions.push(...inner.expansions);
		parts.push(inner.text);
	}

	parts.push(text.slice(cursor));
	return { text: parts.join(""), expansions };
}

/** Read a file with a size cap and an mtime-based cache. */
async function readSlotFile(p: string): Promise<{ text: string; bytes: number } | null> {
	try {
		const st = await stat(p);
		const cached = fileCache.get(p);
		if (cached && cached.mtimeMs === st.mtimeMs) {
			return { text: cached.text, bytes: Buffer.byteLength(cached.text, "utf8") };
		}
		if (st.size > MAX_FILE_BYTES) return null;
		const text = await readFile(p, "utf8");
		fileCache.set(p, { mtimeMs: st.mtimeMs, text });
		return { text, bytes: st.size };
	} catch {
		return null;
	}
}

async function pathReadable(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

function expandTilde(ref: string): string {
	if (ref === "~") return homedir();
	if (ref.startsWith("~/")) return join(homedir(), ref.slice(2));
	return ref;
}
