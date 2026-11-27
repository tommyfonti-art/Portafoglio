// Scarica l'ultimo prezzo di ogni ETF e lo salva in prezzi.json, che l'app legge.
import { readFile, writeFile } from 'node:fs/promises';

const elenco = JSON.parse(await readFile(new URL('./simboli.json', import.meta.url)));
// Aggiunge gli ETF registrati da tutti i profili dell'app (solo sigla e ISIN).
try {
  const conf = await readFile(new URL('../firebase-config.js', import.meta.url), 'utf8');
  const chiave = conf.match(/apiKey:\s*"([^"]+)"/)?.[1], progetto = conf.match(/projectId:\s*"([^"]+)"/)?.[1];
  let pagina = '';
  do {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${progetto}/databases/(default)/documents/simboli?pageSize=300&key=${chiave}${pagina ? '&pageToken=' + pagina : ''}`);
    const j = await r.json();
    if (!r.ok) { console.log('elenco Firebase', r.status, JSON.stringify(j).slice(0, 200)); break; }
    for (const d of j.documents || []) {
      const sim = decodeURIComponent(d.name.split('/').pop()).toUpperCase();
      const isin = d.fields?.isin?.stringValue;
      if (/^[A-Z0-9]{1,12}\.MI$/.test(sim) && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin || '') && !elenco[sim]) elenco[sim] = { isin, tipo: 'etf' };
    }
    pagina = j.nextPageToken || '';
  } while (pagina);
} catch (e) { console.log('elenco Firebase', e.message); }
const simboli = Object.keys(elenco);
console.log('ETF da cercare:', simboli.length);
let vecchio = { prezzi: {} };
try { vecchio = JSON.parse(await readFile('prezzi.json', 'utf8')); } catch {}

const intestazioni = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 'Accept': 'application/json' };

async function daYahoo(s) {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=5d`, { headers: intestazioni });
      if (!r.ok) { console.log(s, host, r.status); continue; }
      const m = (await r.json())?.chart?.result?.[0]?.meta;
      if (m?.regularMarketPrice > 0) return { prezzo: m.regularMarketPrice, data: new Date(m.regularMarketTime * 1000).toISOString(), fonte: 'yahoo' };
    } catch (e) { console.log(s, host, e.message); }
  }
  return null;
}

const numero = t => parseFloat(t.replace(/\./g, '').replace(',', '.'));

async function daBorsaItaliana(s) {
  // Scheda pubblica su Borsa Italiana: è il prezzo di Milano, lo stesso che vede Directa.
  const { isin, tipo } = elenco[s] || {};
  if (!isin) return null;
  for (const t of [tipo, tipo === 'etf' ? 'etc-etn' : 'etf']) {
    try {
      const r = await fetch(`https://www.borsaitaliana.it/borsa/${t}/scheda/${isin}.html?lang=it`, { headers: { ...intestazioni, Accept: 'text/html' } });
      const html = await r.text();
      const m = html.match(/formatPrice[^>]*>\s*(?:<strong>)?\s*([\d.]+,\d+)/);
      if (m) return { prezzo: numero(m[1]), data: new Date().toISOString(), fonte: 'borsaitaliana' };
      console.log(s, 'borsa', t, r.status, html.length);
    } catch (e) { console.log(s, 'borsa', e.message); }
  }
  return null;
}

async function daJustEtf(s) {
  const { isin } = elenco[s] || {};
  if (!isin) return null;
  try {
    const r = await fetch(`https://www.justetf.com/api/etfs/${isin}/quote?locale=it&currency=EUR&isin=${isin}`, { headers: intestazioni });
    const testo = await r.text();
    const j = JSON.parse(testo);
    const p = j?.latestQuote?.raw;
    if (p > 0) return { prezzo: p, data: j.latestQuoteDate ? new Date(j.latestQuoteDate).toISOString() : new Date().toISOString(), fonte: 'justetf' };
    console.log(s, 'justetf', r.status, testo.slice(0, 150));
  } catch (e) { console.log(s, 'justetf', e.message); }
  return null;
}

const prezzi = Object.fromEntries(Object.entries(vecchio.prezzi || {}).filter(([k]) => simboli.includes(k)));
for (const s of simboli) {
  const p = (await daBorsaItaliana(s)) || (await daYahoo(s)) || (await daJustEtf(s));
  if (p) prezzi[s] = p; else console.log('NON TROVATO', s);
  console.log(s, p ? p.prezzo + ' (' + p.fonte + ')' : '-');
}
await writeFile('prezzi.json', JSON.stringify({ aggiornato: new Date().toISOString(), prezzi }, null, 1) + '\n');
