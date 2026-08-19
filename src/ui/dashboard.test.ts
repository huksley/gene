import { test } from "node:test";
import assert from "node:assert/strict";
import { filterAgents } from "./dashboard.ts";
import type { AgentState } from "../monitor.ts";

const agent = (id: string, isProgram: boolean): AgentState =>
  ({
    id,
    title: id,
    stage: isProgram ? "program" : "processing",
    status: "running",
    isProgram,
    lastEvent: "",
    events: [],
    toolCount: 0
  } as AgentState);

test("filterAgents onlyPrograms keeps only program rows", () => {
  const rows = [agent("PRG-1", true), agent("ENG-2", false), agent("PRG-3", true)];
  assert.deepEqual(filterAgents(rows, { onlyPrograms: true }).map(a => a.id), ["PRG-1", "PRG-3"]);
});

test("filterAgents without the filter returns everything", () => {
  const rows = [agent("PRG-1", true), agent("ENG-2", false)];
  assert.deepEqual(filterAgents(rows, { onlyPrograms: false }).map(a => a.id), ["PRG-1", "ENG-2"]);
});
