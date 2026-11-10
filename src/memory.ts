import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { fmtDay, type ResolvedDate } from "./dates.ts";
import type { Source } from "./search.ts";

// One table, append-only. A turn is one question and the answer we gave, stamped
// with when it was asked and which sources it leaned on. Nothing is summarised or
// rewritten, so memory can't drift: what we recall is exactly what was said.
export type Turn = {
  id: number;
  askedAt: Date;
  question: string;
  answer: string;
  sources: Source[];
  meta: Record<string, unknown>;
};

mkdirSync("data", { recursive: true });
const db = new DatabaseSync(process.env.ALMANAC_DB ?? "data/almanac.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS turns (
    id        INTEGER PRIMARY KEY,
    asked_at  INTEGER NOT NULL,           -- unix ms
    question  TEXT NOT NULL,
    answer    TEXT NOT NULL,
    sources   TEXT NOT NULL DEFAULT '[]',
    meta      TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS turns_asked_at ON turns(asked_at);
  CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(question, answer, content='turns', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
    INSERT INTO turns_fts(rowid, question, answer) VALUES (new.id, new.question, new.answer);
  END;
`);

type Row = { id: number; asked_at: number; question: string; answer: string; sources: string; meta: string };

const toTurn = (r: Row): Turn => ({
  id: r.id,
  askedAt: new Date(r.asked_at),
  question: r.question,
  answer: r.answer,
  sources: JSON.parse(r.sources),
  meta: JSON.parse(r.meta),
});

export function saveTurn(t: Omit<Turn, "id">): number {
  const res = db
    .prepare("INSERT INTO turns (asked_at, question, answer, sources, meta) VALUES (?, ?, ?, ?, ?)")
    .run(t.askedAt.getTime(), t.question, t.answer, JSON.stringify(t.sources), JSON.stringify(t.meta));
  return Number(res.lastInsertRowid);
}

export function recentTurns(limit: number, before = Date.now()): Turn[] {
  const rows = db
    .prepare("SELECT * FROM turns WHERE asked_at < ? ORDER BY asked_at DESC LIMIT ?")
    .all(before, limit) as Row[];
  return rows.reverse().map(toTurn);
}

function turnsBetween(start: Date, end: Date): Turn[] {
  const rows = db
    .prepare("SELECT * FROM turns WHERE asked_at >= ? AND asked_at < ? ORDER BY asked_at LIMIT 12")
    .all(start.getTime(), end.getTime()) as Row[];
  return rows.map(toTurn);
}

const STOP = new Set(
  "a an and are as at be but by can did do does for from has have how i in is it me my of on or our so that the their them then there they this to was we what when where which who why will with you your about any been could should would just still since ask asked tell told".split(" "),
);

// Keyword recall for questions that point at the past without naming a date
// ("that Postgres thing", "the CRMs we shortlisted"). Plain bm25 over FTS5 is
// enough at this scale and needs no embedding model or extra API key.
function turnsMatching(text: string, before: number, limit: number): Turn[] {
  const words = [...new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter((w) => !STOP.has(w));
  if (!words.length) return [];
  const rows = db
    .prepare(
      `SELECT t.* FROM turns_fts f JOIN turns t ON t.id = f.rowid
       WHERE turns_fts MATCH ? AND t.asked_at < ? ORDER BY bm25(turns_fts) LIMIT ?`,
    )
    .all(words.map((w) => `"${w}"`).join(" OR "), before, limit) as Row[];
  return rows.map(toTurn);
}

const fmtTime = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
export const stamp = (d: Date) => `${fmtDay(d)}, ${fmtTime(d)}`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);

export type Recall = {
  recent: Turn[]; // replayed as real chat messages
  notes: string; // index + looked-up days + related turns, for the system prompt
  looked: string[]; // human-readable, shown to the user as status
};

// Builds what the model knows about the past for this message:
//  1. the last few turns, verbatim, as the running conversation;
//  2. a one-line index of every earlier question with its timestamp (cheap, and it
//     lets the model answer "what did I ask on…" even when lookup misses);
//  3. full records for the days the user named, plus keyword matches.
export function recall(text: string, dates: ResolvedDate[], now: Date): Recall {
  const recent = recentTurns(6, now.getTime());
  const recentIds = new Set(recent.map((t) => t.id));
  const parts: string[] = [];
  const looked: string[] = [];
  const shown = new Set<number>();

  const index = recentTurns(200, now.getTime()).filter((t) => !recentIds.has(t.id));
  parts.push(
    index.length
      ? "Every earlier question, oldest first:\n" + index.map((t) => `#${t.id}  ${stamp(t.askedAt)}  ${clip(t.question, 140)}`).join("\n")
      : "No earlier conversations beyond the recent ones shown as chat.",
  );

  const record = (t: Turn) => {
    shown.add(t.id);
    // Old [n] markers point at that turn's sources, not this one's; drop them so they
    // can't be mistaken for citations now, and list the pages plainly instead.
    const src = t.sources.length ? "\nSources used then:\n" + t.sources.map((s) => `  - ${s.title} (${s.url})`).join("\n") : "";
    const said = clip(t.answer.replace(/\s?\[\d+\]/g, ""), 3000);
    return `#${t.id} asked ${stamp(t.askedAt)}\nUser: ${t.question}\nYou answered then:\n${said}${src}`;
  };

  for (const d of dates) {
    for (const [i, r] of d.ranges.entries()) {
      const found = turnsBetween(r.start, r.end).filter((t) => t.askedAt < now);
      const reading = i === 0 ? `"${d.phrase}" → ${r.label}` : `"${d.phrase}" could also mean ${r.label}`;
      looked.push(r.label);
      parts.push(
        found.length
          ? `${reading}. Records from then (what you said at the time, not necessarily true today):\n\n${found.map(record).join("\n\n")}`
          : `${reading}. Nothing was asked in that period.`,
      );
    }
  }

  const related = turnsMatching(text, now.getTime(), 4).filter((t) => !shown.has(t.id) && !recentIds.has(t.id));
  if (related.length) {
    parts.push(`Earlier turns that look related to this message:\n\n${related.map(record).join("\n\n")}`);
    if (!looked.length) looked.push(`${related.length} related earlier conversation${related.length > 1 ? "s" : ""}`);
  }

  return { recent, notes: parts.join("\n\n---\n\n"), looked };
}
