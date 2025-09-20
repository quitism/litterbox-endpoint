import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const ROBLOSECURITY = process.env.ROBLOSECURITY || null; // <-- put your token in env var, never hardcode

// helper: sleep
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * helper that wraps fetch with timing, basic logging, and retry on 429/network errors.
 * - retries on 429 status or network errors (up to maxRetries)
 * - logs method/url, status, duration, response size, and attempt count
 */
async function fetchWithRetries(url, opts = {}, { maxRetries = 2, name = 'fetch' } = {}) {
  let attempt = 0;
  while (true) {
    attempt++;
    const start = Date.now();
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      const durErr = Date.now() - start;
      console.error(`[${name}] attempt ${attempt} NETWORK ERROR for ${url} (${durErr}ms)`, err.message || err);
      if (attempt > maxRetries) throw err;
      const backoff = 100 * Math.pow(2, attempt); // 200, 400ms...
      await sleep(backoff);
      continue;
    }

    const duration = Date.now() - start;
    const status = res.status;

    // read body as text (safe to attempt; may be large for audio endpoints — but these endpoints here return JSON)
    let text;
    try {
      text = await res.text();
    } catch (readErr) {
      console.error(`[${name}] attempt ${attempt} failed to read body for ${url}`, readErr);
      if (attempt > maxRetries) throw readErr;
      const backoff = 100 * Math.pow(2, attempt);
      await sleep(backoff);
      continue;
    }

    const size = text ? text.length : 0;
    console.log(
      `[${name}] attempt ${attempt} ${status} ${url} — ${duration}ms — ${size} bytes`
    );

    // try to parse JSON if content looks like JSON
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (parseErr) {
      // not JSON — fine for some endpoints; log that it wasn't json
      json = null;
    }

    // if Roblox returns a 429 or JSON error indicating "Too many requests", retry
    const hasTooManyRequests =
      status === 429 ||
      (json && (json.errors || []).some?.((e) => (e.message || '').toLowerCase().includes('too many')) ) ||
      (json && json.code === 0 && (json.message || '').toLowerCase().includes('too many'));

    if (hasTooManyRequests) {
      console.warn(`[${name}] attempt ${attempt} rate-limited by Roblox for ${url}.`);
      if (attempt > maxRetries) {
        // return parsed json or fallback to raw text and status
        return { status, ok: res.ok, text, json };
      }
      const backoff = 200 * Math.pow(2, attempt); // 400ms, 800ms...
      await sleep(backoff);
      continue;
    }

    // everything looks good — return structured info
    return { status, ok: res.ok, text, json, headers: res.headers.raw ? res.headers.raw() : {} };
  } // end while
}

// middleware: request logger
app.use((req, res, next) => {
  const id = req.query && req.query.id ? req.query.id : '-';
  const ts = new Date().toISOString();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-';
  const ua = req.headers['user-agent'] || '-';
  console.log(`[REQ] ${ts} ${req.method} ${req.path} id=${id} from=${ip} ua="${ua}"`);
  next();
});

// Thumbnail proxy (unchanged endpoint but with logging + retries)
app.get("/thumbnail", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "Missing id param" });

    const url = `https://thumbnails.roblox.com/v1/assets?assetIds=${id}&size=420x420&format=Png`;
    const result = await fetchWithRetries(url, {}, { maxRetries: 2, name: 'thumbnail' });

    if (!result.ok && result.status !== 200) {
      console.warn(`[thumbnail] non-200 status for id=${id}:`, result.status);
    }

    // prefer parsed json if available, else try to return parsed text
    const payload = result.json ?? (result.text ? (() => { try { return JSON.parse(result.text); } catch { return { raw: result.text }; } })() : null);

    res.set("Access-Control-Allow-Origin", "*");
    res.json(payload);
  } catch (err) {
    console.error(`[thumbnail] failed for id=${req.query.id}`, err);
    res.status(500).json({ error: "Failed to fetch Roblox data" });
  }
});

// AssetDelivery proxy for audio (returns JSON with "location")
app.get("/asset", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "Missing id param" });

    const url = `https://assetdelivery.roblox.com/v1/assetId/${id}`;
    const headers = {};
    if (ROBLOSECURITY) {
      headers.Cookie = `.ROBLOSECURITY=${ROBLOSECURITY}`;
    }

    const result = await fetchWithRetries(url, { headers }, { maxRetries: 2, name: 'asset' });

    // If we got some JSON parsed by helper, use it. Otherwise try to parse text.
    const data = result.json ?? (result.text ? (() => { try { return JSON.parse(result.text); } catch { return { raw: result.text }; } })() : null);

    // Log important metadata about the response while avoiding secret exposure
    console.log(`[asset] resolved id=${id} auth=${!!ROBLOSECURITY} status=${result.status} location=${data && data.location ? '[present]' : '[missing]'}`);

    res.set("Access-Control-Allow-Origin", "*");
    res.json(data);
  } catch (err) {
    console.error(`[asset] failed for id=${req.query.id}`, err);
    res.status(500).json({ error: "Failed to fetch Roblox asset" });
  }
});


// optional: endpoint that redirects straight to audio file
app.get("/audio", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "Missing id param" });

    const url = `https://assetdelivery.roblox.com/v1/assetId/${id}`;
    const result = await fetchWithRetries(url, {}, { maxRetries: 2, name: 'audio-asset' });

    const data = result.json ?? (result.text ? (() => { try { return JSON.parse(result.text); } catch { return { raw: result.text }; } })() : null);

    if (!data || !data.location) {
      console.warn(`[audio] location not found for id=${id} — status=${result.status}`);
      return res.status(404).json({ error: "Audio location not found", raw: data ?? result.text });
    }

    // Log the resolved CDN URL (but not headers/cookies)
    console.log(`[audio] id=${id} -> resolved location (length=${data.location.length})`);

    // Redirect to the real audio file
    res.redirect(data.location);
  } catch (err) {
    console.error(`[audio] failed for id=${req.query.id}`, err);
    res.status(500).json({ error: "Failed to resolve audio" });
  }
});

app.listen(PORT, () => {
  console.log(`proxy listening on port ${PORT}`);
  if (!ROBLOSECURITY) {
    console.warn('ROBLOSECURITY env var not set. Some asset endpoints may return different results or require authentication.');
  } else {
    console.log('ROBLOSECURITY env var detected (value not logged for safety).');
  }
});
