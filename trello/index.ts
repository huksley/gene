/**
 * Public surface of the Trello wrapper.
 *
 *   import { createTrelloClient } from "./trello/index.ts";
 *
 *   const trello = createTrelloClient();              // reads TRELLO_API_KEY + TRELLO_TOKEN
 *   const issues = await trello.listCardsInList(listId);
 *   await trello.addComment(cardId, "on it");
 *   const thread = await trello.getComments(cardId);  // oldest-first
 */

export { TrelloClient, TrelloApiError, createTrelloClient } from "./client.ts";
export type {
  TrelloBoard,
  TrelloList,
  TrelloLabel,
  TrelloCard,
  TrelloComment,
  TrelloCredentials,
  CreateCardInput,
  UpdateCardInput
} from "./types.ts";
