# Almanac

A chat agent with one tool, web search, and a memory of what you asked and when.

Ask it something that changes, like a price, a release or a version, and it searches, answers and cites the pages it used. Come back days later and ask *"what did I ask you on Monday, is it still right?"*, and it finds that conversation, checks each claim again and tells you what changed.

```
You      Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?

         · Looking back at Tue, 10 Nov 2026, Tue, 3 Nov 2026
         · Searching "Neon pricing plans free paid per month", "Supabase pricing plans Pro Free compute",
           "Render Postgres pricing Basic-256mb disk", "Aiven PostgreSQL pricing Developer plan", …
         · Reading 20 sources

Almanac  No price changes since Tuesday 10 November across the options I gave you, though I checked
         these sources rather than every live pricing page.

         • Neon Free: unchanged, $0/month, 100 CU-hours, 1 GB per project [1]
         • Neon paid: the discrepancy I flagged on Tuesday looks settled, usage-based with no
           minimum, Launch at $0.106/CU-hour plus $0.35/GB-month [2][4]
         • Supabase Pro: unchanged at $25/month with a $10 compute credit [5]
         • Render: unchanged, Basic-256mb $6/month, free databases expire after 30 days [12]
         …
```

*A real answer from the seeded history, shortened. It took 12.8 s, with five searches in one round.*

## Run it

You need Node 22.13 or newer, an [OpenRouter](https://openrouter.ai/keys) key (or any OpenAI-compatible endpoint), and a [Tavily](https://app.tavily.com) key for search.

```bash
npm install
cp .env.example .env      # add LLM_API_KEY and TAVILY_API_KEY
npm run dev               # http://localhost:3000
```

A fresh install has no history to remember yet. To try the memory questions straight away, seed a few past conversations first. This runs real questions through the agent with the clock set back to earlier days:

```bash
npm run seed
```

Then ask things like:

- *What did I ask you on <date the seed prints>? Is your answer still correct today?*
- *Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?*
- *On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?*

## How it works

```
message ─▶ resolve dates ─▶ recall from SQLite ─▶ model ⇄ web_search ─▶ check citations ─▶ save turn
           "last Tuesday"    those days' turns,      parallel queries,     drop any [n] with    question, answer,
           → Tue 3 Nov       question index,         ≤ 3 rounds / 20 s     no fetched page      sources, timestamp
                             keyword matches
```

- Dates are worked out in code, not by the model. When a phrase is ambiguous, both days are looked up.
- Memory is one append-only table, so what it recalls is exactly what was said, with the sources from then.
- The single tool takes several queries at once and runs them in parallel.
- Everything streams. You see what it's doing ("Looking back at…", "Searching…") before the first word.

The reasoning behind each choice, and what I left out, is in [DESIGN.md](DESIGN.md).

## Project layout

```
src/
  server.ts     http server, SSE stream, static files
  agent.ts      prompt, tool loop, citation check
  memory.ts     SQLite + FTS5 store and recall
  dates.ts      relative dates → exact ranges
  search.ts     the web_search tool (Tavily, parallel, cached)
  *.test.ts     date resolution and tool-argument parsing
public/         the chat page (no build step)
scripts/seed.ts sample history on a fake clock
```

## Configuration

| Variable | Default | |
|---|---|---|
| `LLM_API_KEY` | | required |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | any OpenAI-compatible endpoint |
| `LLM_MODEL` | `anthropic/claude-haiku-5.5` | |
| `TAVILY_API_KEY` | | required |
| `PORT` | `3000` | |
| `ALMANAC_DB` | `data/almanac.db` | delete it to start over |

## Scripts

| | |
|---|---|
| `npm run dev` | start with reload on change |
| `npm start` | start without the file watcher |
| `npm run seed` | add sample past conversations |
| `npm test` | unit tests |
| `npm run typecheck` | `tsc --noEmit` |

## License

MIT
