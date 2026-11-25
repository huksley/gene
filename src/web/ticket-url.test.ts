import { test } from "node:test";
import assert from "node:assert/strict";
import { linearWorkspaceOf, splitLinks, splitTicketRefs, teamKeyOf, ticketUrl, ticketUrlBase } from "./ticket-url.ts";

test("linearWorkspaceOf reads the workspace slug from an issue URL", () => {
  assert.equal(linearWorkspaceOf("https://linear.app/verda-cloud/issue/CORE-512/containers-proxy"), "verda-cloud");
  assert.equal(linearWorkspaceOf("https://linear.app/acme/issue/A-1"), "acme");
  assert.equal(linearWorkspaceOf("https://uploads.linear.app/x/y"), undefined);
  assert.equal(linearWorkspaceOf("https://trello.com/c/abc"), undefined);
  assert.equal(linearWorkspaceOf(undefined), undefined);
});

test("ticketUrl builds a tracker link from the identifier", () => {
  assert.equal(ticketUrl("linear", "CLOUD-1", "acme"), "https://linear.app/acme/issue/CLOUD-1");
  assert.equal(ticketUrl("linear", "CLOUD-1", undefined), undefined);
  assert.equal(ticketUrl("trello", "aBc123", undefined), "https://trello.com/c/aBc123");
  assert.equal(ticketUrl("github", "X-1", "acme"), undefined);
});

test("ticketUrlBase is the prefix an identifier is appended to", () => {
  assert.equal(ticketUrlBase("linear", "acme"), "https://linear.app/acme/issue/");
  assert.equal(ticketUrlBase("linear", undefined), undefined);
  assert.equal(ticketUrlBase("trello", undefined), undefined);
});

test("teamKeyOf takes the key off a Linear-style identifier", () => {
  assert.equal(teamKeyOf("CORE-512"), "CORE");
  assert.equal(teamKeyOf("T2-9"), "T2");
  assert.equal(teamKeyOf("aBc123"), undefined);
});

test("splitTicketRefs finds known keys only, as whole words", () => {
  const keys = ["CORE", "CLOUD"];
  assert.deepEqual(splitTicketRefs("Fixed in CORE-512, see (CLOUD-3442).", keys), [
    "Fixed in ",
    { identifier: "CORE-512" },
    ", see (",
    { identifier: "CLOUD-3442" },
    ")."
  ]);
  assert.deepEqual(splitTicketRefs("UTF-8 and ABC-1 stay text", keys), ["UTF-8 and ABC-1 stay text"]);
  assert.deepEqual(splitTicketRefs("XCORE-1 CORE-1x path/CORE-2 CORE-3-fix", keys), [
    "XCORE-1 CORE-1x path/CORE-2 CORE-3-fix"
  ]);
  assert.deepEqual(splitTicketRefs("CORE-7", keys), [{ identifier: "CORE-7" }]);
  assert.deepEqual(splitTicketRefs("anything", []), ["anything"]);
});

test("splitLinks finds URLs and ticket references in plain text", () => {
  const mr = "https://gitlab.example.com/g/app/-/merge_requests/2465";
  assert.deepEqual(splitLinks(`${mr} check review notes for CORE-1.`, ["CORE"]), [
    { url: mr },
    " check review notes for ",
    { identifier: "CORE-1" },
    "."
  ]);
  // Trailing prose punctuation and wrapping brackets stay outside the link.
  assert.deepEqual(splitLinks("see (https://x.test/a?b=1), then https://y.test/p.", []), [
    "see (",
    { url: "https://x.test/a?b=1" },
    "), then ",
    { url: "https://y.test/p" },
    "."
  ]);
  // A ticket key inside a URL is part of the URL, not a separate reference.
  assert.deepEqual(splitLinks("https://linear.app/a/issue/CORE-9/x", ["CORE"]), [{ url: "https://linear.app/a/issue/CORE-9/x" }]);
  assert.deepEqual(splitLinks("javascript:alert(1) ftp://x", []), ["javascript:alert(1) ftp://x"]);
  assert.deepEqual(splitLinks("", ["CORE"]), []);
});
