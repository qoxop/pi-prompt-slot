# pi-prompt-slot

A [pi](https://pi.dev) extension that inlines **`@{<path>}`** slot references into the
**system prompt**.

When the system prompt contains a slot like `@{./docs/standards.md}` or
`@{./glossary.md}`, the referenced file's text is loaded and spliced in, in
place of the slot. This covers everything pi assembles into the system prompt:
`--system-prompt` / `--append-system-prompt`, `SYSTEM.md` / `APPEND_SYSTEM.md`,
and `AGENTS.md` / `CLAUDE.md` context files.

```markdown
<!-- AGENTS.md -->
You are an expert reviewer. Always follow the project standards:

@{./docs/standards.md}

Glossary of domain terms:
@{./docs/glossary.md}
```

On startup the referenced files are inlined into the system prompt before it
reaches the model.

## Scope

| Source | Processed? |
|--------|-----------|
| System prompt (`--system-prompt`, `--append-system-prompt`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md`/`CLAUDE.md`) | ✅ |
| User-typed input | ❌ |
| Prompt templates (`/template`) | ❌ |
| Tool prompts (`promptSnippet` / `promptGuidelines`) | ❌ |

If you need slot expansion for prompt templates too, that can be added later
(it requires correlating a `/template` invocation in the `input` event with the
expanded body that only appears later in the `context` event).

## Slot syntax

```
@{<path>}
```

- `path` may be relative (`./foo.md`, `../bar/baz.txt`, `sub/file.md`),
  absolute (`/etc/hosts`), or home-relative (`~/notes.md`).
- Whitespace inside the braces is trimmed: `@{ ./foo.md }` ≡ `@{./foo.md}`.
- The braces make this distinct from pi's built-in `@file` argument syntax, so the
  two never collide.

## How paths resolve

The system prompt is a concatenation of several files, so once pi assembles it
the origin of any given slot can no longer be recovered. Relative paths are
therefore resolved against the **working directory** (the project root, where
`AGENTS.md` typically lives). The search order is:

1. The current working directory.
2. (For nested slots) the directory of the file currently being inlined.

Absolute paths (`/etc/...`) and home-relative paths (`~/notes.md`) are honored
as-is.

Expansion happens in the `before_agent_start` hook, once per user prompt, by
rewriting `event.systemPrompt`. It is idempotent across turns, and an mtime
cache keeps repeated turns cheap while still picking up your file edits.

## Recursive resolution & safety

- A referenced file may itself contain `@{...}` slots; they are resolved relative to
  **that** file's directory, recursively.
- Max nesting depth: `10`. Reference cycles are detected and broken.
- Files larger than **512 KB** are skipped (left as-is, reported) to protect the context.
- An in-memory mtime cache keeps repeated turns cheap and picks up your file edits.
- Unreadable / not-found references are left untouched and surfaced as a warning notification.

## Installation

Install as a pi package (recommended). Pi reads the `pi` manifest in
`package.json` and auto-discovers the extension — no manual copying needed.

```bash
# global (available across all projects)
pi install git:github.com/qoxop/pi-prompt-slot

# or project-local (under .pi/, this project only)
pi install -l git:github.com/qoxop/pi-prompt-slot
```

Then `/reload` (or restart pi). Manage it with the usual package commands:

```bash
pi list                                  # list installed packages
pi config                                # enable/disable extensions
pi update --extensions                   # update installed packages
pi remove git:github.com/qoxop/pi-prompt-slot
```

For a quick test without installing, clone and load it directly:

```bash
git clone https://github.com/qoxop/pi-prompt-slot
pi -e ./pi-prompt-slot/src/index.ts
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # resolver + wiring tests (uses bun as the test runner)
```

## How it works (under the hood)

The extension hooks a single pi lifecycle event:

| Hook | Responsibility |
|------|----------------|
| `before_agent_start` | Rewrites `event.systemPrompt`, inlining any `@{...}` slots resolved against the cwd. Runs once per user prompt. |

See [pi extensions docs](https://pi.dev/docs/extensions) for the full event model.

## Notes

- No configuration is required — drop it in and use `@{...}` in your
  `AGENTS.md` / `SYSTEM.md` / `--system-prompt`.
- Only the **system prompt** is processed; put your `@{...}` references in
  `AGENTS.md` (or `SYSTEM.md` / `--append-system-prompt`) for them to take effect.
