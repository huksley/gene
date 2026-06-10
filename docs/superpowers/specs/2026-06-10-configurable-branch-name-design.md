# Configurable branch name — design

**Date:** 2026-06-10
**Status:** Approved, ready for implementation plan

## Problem

The branch Gene works on comes from `issue.branchName`, which is built differently per tracker and is not configurable:

- **Trello** (`src/tracker/trello.ts`, `toIssue`): hardcoded `gene/${identifier}`.
- **Linear** (`src/tracker/linear.ts`, `toIssue`): passes through Linear's own suggested
  `raw.branchName` (e.g. `fix/abc-123-title` in this workspace, since Linear is configured
  with label-based branch prefixes).

We want one configurable format, e.g. `{prefix}/{identifier}-{slug}`, where the prefix is
derived from the tracker when possible and the slug is a short description from the issue title.

### Constraint: Linear PR/MR auto-linking

Linear auto-links a change request to its issue when the **issue identifier** (`abc-123`)
appears anywhere in the branch name. It does not require Linear's exact suggested string.
Therefore a format like `fix/abc-123-login-broken` keeps auto-linking working, and we can
apply the same template to both trackers.

## Design

### New environment variable

One new var, read in `src/config.ts`:

- `GENE_BRANCH_TEMPLATE` — default `"{prefix}/{identifier}-{slug}"`.
  Supported placeholders: `{prefix}`, `{identifier}`, `{slug}`.

No `GENE_BRANCH_PREFIX` (deliberately omitted to avoid env clutter / confusion). The slug
length cap is hardcoded (40) rather than exposed.

The fallback prefix (used when the tracker supplies none) is derived from the existing
`GENE_COMMAND_BASE`: take its value (default `!gene`) and strip every non-alphanumeric
character → `gene`.

### New module: `src/branch.ts`

Pure, dependency-light helpers (mirrors the style of other small `src/*.ts` modules):

- `fallbackPrefix(): string`
  - `env.COMMAND_BASE` with all non-`[A-Za-z0-9]` characters removed, lowercased.
  - `!gene` → `gene`. If stripping leaves an empty string, use `"gene"` as a last resort.

- `slugify(title: string): string`
  - Lowercase; replace any run of non-`[a-z0-9]` with a single `-`; trim leading/trailing `-`.
  - Cap at 40 chars, then re-trim any trailing `-` left by the cut.
  - Returns `""` for an empty/emoji-only title.

- `buildBranchName({ prefix, identifier, title }): string`
  - Compute `slug = slugify(title)`.
  - Fill `GENE_BRANCH_TEMPLATE`, replacing `{prefix}`, `{identifier}`, `{slug}`.
  - **Empty-slug handling:** when `slug === ""`, drop a trailing `-{slug}` (and a bare
    `{slug}`) so the result collapses to e.g. `fix/abc-123` rather than `fix/abc-123-`.
  - Sanitize the final string to a valid git ref: keep `[A-Za-z0-9/_-]`, collapse repeats,
    trim stray leading/trailing separators.

### Per-tracker wiring

Each tracker computes a `prefix` and calls `buildBranchName` inside its existing `toIssue`.

- **Linear** (`src/tracker/linear.ts`):
  - `prefix` = the segment **before the first `/`** in Linear's `raw.branchName`.
    If there is no `/` (or the segment is empty), use `fallbackPrefix()`.
  - `branchName = buildBranchName({ prefix, identifier: raw.identifier, title: raw.title ?? "" })`.
  - Prefix is trusted as-is — no username guard (this workspace uses `fix`/`feature` prefixes).

- **Trello** (`src/tracker/trello.ts`):
  - `prefix = fallbackPrefix()` (Trello has no tracker-supplied prefix).
  - `branchName = buildBranchName({ prefix, identifier, title: card.name })`,
    replacing the current `gene/${identifier}`.

### Behavior preserved elsewhere

`issue.branchName` is consumed unchanged downstream (`src/invoke.ts` `workBranch`,
`src/index.ts`, forge prompts). Continuing an existing change request still uses
`existing.branch`, so this only affects fresh work. The forge prompt copy
("the branch matches the Linear issue's branch name, so the PR auto-links") remains
accurate because the identifier is still present in the branch name.

## Documentation

- `.env.example`: add a `GENE_BRANCH_TEMPLATE` entry near `GENE_COMMAND_BASE`, documenting
  the placeholders and the `GENE_COMMAND_BASE`-derived fallback prefix.
- `README.md`: note the configurable branch name where branch/worktree behavior is described.

## Testing

- Unit tests for `src/branch.ts`:
  - `slugify`: spaces, punctuation, mixed case, length cap, trailing-dash trim, empty/emoji input.
  - `fallbackPrefix`: `!gene` → `gene`; custom `GENE_COMMAND_BASE`; empty-after-strip fallback.
  - `buildBranchName`: default template, custom template, empty-slug collapse, git-ref sanitize.
- Tracker mapping: `toIssue` for Linear (prefix extracted from `raw.branchName`; fallback when
  no `/`) and Trello (fallback prefix; replaces `gene/...`).

## Out of scope (YAGNI)

- Label-to-prefix mapping for Trello.
- A `{title}`/`{team}` placeholder set beyond `{prefix}`/`{identifier}`/`{slug}`.
- Exposing the slug-length cap as an env var.
- A username guard on the extracted Linear prefix.
