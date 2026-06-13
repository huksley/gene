#!/usr/bin/env node
/**
 * Thin CLI around TrelloClient — handy for trying the wrapper or scripting from
 * the shell. Reads TRELLO_API_KEY + TRELLO_TOKEN from the environment.
 *
 *   node --env-file-if-exists=.env.development trello/cli.ts <command> [args]
 *   # or, via package.json:
 *   npm run trello -- <command> [args]
 */

import { TrelloClient } from "./client.ts";
import type { TrelloCard } from "./types.ts";

const USAGE = `trello — manage Trello cards ("issues") + comments

Usage:
  trello boards                          List boards you can access
  trello lists <boardId>                 List a board's lists (status columns)
  trello cards <boardId>                 List a board's cards (issues)
  trello list-cards <listId>             List cards in one list
  trello card <cardId>                   Show one card
  trello create --list <id> --name <t> [--desc <d>] [--label <id>...] [--member <id>...]
                                         Create a card (--label/--member repeatable)
  trello move <cardId> <listId>          Move a card to another list
  trello archive <cardId>                Archive (close) a card
  trello delete <cardId>                 Permanently delete a card
  trello comment <cardId> <text...>      Add a comment
  trello comments <cardId>               Read comments (oldest first)

Auth: set TRELLO_API_KEY and TRELLO_TOKEN (see trello/README.md).`;

/**
 * Minimal parser: pulls `--flag value` pairs out, leaves the rest as positionals.
 * `flags` keeps the last value per flag; `repeated` keeps every value, so a flag passed
 * multiple times (e.g. `--label a --label b`) can be collected as a list.
 */
const parseArgs = (
  argv: string[]
): { flags: Record<string, string>; repeated: Record<string, string[]>; rest: string[] } => {
  const flags: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next: string | undefined = argv[i + 1];
      const value = next === undefined || next.startsWith("--") ? "true" : (i += 1, next);
      flags[name] = value;
      (repeated[name] ??= []).push(value);
    } else {
      rest.push(arg);
    }
  }
  return { flags, repeated, rest };
};

const printCard = (c: TrelloCard): void => {
  console.log(`${c.closed ? "[archived] " : ""}${c.name}`);
  console.log(`  id:   ${c.id}`);
  console.log(`  list: ${c.idList}`);
  console.log(`  url:  ${c.url}`);
};

const main = async (): Promise<void> => {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  const client = TrelloClient.fromEnv();
  const { flags, repeated, rest } = parseArgs(argv);

  switch (command) {
    case "boards": {
      for (const b of await client.listBoards()) {
        console.log(`${b.id}  ${b.name}${b.closed ? "  (closed)" : ""}`);
      }
      return;
    }
    case "lists": {
      const boardId = rest[0];
      if (!boardId) {
        throw new Error("usage: trello lists <boardId>");
      }
      for (const l of await client.listLists(boardId)) {
        console.log(`${l.id}  ${l.name}`);
      }
      return;
    }
    case "cards": {
      const boardId = rest[0];
      if (!boardId) {
        throw new Error("usage: trello cards <boardId>");
      }
      for (const c of await client.listCardsOnBoard(boardId)) {
        console.log(`${c.id}  ${c.name}`);
      }
      return;
    }
    case "list-cards": {
      const listId = rest[0];
      if (!listId) {
        throw new Error("usage: trello list-cards <listId>");
      }
      for (const c of await client.listCardsInList(listId)) {
        console.log(`${c.id}  ${c.name}`);
      }
      return;
    }
    case "card": {
      const cardId = rest[0];
      if (!cardId) {
        throw new Error("usage: trello card <cardId>");
      }
      const c = await client.getCard(cardId);
      printCard(c);
      if (c.desc) {
        console.log(`\n${c.desc}`);
      }
      return;
    }
    case "create": {
      const idList = flags.list;
      const name = flags.name;
      if (!idList || !name) {
        throw new Error(
          "usage: trello create --list <id> --name <title> [--desc <text>] [--label <id>...] [--member <id>...]"
        );
      }
      const c = await client.createCard({
        idList,
        name,
        desc: flags.desc,
        idLabels: repeated.label,
        idMembers: repeated.member
      });
      console.log("created:");
      printCard(c);
      return;
    }
    case "move": {
      const [cardId, listId] = rest;
      if (!cardId || !listId) {
        throw new Error("usage: trello move <cardId> <listId>");
      }
      const c = await client.moveCard(cardId, listId);
      console.log(`moved ${c.id} -> list ${c.idList}`);
      return;
    }
    case "archive": {
      const cardId = rest[0];
      if (!cardId) {
        throw new Error("usage: trello archive <cardId>");
      }
      await client.archiveCard(cardId);
      console.log(`archived ${cardId}`);
      return;
    }
    case "delete": {
      const cardId = rest[0];
      if (!cardId) {
        throw new Error("usage: trello delete <cardId>");
      }
      await client.deleteCard(cardId);
      console.log(`deleted ${cardId}`);
      return;
    }
    case "comment": {
      const [cardId, ...words] = rest;
      const text = words.join(" ");
      if (!cardId || !text) {
        throw new Error("usage: trello comment <cardId> <text...>");
      }
      const c = await client.addComment(cardId, text);
      console.log(`commented on ${cardId} (action ${c.id})`);
      return;
    }
    case "comments": {
      const cardId = rest[0];
      if (!cardId) {
        throw new Error("usage: trello comments <cardId>");
      }
      const comments = await client.getComments(cardId);
      if (comments.length === 0) {
        console.log("(no comments)");
        return;
      }
      for (const c of comments) {
        const who = c.authorName ?? c.authorUsername ?? "unknown";
        console.log(`- ${who} - ${c.date} (${c.id})`);
        console.log(`${c.text}\n`);
      }
      return;
    }
    default:
      throw new Error(`unknown command "${command}". Run \`trello help\`.`);
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
