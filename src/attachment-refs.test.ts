import { test } from "node:test";
import assert from "node:assert/strict";
import { collectAttachmentRefsFromText, isStageableName } from "./attachment-refs.ts";

const linearOk = (url: string) => url.startsWith("https://uploads.linear.app/");

test("stages a markdown link whose extension lives only in the label (extension-less upload URL)", () => {
  // The real ID-601 case: the URL is a UUID path, `.md` is only in the link label.
  const url = "https://uploads.linear.app/9d25b83c/c0376629/cdd51860-24a0-4a0b-81c3-9b07056a8992";
  const text = `Design spec: [2026-06-14-branch-deployments-design.md](${url})`;
  const refs = collectAttachmentRefsFromText(text, linearOk);
  assert.deepEqual(refs, [{ url, fileName: "2026-06-14-branch-deployments-design.md" }]);
});

test("stages an inline image whose extension is in the URL (no useful label)", () => {
  const url = "https://uploads.linear.app/a/b/diagram.png";
  const refs = collectAttachmentRefsFromText(`![screenshot](${url})`, linearOk);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.url, url);
});

test("skips non-stageable extensions in the label", () => {
  const url = "https://uploads.linear.app/a/b/cdd51860-uuid";
  const refs = collectAttachmentRefsFromText(`[archive.zip](${url})  [report.pdf](${url}2)`, linearOk);
  assert.deepEqual(refs, []);
});

test("ignores URLs the gate rejects (wrong host)", () => {
  const refs = collectAttachmentRefsFromText("[notes.md](https://example.com/x/notes.md)", linearOk);
  assert.deepEqual(refs, []);
});

test("picks up a bare upload URL that carries its own extension", () => {
  const url = "https://uploads.linear.app/a/b/data.csv";
  const refs = collectAttachmentRefsFromText(`see ${url} for the data`, linearOk);
  assert.deepEqual(refs, [{ url }]);
});

test("dedupes by URL, preferring the label-derived filename", () => {
  const url = "https://uploads.linear.app/a/b/uuid";
  const text = `[spec.md](${url}) and again [spec.md](${url})`;
  const refs = collectAttachmentRefsFromText(text, linearOk);
  assert.deepEqual(refs, [{ url, fileName: "spec.md" }]);
});

test("isStageableName accepts images + text/docs, rejects binaries", () => {
  for (const ok of ["a.md", "a.markdown", "a.txt", "a.csv", "a.json", "a.yaml", "a.yml", "a.log", "a.png", "a.JPEG"]) {
    assert.equal(isStageableName(ok), true, ok);
  }
  for (const no of ["a.pdf", "a.zip", "a.tar.gz", "a.exe", "noext"]) {
    assert.equal(isStageableName(no), false, no);
  }
});
