/**
 * Branch-name construction. The branch Gene works on is built from a configurable
 * template (GENE_BRANCH_TEMPLATE, default "{prefix}/{identifier}-{slug}") so every
 * tracker produces the same shape. Placeholders: {prefix}, {identifier}, {slug}.
 *
 * The {prefix} is derived from the tracker when it supplies one (Linear's suggested
 * branch name carries a label-based prefix); otherwise it falls back to the command
 * base (GENE_COMMAND_BASE, e.g. "!gene") stripped to alphanumerics → "gene".
 *
 * Linear auto-links a change request to its issue whenever the issue *identifier*
 * appears anywhere in the branch name, so a "{prefix}/{identifier}-{slug}" branch
 * keeps auto-linking working for both trackers.
 */

import { env } from "./config.ts";

/** Longest the {slug} segment may be (hardcoded — not worth an env var). */
const SLUG_MAX = 40;

/** The fallback prefix: GENE_COMMAND_BASE stripped to alphanumerics ("!gene" → "gene"). */
export const fallbackPrefix = (): string => {
  const stripped = env.COMMAND_BASE.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return stripped || "gene";
};

/**
 * A short, git-safe slug from an issue title: lowercase, any run of non-alphanumerics
 * collapsed to a single "-", trimmed, capped at SLUG_MAX. Returns "" for an
 * empty/emoji-only title (callers drop the slug segment then).
 */
export const slugify = (title: string): string => {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Cap, then re-trim a "-" the cut may have left dangling.
  return base.slice(0, SLUG_MAX).replace(/-+$/g, "");
};

/** Keep only valid git-ref chars, collapse repeated separators, trim the ends. */
const sanitizeRef = (ref: string): string =>
  ref
    .replace(/[^A-Za-z0-9/_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/_]+|[-/_]+$/g, "");

/**
 * Fill GENE_BRANCH_TEMPLATE with the issue's prefix/identifier/slug. When the slug
 * is empty its placeholder (and a leading "-"/"_"/"/" separator) is dropped, so the
 * branch collapses to e.g. "fix/abc-123" rather than "fix/abc-123-".
 */
export const buildBranchName = (input: { prefix: string; identifier: string; title: string }): string => {
  const slug = slugify(input.title);
  let out = env.BRANCH_TEMPLATE;
  if (slug === "") {
    out = out.replace(/[-_/]?\{slug\}/g, "");
  }
  out = out
    .replaceAll("{prefix}", input.prefix)
    .replaceAll("{identifier}", input.identifier)
    .replaceAll("{slug}", slug);
  return sanitizeRef(out);
};

/** The prefix Linear supplies: the segment before the first "/" of its suggested branch. */
export const prefixFromLinearBranch = (linearBranch: string): string => {
  const idx = linearBranch.indexOf("/");
  const head = idx > 0 ? linearBranch.slice(0, idx).trim() : "";
  return head || fallbackPrefix();
};
