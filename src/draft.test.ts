import { test } from "node:test";
import assert from "node:assert/strict";
import { needsRedraft, redraft } from "./draft.ts";
import type { ChangeRequestReview, Forge } from "./forge/index.ts";
import type { RepoTarget } from "./repos.ts";

const target = { host: "github.com", repoPath: "acme/widgets" } as RepoTarget;

const review = (over: Partial<ChangeRequestReview> = {}): ChangeRequestReview => ({
  iid: "42",
  url: "https://github.com/acme/widgets/pull/42",
  state: "open",
  isDraft: false,
  sourceBranch: "gene/abc-1",
  targetBranch: "main",
  headSha: "deadbeef",
  ci: { status: "success" },
  comments: [],
  ...over
});

/**
 * A Forge stub recording markDraft calls. `after` is what the post-write verify read
 * returns (undefined = the read failed, which must not be read as a failed write).
 */
const stubForge = (opts: { marked?: boolean; after?: ChangeRequestReview | null } = {}) => {
  const calls: string[] = [];
  const forge = {
    name: "github",
    changeRequestTerm: "pull request",
    async markDraft(_repo: RepoTarget, iid: string) {
      calls.push(iid);
      return opts.marked ?? true;
    },
    async getReviewByIid() {
      return opts.after === undefined ? review({ isDraft: true }) : opts.after;
    }
  } as unknown as Forge;
  return { forge, calls };
};

test("needsRedraft only flags an open change request that is not a draft", () => {
  assert.equal(needsRedraft(review()), true);
  assert.equal(needsRedraft(review({ isDraft: true })), false);
  assert.equal(needsRedraft(review({ state: "merged" })), false);
  assert.equal(needsRedraft(review({ state: "closed" })), false);
  assert.equal(needsRedraft(review({ state: "locked" })), false);
  assert.equal(needsRedraft(null), false);
  assert.equal(needsRedraft(undefined), false);
});

test("redraft forces an open non-draft change request back to draft", async () => {
  const { forge, calls } = stubForge();
  const detail = await redraft(review(), target, forge);
  assert.deepEqual(calls, ["42"]);
  assert.equal(detail, "forced pull request back to draft: https://github.com/acme/widgets/pull/42");
});

test("redraft falls back to #iid in its detail when the change request has no URL", async () => {
  const { forge } = stubForge();
  assert.equal(await redraft(review({ url: "" }), target, forge), "forced pull request back to draft: #42");
});

test("redraft is a no-op for a change request that is already a draft", async () => {
  const { forge, calls } = stubForge();
  assert.equal(await redraft(review({ isDraft: true }), target, forge), null);
  assert.deepEqual(calls, []);
});

test("redraft is a no-op once the change request is merged or closed", async () => {
  const { forge, calls } = stubForge();
  assert.equal(await redraft(review({ state: "merged" }), target, forge), null);
  assert.equal(await redraft(review({ state: "closed" }), target, forge), null);
  assert.deepEqual(calls, []);
});

test("redraft is a no-op when there is no change request at all", async () => {
  const { forge, calls } = stubForge();
  assert.equal(await redraft(null, target, forge), null);
  assert.equal(await redraft(undefined, target, forge), null);
  assert.deepEqual(calls, []);
});

test("redraft reports nothing when the forge refuses to re-draft", async () => {
  const { forge, calls } = stubForge({ marked: false });
  assert.equal(await redraft(review(), target, forge), null);
  assert.deepEqual(calls, ["42"], "it still attempted the write");
});

test("redraft reports nothing when the change request is verifiably still not a draft", async () => {
  const { forge } = stubForge({ after: review({ isDraft: false }) });
  assert.equal(await redraft(review(), target, forge), null);
});

test("redraft trusts a successful write when the verify read itself fails", async () => {
  const { forge } = stubForge({ after: null });
  assert.equal(await redraft(review(), target, forge), "forced pull request back to draft: https://github.com/acme/widgets/pull/42");
});
