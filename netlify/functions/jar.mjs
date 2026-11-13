// Trip Piggybank API: stores the jar in Netlify Blobs (built in, no setup).
import { getStore } from "@netlify/blobs";

const EMPTY = { settings: null, entries: [], pinHash: null, pinSalt: null };

async function hashPin(pin, salt) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ":" + pin));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// What the browser sees: never the PIN hash, just whether a PIN is on.
function publicView(data) {
  return { settings: { ...(data.settings || {}), pinEnabled: !!data.pinHash }, entries: data.entries, hasSettings: !!data.settings };
}

async function authorized(req, data) {
  if (!data.pinHash) return true;
  const pin = req.headers.get("x-jar-pin") || "";
  return pin && (await hashPin(pin, data.pinSalt)) === data.pinHash;
}

async function apply(data, b) {
  if (b.op === "add") {
    const x = b.entry || {};
    const amount = Number(x.amount);
    if (!["p1", "p2", "Both"].includes(x.who)) throw new Error("bad who");
    if (!["lunch", "dinner"].includes(x.meal)) throw new Error("bad meal");
    if (!(amount > 0 && amount < 10000)) throw new Error("bad amount");
    data.entries.push({ id: crypto.randomUUID(), who: x.who, meal: x.meal, people: Number(x.people) || 1, amount, ts: Number(x.ts) || Date.now() });
  } else if (b.op === "delete") {
    data.entries = data.entries.filter(e => e.id !== b.id);
  } else if (b.op === "settings") {
    const s = b.settings || {};
    const ppl = Array.isArray(s.people) ? s.people : [];
    data.settings = {
      tripName: String(s.tripName || "Trip Fund").slice(0, 40),
      people: ["J", "R"].map((d, i) => String(ppl[i] ?? "").trim().slice(0, 8) || d),
      goal: Math.max(1, Number(s.goal) || 2500),
      lunch: Math.max(0, Number(s.lunch) || 0),
      dinner: Math.max(0, Number(s.dinner) || 0)
    };
    if (s.pinEnabled) {
      if (s.newPin) {
        if (!/^\d{4,8}$/.test(String(s.newPin))) throw new Error("PIN must be 4 to 8 digits");
        data.pinSalt = crypto.randomUUID();
        data.pinHash = await hashPin(String(s.newPin), data.pinSalt);
      } else if (!data.pinHash) throw new Error("Choose a PIN");
    } else { data.pinHash = null; data.pinSalt = null; }
  } else throw new Error("unknown op");
  return data;
}

export default async (req) => {
  const store = getStore({ name: "piggybank", consistency: "strong" });

  if (req.method === "GET") {
    const data = (await store.get("jar", { type: "json" })) || EMPTY;
    if (!(await authorized(req, data))) return Response.json({ error: "pin" }, { status: 401 });
    return Response.json(publicView(data), { headers: { "Cache-Control": "no-store" } });
  }
  if (req.method !== "POST") return Response.json({ error: "method" }, { status: 405 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }

  // Retry on concurrent writes so two phones tapping at once don't overwrite each other.
  for (let i = 0; i < 5; i++) {
    const cur = await store.getWithMetadata("jar", { type: "json" });
    const data = structuredClone(cur?.data || EMPTY);
    if (!(await authorized(req, data))) return Response.json({ error: "pin" }, { status: 401 });
    try { await apply(data, body); } catch (e) { return Response.json({ error: e.message }, { status: 400 }); }
    const res = await store.setJSON("jar", data, cur?.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res?.modified !== false) return Response.json(publicView(data));
  }
  return Response.json({ error: "busy, try again" }, { status: 409 });
};

export const config = { path: "/api/jar" };
