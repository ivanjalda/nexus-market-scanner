import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("market-data");
  const [stocks, crypto, fx] = await Promise.all([
    store.get("results_stocks", { type: "json" }),
    store.get("results_crypto", { type: "json" }),
    store.get("results_fx", { type: "json" })
  ]);

  return new Response(JSON.stringify({
    stocks: stocks || null,
    crypto: crypto || null,
    fx: fx || null
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" }
  });
};
