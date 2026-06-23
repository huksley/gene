import { test } from "node:test";
import assert from "node:assert/strict";
import { overlayEnv } from "./bootstrap.ts";

// Layers are passed in precedence order [.gene.config, gene.config]; overlayEnv fills
// only keys the base (real env) leaves unset, earlier layers winning over later ones.
// Resulting precedence: real env > .gene.config > gene.config.

test("real env wins over both files", () => {
  const overlay = overlayEnv({ LINEAR_API_KEY: "from-env" }, [
    { LINEAR_API_KEY: "from-secrets" },
    { LINEAR_API_KEY: "from-config" }
  ]);
  // The key is already set in the base, so nothing is overlaid for it.
  assert.equal(overlay.LINEAR_API_KEY, undefined);
});

test(".gene.config wins over gene.config on a shared key", () => {
  const overlay = overlayEnv({}, [{ GENE_TRACKER: "trello" }, { GENE_TRACKER: "linear" }]);
  assert.equal(overlay.GENE_TRACKER, "trello");
});

test("gene.config supplies keys absent from .gene.config", () => {
  const overlay = overlayEnv({}, [{ LINEAR_API_KEY: "secret" }, { GENE_TRACKER: "linear" }]);
  assert.equal(overlay.LINEAR_API_KEY, "secret");
  assert.equal(overlay.GENE_TRACKER, "linear");
});

test("a blank base value counts as unset and is filled", () => {
  const overlay = overlayEnv({ LINEAR_WORKSPACE: "   " }, [{ LINEAR_WORKSPACE: "acme" }, {}]);
  assert.equal(overlay.LINEAR_WORKSPACE, "acme");
});

test("missing files (empty layers) overlay nothing", () => {
  assert.deepEqual(overlayEnv({ GENE_TRACKER: "linear" }, [{}, {}]), {});
});
