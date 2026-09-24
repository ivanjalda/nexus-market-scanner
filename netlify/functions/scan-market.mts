import { schedule } from '@netlify/functions';

const WATCHLIST = [
  'AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'GOOGL', 'META',
  'BTC/USD', 'ETH/USD', 'EUR/USD', 'GBP/USD'
];

export const handler = schedule('0 21 * * 1-5', async () => {
  console.log('🚀 Iniciando escaneo del mercado real con Twelve Data...');
  
  const apiKey = process.env.TWELVE_DATA_API_KEY || process.env.POLYGON_API_KEY;
  
  if (!apiKey) {
    console.error('❌ ERROR: No se encontró ninguna API Key configurada.');
    return { statusCode: 500, body: 'Missing API Key' };
  }

  try {
    const symbolsStr = WATCHLIST.join(',');
    const url = `https://api.twelvedata.com/quote?symbol=${symbolsStr}&apikey=${apiKey}`;
    
    console.log(`📡 Consultando mercado para: ${symbolsStr}`);
    const response = await fetch(url);
    const data = await response.json();

    console.log('✅ Respuestas recibidas de la API con éxito.');
    
    const results = [];
    
    for (const sym of WATCHLIST) {
      const item = data[sym] || (data.symbol === sym ? data : null);
      if (item && item.close) {
        const price = parseFloat(item.close);
        const changePct = parseFloat(item.percent_change || 0);
        
        let signal = 'NEUTRAL';
        if (changePct > 0.8) signal = 'COMPRA (ALCISTA)';
        else if (changePct < -0.8) signal = 'VENTA (BAJISTA)';

        results.push({
          symbol: sym,
          price: price,
          changePercent: changePct,
          signal: signal,
          updatedAt: new Date().toISOString()
        });
      }
    }

    console.log(`📊 Escaneo finalizado. Total activos analizados: ${results.length}`);
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ok', data: results })
    };

  } catch (err) {
    console.error('❌ Error durante la ejecución:', err);
    return { statusCode: 500, body: String(err) };
  }
});
