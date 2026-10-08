import { test } from "node:test";
import assert from "node:assert/strict";
import { displayWidth, fit } from "./format.ts";

test("displayWidth: emoji-presentation glyphs take two terminal cells", () => {
  assert.equal(displayWidth("⚡"), 2);
  assert.equal(displayWidth("⟳"), 1);
  assert.equal(displayWidth("L"), 1);
});

// The ⚡ lead glyph rendered two cells wide but was padded as one, shifting every
// trigger row one column right of the others.
test("fit pads by display width so wide and narrow glyphs line up", () => {
  assert.equal(fit("⚡", 2), "⚡");
  assert.equal(fit("L", 2), "L ");
  assert.equal(fit("⟳", 2), "⟳ ");
});
