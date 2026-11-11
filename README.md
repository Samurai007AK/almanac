# Almanac

A chat agent with one tool, web search, and a memory of what you asked and when.

Ask about anything that changes, like a price, a release or a version, and it searches, answers and cites the pages it read. Come back a week later and ask *"what did I ask you on Monday, is it still right?"*. It finds that conversation, checks each claim again and tells you what changed.

```text
You      Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?

         · Looking back at Tue 10 Nov, Tue 3 Nov
         · Searching "Neon pricing plans", "Supabase pricing Pro", "Render Postgres pricing", …
         · Reading 20 sources

Almanac  No price changes since Tuesday 10 November across the options I gave you.

         • Neon Free: unchanged, $0/month, 100 CU-hours, 1 GB per project [1]
         • Neon paid: usage-based with no minimum, Launch at $0.106/CU-hour [2][4]
         • Supabase Pro: unchanged at $25/month with a $10 compute credit [5]
         • Render: unchanged, Basic-256mb at $6/month, free databases expire after 30 days [12]
```

<sub>A real answer from the seeded history, shortened. Five searches ran in one round, and the answer took 12.8 s.</sub>

## Quick start

You need **Node 22.13+**, an [OpenRouter](https://openrouter.ai/keys) key (or any OpenAI-compatible endpoint) and a [Tavily](https://app.tavily.com) key for search. Tavily has a free tier.

```bash
npm install
cp .env.example .env     # then fill in LLM_API_KEY and TAVILY_API_KEY
npm run dev              # open http://localhost:3000
```

If a key is missing, the server still starts and tells you which one to add.

## Try the memory

A fresh install has nothing to remember yet. Seed a few past conversations first. This runs real questions through the agent with the clock set back a few days:

```bash
npm run seed
```

Then ask:

- *What did I ask you on* \<a date the seed prints\>*? Is your answer still correct today?*
- *Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?*
- *On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?*

## How it works

```text
 message
    │
    ▼
 resolve dates      "last Tuesday" → Tue 10 Nov or Tue 3 Nov, worked out in code
    │
    ▼
 recall             those days' turns, an index of every past question, keyword matches
    │
    ▼
 model ⇄ search     parallel queries, at most 3 rounds or 20 s
    │
    ▼
 check citations    drop any [n] that doesn't point to a page read this turn
    │
    ▼
 save turn          question, answer, sources, timestamp
```

- **Dates are resolved in code, not by the model.** If a phrase could mean two days, both are looked up.
- **Memory is one append-only table.** What it recalls is exactly what was said, along with the sources it used then.
- **The search tool takes several queries per call** and runs them in parallel, so five vendors cost one round, not five.
- **Everything streams.** Status lines like "Looking back at…" and "Searching…" show up before the first word of the answer.

Why each choice was made, and what was left out, is in [DESIGN.md](DESIGN.md).

## Project layout

```text
src/
  server.ts       HTTP server, SSE stream, static files
  agent.ts        prompt, tool loop, citation check
  memory.ts       SQLite + FTS5 store and recall
  dates.ts        relative dates → exact ranges
  search.ts       the web_search tool (Tavily, parallel, cached)
  *.test.ts       date resolution and tool-argument parsing
public/           the chat page, no build step
scripts/seed.ts   sample history on a fake clock
```

## Configuration

All settings live in `.env`. See [`.env.example`](.env.example).

| Variable | Default | Notes |
|---|---|---|
| `LLM_API_KEY` | none | Required |
| `TAVILY_API_KEY` | none | Required |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint |
| `LLM_MODEL` | `anthropic/claude-haiku-5.5` | Any model the endpoint serves |
| `PORT` | `3000` | |
| `ALMANAC_DB` | `data/almanac.db` | Delete it to start over |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with reload on file changes |
| `npm start` | Start without the file watcher |
| `npm run seed` | Add sample past conversations |
| `npm test` | Run the unit tests |
| `npm run typecheck` | Type-check with `tsc --noEmit` |

## License

[MIT](LICENSE)
