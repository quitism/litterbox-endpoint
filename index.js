import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || null;

// middleware near the top of index.js
const ALLOWED_ORIGIN = "https://cw-litterbox.netlify.app";

app.use((req, res, next) => {
    const origin = req.get("origin");
    const referer = req.get("referer");

    if (origin === ALLOWED_ORIGIN || (referer && referer.startsWith(ALLOWED_ORIGIN))) {
        return next();
    }

    res.status(403).json({ error: "Forbidden" });
});


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base) => base + Math.floor(Math.random() * 200);

async function fetchWithRetries(url, opts = {}, { maxRetries = 2, name = "fetch" } = {}) {
  let attempt = 0;
  while (true) {
    attempt++;
    const start = Date.now();
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      const dur = Date.now() - start;
      console.error(`[${name}] attempt ${attempt} NETWORK ERROR ${url} (${dur}ms)`, err.message || err);
      if (attempt > maxRetries) throw err;
      await sleep(jitter(100 * Math.pow(2, attempt)));
      continue;
    }

    const duration = Date.now() - start;
    let text = null;
    try {
      text = await res.text();
    } catch (readErr) {
      console.error(`[${name}] attempt ${attempt} failed to read body for ${url}`, readErr.message || readErr);
      if (attempt > maxRetries) throw readErr;
      await sleep(jitter(100 * Math.pow(2, attempt)));
      continue;
    }

    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}

    console.log(`[${name}] attempt ${attempt} ${res.status} ${url} — ${duration}ms — ${text ? text.length : 0} bytes`);

    const tooManyRequests =
      res.status === 429 ||
      (json && ((Array.isArray(json.errors) && json.errors.some?.((e) => (e.message || "").toLowerCase().includes("too many"))) || (json.code === 0 && (json.message || "").toLowerCase().includes("too many"))));

    if (tooManyRequests) {
      console.warn(`[${name}] attempt ${attempt} rate-limited for ${url}`);
      if (attempt > maxRetries) {
        return { status: res.status, ok: res.ok, text, json, headers: Object.fromEntries(res.headers.entries()) };
      }
      await sleep(jitter(200 * Math.pow(2, attempt)));
      continue;
    }

    return { status: res.status, ok: res.ok, text, json, headers: Object.fromEntries(res.headers.entries()) };
  }
}

// simple logger middleware
app.use((req, res, next) => {
  const id = req.query && req.query.id ? req.query.id : "-";
  const ts = new Date().toISOString();
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "-";
  const ua = req.headers["user-agent"] || "-";
  console.log(`[REQ] ${ts} ${req.method} ${req.path} id=${id} from=${ip} ua="${ua}"`);
  next();
});

const thumbnailCache = new Map();
const DEFAULT_TTL_MS = 30 * 60 * 1000;

app.get("/thumbnail", async (req, res) => {
  try {
    const raw = req.query.id;
    if (!raw) return res.status(400).json({ error: "Missing id param" });

    const reqIds = Array.from(new Set(raw.split(",").map(s => s.trim()).filter(Boolean)));
    if (reqIds.length === 0) return res.status(400).json({ error: "No valid ids provided" });

    const responseData = [];
    const missingIds = [];

    for (const id of reqIds) {
      const cached = thumbnailCache.get(id);
      if (cached && Date.now() < cached.expires) {
        responseData.push(cached.entry);
      } else {
        missingIds.push(id);
      }
    }

    if (missingIds.length > 0) {
      const batchParam = missingIds.join(",");
      const url = `https://thumbnails.roblox.com/v1/assets?assetIds=${encodeURIComponent(batchParam)}&size=420x420&format=Png`;

      const result = await fetchWithRetries(url, {}, { maxRetries: 4, name: "thumbnail-batch" });

      let payload = result.json ?? null;
      if (!payload && result.text) {
        try { payload = JSON.parse(result.text); } catch { payload = { data: [] }; }
      }
      payload = payload || { data: [] };

      const items = Array.isArray(payload.data) ? payload.data : [];
      const byId = new Map();
      for (const item of items) {
        const assetId = (item.assetId ?? item.targetId ?? item.id ?? item.targetId);
        if (assetId !== undefined && assetId !== null) byId.set(String(assetId), item);
      }

      for (const id of missingIds) {
        const item = byId.get(id);
        let entry;
        if (item) {
          entry = item;
        } else {
          entry = { assetId: Number(id), state: "Error", errorMessage: "Not found or rate-limited" };
        }
        thumbnailCache.set(id, { expires: Date.now() + DEFAULT_TTL_MS, entry });
        responseData.push(entry);
      }
    }

    res.set("Access-Control-Allow-Origin", "*");
    res.json({ data: responseData });
  } catch (err) {
    console.error(`[thumbnail] handler error`, err);
    res.status(500).json({ error: "Internal error fetching thumbnails" });
  }
});

app.get("/asset", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "Missing id param" });

    const url = `https://assetdelivery.roblox.com/v1/assetId/${id}`;
    const headers = {};
    if (ROBLOSECURITY) headers.Cookie = `.ROBLOSECURITY=${ROBLOSECURITY}`;

    const result = await fetchWithRetries(url, { headers }, { maxRetries: 3, name: "asset" });

    const data = result.json ?? (result.text ? (() => { try { return JSON.parse(result.text); } catch { return { raw: result.text }; } })() : null);

    console.log(`[asset] resolved id=${id} auth=${!!ROBLOSECURITY} status=${result.status} location=${data && data.location ? "[present]" : "[missing]"}`);

    res.set("Access-Control-Allow-Origin", "*");
    res.json(data);
  } catch (err) {
    console.error(`[asset] failed for id=${req.query.id}`, err);
    res.status(500).json({ error: "Failed to fetch Roblox asset" });
  }
});

app.get("/audio", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "Missing id param" });

    const url = `https://assetdelivery.roblox.com/v1/assetId/${id}`;
    const result = await fetchWithRetries(url, {}, { maxRetries: 3, name: "audio-asset" });

    const data = result.json ?? (result.text ? (() => { try { return JSON.parse(result.text); } catch { return { raw: result.text }; } })() : null);

    if (!data || !data.location) {
      console.warn(`[audio] location not found for id=${id} — status=${result.status}`);
      return res.status(404).json({ error: "Audio location not found", raw: data ?? result.text });
    }

    console.log(`[audio] id=${id} -> resolved location length=${data.location.length}`);
    res.redirect(data.location);
  } catch (err) {
    console.error(`[audio] failed for id=${req.query.id}`, err);
    res.status(500).json({ error: "Failed to resolve audio" });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`proxy listening on port ${PORT}`);
  if (!ROBLOSECURITY) {
    console.warn("ROBLOSECURITY env var not set. Some asset endpoints may return different results or require authentication.");
  } else {
    console.log("ROBLOSECURITY env var detected (value not logged for safety).");
  }
});
