# Design

Almanac is a chat agent with one tool, web search, and a memory of every conversation stamped with when it happened. The test questions that shaped it are the ones that mix the two: *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"*

## How it works

Every message goes through the same four steps.

1. **Resolve dates in code.** `src/dates.ts` turns "last Tuesday", "on 3 November", "last week" or "in October" into exact local date ranges (chrono-node does the parsing; about 40 lines of rules handle the edge cases). Bare weekdays always point backwards. A day-month in the future means last year. "Last Tuesday" said on a Wednesday could be yesterday or eight days ago, so both days are looked up and the model picks whichever one has a matching conversation.
2. **Recall.** `src/memory.ts` keeps one append-only SQLite table: question, answer, cited sources and timestamp per turn. For each message the model gets the last six turns as normal chat, a one-line index of every earlier question with its timestamp, the full records for the days the user named, and up to four keyword matches from FTS5. Old answers are labelled as what was said then, not as current fact.
3. **Answer with search.** A plain streaming tool loop against any OpenAI-compatible endpoint. The single tool is `web_search({ queries[], since? })`. One call fans out up to five queries in parallel against Tavily, with an 8 s timeout each, dedupes by URL and numbers the results so the model can cite `[n]`. At most three search rounds or 20 seconds, then the model must answer and say what it couldn't confirm.
4. **Check and store.** Any `[n]` that doesn't match a page fetched this turn is removed. The turn is saved with only the sources it actually cited, plus latency and the queries it ran.

The browser gets status lines ("Looking back at Tue 3 Nov", "Searching …") and tokens over server-sent events the moment they exist. Measured on my machine: chat and memory-only answers finish in about 2 s, a simple search answer in 6 to 7 s, and a five-vendor "has anything changed since Monday?" in 11 to 15 s.

## What testing changed

- Tavily's `advanced` depth took about 6 s for five queries. `basic` returned the same top pages in about 1 s, so it's the default.
- The model kept putting `since` on pricing queries, and the date filter dropped every undated pricing page. Now the tool retries those queries unfiltered itself instead of spending a model round finding out.
- Haiku occasionally sends almost-JSON (`{"queries": neon pricing}`). The tool salvages the query instead of bouncing the call back. This one has a test.
- "I'll check back later this week" was being looked up as next week. Date phrases that point forward are now ignored.

## Why this shape

- **Memory lives in the harness, not in a tool.** The rules allow one tool. More importantly, a "recall" tool would cost a model round trip before every answer that touches the past. Looking things up deterministically before the model runs is faster and can't be skipped by a model that forgot to call it.
- **The model never does calendar maths.** It gets today's date, a two-week calendar and the resolved ranges. Weekday arithmetic is exactly the kind of thing LLMs get confidently wrong, and a wrong date here means diffing against the wrong conversation.
- **Raw records over summaries.** Summaries drift and drop the figures you later want to compare. Storing exactly what was said, with its sources, is what makes "is your answer still correct?" answerable: the model re-checks those claims and reports then → now per item.
- **No separate planner call.** The model decides whether to search within the same call that answers. Greetings, maths and "what did I ask on…" cost one model call, not two.
- **Many queries per call.** "Did any of these five CRMs change pricing?" becomes one tool call with five parallel searches instead of five round trips.
- **OpenAI-compatible wire format.** One code path works with OpenRouter, OpenAI, Gemini, Groq or a local model. The default is Claude Haiku 5.5 through OpenRouter. In my tests it reached its first token in about 1.1 s and wrote several targeted queries on its own. Gemini 3.8 Flash was about 2.5 s slower.
- **Few dependencies.** Node's built-in `http` and `node:sqlite`, the `openai` client, chrono-node, and marked + DOMPurify for the page. No framework, no build step, no native modules to compile.

## Considered and rejected

- **A planner/router LLM call before answering.** Cleaner traces, but it adds 0.5 to 1 s to every message, and the answering model makes the same decision for free.
- **Embeddings for recall.** Needs another API key or a local model. For one user's history, dates plus bm25 find the right turn, and the full question index is always in the prompt as a fallback.
- **Summarised or extracted "facts" memory** (mem0-style). It's an extra LLM call per turn and it loses detail. I'd add claim extraction only if raw answers stop fitting in context.
- **A background watcher that re-checks saved topics.** Very much in minimi's spirit, but it spends searches nobody asked for and doesn't help a reviewer's first conversation.
- **Speculative search while the user is typing**, and **draft-then-correct answers.** Both make it feel faster. The first wastes calls, and the second makes the answer change under you.
- **The LLM's own browsing or grounding** (`:online` models, Gemini grounding). That hides the one tool I'm meant to design.

## With another week

- **Claim-level diffs.** At write time, store prices and versions as structured claims with their source quote. "Has anything changed?" then becomes a per-claim re-check with a verbatim before and after.
- **Watches.** "Keep an eye on these five" saves the claims and re-checks them on the next visit, opening with "since Monday, two of them changed". That's the nudge part of minimi.
- **Page fetch for thin results.** Pricing pages are often JavaScript-rendered and come back as weak snippets. Let the tool take URLs and pull full text for the top one or two only when snippets don't settle it.
- **An eval set.** Twenty dated conversations and follow-ups, scored on whether the right past turn was found, whether figures match the cited page, and latency to first token, run on every prompt change.
- **Multiple users and conversations.** Today there is one timeline on one machine, which matches a personal assistant but nothing bigger.
