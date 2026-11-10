import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { calendar, resolveDates } from "./dates.ts";
import { recall, saveTurn, stamp, type Turn } from "./memory.ts";
import { parseSearchArgs, searchTool, webSearch, type Source } from "./search.ts";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "token"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; turn: Turn }
  | { type: "error"; message: string };

// Any OpenAI-compatible endpoint works (OpenRouter, OpenAI, Gemini, Groq, a local
// server). One wire format means one code path, and the reviewer can bring
// whichever key they already have.
const client = new OpenAI({
  // "unset" lets the server boot and explain what's missing; keys are checked before each turn.
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "unset",
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
});
export const MODEL = process.env.LLM_MODEL || "anthropic/claude-haiku-5.5";

const MAX_ROUNDS = 3; // search rounds per answer, then we make it answer
const BUDGET_MS = 20_000; // past this, no more searching either

const stripCites = (s: string) => s.replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, "");

function systemPrompt(now: Date, memory: string): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `You are Almanac, a chat assistant with one tool, web_search, and a memory of every conversation you have had with this user.

It is now ${stamp(now)} (${tz}).
${calendar(now)}

How to answer
- Lead with the answer. Then only the detail that helps. Plain prose, short lists or a small table. No preamble, no "great question", no recap of the question.
- Search whenever the answer depends on something that changes: prices, plans, releases, news, who holds a role, versions, dates of events. Also search when you are not sure. Do not search for greetings, opinions, rewriting, maths, or questions about our own past conversations.
- Put every query you need into one web_search call. They run in parallel. Prefer primary sources: official pricing pages, changelogs, release notes, docs.
- Cite with [n] right after the claim it supports, using the numbers from this turn's search results. Only cite what a result actually says. If you could not confirm something, say so instead of guessing.
- Prices and plans: give the figure, the plan name and what it is per (month, seat, GB). Keep table cells short.
- Never end with a list of sources or links. The app shows the cited pages under your answer.
- Each user message starts with the time it was sent, in brackets. That is for you; never repeat it.

Memory
- Below is what the app found in your history for this message. Dates in it are exact; trust them over your own date arithmetic.
- "You answered then" is a record of what you said at that time, not a fact about today. If the user asks whether it still holds, or what changed since, search again for each claim and answer per item as then → now (changed, unchanged, or couldn't verify), with dates. Absence of news is not proof nothing changed; say what you checked.
- If a phrase could mean two dates and only one has a matching conversation, use it and don't mention the other. If both do, say in a few words which one you went with.
- If nothing was asked on the day the user means, say so plainly and mention the nearest dates you do have. Never invent a past conversation.

${memory}`;
}

export async function runTurn(question: string, emit: (e: AgentEvent) => void, now = new Date()): Promise<void> {
  const t0 = Date.now();
  const mem = recall(question, resolveDates(question, now), now);
  if (mem.looked.length) emit({ type: "status", text: `Looking back at ${mem.looked.join(", ")}` });

  const messages: ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt(now, mem.notes) }];
  for (const t of mem.recent) {
    messages.push({ role: "user", content: `[${stamp(t.askedAt)}] ${t.question}` });
    messages.push({ role: "assistant", content: stripCites(t.answer) });
  }
  messages.push({ role: "user", content: `[${stamp(now)}] ${question}` });

  const sources: Source[] = [];
  const queries: string[] = [];
  let answer = "";
  let ttft = 0;

  try {
    for (let round = 0; ; round++) {
      const final = round >= MAX_ROUNDS || Date.now() - t0 > BUDGET_MS;
      const stream = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools: [searchTool],
        tool_choice: final ? "none" : "auto",
        stream: true,
        max_tokens: 4000,
      });

      let text = "";
      const calls: { id: string; name: string; args: string }[] = [];
      let cut = false;
      for await (const chunk of stream) {
        if (chunk.choices[0]?.finish_reason === "length") cut = true;
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          ttft ||= Date.now() - t0;
          text += delta.content;
          emit({ type: "token", text: delta.content });
        }
        for (const tc of delta.tool_calls ?? []) {
          const c = (calls[tc.index ?? calls.length] ??= { id: "", name: "", args: "" });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name ||= tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
        }
      }
      if (cut) text += "\n\n*(This answer hit the length limit and was cut short. Ask me to continue.)*";
      answer += text;
      if (!calls.length || final) break;

      if (text) {
        answer += "\n\n";
        emit({ type: "token", text: "\n\n" });
      }
      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } })),
      });

      const results = await Promise.all(
        calls.map(async (c) => {
          const args = parseSearchArgs(c.args);
          // Models sometimes send one `query` string instead of the array; take either.
          const qs = [args.queries ?? args.query].flat().filter((q): q is string => typeof q === "string" && !!q.trim());
          if (!qs.length) return 'web_search needs {"queries": ["..."]}. Try again.';
          queries.push(...qs);
          const since = args.since ? ` (since ${args.since})` : "";
          emit({ type: "status", text: `Searching ${qs.map((q) => `“${q}”`).join(", ")}${since}` });
          return webSearch(qs, args.since, sources);
        }),
      );
      emit({ type: "sources", sources: [...sources] });

      const lastRound = round + 1 >= MAX_ROUNDS || Date.now() - t0 > BUDGET_MS;
      calls.forEach((c, i) =>
        messages.push({
          role: "tool",
          tool_call_id: c.id,
          content: results[i] + (lastRound && i === calls.length - 1 ? "\n\nThat is all the searching there is time for. Answer now with what you have, and say what you could not confirm." : ""),
        }),
      );
      emit({ type: "status", text: sources.length ? `Reading ${sources.length} sources` : "Search came back empty" });
    }
  } catch (err) {
    emit({ type: "error", message: (err as Error).message });
    return;
  }

  // A citation must point at a page we actually fetched this turn. Anything else is dropped.
  answer = answer
    .replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (_, list: string) => list.split(",").map((n) => `[${n.trim()}]`).join(""))
    .replace(/\[(\d+)\]/g, (m, n) => (Number(n) >= 1 && Number(n) <= sources.length ? m : ""))
    .trim();
  const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));

  const turn: Omit<Turn, "id"> = {
    askedAt: now,
    question,
    answer,
    sources: sources.filter((s) => cited.has(s.id)),
    meta: { model: MODEL, ms: Date.now() - t0, ttftMs: ttft, queries },
  };
  emit({ type: "done", turn: { id: saveTurn(turn), ...turn } });
}
