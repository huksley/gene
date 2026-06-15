import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRepoUrl,
  sameRepo,
  isDevStagingApp,
  baseAppNameStem,
  deploymentNameFor,
  dnsLabel,
  customHostnameFrom
} from "./dollardeploy.ts";

test("normalizeRepoUrl strips scheme, .git, trailing slash; handles ssh", () => {
  assert.equal(normalizeRepoUrl("https://github.com/dollardeploy/app"), "github.com/dollardeploy/app");
  assert.equal(normalizeRepoUrl("https://github.com/dollardeploy/app.git/"), "github.com/dollardeploy/app");
  assert.equal(normalizeRepoUrl("git@github.com:dollardeploy/app.git"), "github.com/dollardeploy/app");
});

test("sameRepo compares repos modulo scheme/.git, and is false for empty", () => {
  assert.equal(sameRepo("https://github.com/dollardeploy/app", "git@github.com:dollardeploy/app.git"), true);
  assert.equal(sameRepo("https://github.com/dollardeploy/app", "https://github.com/dollardeploy/other"), false);
  assert.equal(sameRepo(null, null), false);
  assert.equal(sameRepo("", "https://github.com/dollardeploy/app"), false);
});

test("isDevStagingApp matches dev/staging tokens in name or hostname", () => {
  assert.equal(isDevStagingApp({ id: "1", name: "app-dev" }), true);
  assert.equal(isDevStagingApp({ id: "1", name: "app-staging" }), true);
  assert.equal(isDevStagingApp({ id: "1", name: "development-app" }), true);
  assert.equal(isDevStagingApp({ id: "1", name: "app", hostname: "dev.example.com" }), true);
  assert.equal(isDevStagingApp({ id: "1", name: "app" }), false);
  assert.equal(isDevStagingApp({ id: "1", name: "developer-portal" }), false); // "developer" is not a token
  // The `.dev` TLD of a normal hostname must NOT count (only the subdomain label does).
  assert.equal(isDevStagingApp({ id: "1", name: "nextjs", hostname: "app4.mh6i6q7v.dollardeploy.dev" }), false);
  assert.equal(isDevStagingApp({ id: "1", name: "appsmith", hostname: "app5.x.dollardeploy.dev" }), false);
});

test("baseAppNameStem strips dev/staging tokens, keeps the rest", () => {
  assert.equal(baseAppNameStem("nextjs"), "nextjs");
  assert.equal(baseAppNameStem("app-staging"), "app");
  assert.equal(baseAppNameStem("staging-app"), "app");
  assert.equal(baseAppNameStem("dev.app"), "app");
  assert.equal(baseAppNameStem("my-app-dev"), "my-app");
  assert.equal(baseAppNameStem("staging"), "staging"); // nothing left → fall back
});

test("deploymentNameFor joins stem + ticket id (ticket case preserved)", () => {
  assert.equal(deploymentNameFor(baseAppNameStem("nextjs"), "ID-244"), "nextjs-ID-244");
  assert.equal(deploymentNameFor(baseAppNameStem("app-staging"), "ID-601"), "app-ID-601");
});

test("dnsLabel is lowercase, dash-collapsed, ≤63 chars, trimmed", () => {
  assert.equal(dnsLabel("app-ID-601"), "app-id-601");
  assert.equal(dnsLabel("My App!! v2"), "my-app-v2");
  assert.equal(dnsLabel("x".repeat(80)).length, 63);
});

test("customHostnameFrom swaps the first label of a subdomain base", () => {
  assert.equal(
    customHostnameFrom("app4.mh6i6q7v.dollardeploy.dev", "app-ID-601"),
    "app-id-601.mh6i6q7v.dollardeploy.dev"
  );
});

test("customHostnameFrom returns undefined when the base isn't a usable subdomain", () => {
  assert.equal(customHostnameFrom("example.com", "app-ID-601"), undefined);
  assert.equal(customHostnameFrom(null, "app-ID-601"), undefined);
  assert.equal(customHostnameFrom("", "app-ID-601"), undefined);
});
