import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runOrThrow } from "./exec.ts";
import { addWorktree, syncWorktreeToBase } from "./git.ts";

const git = (cwd: string, ...args: string[]) =>
  runOrThrow("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);

/** A bare "origin" with `main` and `develop`, a clone of it, and a worktree off main. */
const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gene-git-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const clone = path.join(root, "clone");
  const worktree = path.join(root, "wt");
  await runOrThrow("git", ["init", "--bare", "-b", "main", origin]);
  await runOrThrow("git", ["clone", origin, seed]);
  await writeFile(path.join(seed, "f.txt"), "v1\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "v1");
  await git(seed, "push", "origin", "HEAD:main", "HEAD:develop");
  await runOrThrow("git", ["clone", origin, clone]);
  await addWorktree(clone, worktree, "prg-1", "main");
  /** Push a new commit to `branch` on origin, from the seed clone. */
  const pushCommit = async (branch: string, content: string) => {
    await git(seed, "checkout", "-B", branch, `origin/${branch}`);
    await git(seed, "fetch", "origin");
    await git(seed, "reset", "--hard", `origin/${branch}`);
    await writeFile(path.join(seed, "f.txt"), content);
    await git(seed, "commit", "-am", content.trim());
    await git(seed, "push", "origin", `HEAD:${branch}`);
  };
  return { root, clone, worktree, pushCommit };
};

test("syncWorktreeToBase: a stale worktree is brought to the remote tip, dropping leftovers", async () => {
  const { root, clone, worktree, pushCommit } = await setup();
  try {
    await pushCommit("main", "v2\n");
    await writeFile(path.join(worktree, "f.txt"), "leftover edit\n");
    await syncWorktreeToBase(clone, worktree, "prg-1", "main");
    assert.equal(await readFile(path.join(worktree, "f.txt"), "utf8"), "v2\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncWorktreeToBase: switches the worktree onto an explicitly pinned branch", async () => {
  const { root, clone, worktree, pushCommit } = await setup();
  try {
    await pushCommit("develop", "dev\n");
    await syncWorktreeToBase(clone, worktree, "prg-1", "develop");
    assert.equal(await readFile(path.join(worktree, "f.txt"), "utf8"), "dev\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncWorktreeToBase: a branch missing on origin throws a readable error", async () => {
  const { root, clone, worktree } = await setup();
  try {
    await assert.rejects(
      () => syncWorktreeToBase(clone, worktree, "prg-1", "no-such-branch"),
      /could not fetch branch "no-such-branch"/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
