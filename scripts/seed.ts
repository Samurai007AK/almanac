// Gives a fresh install some history to remember. Each question below goes through
// the real agent (real searches, real answers) with the clock set back to a past
// day, so "what did I ask on Monday?" has something true to find.
import "../src/env.ts";
import { missingKeys } from "../src/env.ts";
import { runTurn } from "../src/agent.ts";
import { fmtDay } from "../src/dates.ts";

if (missingKeys().length) {
  console.error(`Missing ${missingKeys().join(", ")} in .env`);
  process.exit(1);
}

const today = new Date();
// Most recent `weekday` (0 = Sunday) strictly before today, at the given time.
const last = (weekday: number, hh: number, mm: number) => {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, hh, mm);
  while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
  return d;
};
const daysAgo = (n: number, hh: number, mm: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n, hh, mm);

const script = ([
  [daysAgo(9, 9, 40), "What's the current LTS version of Node.js, and when does it stop getting security fixes?"],
  [last(2, 10, 30), "I need managed Postgres for a side project. What are the cheapest decent options right now and what do they cost?"],
  [last(1, 11, 0), "We're a 20-person sales team picking a CRM. Give me a shortlist of 5 with the price per seat for each."],
  [new Date(last(1, 11, 0).getTime() + 6 * 60_000), "Good, that's our shortlist for now. I'll check back later in the week."],
] as [Date, string][]).sort((a, b) => a[0].getTime() - b[0].getTime());

for (const [at, q] of script) {
  process.stdout.write(`${fmtDay(at)}  ${q}\n`);
  await runTurn(
    q,
    (e) => {
      if (e.type === "status") process.stdout.write(`    · ${e.text}\n`);
      if (e.type === "error") console.error(`    ! ${e.message}`);
      if (e.type === "done") process.stdout.write(`    saved #${e.turn.id} (${(Number(e.turn.meta.ms) / 1000).toFixed(1)}s)\n\n`);
    },
    at,
  );
}

console.log(`Done. Now run npm run dev and try:
  What did I ask you on ${daysAgo(9, 0, 0).toLocaleDateString("en-GB", { day: "numeric", month: "long" })}? Is your answer still correct today?
  Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?
  On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?`);
