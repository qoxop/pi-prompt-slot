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
 *   Each slot is resolved **relative to the source file that contains it**
 *   whenever we can identify that source file — the natural, least-surprise
 *   behavior. Because pi assembles the system prompt from several files and
 *   drops most origin metadata by the time extensions see it, we recover the
 *   mapping by content-matching: at handler time we build an index of
 *   candidate source files (contextFiles from `systemPromptOptions`, plus a
 *   bounded scan of `.md` files under the cwd), locate each one's byte range
 *   inside the assembled prompt via `indexOf`, and for every `@{...}` we look
 *   up which range it falls into and prepend that file's directory to the
 *   candidate search path. Slots outside any known range fall back to the
 *   working directory. Absolute and `~/`-prefixed paths are honored as-is.
 *   Nested slots inside a resolved file are resolved relative to that file's
 *   directory (unchanged), with depth + cycle guards and a per-file size cap.
 *
 * Hook: `before_agent_start` rewrites `event.systemPrompt` once per user
 * prompt (idempotent; an mtime cache keeps it cheap across turns).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative as relativePath } from "node:path";

/** Existence check for slots (non-global => safe to use with .test()). */
const HAS_SLOT = /@\{[^}]+\}/;

/** Max nesting depth for recursive slot resolution. */
const MAX_DEPTH = 10;
/** Skip files larger than this to avoid blowing up the context. */
const MAX_FILE_BYTES = 512 * 1024; // 512 KB

// -- Source-index scan limits (per handler invocation) --
/** Max directory depth walked when hunting for candidate host files. */
const SCAN_MAX_DEPTH = 5;
/** Hard cap on how many files we ever open in one scan. */
const SCAN_MAX_FILES = 800;
/** Directories we never descend into. */
const SCAN_SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	".turbo",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	"target",
	"coverage",
]);
/** File extensions considered as potential slot hosts. */
const SCAN_INCLUDE_EXT = new Set([".md", ".markdown", ".mdx", ".txt"]);

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
	/** Absolute path of the file that hosts this slot, if known. */
	host?: string;
}

interface ExpandOutcome {
	text: string;
	expansions: Expansion[];
}

/** In-memory file cache (path -> {mtime, text}) so repeated turns stay cheap. */
const fileCache = new Map<string, { mtimeMs: number; text: string }>();

/** A byte range inside the assembled system prompt that maps back to a source file. */
interface SourceInterval {
	path: string;
	dir: string;
	start: number;
	end: number;
}

/**
 * Resolve a slot position (in the top-level prompt) to its host file's directory.
 * Returns null when no known source file covers that position.
 */
export type HostLookup = (positionInText: number) => string | null;

export default function promptSlotExtension(pi: ExtensionAPI) {
	// ------------------------------------------------------------------
	// before_agent_start: expand slots in the system prompt
	// ------------------------------------------------------------------
	pi.on("before_agent_start", async (event, ctx) => {
		const systemPrompt = event.systemPrompt;
		if (!systemPrompt || !HAS_SLOT.test(systemPrompt)) return undefined;

		// Build a source index so each slot can be resolved relative to the file
		// that actually contains it (see module header). Falls back to cwd for
		// slots we cannot attribute to any known source file.
		const contextFiles = (event as any).systemPromptOptions?.contextFiles as
			| Array<{ path: string; content: string }>
			| undefined;
		const intervals = await buildSourceIndex(systemPrompt, ctx.cwd, contextFiles);
		const hostLookup: HostLookup = (pos) => findHostDir(intervals, pos);

		const outcome = await expandText(systemPrompt, [ctx.cwd], 0, new Set(), hostLookup);
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
			const host = e.host ? ` [host: ${displayPath(e.host, cwd)}]` : "";
			out.push(`  • @{${e.ref}}${e.error ? ` [${e.error}]` : ""} → ${display}${host}`);
		}
		return out;
	}

	function displayPath(p: string, cwd: string): string {
		const rel = relativePath(cwd, p);
		return rel && !rel.startsWith("..") ? rel : p;
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
 *
 * The optional `hostLookup` is applied only at the top-level call: for each
 * slot, if we can attribute it to a known source file, that file's directory
 * is prepended to `candidateDirs` for just this one slot. Nested recursion
 * uses the standard `dirname(resolved)` chain instead.
 */
export async function expandText(
	text: string,
	candidateDirs: string[],
	depth: number,
	visiting: Set<string>,
	hostLookup?: HostLookup,
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
		const hostDir = hostLookup ? hostLookup(start) : null;
		// Per-slot search path: host dir first (if known), then whatever was passed in.
		const dirs = hostDir ? [hostDir, ...candidateDirs] : candidateDirs;

		// Locate the file: absolute path as-is, else search candidate dirs.
		let resolved: string | null = null;
		if (isAbsolute(ref)) {
			resolved = (await pathReadable(ref)) ? ref : null;
		} else {
			for (const base of dirs) {
				const candidate = join(base, ref);
				if (await pathReadable(candidate)) {
					resolved = candidate;
					break;
				}
			}
		}

		if (!resolved) {
			expansions.push({ ref: rawRef, resolved: "", bytes: 0, host: hostDir ?? undefined, error: "not found" });
			parts.push(match[0]); // leave the slot untouched in the output
			continue;
		}

		if (visiting.has(resolved)) {
			expansions.push({ ref: rawRef, resolved, bytes: 0, host: hostDir ?? undefined, error: "cycle" });
			parts.push(match[0]);
			continue;
		}

		const loaded = await readSlotFile(resolved);
		if (!loaded) {
			expansions.push({
				ref: rawRef,
				resolved,
				bytes: 0,
				host: hostDir ?? undefined,
				error: "unreadable/too large",
			});
			parts.push(match[0]);
			continue;
		}

		// Recurse: nested slots resolve relative to THIS file's directory first.
		// hostLookup is NOT propagated — it applies to the top-level assembled
		// prompt only; nested resolution follows the dirname(resolved) chain.
		const nextDirs = [dirname(resolved), ...candidateDirs];
		const inner = await expandText(loaded.text, nextDirs, depth + 1, new Set(visiting).add(resolved));
		expansions.push({ ref: rawRef, resolved, bytes: loaded.bytes, host: hostDir ?? undefined });
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

// ----------------------------------------------------------------------
// Source index: map prompt byte ranges back to their originating files
// ----------------------------------------------------------------------

/**
 * Build a list of prompt byte ranges that correspond to known source files.
 * The list is sorted so that narrower/later-added entries win ties in
 * `findHostDir` (a more specific match should override a broader one).
 */
export async function buildSourceIndex(
	systemPrompt: string,
	cwd: string,
	contextFiles?: Array<{ path: string; content: string }>,
): Promise<SourceInterval[]> {
	const intervals: SourceInterval[] = [];
	const seenPaths = new Set<string>();

	// 1. Files pi already knows about (AGENTS.md/CLAUDE.md). Path is authoritative.
	for (const cf of contextFiles ?? []) {
		if (!cf?.path || !cf?.content) continue;
		if (seenPaths.has(cf.path)) continue;
		if (!HAS_SLOT.test(cf.content)) {
			// still add — a no-slot host is fine, just useless for lookup.
			// We skip it to keep intervals lean.
			seenPaths.add(cf.path);
			continue;
		}
		const start = systemPrompt.indexOf(cf.content);
		if (start >= 0) {
			intervals.push({ path: cf.path, dir: dirname(cf.path), start, end: start + cf.content.length });
			seenPaths.add(cf.path);
		}
	}

	// 2. Bounded scan of markdown-ish files under cwd. Only files that
	//    themselves contain a slot can host one, so we filter aggressively.
	try {
		const candidates = await scanMarkdownFiles(cwd);
		for (const c of candidates) {
			if (seenPaths.has(c.path)) continue;
			if (!HAS_SLOT.test(c.content)) continue;
			const start = systemPrompt.indexOf(c.content);
			if (start >= 0) {
				intervals.push({ path: c.path, dir: dirname(c.path), start, end: start + c.content.length });
				seenPaths.add(c.path);
			}
		}
	} catch {
		// Scan errors are non-fatal — we just lose the ability to attribute
		// some slots to their host file; the extension still works via cwd.
	}

	// Narrower ranges are more specific — sort by (end - start) ASC so
	// findHostDir picks the tightest containing range first.
	intervals.sort((a, b) => a.end - a.start - (b.end - b.start));
	return intervals;
}

/** Find the tightest source interval containing `pos`, or null. */
export function findHostDir(intervals: SourceInterval[], pos: number): string | null {
	for (const iv of intervals) {
		if (pos >= iv.start && pos < iv.end) return iv.dir;
	}
	return null;
}

/**
 * Bounded recursive walk under `root`, returning candidate host files
 * (markdown-ish, small enough, not under skip dirs). Uses the same mtime
 * cache as slot resolution to stay cheap across turns.
 */
async function scanMarkdownFiles(root: string): Promise<Array<{ path: string; content: string }>> {
	const out: Array<{ path: string; content: string }> = [];
	let visited = 0;

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > SCAN_MAX_DEPTH) return;
		if (out.length >= SCAN_MAX_FILES) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			if (out.length >= SCAN_MAX_FILES) return;
			if (ent.name.startsWith(".") && ent.name !== "." && ent.name !== ".pi") {
				// Skip most dotfiles/dotdirs to avoid dep caches; keep `.pi` because
				// project prompts often live there.
				if (ent.isDirectory()) continue;
			}
			const full = join(dir, ent.name);
			if (ent.isDirectory()) {
				if (SCAN_SKIP_DIRS.has(ent.name)) continue;
				await walk(full, depth + 1);
				continue;
			}
			if (!ent.isFile()) continue;
			const dot = ent.name.lastIndexOf(".");
			const ext = dot >= 0 ? ent.name.slice(dot).toLowerCase() : "";
			if (!SCAN_INCLUDE_EXT.has(ext)) continue;
			visited++;
			const loaded = await readSlotFile(full);
			if (!loaded) continue;
			out.push({ path: full, content: loaded.text });
		}
	}

	await walk(root, 0);
	return out;
}
