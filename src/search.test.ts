import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearchArgs } from "./search.ts";

test("valid JSON passes through", () => {
  assert.deepEqual(parseSearchArgs('{"queries": ["a b", "c"], "since": "2026-11-01"}'), { queries: ["a b", "c"], since: "2026-11-01" });
});

test("salvages the almost-JSON models sometimes send", () => {
  assert.deepEqual(parseSearchArgs('{"queries": Node.js 24 LTS end of life date}'), { queries: ["Node.js 24 LTS end of life date"], since: undefined });
  assert.deepEqual(parseSearchArgs('{"queries": Node.js release schedule, "since": "2026-01-01"}'), { queries: ["Node.js release schedule"], since: "2026-01-01" });
  assert.deepEqual(parseSearchArgs('{"queries": ["neon pricing", "supabase pricing"}'), { queries: ["neon pricing", "supabase pricing"], since: undefined });
});
