const RANGE_MAP = {
  "1m":  { range: "1mo", interval: "1d" },
  "3m":  { range: "3mo", interval: "1d" },
  "6m":  { range: "6mo", interval: "1d" },
  "ytd": { range: "ytd", interval: "1d" },
  "all": { range: "max", interval: "1d" }
};

function cleanSymbol(value) {
  const s = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9.^=_-]{1,24}$/.test(s)) return null;
  return s;
}

async function yahooChart(symbol, range="5d", interval="1d") {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(symbol) +
    "?range=" + encodeURIComponent(range) +
    "&interval=" + encodeURIComponent(interval) +
    "&includePrePost=false&events=div%2Csplits";

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 Baggy-Coinly/1.0"
    }
  });

  if (!response.ok) {
    throw new Error("Yahoo Finance returned " + response.status);
  }

  const json = await response.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    const msg = json?.chart?.error?.description || "No market data";
    throw new Error(msg);
  }
  return result;
}

async function resolveSymbol(requested, range, interval) {
  const attempts = [requested];
  // Legacy ledger contains a few Xetra tickers without the Yahoo exchange
  // suffix. Try the raw symbol first; only then try .DE.
  if (!requested.includes(".")) attempts.push(requested + ".DE");

  let lastError;
  for (const symbol of attempts) {
    try {
      const data = await yahooChart(symbol, range, interval);
      return { symbol, data };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("No market data");
}

function normalise(result, requestedSymbol, includeHistory) {
  const { symbol, data } = result;
  const meta = data.meta || {};
  const timestamps = data.timestamp || [];
  const quotes = data.indicators?.quote?.[0] || {};
  const closes = quotes.close || [];

  let currentPrice = Number(meta.regularMarketPrice);
  if (!Number.isFinite(currentPrice)) {
    for (let i = closes.length - 1; i >= 0; i--) {
      const n = Number(closes[i]);
      if (Number.isFinite(n)) {
        currentPrice = n;
        break;
      }
    }
  }

  const out = {
    requestedSymbol,
    symbol,
    currency: meta.currency || "",
    exchangeName: meta.exchangeName || "",
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
    marketTime: meta.regularMarketTime || null
  };

  if (includeHistory) {
    out.history = timestamps.map((ts, i) => ({
      timestamp: ts,
      close: Number.isFinite(Number(closes[i])) ? Number(closes[i]) : null
    })).filter(p => p.close !== null);
  }

  return out;
}

exports.handler = async function(event) {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const raw = event.queryStringParameters?.symbols || "";
  const symbols = raw.split(",").map(cleanSymbol).filter(Boolean);
  if (!symbols.length) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing symbols" }) };
  }
  if (symbols.length > 20) {
    return { statusCode: 400, body: JSON.stringify({ error: "Maximum 20 symbols per request" }) };
  }

  const period = String(event.queryStringParameters?.period || "").toLowerCase();
  const includeHistory = Boolean(period && RANGE_MAP[period]);
  const cfg = includeHistory ? RANGE_MAP[period] : { range: "5d", interval: "1d" };

  const results = await Promise.all(symbols.map(async requestedSymbol => {
    try {
      const resolved = await resolveSymbol(requestedSymbol, cfg.range, cfg.interval);
      return normalise(resolved, requestedSymbol, includeHistory);
    } catch (e) {
      return {
        requestedSymbol,
        symbol: requestedSymbol,
        currentPrice: null,
        currency: "",
        error: e?.message || String(e)
      };
    }
  }));

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=900",
      "Netlify-CDN-Cache-Control": "public, durable, max-age=300, stale-while-revalidate=900"
    },
    body: JSON.stringify({ results })
  };
};
