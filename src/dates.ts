import * as chrono from "chrono-node";

export type DayRange = { start: Date; end: Date; label: string };

export type ResolvedDate = {
  phrase: string;
  ranges: DayRange[]; // first is the likeliest reading; a second one means "could also be"
};

const DAY = 86_400_000;
const NOW_WORDS = /^(today|now|right now|tonight|this (morning|afternoon|evening))$/i;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));

export const fmtDay = (d: Date) =>
  d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

const dayRange = (d: Date): DayRange => {
  const start = startOfDay(d);
  return { start, end: addDays(start, 1), label: fmtDay(start) };
};

const weekRange = (d: Date): DayRange => {
  const start = mondayOf(d);
  const end = addDays(start, 7);
  return { start, end, label: `week of ${fmtDay(start)}` };
};

// Turns "last Tuesday", "on 3 November", "last week", "in October" into concrete
// local-time ranges, so the model never has to do calendar math and the harness
// can pull the right conversations out of memory before the model runs.
export function resolveDates(text: string, now: Date): ResolvedDate[] {
  const today = startOfDay(now);
  const out: ResolvedDate[] = [];

  for (const r of chrono.parse(text, now, { forwardDate: false })) {
    const phrase = r.text.trim();
    if (NOW_WORDS.test(phrase) || /\b(next|coming|upcoming|tomorrow)\b/i.test(phrase)) continue;
    const s = r.start;
    let d = s.date();
    const ranges: DayRange[] = [];

    if (/\bweek\b/i.test(phrase)) {
      ranges.push(weekRange(d));
    } else if (s.isCertain("weekday") && !s.isCertain("day")) {
      // A bare weekday always points backwards here: people ask about what already happened.
      // "Last Tuesday" said on a Wednesday is genuinely ambiguous (yesterday, or a week
      // earlier), so we hand both days to the model instead of silently picking one.
      if (d > now) d = addDays(d, -7);
      ranges.push(dayRange(d));
      if (/\blast\b/i.test(phrase) || startOfDay(d).getTime() === today.getTime()) ranges.push(dayRange(addDays(d, -7)));
    } else if (s.isCertain("month") && !s.isCertain("day")) {
      if (d > now && !s.isCertain("year")) d = new Date(d.getFullYear() - 1, d.getMonth(), 1);
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      ranges.push({ start, end, label: start.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) });
    } else {
      if (d > now && !s.isCertain("year")) d = new Date(d.getFullYear() - 1, d.getMonth(), d.getDate());
      ranges.push(dayRange(d));
    }

    // We only ever look back. "I'll check back later this week" is not a lookup.
    if (ranges[0].start > now) continue;
    // chrono happily returns several readings of overlapping text; keep the first.
    if (!out.some((o) => o.ranges[0].start.getTime() === ranges[0].start.getTime())) out.push({ phrase, ranges });
  }
  return out;
}

// A small calendar for the system prompt. Models are bad at weekday arithmetic,
// so we give them the answer instead of the problem.
export function calendar(now: Date): string {
  const thisMon = mondayOf(now);
  const line = (mon: Date) =>
    Array.from({ length: 7 }, (_, i) => addDays(mon, i))
      .map((d) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }))
      .join(", ");
  return `This week: ${line(thisMon)}\nLast week: ${line(addDays(thisMon, -7))}`;
}

export const daysBetween = (a: Date, b: Date) => Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY);
