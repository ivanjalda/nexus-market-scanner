import { getStore } from "@netlify/blobs";

// ---- Configuración ----
const POLYGON_KEY = process.env.POLYGON_API_KEY;
const CALL_DELAY_MS = 13000;      // 5 llamadas/min en el plan gratuito de Polygon -> 12s + margen
const MAX_CALLS_PER_RUN = 65;     // ~14 min por ejecución, deja margen antes de cualquier corte de tiempo
const HISTORY_LENGTH = 60;        // sesiones que guardamos por ticker
const MIN_DOLLAR_VOLUME = 5_000_000; // filtro de liquidez para descartar basura/penny stocks
const MIN_PRICE = 1;

const MARKETS = [
  { key: "stocks", path: "us/market/stocks" },
  { key: "crypto", path: "global/market/crypto" },
  { key: "fx",     path: "global/market/fx" }
];

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function toISODate(d: Date) { return d.toISOString().slice(0, 10); }

function addDays(d: Date, n: number) { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; }

async function fetchGroupedDaily(marketPath: string, date: string) {
  const url = `https://api.polygon.io/v2/aggs/grouped/locale/${marketPath}/${date}?adjusted=true&apiKey=${POLYGON_KEY}`;
  const res = await fetch(url);
  if (res.status === 404) return null; // no hubo sesión ese día
  const json = await res.json();
  if (json.status === "ERROR" || json.status === "NOT_AUTHORIZED") {
    throw new Error(`Polygon error (${marketPath} ${date}): ${json.error || json.message}`);
  }
  return json.results || null; // [{T:ticker, o,h,l,c,v}, ...]
}

// ---- Indicadores reales ----
function sma(arr: number[], period: number) {
  if (arr.length < period) return null;
  const s = arr.slice(-period);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
function rsi(closes: number[], period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function atr(highs: number[], lows: number[], closes: number[], period = 14) {
  if (closes.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function analyzeTicker(closes: number[], highs: number[], lows: number[], volumes: number[]) {
  const price = closes[closes.length - 1];
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(highs, lows, closes, 14);
  const window20c = closes.slice(-20), window20h = highs.slice(-20), window20l = lows.slice(-20);
  const high20 = Math.max(...window20h), low20 = Math.min(...window20l);
  if (s20 === null || r === null || a === null) return null;

  const trend = s50 !== null ? (s20 > s50 ? "alcista" : "bajista") : (price > s20 ? "alcista" : "bajista");
  const trendStrength = s50 !== null ? ((s20 - s50) / s50) * 100 : ((price - s20) / s20) * 100;
  const distToHigh = ((high20 - price) / price) * 100;
  const distToLow = ((price - low20) / price) * 100;
  const atrPct = (a / price) * 100;

  let verdict = "wait", why = "Sin condiciones técnicas claras — rango sin dirección definida.";
  if (trend === "alcista" && r < 68 && distToHigh < 3) {
    verdict = "long"; why = "Tendencia alcista, RSI sin sobrecompra extrema y precio cerca de máximos de 20 sesiones.";
  } else if (trend === "bajista" && r > 32 && distToLow < 3) {
    verdict = "short"; why = "Tendencia bajista, RSI sin sobreventa extrema y precio cerca de mínimos de 20 sesiones.";
  } else if (r > 72) {
    why = `RSI en sobrecompra (${r.toFixed(1)}) — riesgo de corrección antes de continuar.`;
  } else if (r < 28) {
    why = `RSI en sobreventa (${r.toFixed(1)}) — riesgo de rebote antes de confirmar bajista.`;
  }

  // Horizonte orientativo, NO una promesa: cuanto más fuerte la tendencia y más baja la volatilidad relativa, horizonte algo mayor.
  const strengthAbs = Math.abs(trendStrength);
  let horizon = "1-3 sesiones";
  if (strengthAbs > 8 && atrPct < 4) horizon = "5-10 sesiones";
  else if (strengthAbs > 4) horizon = "3-6 sesiones";

  return {
    price: round(price), rsi: round(r), sma20: round(s20), sma50: s50 !== null ? round(s50) : null,
    high20: round(high20), low20: round(low20), distToHigh: round(distToHigh), distToLow: round(distToLow),
    trend, trendStrength: round(trendStrength), atr: round(a), atrPct: round(atrPct),
    stopSuggested: round(a * 1.5), horizon, verdict, why,
    avgDollarVolume: round(avgOf(volumes) * price)
  };
}
function round(n: number) { return Math.round(n * 100) / 100; }
function avgOf(arr: number[]) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

export default async () => {
  if (!POLYGON_KEY) {
    return new Response(JSON.stringify({ error: "Falta la variable de entorno POLYGON_API_KEY en Netlify." }), { status: 500 });
  }

  const store = getStore("market-data");
  let calls = 0;

  for (const market of MARKETS) {
    const seriesKey = `series_${market.key}`;
    let series: Record<string, { dates: string[]; c: number[]; h: number[]; l: number[]; v: number[] }> =
      (await store.get(seriesKey, { type: "json" })) || {};
    let cursorKey = `cursor_${market.key}`;
    let cursor: string | null = (await store.get(cursorKey, { type: "json" })) || null;

    // Punto de partida: si no hay histórico, arrancamos ~95 días naturales atrás para acumular ~60 sesiones.
    let cursorDate = cursor ? addDays(new Date(cursor), 1) : addDays(new Date(), -95);
    const today = new Date();

    while (calls < MAX_CALLS_PER_RUN && cursorDate < today) {
      const dateStr = toISODate(cursorDate);
      try {
        const results = await fetchGroupedDaily(market.path, dateStr);
        calls++;
        if (results && results.length) {
          for (const r of results) {
            const sym = r.T;
            if (!sym) continue;
            if (!series[sym]) series[sym] = { dates: [], c: [], h: [], l: [], v: [] };
            const s = series[sym];
            s.dates.push(dateStr); s.c.push(r.c); s.h.push(r.h); s.l.push(r.l); s.v.push(r.v);
            if (s.dates.length > HISTORY_LENGTH) {
              s.dates.shift(); s.c.shift(); s.h.shift(); s.l.shift(); s.v.shift();
            }
          }
        }
        cursor = dateStr;
        await store.setJSON(cursorKey, cursor);
        await store.setJSON(seriesKey, series);
      } catch (e) {
        // si un día falla, lo dejamos y seguimos con el siguiente en la próxima ejecución
        break;
      }
      cursorDate = addDays(cursorDate, 1);
      if (calls < MAX_CALLS_PER_RUN) await sleep(CALL_DELAY_MS);
    }

    // Recalcular análisis con lo que tengamos hasta ahora
    const scored: any[] = [];
    for (const [sym, s] of Object.entries(series)) {
      if (s.c.length < 20) continue; // histórico insuficiente todavía
      const lastPrice = s.c[s.c.length - 1];
      const avgVol = avgOf(s.v);
      if (lastPrice < MIN_PRICE) continue;
      if (avgVol * lastPrice < MIN_DOLLAR_VOLUME) continue;
      const analysis = analyzeTicker(s.c, s.h, s.l, s.v);
      if (analysis) scored.push({ symbol: sym, market: market.key, ...analysis });
    }

    const longs = scored.filter(s => s.verdict === "long").sort((a, b) => b.trendStrength - a.trendStrength).slice(0, 50);
    const shorts = scored.filter(s => s.verdict === "short").sort((a, b) => a.trendStrength - b.trendStrength).slice(0, 50);

    await store.setJSON(`results_${market.key}`, {
      updatedAt: new Date().toISOString(),
      historyDays: Math.max(0, ...Object.values(series).map((s: any) => s.c.length)),
      totalEligible: scored.length,
      totalTracked: Object.keys(series).length,
      longs, shorts
    });
  }

  return new Response(JSON.stringify({ ok: true, callsUsed: calls }), { status: 200 });
};

export const config = { schedule: "0 21 * * 1-5" }; // 21:00 UTC, de lunes a viernes (tras el cierre de Wall Street)
