/**
 * Parses `@claude <command> [argument]` directives from Trello comment bodies.
 *
 * Supported vocabulary:
 *   @claude approve              - user approves the prior plan; proceed with execution
 *   @claude redo                 - discard current attempt, restart
 *   @claude redo with <argument> - restart with the given scope/change
 *   @claude stop                 - abort current work; close any open PR as draft
 *   @claude retry                - re-attempt the last action (e.g., after CI failure)
 *
 * Notes:
 *  - Pure function — no side effects, easy to unit-test.
 *  - Only the first directive in a comment is returned. Multi-directive
 *    comments are intentionally not supported; keep human intent unambiguous.
 *  - Match is case-insensitive on the command keyword.
 */

export type DirectiveCommand = "approve" | "redo" | "stop" | "retry";

export type Directive = {
  command: DirectiveCommand;
  argument?: string;
  raw: string;
};

const DIRECTIVE_PATTERN =
  /@claude\s+(approve|redo|stop|retry)\b(?:\s+(?:with\s+)?(.+?))?(?:\n|$)/i;

export const parseDirective = (commentText: string): Directive | null => {
  const match = DIRECTIVE_PATTERN.exec(commentText);
  if (!match) {
    return null;
  }
  const [raw, commandRaw, argumentRaw] = match;
  const argument = argumentRaw?.trim();
  return {
    command: commandRaw.toLowerCase() as DirectiveCommand,
    argument: argument && argument.length > 0 ? argument : undefined,
    raw: raw.trim()
  };
};
