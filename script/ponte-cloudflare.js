// Ponte per i prezzi: l'app chiede gli ISIN, questo servizio legge subito Borsa Italiana e risponde con i prezzi.
// Va incollato in un «Worker» di Cloudflare (gratuito).
export default {
  async fetch(request) {
    const origine = request.headers.get('Origin') || '';
    const intestazioni = {
      'Access-Control-Allow-Origin': origine.endsWith('.github.io') ? origine : 'https://tommyfonti-art.github.io',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: intestazioni });
    const url = new URL(request.url);
    const isin = (url.searchParams.get('isin') || '').toUpperCase().split(',')
      .filter(x => /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(x)).slice(0, 25);
    if (!isin.length) return new Response(JSON.stringify({ errore: 'Manca il codice ISIN' }), { status: 400, headers: intestazioni });
    const prezzi = {};
    await Promise.all(isin.map(async i => { prezzi[i] = await prezzo(i); }));
    return new Response(JSON.stringify({ ora: new Date().toISOString(), prezzi }), { headers: intestazioni });
  }
};

async function prezzo(isin) {
  for (const tipo of ['etf', 'etc-etn']) {
    try {
      const r = await fetch(`https://www.borsaitaliana.it/borsa/${tipo}/scheda/${isin}.html?lang=it`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 'Accept': 'text/html' }
      });
      const m = (await r.text()).match(/formatPrice[^>]*>\s*(?:<strong>)?\s*([\d.]+,\d+)/);
      if (m) return parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
    } catch (e) {}
  }
  return null;
}
