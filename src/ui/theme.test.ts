import { test } from "node:test";
import assert from "node:assert/strict";
import { PROGRAM_GLYPH } from "./theme.ts";

test("program glyph is the recycle symbol", () => {
  assert.equal(PROGRAM_GLYPH, "⟳");
});
