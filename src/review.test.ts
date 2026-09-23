import { test } from "node:test";
import assert from "node:assert/strict";
import { isChangeRequestLinked, pickMergedChangeRequest, pickOpenChangeRequest, type ChangeRequestSources } from "./review.ts";
import type { ChangeRequestReview } from "./forge/index.ts";
import type { RepoTarget } from "./repos.ts";

const target = {
  forge: "gitlab",
  host: "gitlab.example.com",
  repoPath: "acme/api"
} as RepoTarget;

const mrUrl = (iid: string) => `https://gitlab.example.com/acme/api/-/merge_requests/${iid}`;

const mr = (iid: string, state: ChangeRequestReview["state"], sourceBranch: string): ChangeRequestReview => ({
  iid,
  url: mrUrl(iid),
  state,
  isDraft: state === "open",
  sourceBranch,
  targetBranch: "main",
  headSha: `sha-${iid}`,
  ci: { status: "success" },
  comments: []
});

// The forge knows about every MR in the repo — including the CLOUD-2247 background
// ones the ticket description cites (merged-then-reverted !1786, someone else's open
// !1801). Only `attachmentUrls` and the issue branch decide what the issue owns.
const background = [mr("1786", "merged", "CLOUD-396/adapter-pg"), mr("1801", "open", "CLOUD-396/prisma-query-compiler")];

const sources = (mrs: ChangeRequestReview[], attachmentUrls: string[] = []): ChangeRequestSources => ({
  branchName: "cloud-2247",
  attachmentUrls,
  target,
  byIid: async iid => mrs.find(m => m.iid === iid) ?? null,
  // Like the real forges: only an *open* MR is found by branch.
  byBranch: async branch => mrs.find(m => m.sourceBranch === branch && m.state === "open") ?? null
});

test("nothing linked and nothing on the branch → no change request, even if the repo has others", async () => {
  assert.equal(await pickOpenChangeRequest(sources(background)), null);
  assert.equal(await pickMergedChangeRequest(sources(background)), null);
});

test("CLOUD-2247: linked open MR is the one picked; unlinked merged MR does not close the issue", async () => {
  const own = mr("2032", "open", "CLOUD-2247/prisma-engine-metrics-env-flag");
  const src = sources([...background, own], [own.url]);
  assert.equal((await pickOpenChangeRequest(src))?.iid, "2032");
  assert.equal(await pickMergedChangeRequest(src), null);
});

test("a linked MR merging moves the issue to done", async () => {
  const own = mr("2032", "merged", "CLOUD-2247/prisma-engine-metrics-env-flag");
  assert.equal((await pickMergedChangeRequest(sources([...background, own], [own.url])))?.iid, "2032");
});

test("not done while another linked MR is still open", async () => {
  const first = mr("2030", "merged", "cloud-2247-part-1");
  const second = mr("2032", "open", "cloud-2247-part-2");
  assert.equal(await pickMergedChangeRequest(sources([first, second], [first.url, second.url])), null);
});

test("not done while an open MR sits on the issue branch, even if a linked one merged", async () => {
  const linked = mr("2030", "merged", "cloud-2247-part-1");
  const onBranch = mr("2032", "open", "cloud-2247");
  assert.equal(await pickMergedChangeRequest(sources([linked, onBranch], [linked.url])), null);
});

test("a linked MR on any branch is picked up (a human's draft)", async () => {
  const draft = mr("1990", "open", "someone/experiment");
  assert.equal((await pickOpenChangeRequest(sources([draft], [draft.url])))?.iid, "1990");
});

test("the open MR on the issue's own branch is found without a link", async () => {
  const own = mr("2032", "open", "cloud-2247");
  assert.equal((await pickOpenChangeRequest(sources([own])))?.iid, "2032");
});

test("linked MR links for a different repo are ignored", async () => {
  const src = sources([mr("7", "open", "x")], ["https://gitlab.example.com/acme/other/-/merge_requests/7"]);
  assert.equal(await pickOpenChangeRequest(src), null);
});

test("isChangeRequestLinked matches by iid in the target repo, whatever the URL's tail", () => {
  assert.equal(isChangeRequestLinked([`${mrUrl("2032")}/diffs`], target, "2032"), true);
  assert.equal(isChangeRequestLinked([mrUrl("1786")], target, "2032"), false);
  assert.equal(isChangeRequestLinked(["https://gitlab.example.com/acme/other/-/merge_requests/2032"], target, "2032"), false);
  assert.equal(isChangeRequestLinked(["https://example.com/design.png"], target, "2032"), false);
});
