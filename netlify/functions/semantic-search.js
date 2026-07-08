// Netlify Function: semantic-search
// Proxies a search query + candidate node list to Claude (Haiku) for semantic matching.
// The API key lives ONLY in this server-side function (Netlify env var ANTHROPIC_API_KEY),
// never in the client bundle. Includes a daily global cap and a per-IP hourly cap so a
// public, unauthenticated demo can't run up an unbounded bill.

const { getStore } = require("@netlify/blobs");

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 300;

const DAILY_CAP = 300;
const HOURLY_IP_CAP = 15;
const MAX_QUERY_LEN = 100;
const MAX_CANDIDATES = 200;

function todayKey() {
return new Date().toISOString().slice(0, 10);
}
function hourKey() {
return new Date().toISOString().slice(0, 13);
}
function json(status, body) {
return {
statusCode: status,
headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
body: JSON.stringify(body),
};
}

exports.handler = async (event) => {
if (event.httpMethod === "OPTIONS") {
return json(200, { ok: true });
}
if (event.httpMethod !== "POST") {
return json(405, { error: "POST only" });
}

let payload;
try {
payload = JSON.parse(event.body || "{}");
} catch {
return json(400, { error: "bad json" });
}

const query = String(payload.query || "").trim().slice(0, MAX_QUERY_LEN);
const candidates = Array.isArray(payload.candidates) ? payload.candidates.slice(0, MAX_CANDIDATES) : [];

if (!query || query.length < 2 || candidates.length === 0) {
return json(400, { error: "missing query or candidates" });
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
return json(500, { error: "search is not configured" });
}

try {
const usage = getStore("search-usage");

const dKey = `day-${todayKey()}`;
const dayCount = (await usage.get(dKey, { type: "json" })) || 0;
if (dayCount >= DAILY_CAP) {
return json(429, { error: "Semantic search has hit its free daily limit. Try again tomorrow, or use plain keyword search above." });
}

const ip =
event.headers["x-nf-client-connection-ip"] ||
event.headers["x-forwarded-for"] ||
"unknown";
const hKey = `ip-${ip}-${hourKey()}`;
const ipCount = (await usage.get(hKey, { type: "json" })) || 0;
if (ipCount >= HOURLY_IP_CAP) {
return json(429, { error: "Too many searches from this location in the last hour. Try again shortly." });
}

await usage.set(dKey, dayCount + 1, { metadata: { updated: Date.now() } });
await usage.set(hKey, ipCount + 1, { metadata: { updated: Date.now() } });
} catch (e) {
console.error("rate-limit store error", e);
}

const list = candidates
.map((c, i) => `${i}. ${c.name || ""}${c.meta ? " — " + String(c.meta).slice(0, 140) : ""}`)
.join("\n");

const prompt = `You are matching a search query against a list of construction business records (a demo dataset). Given the query and the numbered list below, return ONLY the indices of items that are relevant — including synonyms, related trades, and related concepts (e.g. "structural material" should match steel, concrete, lumber items if present). Respond with ONLY a JSON array of integers, nothing else. If nothing is relevant, respond with [].

Query: "${query}"

Items:
${list}`;

try {
const resp = await fetch("https://api.anthropic.com/v1/messages", {
method: "POST",
headers: {
"content-type": "application/json",
"x-api-key": apiKey,
"anthropic-version": "2023-06-01",
},
body: JSON.stringify({
model: MODEL,
max_tokens: MAX_TOKENS,
messages: [{ role: "user", content: prompt }],
}),
});

if (!resp.ok) {
const errText = await resp.text();
console.error("anthropic error", resp.status, errText);
return json(502, { error: "search backend error" });
}

const data = await resp.json();
const text = (data.content && data.content[0] && data.content[0].text) || "[]";
const match = text.match(/\[[\d,\s]*\]/);
let indices = [];
if (match) {
try { indices = JSON.parse(match[0]); } catch { indices = []; }
}
const ids = indices
.filter((i) => Number.isInteger(i) && candidates[i])
.map((i) => candidates[i].id);

return json(200, { ids });
} catch (e) {
console.error("semantic-search fatal", e);
return json(502, { error: "search backend error" });
}
};
