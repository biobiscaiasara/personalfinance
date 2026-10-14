function cleanSymbol(value) {
  const s = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9.^=_-]{1,24}$/.test(s) ? s : null;
}

function unix(dateStr, endOfDay=false) {
  const d = new Date(dateStr + (endOfDay ? "T23:59:59Z" : "T00:00:00Z"));
  return Math.floor(d.getTime()/1000);
}

async function chartFromHost(host, symbol, params) {
  const qs = new URLSearchParams(params);
  qs.set("includePrePost","false");
  qs.set("events","div,splits");
  qs.set("corsDomain","finance.yahoo.com");

  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs.toString()}`;
  const response = await fetch(url, {
    headers: {
      "Accept":"application/json,text/plain,*/*",
      "Accept-Language":"en-US,en;q=0.9",
      "Cache-Control":"no-cache",
      "Pragma":"no-cache",
      "Referer":"https://finance.yahoo.com/",
      "User-Agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
    }
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`${host} returned ${response.status}: ${raw.slice(0,120)}`);
  }
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error(`${host} returned invalid JSON`); }
  const result = json?.chart?.result?.[0];
  if (!result) {
    throw new Error(json?.chart?.error?.description || "No chart data");
  }
  return result;
}

async function yahooChart(symbol, params) {
  let last;
  for (const host of ["query1.finance.yahoo.com","query2.finance.yahoo.com"]) {
    try { return await chartFromHost(host, symbol, params); }
    catch (e) { last=e; }
  }
  throw last || new Error("Yahoo chart failed");
}

async function resolveSymbol(requested, params) {
  const attempts=[requested];
  if(!requested.includes("."))attempts.push(requested+".DE");
  let last;
  for(const symbol of attempts){
    try{return {symbol,data:await yahooChart(symbol,params)}}
    catch(e){last=e}
  }
  throw last||new Error("No market data");
}

function normalize(res, requested, includeHistory) {
  const {symbol,data}=res;
  const meta=data.meta||{};
  const timestamps=data.timestamp||[];
  const quote=data.indicators?.quote?.[0]||{};
  const closes=quote.close||[];

  let currentPrice=Number(meta.regularMarketPrice);
  if(!Number.isFinite(currentPrice)){
    for(let i=closes.length-1;i>=0;i--){
      const n=Number(closes[i]); if(Number.isFinite(n)){currentPrice=n;break}
    }
  }

  const out={
    requestedSymbol:requested,
    symbol,
    currency:meta.currency||"",
    exchangeName:meta.exchangeName||"",
    currentPrice:Number.isFinite(currentPrice)?currentPrice:null,
    marketTime:meta.regularMarketTime||null
  };

  if(includeHistory){
    out.history=timestamps.map((ts,i)=>{
      const close=Number(closes[i]);
      if(!Number.isFinite(close))return null;
      return {
        date:new Date(ts*1000).toISOString().slice(0,10),
        timestamp:ts,
        close
      };
    }).filter(Boolean);
  }
  return out;
}

exports.handler=async function(event){
  if(event.httpMethod!=="GET"){
    return {statusCode:405,body:JSON.stringify({error:"Method not allowed"})};
  }

  const raw=event.queryStringParameters?.symbols||"";
  const symbols=raw.split(",").map(cleanSymbol).filter(Boolean);
  if(!symbols.length)return {statusCode:400,body:JSON.stringify({error:"Missing symbols"})};
  if(symbols.length>10)return {statusCode:400,body:JSON.stringify({error:"Maximum 10 symbols per request"})};

  const from=event.queryStringParameters?.from;
  const to=event.queryStringParameters?.to;
  const includeHistory=Boolean(from&&to);

  let params;
  if(includeHistory){
    params={period1:String(unix(from)),period2:String(unix(to,true)),interval:"1d"};
  }else{
    params={range:"5d",interval:"1d"};
  }

  const results=await Promise.all(symbols.map(async requested=>{
    try{
      return normalize(await resolveSymbol(requested,params),requested,includeHistory);
    }catch(e){
      return {requestedSymbol:requested,symbol:requested,currentPrice:null,currency:"",error:e?.message||String(e)};
    }
  }));

  return {
    statusCode:200,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":includeHistory
        ? "public, max-age=86400, stale-while-revalidate=604800"
        : "public, max-age=300, stale-while-revalidate=900",
      "Netlify-CDN-Cache-Control":includeHistory
        ? "public, durable, max-age=86400, stale-while-revalidate=604800"
        : "public, durable, max-age=300, stale-while-revalidate=900"
    },
    body:JSON.stringify({results})
  };
};
