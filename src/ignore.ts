/**
 * Comment ignore-patterns. Some comments shouldn't wake Gene up — Gene's own
 * comments (they carry GENE_AGENT_MARKER), slash/bang commands aimed at other bots
 * (`/review`), or a tracker's own status chatter — so they're filtered out before
 * they count as a new human comment (decide.ts) or a new review comment on the
 * change request (review.ts).
 *
 * Patterns are combined per source ("linear" / "trello" / "gitlab" / "github"):
 *   - the agent marker (GENE_AGENT_MARKER) everywhere — self-generated comments are
 *     never a trigger (this is the same signal as `Comment.isAgent`);
 *   - built-ins (below): `!review` and `/review` everywhere, plus `Review` on Linear;
 *   - env: GITLAB_/GITHUB_/LINEAR_/TRELLO_IGNORE_COMMENTS — a comma-separated list,
 *     each item either a bare string (case-insensitive *substring* match) or a
 *     `/regexp/flags` literal (full regex test). Commas inside `/.../` are kept.
 * Your env patterns add to the built-ins; they don't replace them.
 */

import logger from "./logger.ts";
import { env } from "./config.ts";

type CommentMatcher = (body: string) => boolean;

/** Built-ins applied to every tracker and forge. */
const COMMON_BUILTINS = ["!review", "/review"];

/** Extra built-ins for a specific source (Linear's "...In Review" status chatter). */
const SOURCE_BUILTINS: Record<string, string[]> = {
  linear: ["Review"]
};

/** The raw env spec for a source, or undefined when unset. */
const envSpecFor = (source: string): string | undefined => {
  switch (source) {
    case "gitlab":
      return env.GITLAB_IGNORE_COMMENTS;
    case "github":
      return env.GITHUB_IGNORE_COMMENTS;
    case "linear":
      return env.LINEAR_IGNORE_COMMENTS;
    case "trello":
      return env.TRELLO_IGNORE_COMMENTS;
    default:
      return undefined;
  }
};

/**
 * Split a spec into pattern tokens on top-level commas, but keep commas that live
 * inside a `/regexp/` literal (so `/a{1,2}/, foo` is two patterns, not three).
 */
const splitPatterns = (spec: string): string[] => {
  const out: string[] = [];
  const n = spec.length;
  let i = 0;
  while (i < n) {
    while (i < n && (spec[i] === "," || spec[i] === " " || spec[i] === "\t")) {
      i += 1;
    }
    if (i >= n) {
      break;
    }
    if (spec[i] === "/") {
      // Possibly a /regex/ literal — scan for the closing unescaped slash.
      let j = i + 1;
      while (j < n && spec[j] !== "/") {
        j += spec[j] === "\\" ? 2 : 1;
      }
      if (j < n) {
        let k = j + 1; // consume regex flag letters after the closing slash
        while (k < n && /[a-zA-Z]/.test(spec[k]!)) {
          k += 1;
        }
        out.push(spec.slice(i, k).trim());
        i = k;
        while (i < n && spec[i] !== ",") {
          i += 1; // ignore any stray chars between this token and the next comma
        }
        continue;
      }
      // No closing slash → not a regex; fall through and read as a bare string.
    }
    let end = i;
    while (end < n && spec[end] !== ",") {
      end += 1;
    }
    const token = spec.slice(i, end).trim();
    if (token) {
      out.push(token);
    }
    i = end;
  }
  return out;
};

const REGEX_LITERAL = /^\/(.+)\/([a-zA-Z]*)$/;

/** Compile one token into a matcher. `/re/flags` → regex test; else substring (ci). */
const compile = (source: string, token: string): CommentMatcher | null => {
  const literal = REGEX_LITERAL.exec(token);
  if (literal) {
    try {
      const re = new RegExp(literal[1]!, literal[2]);
      return body => re.test(body);
    } catch (error) {
      logger.warn(
        `${logger.tag.ignore} skipping invalid ${source.toUpperCase()}_IGNORE_COMMENTS regex ${token}:`,
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }
  const needle = token.toLowerCase();
  return body => body.toLowerCase().includes(needle);
};

const cache = new Map<string, CommentMatcher[]>();

const matchersFor = (source: string): CommentMatcher[] => {
  const cached = cache.get(source);
  if (cached) {
    return cached;
  }

  const tokens = [
    ...COMMON_BUILTINS,
    // Self-generated comments carry the agent marker and must never wake Gene.
    env.AGENT_MARKER,
    ...(SOURCE_BUILTINS[source] ?? []),
    ...splitPatterns(envSpecFor(source) ?? "")
  ];

  const matchers: CommentMatcher[] = [];
  for (const token of tokens) {
    const matcher = compile(source, token);
    if (matcher) {
      matchers.push(matcher);
    }
  }
  cache.set(source, matchers);
  return matchers;
};

/**
 * True when a comment body matches any ignore pattern for the source
 * ("linear" / "trello" / "gitlab" / "github"). Used to drop a comment before it
 * counts as a trigger; it does not hide the comment from change-request discovery.
 */
export const commentIsIgnored = (source: string, body: string): boolean =>
  matchersFor(source).some(match => match(body));
