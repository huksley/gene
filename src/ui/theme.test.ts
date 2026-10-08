import { test } from "node:test";
import assert from "node:assert/strict";
import { PROGRAM_GLYPH, TRIGGER_GLYPH } from "./theme.ts";

test("program glyph is the recycle symbol", () => {
  assert.equal(PROGRAM_GLYPH, "⟳");
});

test("trigger glyph is a lightning bolt", () => {
  assert.equal(TRIGGER_GLYPH, "ϟ");
});
