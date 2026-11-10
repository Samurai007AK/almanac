const log = document.getElementById("log");
const input = document.getElementById("input");
const send = document.getElementById("send");
const empty = document.getElementById("empty");
let lastDay = "";
let busy = false;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const dayLabel = (d) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const timeLabel = (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

// Markdown in, sanitised HTML out. [n] becomes a link to source n; a number with no
// matching source is dropped rather than shown as a dead citation.
function render(md, sources) {
  const withCites = md.replace(/\[(\d+)\]/g, (_, n) => {
    const s = sources.find((x) => x.id === Number(n));
    return s ? `<a class="cite" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}">${n}</a>` : "";
  });
  return DOMPurify.sanitize(marked.parse(withCites, { breaks: true }), { ADD_ATTR: ["target"] });
}

function daySeparator(date) {
  const label = dayLabel(date);
  if (label !== lastDay) {
    lastDay = label;
    log.append(el("div", "day", esc(label)));
  }
}

function addUser(text, date) {
  empty.hidden = true;
  daySeparator(date);
  const m = el("div", "msg user");
  m.append(el("div", "bubble", esc(text)), el("div", "time", timeLabel(date)));
  log.append(m);
}

function addBot() {
  const m = el("div", "msg bot");
  const parts = { status: el("div", "status"), body: el("div", "body"), sources: el("div", "sources"), meta: el("div", "meta") };
  parts.status.hidden = true;
  m.append(parts.status, parts.body, parts.sources, parts.meta);
  log.append(m);
  return parts;
}

function fill(parts, answer, sources, meta) {
  parts.body.innerHTML = render(answer, sources);
  const cited = sources.filter((s) => answer.includes(`[${s.id}]`));
  parts.sources.innerHTML = cited
    .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}"><b>${s.id}</b>${esc(host(s.url))}</a>`)
    .join("");
  if (meta) {
    const bits = [secs(meta.ms)];
    if (meta.ttftMs) bits.push(`first words in ${secs(meta.ttftMs)}`);
    if (meta.queries?.length) bits.push(`${meta.queries.length} search${meta.queries.length > 1 ? "es" : ""}`);
    parts.meta.textContent = bits.join(" · ");
  }
}

const scroll = () => log.scrollTo({ top: log.scrollHeight });

async function ask(text) {
  if (busy || !text.trim()) return;
  busy = true;
  send.disabled = true;
  input.value = "";
  autosize();

  addUser(text, new Date());
  const parts = addBot();
  parts.status.hidden = false;
  parts.status.textContent = "Thinking";
  scroll();

  let answer = "";
  let sources = [];
  let frame = 0;
  const paint = () => {
    frame = 0;
    fill(parts, answer, sources);
    scroll();
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const events = buf.split("\n\n");
      buf = events.pop();
      for (const line of events) {
        if (!line.startsWith("data: ")) continue;
        const e = JSON.parse(line.slice(6));
        if (e.type === "status") parts.status.textContent = e.text;
        if (e.type === "sources") sources = e.sources;
        if (e.type === "token") {
          answer += e.text;
          frame ||= requestAnimationFrame(paint);
        }
        if (e.type === "done") {
          parts.status.hidden = true;
          fill(parts, e.turn.answer, e.turn.sources, e.turn.meta);
        }
        if (e.type === "error") throw new Error(e.message);
      }
    }
  } catch (err) {
    parts.status.hidden = true;
    parts.body.append(el("p", "error", esc(`Something went wrong: ${err.message}`)));
  }
  scroll();
  busy = false;
  send.disabled = false;
  input.focus();
}

function autosize() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    ask(input.value);
  }
});
document.getElementById("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  ask(input.value);
});
for (const b of document.querySelectorAll(".examples button")) b.addEventListener("click", () => ask(b.textContent));

(async () => {
  const state = await (await fetch("/api/state")).json();
  document.getElementById("model").textContent = state.model;
  if (state.missing.length) {
    const banner = document.getElementById("banner");
    banner.hidden = false;
    banner.innerHTML = `Almanac needs ${state.missing.map((k) => `<code>${k}</code>`).join(" and ")}. Copy <code>.env.example</code> to <code>.env</code>, add the keys, and restart <code>npm run dev</code>.`;
  }
  empty.hidden = state.turns.length > 0;
  for (const t of state.turns) {
    addUser(t.question, new Date(t.askedAt));
    fill(addBot(), t.answer, t.sources, t.meta);
  }
  scroll();
})();
