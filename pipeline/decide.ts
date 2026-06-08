import { AGENT_MEMBER_ID, LABELS, LISTS, REQUIRED_DESC_SECTIONS } from "./config";
import type { TrelloCard, TrelloComment } from "./trello";

export type Action =
  | { kind: "nothing"; reason: string }
  | { kind: "ask-clarification"; reason: string; missingSections: string[] }
  | { kind: "start-processing" }
  | { kind: "resume-from-block"; latestUserCommentId: string }
  | { kind: "handle-user-feedback"; latestUserCommentId: string };

const hasLabel = (card: TrelloCard, labelId: string): boolean =>
  card.idLabels.includes(labelId);

const findMissingSections = (desc: string): string[] => {
  const text = desc || "";
  return REQUIRED_DESC_SECTIONS.filter(section => {
    const headingPattern = new RegExp(
      `^${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
      "m"
    );
    if (!headingPattern.test(text)) {
      return true;
    }
    const sectionStart = text.indexOf(section);
    const nextHeading = text.slice(sectionStart + section.length).search(/\n##\s/);
    const body =
      nextHeading === -1
        ? text.slice(sectionStart + section.length)
        : text.slice(
            sectionStart + section.length,
            sectionStart + section.length + nextHeading
          );
    return body.trim().length === 0;
  });
};

const latestCommentByAgent = (comments: TrelloComment[]): TrelloComment | undefined => {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    if (comments[i].idMemberCreator === AGENT_MEMBER_ID) {
      return comments[i];
    }
  }
  return undefined;
};

const userCommentsAfter = (
  comments: TrelloComment[],
  afterIsoDate: string | undefined
): TrelloComment[] => {
  return comments.filter(
    comment =>
      comment.idMemberCreator !== AGENT_MEMBER_ID &&
      (afterIsoDate === undefined || comment.date > afterIsoDate)
  );
};

export const decideAction = (card: TrelloCard, comments: TrelloComment[]): Action => {
  const blocked = hasLabel(card, LABELS.AI_BLOCKED);
  const lastAgent = latestCommentByAgent(comments);
  const newUserComments = userCommentsAfter(comments, lastAgent?.date);

  if (card.idList === LISTS.AI_CODE_ASSISTANT) {
    if (blocked && newUserComments.length === 0) {
      return { kind: "nothing", reason: "blocked in queue, waiting for user edit or comment" };
    }
    const missing = findMissingSections(card.desc);
    if (missing.length > 0) {
      return {
        kind: "ask-clarification",
        reason: "missing-required-sections",
        missingSections: missing
      };
    }
    return { kind: "start-processing" };
  }

  if (card.idList === LISTS.IN_PROCESS_AI) {
    if (blocked && newUserComments.length > 0) {
      return {
        kind: "resume-from-block",
        latestUserCommentId: newUserComments[newUserComments.length - 1].id
      };
    }
    if (!blocked && newUserComments.length > 0) {
      return {
        kind: "handle-user-feedback",
        latestUserCommentId: newUserComments[newUserComments.length - 1].id
      };
    }
    if (blocked) {
      return { kind: "nothing", reason: "blocked, waiting for user reply" };
    }
    return { kind: "nothing", reason: "in-process, no new activity" };
  }

  return { kind: "nothing", reason: `card not in pipeline-managed list (${card.idList})` };
};
