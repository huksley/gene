/**
 * Parses `@gene <command> [argument]` directives from Linear comment bodies.
 *
 * Supported vocabulary:
 *   @gene approve              - user approves the prior plan; proceed with execution
 *   @gene redo                 - discard current attempt, restart
 *   @gene redo with <argument> - restart with the given scope/change
 *   @gene stop                 - abort current work; close any open MR/PR
 *   @gene retry                - re-attempt the last action (e.g., after CI failure)
 *
 * Pure function — only the first directive in a comment is returned; match is
 * case-insensitive on the command keyword.
 */

export type DirectiveCommand = "approve" | "redo" | "stop" | "retry";

export type Directive = {
  command: DirectiveCommand;
  argument?: string;
  raw: string;
};

const DIRECTIVE_PATTERN = /@gene\s+(approve|redo|stop|retry)\b(?:\s+(?:with\s+)?(.+?))?(?:\n|$)/i;

export const parseDirective = (commentText: string): Directive | null => {
  const match = DIRECTIVE_PATTERN.exec(commentText);
  if (!match) {
    return null;
  }
  const [raw, commandRaw, argumentRaw] = match;
  const argument = argumentRaw?.trim();
  return {
    command: commandRaw!.toLowerCase() as DirectiveCommand,
    argument: argument && argument.length > 0 ? argument : undefined,
    raw: raw.trim()
  };
};
