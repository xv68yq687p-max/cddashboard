// src/endpoints/morningReport.ts
import type { Context } from "hono";
import { Hono } from "hono";

type Bindings = {
  PERPLEXITY_API_KEY?: string;
};

type Item = {
  title: string;
  url: string;
  source?: string;
  published_at?: string | null;
  tags?: string[];
  summary?: string;
};

type CategoryOut = { items: Item[] };
type Out = {
  generated_at: string;
  window_hours: number;
  categories: Record<string, CategoryOut>;
  meta: { titles: Record<string, string> };
};

const CATEGORY_CONFIG: { id: string; title: string; queries: string[] }[] = [
  { id: "world_major_incidents", title: "Store cyberhendelser globalt", queries: [
      "major cyber incident site:reuters.com OR site:apnews.com OR site:bbc.com",
      "CISA alert OR advisory site:cisa.gov",
      "widespread ransomware outage",
  ]},
  { id: "norway_incidents", title: "Hendelser i Norge/norske mål", queries: [
      "Norway cyber attack OR Norge dataangrep OR NSM",
  ]},
  { id: "key_reports", title: "Viktige rapporter", queries: [
      "cybersecurity annual report OR trusselvurdering OR whitepaper",
  ]},
  { id: "cyberforsvaret_social", title: "SoMe: Cyberforsvaret", queries: [
      "\"Cyberforsvaret\" OR \"Norwegian Armed Forces Cyber Defence\"",
  ]},
  { id: "milno_targeting", title: "Omtale/angrep mot mil.no", queries: [
      "\"mil.no\" cyber attack OR target OR phishing",
  ]},
  { id: "cyberforsvaret_media", title: "Norske medier: Cyberforsvaret", queries: [
      "Cyberforsvaret site:nrk.no OR site:aftenposten.no OR site:vg.no OR site:dn.no OR site:e24.no",
  ]},
  { id: "mil_ops_analysis", title: "Analyser: cyber i militære operasjoner", queries: [
      "offensive cyber in military operations analysis",
      "defensive cyber doctrine electronic warfare",
  ]},
];

export const morningReport = new Hono<{ Bindings: Bindings }>();

morningReport.get("/morning-report", async (c: Context<{ Bindings: Bindings }>) => {
  const hours = Number(c.req.query("hours") || "24");
  const cutoff = Date.now() - hours * 3600 * 1000;

  let categories: Record<string, CategoryOut>;
  if (c.env.PERPLEXITY_API_KEY) {
    categories = await viaPerplexity(CATEGORY_CONFIG, cutoff, c.env.PERPLEXITY_API_KEY);
  } else {
    categories = await viaRssFallback(CATEGORY_CONFIG, cutoff);
  }

  const out: Out = {
    generated_at: new Date().toISOString(),
    window_hours: hours,
    categories,
    meta: { titles: Object.fromEntries(CATEGORY_CONFIG.map(c => [c.id, c.title])) },
  };

  return c.json(out, 200, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
});

// ---------- helpers ----------
async function viaPerplexity(
  cats: { id: string; title: string; queries: string[] }[],
  cutoffMs: number,
  key: string
): Promise<Record<string, CategoryOut>> {
  const out: Record<string, CategoryOut> = {};
  for (const cat of cats) {
    const bucket: Item[] = [];
    for (const q of cat.queries) {
      const r = await fetch("https://api.perplexity.ai/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ query: q, top_k: 5 }),
      });
      if (!r.ok) continue;
      const data = await r.json() as any;
      const hits = (data.results || []).map((x: any) => ({
        title: x.title || x.url,
        url: x.url,
        source: safeHost(x.url),
        published_at: x.published_at || null,
        tags: [],
      })) as Item[];

      for (const h of hits) {
        if (!h.url) continue;
        if (h.published_at) {
          const t = Date.parse(h.published_at);
          if (!Number.isNaN(t) && t < cutoffMs) continue;
        }
        if (!bucket.find(e => e.url === h.url)) bucket.push(h);
      }
      await sleep(150);
    }
    out[cat.id] = { items: bucket.slice(0, 10) };
  }
  return out;
}

async function viaRssFallback(
  cats: { id: string; title: string; queries: string[] }[],
  cutoffMs: number
): Promise<Record<string, CategoryOut>> {
  // Åpne, nøkkelløse kilder – utvid gjerne
  const FEEDS = [
    { url: "https://krebsonsecurity.com/feed/", label: "Krebs" },
    { url: "https://feeds.feedburner.com/TheHackersNews", label: "The Hacker News" },
    { url: "https://www.bleepingcomputer.com/feed/", label: "BleepingComputer" },
  ];
  const pool: Item[] = [];
  for (const f of FEEDS) {
    try {
      const res = await fetch(f.url, { cf: { cacheTtl: 600 } as any });
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseRssOrAtom(xml).map(i => ({ ...i, source: f.label || safeHost(i.url) }));
      pool.push(...items);
    } catch { /* ignore */ }
  }
  const out: Record<string, CategoryOut> = {};
  for (const cat of cats) {
    const items = pool
      .filter(i => matchCategory(i, cat.id))
      .filter(i => {
        if (!i.published_at) return true;
        const t = Date.parse(i.published_at);
        return Number.isNaN(t) ? true : t >= cutoffMs;
      });
    out[cat.id] = { items: dedupe(items).slice(0, 10) };
  }
  return out;
}

function matchCategory(it: Item, id: string) {
  const t = `${it.title ?? ""} ${it.summary ?? ""}`.toLowerCase();
  switch (id) {
    case "norway_incidents":
      return /(norway|norge|norwegian|nsm|oslo|bergen|trondheim|stavanger)/.test(t);
    case "key_reports":
      return /(report|whitepaper|trusselvurdering|annual|trend)/.test(t);
    case "cyberforsvaret_social":
      return /(cyberforsvaret|norwegian armed forces cyber defence|cyfor)/.test(t);
    case "milno_targeting":
      return /(mil\.no)/.test(t);
    case "cyberforsvaret_media":
      return /(cyberforsvaret)/.test(t) && /(nrk|aftenposten|vg|dagbladet|dn\.no|e24)/.test((it.source ?? "").toLowerCase());
    case "mil_ops_analysis":
      return /(offensive cyber|defensive cyber|military operations|doktrine|electronic warfare|ew)/.test(t);
    default:
      return /(ransomware|ddos|sårbarhet|vulnerability|intrusion|breach|cisa|cert)/.test(t);
  }
}

function dedupe(items: Item[]) {
  const seen = new Set<string>(); const out: Item[] = [];
  for (const it of items) {
    const k = it.url || it.title;
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(it);
  }
  return out;
}

function parseRssOrAtom(xml: string): Item[] {
  const items: Item[] = [];
  const rss = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of rss) {
    items.push({
      title: pick(block, "title"),
      url: pick(block, "link"),
      published_at: pick(block, "pubDate") || null,
      summary: pick(block, "description"),
      tags: [],
    });
  }
  const atom = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of atom) {
    const linkHref = (block.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i) || [])[1] || "";
    items.push({
      title: pick(block, "title"),
      url: linkHref || pick(block, "id"),
      published_at: pick(block, "updated") || pick(block, "published") || null,
      summary: pick(block, "summary") || pick(block, "content"),
      tags: [],
    });
  }
  return items.filter(x => x.title || x.url);
}

function pick(block: string, tag: string) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!m) return "";
  return decodeHtml(stripTags(m[1]).trim());
}

function stripTags(s: string) { return s.replace(/<[^>]+>/g, ""); }
function decodeHtml(s: string) {
  return s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
          .replace(/&quot;/g,"\"").replace(/&#39;/g,"'");
}
function safeHost(u?: string) { try { return new URL(u!).hostname.replace(/^www\./,""); } catch { return "kilde"; } }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export default morningReport;
