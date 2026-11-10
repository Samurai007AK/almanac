import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDates } from "./dates.ts";

// Wednesday 11 November 2026, mid-afternoon local time.
const now = new Date(2026, 10, 11, 15, 0);
const days = (text: string) =>
  resolveDates(text, now).map((r) => r.ranges.map((x) => x.start.toDateString()));

test("bare weekday points to the most recent one", () => {
  assert.deepEqual(days("On Monday we shortlisted 5 CRM tools"), [["Mon Nov 09 2026"]]);
});

test("'last Tuesday' on a Wednesday keeps both readings", () => {
  assert.deepEqual(days("Last Tuesday I asked you about Postgres hosting"), [["Tue Nov 10 2026", "Tue Nov 03 2026"]]);
});

test("today's weekday also offers last week's", () => {
  assert.deepEqual(days("what did I ask on Wednesday"), [["Wed Nov 11 2026", "Wed Nov 04 2026"]]);
});

test("explicit dates", () => {
  assert.deepEqual(days("What did I ask you on 3 November?"), [["Tue Nov 03 2026"]]);
  assert.deepEqual(days("what did we talk about yesterday"), [["Tue Nov 10 2026"]]);
});

test("a day-month in the future means last year", () => {
  assert.deepEqual(days("what did I ask on 3 Dec"), [["Wed Dec 03 2025"]]);
});

test("'last week' is the whole previous calendar week", () => {
  const [r] = resolveDates("anything from last week?", now);
  assert.equal(r.ranges[0].start.toDateString(), "Mon Nov 02 2026");
  assert.equal(r.ranges[0].end.toDateString(), "Mon Nov 09 2026");
});

test("a month is the whole month", () => {
  const [r] = resolveDates("what did I ask in October", now);
  assert.equal(r.ranges[0].start.toDateString(), "Thu Oct 01 2026");
  assert.equal(r.ranges[0].end.toDateString(), "Sun Nov 01 2026");
});

test("future references are not lookups", () => {
  assert.deepEqual(days("Good, I'll check back later in the week"), []);
  assert.deepEqual(days("remind me next Monday"), []);
});

test("'today' and plain questions resolve to nothing", () => {
  assert.deepEqual(days("Is your answer still correct today?"), []);
  assert.deepEqual(days("cheapest postgres hosting?"), []);
});
