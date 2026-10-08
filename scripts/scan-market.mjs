import { readFile, writeFile, mkdir } from 'fs/promises';

const POLYGON_KEY = process.env.POLYGON_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

const CALL_DELAY_MS = 12500;
const MAX_CALLS_PER_RUN = 30;
const HISTORY_LENGTH = 60;
const MIN_DOLLAR_VOLUME = 5_000_000;
const MIN_PRICE = 1;
const EVAL_HORIZON = 5;

const MARKETS = [
  { key: "stocks", path: "us/market/stocks", label: "Acciones EEUU" },
  { key: "crypto", path: "global/market/crypto", label: "Cripto" },
  { key: "fx",     path: "global/market/fx", label: "Forex" }
];
const DATA_DIR = "data";

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function toISODate(d){ return d.toISOString().slice(0,10); }
function addDays(d,n){ const c=new Date(d); c.setUTCDate(c.getUTCDate()+n); return c; }

async function loadJSON(path, fallback){
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}
async function saveJSON(path, obj){ await writeFile(path, JSON.stringify(obj), 'utf8'); }

async function sendTelegram(text){
  if(!TG_TOKEN || !TG_CHAT) return;
  try{
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true })
    });
  }catch(e){ console.error("Error enviando Telegram:", e.message); }
}

async function fetchGroupedDaily(marketPath, date){
  const url = `https://api.polygon.io/v2/aggs/grouped/locale/${marketPath}/${date}?adjusted=true&apiKey=${POLYGON_KEY}`;
  const res = await fetch(url);
  if(res.status===404) return null;
  const json = await res.json();
  if(json.status==="ERROR"||json.status==="NOT_AUTHORIZED"){
    throw new Error(`Polygon error (${marketPath} ${date}): ${json.error||json.message}`);
  }
  return json.results||null;
}

function sma(arr,period){ if(arr.length<period) return null; const s=arr.slice(-period); return s.reduce((a,b)=>a+b,0)/s.length; }
function rsi(closes,period=14){
  if(closes.length<period+1) return null;
  let gains=0, losses=0;
  for(let i=closes.length-period;i<closes.length;i++){
    const diff=closes[i]-closes[i-1];
    if(diff>=0) gains+=diff; else losses-=diff;
  }
  const avgGain=gains/period, avgLoss=losses/period;
  if(avgLoss===0) return 100;
  return 100-100/(1+avgGain/avgLoss);
}
function atr(highs,lows,closes,period=14){
  if(closes.length<period+1) return null;
  const trs=[];
  for(let i=closes.length-period;i<closes.length;i++){
    const tr=Math.max(
      highs[i]-lows[i],
      Math.abs(highs[i]-closes[i-1]),
      Math.abs(lows[i]-closes[i-1])
    );
    trs.push(tr);
  }
  return trs.reduce((a,b)=>a+b,0)/trs.length;
}
function round(n){ return Math.round(n*100)/100; }
function avgOf(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }

function analyzeTicker(closes,highs,lows,volumes){
  const price=closes[closes.length-1];
  const s20=sma(closes,20), s50=sma(closes,50), r=rsi(closes,14), a=atr(highs,lows,closes,14);
  const h20=Math.max(...highs.slice(-20)), l20=Math.min(...lows.slice(-20));
  if(s20===null||r===null||a===null) return null;

  const trend = s50!==null ? (s20>s50?"alcista":"bajista") : (price>s20?"alcista":"bajista");
  const trendStrength = s50!==null ? ((s20-s50)/s50)*100 : ((price-s20)/s20)*100;
  const distToHigh=((h20-price)/price)*100, distToLow=((price-l20)/price)*100;
  const atrPct=(a/price)*100;

  let verdict="wait", why="Sin condiciones técnicas claras — rango sin dirección definida.";
  if(trend==="alcista" && r<68 && distToHigh<3){
    verdict="long"; why="Tendencia alcista, RSI sin sobrecompra extrema y precio cerca de máximos de 20 sesiones.";
  } else if(trend==="bajista" && r>32 && distToLow<3){
    verdict="short"; why="Tendencia bajista, RSI sin sobreventa extrema y precio cerca de mínimos de 20 sesiones.";
  } else if(r>72){
    why=`RSI en sobrecompra (${r.toFixed(1)}) — riesgo de corrección antes de continuar.`;
  } else if(r<28){
    why=`RSI en sobreventa (${r.toFixed(1)}) — riesgo de rebote antes de confirmar bajista.`;
  }

  const strengthAbs=Math.abs(trendStrength);
  let horizon="1-3 sesiones";
  if(strengthAbs>8 && atrPct<4) horizon="5-10 sesiones";
  else if(strengthAbs>4) horizon="3-6 sesiones";

  return {
    price:round(price), rsi:round(r), sma20:round(s20), sma50:s50!==null?round(s50):null,
    high20:round(h20), low20:round(l20), distToHigh:round(distToHigh), distToLow:round(distToLow),
    trend, trendStrength:round(trendStrength), atr:round(a), atrPct:round(atrPct),
    stopSuggested:round(a*1.5), horizon, verdict, why,
    avgDollarVolume: round(avgOf(volumes)*price)
  };
}

function evaluateSignals(signals, seriesByMarket){
  for(const sig of signals){
    if(sig.status === "closed") continue;
    const marketSeries = seriesByMarket[sig.market];
    const s = marketSeries ? marketSeries[sig.symbol] : null;
    if(!s) continue;
    const i0 = s.dates.indexOf(sig.signalDate);
    if(i0 === -1){ sig.status = "unverified"; continue; }
    const iEntry = i0 + 1;
    if(iEntry >= s.c.length) continue;
    if(sig.entryPrice === null){
      sig.entryPrice = s.c[iEntry];
      sig.entryDate = s.dates[iEntry];
    }
    const iExit = iEntry + EVAL_HORIZON;
    const dir = sig.verdict === "long" ? 1 : -1;
    if(iExit < s.c.length){
      sig.exitPrice = s.c[iExit];
      sig.exitDate = s.dates[iExit];
      sig.returnPct = round(dir * (s.c[iExit] / sig.entryPrice - 1) * 100);
      sig.currentReturnPct = null;
      sig.status = "closed";
    } else {
      sig.currentReturnPct = round(dir * (s.c[s.c.length - 1] / sig.entryPrice - 1) * 100);
    }
  }
}

async function run(){
  if(!POLYGON_KEY){ console.error("Falta POLYGON_API_KEY"); process.exit(1); }
  await mkdir(DATA_DIR, {recursive:true});

  const previousResults = await loadJSON("results.json", {});
  const signals = await loadJSON(`${DATA_DIR}/signals.json`, []);
  const knownIds = new Set(signals.map(s=>s.id));
  const seriesByMarket = {};
  let totalCalls=0;
  const results={};
  const alertBlocks = [];

  for(const market of MARKETS){
    const seriesPath = `${DATA_DIR}/series_${market.key}.json`;
    const stateObj = await loadJSON(seriesPath, {cursor:null, series:{}});
    const series = stateObj.series;
    let cursor = stateObj.cursor;

    let cursorDate = cursor ? addDays(new Date(cursor),1) : addDays(new Date(), -95);
    const todayStr = toISODate(new Date());

    while(totalCalls<MAX_CALLS_PER_RUN && toISODate(cursorDate)<todayStr){
      const dateStr=toISODate(cursorDate);
      try{
        const res = await fetchGroupedDaily(market.path, dateStr);
        totalCalls++;
        console.log(`[${market.key}] ${dateStr}: ${res?res.length:0} tickers`);
        if(res && res.length){
          for(const r of res){
            const sym = r.T;
            if(!sym) continue;
            if(!series[sym]) series[sym]={dates:[],c:[],h:[],l:[],v:[]};
            const s = series[sym];
            s.dates.push(dateStr); s.c.push(r.c); s.h.push(r.h); s.l.push(r.l); s.v.push(r.v);
            if(s.dates.length>HISTORY_LENGTH){ s.dates.shift(); s.c.shift(); s.h.shift(); s.l.shift(); s.v.shift(); }
          }
        }
        cursor=dateStr;
      }catch(e){
        console.error(`FALLO en ${market.key} ${dateStr}:`, e.message);
        break;
      }
      cursorDate=addDays(cursorDate,1);
      if(totalCalls<MAX_CALLS_PER_RUN && toISODate(cursorDate)<todayStr) await sleep(CALL_DELAY_MS);
    }

    await saveJSON(seriesPath, {cursor, series});
    seriesByMarket[market.key] = series;

    const scored=[];
    for(const [sym,s] of Object.entries(series)){
      if(s.c.length<20) continue;
      const lastPrice=s.c[s.c.length-1];
      const avgVol=avgOf(s.v);
      if(lastPrice<MIN_PRICE) continue;
      if(avgVol*lastPrice<MIN_DOLLAR_VOLUME) continue;
      const a=analyzeTicker(s.c,s.h,s.l,s.v);
      if(a) scored.push({symbol:sym, market:market.key, ...a});
    }

    const longs = scored.filter(s=>s.verdict==="long").sort((a,b)=>b.trendStrength-a.trendStrength).slice(0,50);
    const shorts = scored.filter(s=>s.verdict==="short").sort((a,b)=>a.trendStrength-b.trendStrength).slice(0,50);

    const prevMarket = previousResults[market.key] || { longs: [], shorts: [] };
    const prevSymbols = new Set([
      ...(prevMarket.longs||[]).map(s=>s.symbol),
      ...(prevMarket.shorts||[]).map(s=>s.symbol)
    ]);
    const newLongs = longs.filter(s=>!prevSymbols.has(s.symbol));
    const newShorts = shorts.filter(s=>!prevSymbols.has(s.symbol));

    for(const s of [...newLongs, ...newShorts]){
      const ser = series[s.symbol];
      const signalDate = ser.dates[ser.dates.length-1];
      const id = `${market.key}|${s.symbol}|${s.verdict}|${signalDate}`;
      if(knownIds.has(id)) continue;
      knownIds.add(id);
      signals.push({
        id, market: market.key, symbol: s.symbol, verdict: s.verdict, signalDate,
        trendStrength: s.trendStrength, rsi: s.rsi, status: "open",
        entryDate: null, entryPrice: null, exitDate: null, exitPrice: null,
        returnPct: null, currentReturnPct: null
      });
    }

    if(newLongs.length || newShorts.length){
      const MAX_PER_DIRECTION = 15;
      let block = `${market.label}\n`;
      newLongs.slice(0, MAX_PER_DIRECTION).forEach(s => block += `🟢 LONG ${s.symbol} — fuerza ${s.trendStrength}%, RSI ${s.rsi}\n`);
      if(newLongs.length > MAX_PER_DIRECTION) block += `…y ${newLongs.length - MAX_PER_DIRECTION} alcistas más (ver web)\n`;
      newShorts.slice(0, MAX_PER_DIRECTION).forEach(s => block += `🔴 SHORT ${s.symbol} — fuerza ${s.trendStrength}%, RSI ${s.rsi}\n`);
      if(newShorts.length > MAX_PER_DIRECTION) block += `…y ${newShorts.length - MAX_PER_DIRECTION} bajistas más (ver web)\n`;
      alertBlocks.push(block);
    }

    results[market.key] = {
      updatedAt: new Date().toISOString(),
      historyDays: Math.max(0, ...Object.values(series).map(s=>s.c.length)),
      totalEligible: scored.length,
      totalTracked: Object.keys(series).length,
      all: scored.slice().sort((a,b)=>a.symbol.localeCompare(b.symbol)),
      longs, shorts
    };
    console.log(`[${market.key}] histórico máximo: ${results[market.key].historyDays} sesiones, elegibles: ${scored.length}`);
  }

  evaluateSignals(signals, seriesByMarket);
  await saveJSON(`${DATA_DIR}/signals.json`, signals);
  await saveJSON("results.json", results);

  if(alertBlocks.length){
    for(const block of alertBlocks){
      await sendTelegram(`📊 Nexus Terminal — nuevas señales\n\n${block}`);
    }
    console.log(`Alertas de Telegram enviadas: ${alertBlocks.length}`);
  } else {
    console.log("Sin señales nuevas, no se envía alerta.");
  }

  console.log(`Listo. Llamadas usadas: ${totalCalls}. Señales registradas: ${signals.length}`);
}

run().catch(e=>{ console.error(e); process.exit(1); });
