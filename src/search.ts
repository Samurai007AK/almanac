// The agent's only tool. One call takes several queries and runs them in parallel,
// so a question like "did any of these 5 CRMs change pricing?" costs one round trip
// to the model instead of five.

export type Source = { id: number; title: string; url: string; published?: string; fetchedAt: string };

type Hit = { title: string; url: string; content: string; published_date?: string };

export const searchTool = {
  type: "function" as const,
  function: {
    name: "web_search",
    description:
      "Search the web. Pass every query you need for this step at once; they run in parallel. " +
      "Write specific queries (product + plan + 'pricing', vendor + 'changelog'), not questions.",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 5,
          description: 'JSON array of query strings, e.g. ["neon postgres pricing", "supabase pricing"]',
        },
        since: {
          type: "string",
          description:
            "Optional YYYY-MM-DD. Only return pages published on or after this date. Use it for news, " +
            "launches and changelogs. Do not use it for pricing or docs pages: those are usually undated and get dropped.",
        },
      },
      required: ["queries"],
    },
  },
};

type SearchArgs = { queries?: unknown; query?: unknown; since?: string };

// Small models occasionally emit almost-JSON, e.g. {"queries": neon pricing}. Recover
// the query rather than spend a whole round telling the model to try again.
export function parseSearchArgs(raw: string): SearchArgs {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    const since = raw.match(/"since"\s*:\s*"([\d-]+)"/)?.[1];
    const body = raw.match(/"quer(?:y|ies)"\s*:\s*([\s\S]*?)\s*(?:,\s*"since"[\s\S]*)?}\s*$/)?.[1] ?? "";
    const queries = body.replace(/^\[|\]$/g, "").split(/"\s*,\s*"/).map((q) => q.replace(/^\s*"|"\s*$/g, "").trim()).filter(Boolean);
    return { queries, since };
  }
}

const TIMEOUT_MS = 8000;
const CACHE_MS = 15 * 60_000;
// ponytail: in-process cache, lost on restart. Fine for one local user; a shared store if this ever serves many.
const cache = new Map<string, { at: number; hits: Hit[] }>();

async function tavily(query: string, since?: string): Promise<Hit[]> {
  const key = `${query.toLowerCase().trim()}|${since ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.hits;

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({
      query,
      // "basic" came back with the same top pages as "advanced" in my tests at a
      // fraction of the time (0.8 s vs 6 s), and half the credits.
      search_depth: "basic",
      max_results: 4,
      include_published_date: true,
      ...(since && { start_date: since }),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const hits = ((await res.json()) as { results: Hit[] }).results ?? [];
  cache.set(key, { at: Date.now(), hits });
  return hits;
}

const normalise = (url: string) => url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();

// Runs the queries, merges results by URL and numbers them so the model can cite
// [n]. Numbering continues across rounds within a turn (`sources` is shared), so a
// citation always points at exactly one page.
export async function webSearch(queries: string[], since: string | undefined, sources: Source[]): Promise<string> {
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) since = undefined;
  const undated: string[] = [];
  // A date filter drops undated pages, and pricing pages are rarely dated. Rather than
  // spend a model round discovering that, retry the query unfiltered right here.
  const run = async (q: string) => {
    const hits = await tavily(q, since);
    if (!since || hits.length) return hits;
    undated.push(q);
    return tavily(q);
  };
  const settled = await Promise.allSettled(queries.slice(0, 5).map(run));
  const seen = new Map(sources.map((s) => [normalise(s.url), s]));
  const blocks: string[] = [];
  const failed: string[] = [];
  const fetchedAt = new Date().toISOString();

  settled.forEach((r, i) => {
    if (r.status === "rejected") return void failed.push(`"${queries[i]}" (${(r.reason as Error).message})`);
    for (const h of r.value) {
      const k = normalise(h.url);
      if (seen.has(k)) continue;
      const src: Source = { id: sources.length + 1, title: h.title, url: h.url, published: h.published_date?.slice(0, 10), fetchedAt };
      sources.push(src);
      seen.set(k, src);
      blocks.push(`[${src.id}] ${h.title}\n${h.url}${src.published ? ` · published ${src.published}` : ""}\n${h.content.slice(0, 900)}`);
    }
  });

  if (undated.length) blocks.push(`Nothing dated on or after ${since} for ${undated.map((q) => `"${q}"`).join(", ")}; those results are unfiltered.`);
  if (failed.length) blocks.push(`These searches failed: ${failed.join("; ")}`);
  // A bad key won't fix itself on retry; say so, or the model burns rounds trying.
  if (failed.length === settled.length && failed.every((f) => / (401|403|432):/.test(f)))
    return "Web search is unavailable right now (the search API key was rejected). Do not retry; answer from what you know and say it is unchecked.";
  return blocks.length ? blocks.join("\n\n") : "No results. Try different wording, or tell the user you couldn't find it.";
}
