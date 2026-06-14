/**
 * Branch-name construction. The branch Gene works on is built from a configurable
 * template (GENE_BRANCH_TEMPLATE, default "{prefix}/{identifier}-{slug}") so every
 * tracker produces the same shape. Placeholders: {prefix}, {identifier}, {slug}.
 *
 * The {prefix} is chosen by Gene itself (not the tracker's suggestion) via
 * {@link choosePrefix}: "fix" or "feature", from the issue's labels and size.
 *
 * Linear auto-links a change request to its issue whenever the issue *identifier*
 * appears anywhere in the branch name, so a "{prefix}/{identifier}-{slug}" branch
 * keeps auto-linking working for both trackers.
 */

import { env } from "./config.ts";

/** Longest the {slug} segment may be (hardcoded — not worth an env var). */
const SLUG_MAX = 40;

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

/** Estimate (story points) at/above which an unlabelled issue counts as "big" → feature. */
const BIG_ESTIMATE = 3;
/** Description length (chars) at/above which an unestimated issue counts as "big" → feature. */
const BIG_DESCRIPTION_CHARS = 600;

/** Labels (lowercased) that force a "fix" prefix, and those that force "feature". */
const FIX_LABELS = new Set(["bug", "fix"]);
const FEATURE_LABELS = new Set(["feature"]);

/**
 * Choose the branch prefix from the issue itself — Gene-owned, independent of the
 * tracker's suggested branch name. Order of precedence:
 *
 *   1. a Bug/Fix label  → "fix"      (explicit: a defect)
 *   2. a Feature label  → "feature"  (explicit: a feature)
 *   3. a "big" issue    → "feature"  (estimate ≥ {@link BIG_ESTIMATE}, or — when
 *                                      unestimated — description ≥
 *                                      {@link BIG_DESCRIPTION_CHARS} chars)
 *   4. otherwise        → "fix"
 *
 * Step 3 is a size proxy for "would need a planning step": the branch is named in
 * the tracker mapping, before any agent runs, so whether a plan was actually
 * proposed/approved isn't known yet — a big issue stands in for that.
 */
export const choosePrefix = (input: {
  labels: string[];
  estimate?: number | null;
  description?: string | null;
}): "fix" | "feature" => {
  const labels = input.labels.map(l => l.toLowerCase());
  if (labels.some(l => FIX_LABELS.has(l))) {
    return "fix";
  }
  if (labels.some(l => FEATURE_LABELS.has(l))) {
    return "feature";
  }
  // Size proxy for "big / would need planning": prefer the team's estimate when one
  // is set (it fully decides), else fall back to description length.
  if (input.estimate != null) {
    return input.estimate >= BIG_ESTIMATE ? "feature" : "fix";
  }
  return (input.description ?? "").length >= BIG_DESCRIPTION_CHARS ? "feature" : "fix";
};
