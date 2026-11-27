import { firebaseConfig } from './firebase-config.js';
import { riepilogo, calcolaAcquisti, nuovoPmc, simula, valorePos, caricoPos, CLASSI, PERCENTILI, ribilancia } from './calcoli.js';

// ---------- Dati di partenza (modificabili tutti dal sito) ----------
function classeDi(id) {
  return ({ mwrd: 'azioni', a500: 'azioni', em710: 'obbligazioni', wgld: 'oro', xeon: 'liquidita', us1: 'dollaro', infl: 'inflazione', qqq5: 'leva' })[id] || 'azioni';
}
// Le quote di ognuno stanno solo nel suo profilo su Firebase, mai nel codice (che è pubblico).
const EMI = { id: 'infl', nome: 'EMI', descr: 'Amundi Euro Gov Inflation-Linked Bond', isin: 'LU1650491282', simbolo: 'EMI.MI', target: 0, quote: 0, pmc: 0, prezzo: 0, ter: 0.09, mu: 3, sigma: 7, classe: 'inflazione', aliquota: 12.5 };
const ISIN_TOMMI = { mwrd: 'IE000BI8OT95', a500: 'LU1681048804', em710: 'LU1287023185', wgld: 'JE00BN2CJ301', xeon: 'LU0290358497', us1: 'LU1407887089', infl: 'LU1650491282' };
// Stime di partenza per tipo di ETF: rendimento annuo composto e volatilità.
const STIME = { azioni: [8, 16], obbligazioni: [3.5, 7], inflazione: [3, 7], oro: [4.5, 15], liquidita: [2, 0.5], dollaro: [2, 8], leva: [10, 80] };

const statoVuoto = () => ({
  versione: 1,
  posizioni: [],
  liquidita: 0,
  storico: [],
  impostazioni: { bollo: 0.2, anni: 30, versamentoMensile: 0, simulazioni: 3000, commissione: 0, inflazione: 2, versamentoCresce: false, ribilanciamento: 'versamenti', percentile: 50, costiExtra: [], aggiornato30: true, toltoQS5L: true },
  ultimaSim: null,
  prezziAggiornati: null
});

let stato = statoVuoto();
let utente = null, db = null, fs = null, authMod = null, auth = null;
let vista = 'riepilogo';
let propostaVersamento = null;
let ultimaSimulazione = null;
let apriPosizione = null;

// ---------- Formattazione ----------
const euro = (x, dec = 2) => (x ?? 0).toLocaleString('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: dec, maximumFractionDigits: dec });
const pct = (x, dec = 1) => ((x ?? 0) * 100).toLocaleString('it-IT', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + '%';
const num = (x, dec = 2) => (x ?? 0).toLocaleString('it-IT', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const segno = x => x > 0.005 ? 'positivo' : x < -0.005 ? 'negativo' : '';
const leggiNum = v => { const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };
const leggiNumSemplice = v => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? 0 : n; };
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function avviso(testo, ms = 2600) {
  const a = $('#avviso'); a.textContent = testo; a.classList.remove('nascosto');
  clearTimeout(avviso.t); avviso.t = setTimeout(() => a.classList.add('nascosto'), ms);
}

// ---------- Salvataggio ----------
const CHIAVE_LOCALE = 'portafoglio-stato-v3';
const usaFirebase = !!firebaseConfig.apiKey;

function unisci(dati) {
  const base = statoVuoto();
  const s = { ...base, ...dati, impostazioni: { ...base.impostazioni, ...(dati.impostazioni || {}) } };
  const tommi = s.posizioni.some(p => p.id === 'mwrd');
  if (tommi && !s.posizioni.some(p => p.id === 'infl')) {
    const infl = structuredClone(EMI);
    const dopo = s.posizioni.findIndex(p => p.id === 'us1');
    s.posizioni.splice(dopo >= 0 ? dopo + 1 : s.posizioni.length, 0, infl);
  }
  for (const p of s.posizioni) {
    if (!p.classe) p.classe = p.correlato === false ? 'liquidita' : classeDi(p.id);
    if (p.aliquota == null) p.aliquota = CLASSI[p.classe]?.aliquota ?? 26;
    delete p.correlato;
  }
  if (!s.impostazioni.aggiornato30) { s.impostazioni.anni = 30; s.impostazioni.aggiornato30 = true; }
  if (!Array.isArray(s.impostazioni.costiExtra)) s.impostazioni.costiExtra = [];
  if (!s.impostazioni.toltoQS5L) { s.posizioni = s.posizioni.filter(p => p.id !== 'qqq5'); s.impostazioni.toltoQS5L = true; }
  for (const p of s.posizioni) if (!p.isin && ISIN_TOMMI[p.id]) p.isin = ISIN_TOMMI[p.id];
  const infl = s.posizioni.find(p => p.id === 'infl');
  if (infl && !infl.simbolo) Object.assign(infl, { nome: 'EMI', descr: 'Amundi Euro Gov Inflation-Linked Bond', simbolo: 'EMI.MI', ter: 0.09, sigma: 7 });
  return s;
}

async function carica() {
  if (usaFirebase && utente) {
    const snap = await fs.getDoc(fs.doc(db, 'portafogli', utente.uid));
    if (snap.exists()) stato = unisci(JSON.parse(snap.data().stato));
    else {
      // Primo accesso: profilo nuovo e vuoto.
      stato = statoVuoto();
      await fs.setDoc(fs.doc(db, 'portafogli', utente.uid), { stato: JSON.stringify(stato), aggiornato: new Date().toISOString() });
    }
  } else {
    try { const s = localStorage.getItem(CHIAVE_LOCALE); if (s) stato = unisci(JSON.parse(s)); } catch {}
  }
  registraSimboli();
}

// Segnala al server dei prezzi gli ETF di questo profilo (solo sigla e ISIN, nessun importo).
async function registraSimboli() {
  // Non serve più: i prezzi arrivano dal ponte su Cloudflare, che legge l'ISIN direttamente.
  return;
  for (const p of stato.posizioni) {
    if (!p.simbolo || !p.isin) continue;
    try { await fs.setDoc(fs.doc(db, 'simboli', p.simbolo.toUpperCase()), { isin: p.isin.toUpperCase() }); } catch {}
  }
}

let attesaSalva = null;
function salva() {
  try { localStorage.setItem(CHIAVE_LOCALE, JSON.stringify(stato)); } catch {}
  if (!(usaFirebase && utente)) { segnaSalvato('Salvato su questo dispositivo'); return; }
  segnaSalvato('Salvataggio…');
  window.portafoglioSalvataggio = true; // l'aggiornamento automatico aspetta che finisca
  clearTimeout(attesaSalva);
  attesaSalva = setTimeout(async () => {
    try {
      await fs.setDoc(fs.doc(db, 'portafogli', utente.uid), { stato: JSON.stringify(stato), aggiornato: new Date().toISOString() });
      segnaSalvato('Salvato');
      window.portafoglioSalvataggio = false;
    } catch (e) { segnaSalvato('Errore di salvataggio'); avviso('Non riesco a salvare: ' + e.message); }
  }, 500);
}
const segnaSalvato = t => { $('#stato-salvataggio').textContent = t; };

// ---------- Prezzi ----------
// Richiesta con tempo massimo: se il server non risponde, si passa oltre invece di restare bloccati.
async function chiedi(url, ms = 12000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { cache: 'no-store', signal: ctl.signal }); } finally { clearTimeout(t); }
}

// Indirizzo del ponte su Cloudflare: prezzi presi da Borsa Italiana nel momento in cui premi il tasto.
const PONTE_PREZZI = 'https://prezzi-portafoglio.tommyfonti.workers.dev/';

async function aggiornaPrezzi(bottone) {
  if (bottone) { bottone.disabled = true; bottone.textContent = 'Aggiorno…'; }
  const conIsin = stato.posizioni.filter(p => p.isin && (p.quote > 0 || p.target > 0));
  const trovati = new Set();
  let quando = null;
  // 1) il ponte su Cloudflare, un ETF alla volta in parallelo: se uno è lento non blocca gli altri
  await Promise.all(conIsin.map(async p => {
    try {
      const r = await chiedi(PONTE_PREZZI + '?isin=' + p.isin, 12000);
      const j = r.ok ? await r.json() : null;
      const v = j?.prezzi?.[p.isin.toUpperCase()];
      if (v > 0) { p.prezzo = v; trovati.add(p.id); quando = j.ora || new Date().toISOString(); }
    } catch {}
  }));
  // 2) per quelli che mancano, l'ultimo prezzo salvato su GitHub (se c'è)
  const mancanti = conIsin.filter(p => !trovati.has(p.id));
  if (mancanti.length) {
    try {
      const r = await chiedi('prezzi.json?t=' + Date.now(), 6000);
      const arch = r.ok ? (await r.json()).prezzi || {} : {};
      for (const p of mancanti) { const a = arch[(p.simbolo || '').toUpperCase()]; if (a?.prezzo > 0) { p.prezzo = a.prezzo; trovati.add(p.id); quando = quando || a.data; } }
    } catch {}
  }
  if (quando) stato.prezziAggiornati = quando;
  salva(); disegna();
  const ancora = conIsin.filter(p => !trovati.has(p.id)).map(p => p.nome);
  const senzaIsin = stato.posizioni.filter(p => !p.isin && (p.quote > 0 || p.target > 0)).map(p => p.nome);
  if (!trovati.size) avviso('Non riesco a prendere i prezzi adesso. Controlla la connessione e riprova.', 4500);
  else if (ancora.length || senzaIsin.length) avviso('Non trovati: ' + [...ancora, ...senzaIsin].join(', ') + '. Puoi scriverli a mano in Posizioni.', 4500);
  else avviso('Prezzi aggiornati');
}

// ---------- Viste ----------
function disegna() {
  const titoli = { riepilogo: 'Riepilogo', versamento: 'Versamento', posizioni: 'Posizioni', simulazione: 'Simulazione', altro: 'Altro' };
  $('#titolo').textContent = titoli[vista];
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('attivo', b.dataset.vista === vista));
  const c = $('#contenuto');
  c.innerHTML = ({ riepilogo: vRiepilogo, versamento: vVersamento, posizioni: vPosizioni, simulazione: vSimulazione, altro: vAltro })[vista]();
  ({ riepilogo: aRiepilogo, versamento: aVersamento, posizioni: aPosizioni, simulazione: aSimulazione, altro: aAltro })[vista]?.();
}

function dataPrezzi() {
  if (!stato.prezziAggiornati) return 'Prezzi mai aggiornati';
  const d = new Date(stato.prezziAggiornati);
  return 'Prezzi del ' + d.toLocaleDateString('it-IT') + ' alle ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function variazioneGiorno() {
  let ora = 0, prima = 0;
  for (const p of stato.posizioni) if (p.prima > 0 && p.prezzo > 0 && p.quote > 0) { ora += p.quote * p.prezzo; prima += p.quote * p.prima; }
  return prima > 0 ? { euro: ora - prima, pct: ora / prima - 1 } : null;
}
const COLORI_CLASSE = { azioni: '#1F5C46', obbligazioni: '#4C7DB0', inflazione: '#8FB0D6', oro: '#C98A1B', liquidita: '#A3ABA6', dollaro: '#6B5CA5', leva: '#C7372F' };
function schedaEquilibrio(r) {
  if (!(r.totale > 0)) return '';
  const sommaT = r.sommaTarget || 100;
  // per tipo di investimento: peso attuale e obiettivo
  const classi = {};
  for (const p of stato.posizioni) {
    const k = p.classe || 'azioni';
    classi[k] = classi[k] || { ora: 0, obi: 0 };
    classi[k].ora += valorePos(p) / r.totale;
    classi[k].obi += (p.target || 0) / sommaT;
  }
  const liq = stato.liquidita / r.totale;
  // l'ETF più lontano dal suo obiettivo
  let lontano = null;
  for (const p of stato.posizioni) {
    if (!(p.target > 0) && !(p.quote > 0)) continue;
    const d = valorePos(p) / r.totale - (p.target || 0) / sommaT;
    if (!lontano || Math.abs(d) > Math.abs(lontano.d)) lontano = { p, d };
  }
  const inEquilibrio = !lontano || Math.abs(lontano.d) < 0.02;
  const stato1 = inEquilibrio
    ? `<div class="positivo">In equilibrio: ogni ETF è entro 2 punti dal suo obiettivo</div>`
    : `<div class="${lontano.d > 0 ? 'positivo' : 'negativo'}">${esc(lontano.p.nome)} è ${lontano.d > 0 ? 'sopra' : 'sotto'} l'obiettivo di ${pct(Math.abs(lontano.d))}</div>`;
  // ribilanciamento solo con acquisti: con la liquidità che hai, cosa comprare; e cosa non comprare perché ne hai già troppo
  let prossimo = '';
  if (stato.posizioni.every(p => !(p.target > 0) || p.prezzo > 0)) {
    const r2 = calcolaAcquisti(stato, 0, true);
    const tot = r.totale, sT = r.sommaTarget || 100;
    const righe = stato.posizioni.filter(p => p.target > 0 || p.quote > 0).map(p => {
      const q = r2.righe.find(x => x.id === p.id)?.quote || 0;
      const scost = valorePos(p) / tot - (p.target || 0) / sT;
      return { p, q, scost };
    });
    const voce = x => x.q > 0
      ? `<div class="riga"><span class="positivo">Compra ${x.q} ${esc(x.p.nome)}</span><span class="pos3-val">${euro(x.q * x.p.prezzo, 0)}</span></div>`
      : x.scost > 0.0005
        ? `<div class="riga"><span><b>${esc(x.p.nome)}</b> <span class="piccolo" style="color:var(--giallo);font-weight:600">ne hai già troppo (+${pct(x.scost)})</span></span><span class="tenue piccolo">non comprare</span></div>`
        : `<div class="riga"><span><b>${esc(x.p.nome)}</b> <span class="tenue piccolo">${Math.abs(x.scost) < 0.0005 ? 'in pari' : 'sotto di ' + pct(-x.scost)}</span></span><span class="tenue piccolo">${Math.abs(x.scost) < 0.0005 ? '' : 'la liquidità non basta'}</span></div>`;
    // quanti soldi servirebbero per arrivare in pari senza vendere niente
    let totPari = 0;
    for (const p of stato.posizioni) if (p.target > 0) totPari = Math.max(totPari, valorePos(p) / ((p.target) / sT));
    const serve = Math.max(0, totPari - (tot - (stato.liquidita || 0)) - (stato.liquidita || 0));
    prossimo = `<div style="margin-top:14px">
      <h2 style="margin-bottom:4px">Cosa comprare</h2>
      <div class="tenue piccolo">Con la liquidità che hai adesso (${euro(stato.liquidita, 0)}), senza vendere niente</div>
      ${righe.sort((a, b) => (b.q > 0) - (a.q > 0) || a.scost - b.scost).map(voce).join('')}
      <div class="tenue piccolo" style="margin-top:6px">Spesa ${euro((stato.liquidita || 0) - r2.residuo, 0)} · liquidità che resta ${euro(r2.residuo, 0)}${serve > 1 ? ` · per essere tutti in pari senza vendere servirebbero altri ${euro(serve, 0)}` : ''}</div>
    </div>`;
  }
  const perTipo = stato.impostazioni.equilibrioPerTipo === true;
  // elementi del grafico: per ETF oppure per tipo di investimento
  const elementi = perTipo
    ? Object.entries(classi).filter(([, c]) => c.ora > 0.0005 || c.obi > 0).map(([k, c]) => ({ nome: CLASSI[k]?.nome || k, ora: c.ora, obi: c.obi, colore: COLORI_CLASSE[k] || '#888' }))
    : stato.posizioni.filter(p => p.quote > 0 || p.target > 0).map((p, i) => ({ nome: p.nome, ora: valorePos(p) / r.totale, obi: (p.target || 0) / sommaT, colore: COLORI_ETF[i % COLORI_ETF.length] }));
  if (liq > 0.0005) elementi.push({ nome: 'Liquidità sul conto', ora: liq, obi: 0, colore: '#D6D0C2', liq: true });
  return `<div class="scheda">
    <h2>Equilibrio del portafoglio</h2>
    ${stato1}
    <div class="scelta2"><button class="${perTipo ? '' : 'attivo'}" data-eq="etf">Per ETF</button><button class="${perTipo ? 'attivo' : ''}" data-eq="tipo">Per tipo</button></div>
    <div class="ciambella-box">${ciambella(elementi, r.totale)}</div>
    ${elementi.map(x => {
      const d = x.ora - x.obi;
      return `<div class="riga voce-eq"><span class="nome-eq"><i class="pallino" style="background:${x.colore}"></i>${esc(x.nome)}</span>
        <span class="destra"><span class="perc-grande">${pct(x.ora)}</span>
        <span class="piccolo">${x.liq ? '<span class="tenue">non investita</span>' : `<span class="tenue">obiettivo ${pct(x.obi, 0)}</span> · <span class="${Math.abs(d) < 0.0005 ? '' : segno(d * 100)}">${d >= 0 ? '+' : ''}${pct(d)}</span>`}</span></span></div>`;
    }).join('')}
    ${prossimo}
  </div>`;
}
const COLORI_ETF = ['#1F5C46', '#4FA37A', '#4C7DB0', '#C98A1B', '#8E9A94', '#6B5CA5', '#8FB0D6', '#C7372F', '#D98C5F', '#5B8C8C'];
// Grafico a ciambella: ogni fetta è un pezzo del portafoglio, al centro il valore totale.
function ciambella(el, totale) {
  const R = 70, C = 2 * Math.PI * R;
  let giro = 0;
  const fette = el.filter(x => x.ora > 0).map(x => {
    const lungo = x.ora * C;
    const f = `<circle r="${R}" cx="100" cy="100" fill="none" stroke="${x.colore}" stroke-width="30" stroke-dasharray="${Math.max(lungo - 1.5, 0.5)} ${C}" stroke-dashoffset="${-giro}" transform="rotate(-90 100 100)"/>`;
    giro += lungo;
    return f;
  }).join('');
  const etichette = (() => { let g = 0; return el.filter(x => x.ora > 0).map(x => {
    const medio = (g + x.ora / 2) * 2 * Math.PI - Math.PI / 2; g += x.ora;
    if (x.ora < 0.06) return '';
    return `<text x="${100 + R * Math.cos(medio)}" y="${100 + R * Math.sin(medio) + 4}" text-anchor="middle" class="et-fetta">${Math.round(x.ora * 100)}%</text>`;
  }).join(''); })();
  return `<svg viewBox="0 0 200 200" width="220" height="220" role="img" aria-label="Grafico del portafoglio">${fette}${etichette}
    <text x="100" y="94" text-anchor="middle" class="centro-et">Totale</text>
    <text x="100" y="116" text-anchor="middle" class="centro-val">${euro(totale, 0)}</text></svg>`;
}
function etichettaPerc(q) {
  return q === 50 ? 'mediano (1 su 2)' : q < 50 ? `pessimista (${q}° percentile)` : `ottimista (${q}° percentile)`;
}
function schedaAttesa() {
  const u = stato.ultimaSim, q = stato.impostazioni.percentile || 50;
  if (!u) return `<div class="scheda"><h2>Rendimento atteso</h2><p class="tenue piccolo">Fai una simulazione per vedere qui il rendimento atteso.</p><button class="secondario" id="vai-sim">Vai alla simulazione</button></div>`;
  return `<div class="scheda">
    <h2>Rendimento atteso a ${u.anni} anni</h2>
    <select id="sel-perc">${PERCENTILI.map(x => `<option value="${x}" ${x === q ? 'selected' : ''}>Scenario ${etichettaPerc(x)}</option>`).join('')}</select>
    <div class="griglia2" style="margin-top:8px">
      <div class="cifra"><div class="et">Rendimento annuo</div><div class="val ${segno(u.rendimento[q] * 100)}">${pct(u.rendimento[q], 1)}</div></div>
      <div class="cifra"><div class="et">Tolta l'inflazione</div><div class="val ${segno(u.rendimentoReale[q] * 100)}">${pct(u.rendimentoReale[q], 1)}</div></div>
      <div class="cifra"><div class="et">Valore finale netto tasse</div><div class="val">${euro(u.netto[q], 0)}</div></div>
      <div class="cifra"><div class="et">In euro di oggi</div><div class="val">${euro(u.reale[q], 0)}</div></div>
    </div>
    <p class="tenue piccolo">Simulazione del ${new Date(u.data).toLocaleDateString('it-IT')} · versati in totale ${euro(u.versatoTotale, 0)}</p>
  </div>`;
}

function vRiepilogo() {
  if (!stato.posizioni.length) return `
  <div class="scheda">
    <h2>Benvenuto</h2>
    <p>Questo è il tuo portafoglio, per ora vuoto.</p>
    <p class="tenue piccolo">1. In Posizioni aggiungi i tuoi ETF: sigla, ISIN, quote e prezzo medio di carico (li trovi sulla tua banca o sul tuo intermediario).<br>2. Scrivi qui la liquidità con la matita.<br>3. Premi «Aggiorna prezzi».</p>
    <button class="primario" id="inizia">Aggiungi il primo ETF</button>
  </div>`;
  const r = riepilogo(stato);
  const avvisoTarget = Math.abs(r.sommaTarget - 100) > 0.01
    ? `<div class="scheda negativo piccolo">La somma degli obiettivi è ${num(r.sommaTarget, 1)}%, non 100%. Sistemala in Posizioni.</div>` : '';
  const senzaPrezzo = stato.posizioni.some(p => !(p.prezzo > 0) && (p.target > 0 || p.quote > 0))
    ? `<div class="scheda piccolo" style="color:var(--giallo)">Alcuni ETF non hanno il prezzo. Premi «Aggiorna prezzi» o scrivilo a mano in Posizioni.</div>` : '';
  return `
  ${avvisoTarget}${senzaPrezzo}
  <div class="scheda">
    <div class="tenue piccolo">Valore totale</div>
    <div class="grande">${euro(r.totale)}</div>
    <div class="${segno(r.guadagno)}">${r.guadagno >= 0 ? '+' : ''}${euro(r.guadagno)} (${r.guadagno >= 0 ? '+' : ''}${pct(r.guadagnoPct, 2)}) <span class="tenue piccolo" style="font-weight:400">guadagno totale</span></div>
    <div class="tenue piccolo" style="margin-top:4px">Se vendessi tutto oggi: <b style="color:var(--testo)">${euro(r.nettoOggi, 0)}</b> netti · tasse <span class="negativo">${euro(r.tasseLatenti, 0)}</span></div>
    <div class="griglia2" style="margin-top:12px">
      <div class="cifra"><div class="et">Investito (prezzo di carico)</div><div class="val">${euro(r.carico, 0)}</div></div>
      <div class="cifra" style="position:relative;padding-right:40px"><div class="et">Liquidità non investita</div><div class="val">${euro(stato.liquidita)}</div>
        <button id="liq-piu" class="matita" aria-label="Modifica liquidità"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg></button></div>
    </div>
    <div id="liq-form" class="nascosto" style="margin-top:10px">
      <label>Liquidità sul conto (€)</label>
      <input id="liq-importo" inputmode="decimal" value="${num(stato.liquidita)}">
      <button id="liq-esatto" class="primario">Salva</button>
    </div>
    <button id="agg-prezzi" class="secondario">Aggiorna prezzi</button>
    <div class="tenue piccolo" style="text-align:center;margin-top:6px">${dataPrezzi()}</div>
  </div>
  ${schedaEquilibrio(r)}
  ${schedaAttesa()}
  <div class="scheda">
    <h2>Posizioni</h2>
    ${stato.posizioni.filter(p => p.quote > 0 || p.target > 0).map((p, i) => {
      const v = valorePos(p), c = caricoPos(p), g = v - c;
      const peso = r.totale > 0 ? v / r.totale : 0, obi = (p.target || 0) / (r.sommaTarget || 100);
      const scost = peso - obi, col = COLORI_ETF[i % COLORI_ETF.length];
      return `<div class="riga tocca pos3" data-id="${p.id}">
        <div class="pos3-perc">${num(peso * 100, peso < 0.1 ? 1 : 0)}%</div>
        <div class="pos3-corpo">
          <div class="r3"><span class="nome">${esc(p.nome)} <span class="tenue">›</span></span><span><span class="pos3-val">${euro(v, 0)}</span>${c > 0 ? ` <span class="piccolo ${segno(g)}">${g >= 0 ? '+' : ''}${pct(g / c, 1)}</span>` : ''}</span></div>
          <div class="barra3"><div style="width:${Math.min(peso * 100, 100)}%;background:${col}"></div><i style="left:${Math.min(obi * 100, 100)}%"></i></div>
          <div class="r3 tenue piccolo"><span>obiettivo ${num(obi * 100, 0)}% · ${num(p.quote, 0)} quote</span><span class="${Math.abs(scost) < 0.0005 ? '' : segno(scost * 100)}">${scost >= 0 ? '+' : ''}${pct(scost)}</span></div>
        </div>
      </div>`;
    }).join('')}
  </div>
  <p class="tenue piccolo" style="text-align:center">Numero grande e barra: peso attuale · linea gialla: obiettivo<br>Tocca un ETF per cambiare obiettivo, quote o venderlo</p>
  <div class="scheda">
    <h2>Costi annui</h2>
    <div class="riga"><span>Bollo (${num(stato.impostazioni.bollo, 2)}%)</span><b>${euro(r.bollo)}</b></div>
    <div class="riga"><span>Costi degli ETF (TER)</span><b>${euro(r.ter)}</b></div>
    <div class="riga"><span>Altri costi</span><b>${euro(r.extra)}</b></div>
    <div class="riga"><span><b>Totale</b></span><b>${euro(r.costiAnnui)} <span class="tenue piccolo" style="font-weight:400">${pct(r.costiPct, 2)} del portafoglio</span></b></div>
    <p class="tenue piccolo">Altri costi e bollo si cambiano in Altro.</p>
  </div>`;
}
function aRiepilogo() {
  document.querySelectorAll('[data-eq]').forEach(b => b.onclick = () => { stato.impostazioni.equilibrioPerTipo = b.dataset.eq === 'tipo'; salva(); disegna(); });
  const ini = $('#inizia'); if (ini) { ini.onclick = () => { vista = 'posizioni'; disegna(); setTimeout(() => $('#nuovo-etf').scrollIntoView({ block: 'start' }), 50); }; return; }
  const sp = $('#sel-perc'); if (sp) sp.onchange = () => { stato.impostazioni.percentile = +sp.value; salva(); disegna(); };
  const vs = $('#vai-sim'); if (vs) vs.onclick = () => { vista = 'simulazione'; disegna(); };
  document.querySelectorAll('.tocca').forEach(r => r.onclick = () => { apriPosizione = r.dataset.id; vista = 'posizioni'; disegna(); });
  $('#agg-prezzi').onclick = e => aggiornaPrezzi(e.target);
  $('#liq-piu').onclick = () => { $('#liq-form').classList.toggle('nascosto'); const i = $('#liq-importo'); i.focus(); i.select(); };
  $('#liq-esatto').onclick = () => {
    const v = $('#liq-importo').value.trim();
    if (v === '') { avviso('Scrivi la liquidità giusta'); return; }
    stato.liquidita = Math.max(0, leggiNum(v));
    salva(); avviso('Liquidità: ' + euro(stato.liquidita)); disegna();
  };
}

function vVersamento() {
  const imp = stato.impostazioni;
  let tabella = '';
  if (propostaVersamento) {
    const { righe, versamento, usaLiq } = propostaVersamento;
    const spesa = righe.reduce((s, r) => s + r.quote * (stato.posizioni.find(p => p.id === r.id).prezzo || 0), 0);
    const disponibile = versamento + (usaLiq ? stato.liquidita : 0);
    const residuo = disponibile - spesa;
    // pesi dopo l'acquisto
    const totDopo = stato.posizioni.reduce((s, p) => s + valorePos(p), 0) + spesa + residuo + (usaLiq ? 0 : stato.liquidita);
    tabella = `
    <div class="scheda">
      <h2>Cosa comprare</h2>
      <table><tr><th>ETF</th><th>Prezzo</th><th>Quote</th><th>Spesa</th><th>Peso dopo</th></tr>
      ${righe.map(r => {
        const p = stato.posizioni.find(x => x.id === r.id);
        const pesoDopo = totDopo > 0 ? (valorePos(p) + r.quote * p.prezzo) / totDopo : 0;
        return `<tr><td><b>${esc(p.nome)}</b></td><td>${num(p.prezzo)}</td>
          <td><input class="quote-in" inputmode="numeric" data-id="${r.id}" value="${r.quote}"></td>
          <td>${euro(r.quote * p.prezzo)}</td><td>${pct(pesoDopo)} <span class="tenue">/ ${num(p.target, 0)}%</span></td></tr>`;
      }).join('')}
      </table>
      <div class="riga"><span>Totale da spendere</span><b>${euro(spesa)}</b></div>
      <div class="riga"><span>Resta in liquidità</span><b class="${residuo < -0.005 ? 'negativo' : ''}">${euro(residuo)}</b></div>
      ${residuo < -0.005 ? '<div class="negativo piccolo">Stai spendendo più di quanto hai messo.</div>' : ''}
      <p class="tenue piccolo">Puoi cambiare il numero di quote a mano. Quando hai comprato su Directa, conferma: aggiorno quote, prezzo di carico e registro.</p>
      <button id="conferma" class="primario" ${residuo < -0.005 ? 'disabled' : ''}>Ho comprato, conferma</button>
      <button id="annulla" class="secondario">Annulla</button>
    </div>`;
  }
  return `
  <div class="scheda">
    <h2>Nuovo versamento</h2>
    <label>Soldi in più da investire, oltre alla liquidità (€)</label>
    <input id="vers-importo" inputmode="decimal" value="${propostaVersamento ? num(propostaVersamento.versamento) : num(0)}">
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--testo)"><input id="vers-liq" type="checkbox" style="width:auto;margin:0" ${(propostaVersamento ? propostaVersamento.usaLiq : stato.liquidita > 0) ? 'checked' : ''}> Usa anche la liquidità non investita (${euro(stato.liquidita)})</label>
    <label>Commissione per ogni acquisto (€)</label>
    <input id="vers-comm" inputmode="decimal" value="${num(imp.commissione)}">
    <button id="calcola" class="primario">Calcola le quote</button>
    <div class="tenue piccolo" style="text-align:center;margin-top:6px">${dataPrezzi()} · <a href="#" id="vers-agg" style="color:var(--blu)">aggiorna</a></div>
  </div>
  ${tabella}`;
}
function aVersamento() {
  $('#vers-agg').onclick = e => { e.preventDefault(); aggiornaPrezzi(); };
  $('#calcola').onclick = () => {
    const versamento = leggiNum($('#vers-importo').value);
    const usaLiq = $('#vers-liq').checked;
    stato.impostazioni.commissione = leggiNumSemplice($('#vers-comm').value);
    if (stato.posizioni.some(p => p.target > 0 && !(p.prezzo > 0))) { avviso('Mancano dei prezzi: aggiornali prima.'); return; }
    const r = calcolaAcquisti(stato, versamento, usaLiq);
    propostaVersamento = { versamento, usaLiq, righe: r.righe };
    salva(); disegna();
  };
  document.querySelectorAll('.quote-in').forEach(inp => inp.onchange = () => {
    const r = propostaVersamento.righe.find(x => x.id === inp.dataset.id);
    r.quote = Math.max(0, Math.round(leggiNumSemplice(inp.value)));
    disegna();
  });
  const conf = $('#conferma');
  if (conf) conf.onclick = () => {
    const { righe, versamento, usaLiq } = propostaVersamento;
    const comm = stato.impostazioni.commissione || 0;
    let spesa = 0;
    const acquisti = [];
    for (const r of righe) {
      if (!r.quote) continue;
      const p = stato.posizioni.find(x => x.id === r.id);
      p.pmc = nuovoPmc(p.quote, p.pmc, r.quote, p.prezzo, comm);
      p.quote += r.quote;
      spesa += r.quote * p.prezzo + comm;
      acquisti.push({ id: p.id, nome: p.nome, quote: r.quote, prezzo: p.prezzo });
    }
    const disponibile = versamento + (usaLiq ? stato.liquidita : 0);
    stato.liquidita = (usaLiq ? 0 : stato.liquidita) + (disponibile - spesa);
    if (stato.liquidita < 0.005 && stato.liquidita > -0.005) stato.liquidita = 0;
    stato.storico.unshift({ data: new Date().toISOString(), versamento, spesa, commissioni: comm * acquisti.length, acquisti, valoreDopo: riepilogo(stato).totale });
    propostaVersamento = null;
    salva(); avviso('Acquisti registrati'); vista = 'riepilogo'; disegna();
  };
  const ann = $('#annulla'); if (ann) ann.onclick = () => { propostaVersamento = null; disegna(); };
}

function vPosizioni() {
  const r = riepilogo(stato);
  return `
  <div class="scheda piccolo ${Math.abs(r.sommaTarget - 100) > 0.01 ? 'negativo' : 'tenue'}">Somma degli obiettivi: <b>${num(r.sommaTarget, 1)}%</b></div>
  ${stato.posizioni.map(p => `
  <details data-id="${p.id}">
    <summary><span>${esc(p.nome)} <span class="tenue piccolo">· ${num(p.target, 1)}% · ${num(p.quote, 0)} quote</span></span></summary>
    <div class="modifica">
      <div><label>Sigla</label><input data-c="nome" value="${esc(p.nome)}"></div>
      <div><label>Simbolo per i prezzi</label><input data-c="simbolo" value="${esc(p.simbolo)}" autocapitalize="characters"></div>
      <div class="intera"><label>Nome</label><input data-c="descr" value="${esc(p.descr)}"></div>
      <div class="intera"><label>Codice ISIN</label><input data-c="isin" value="${esc(p.isin)}" autocapitalize="characters"></div>
      <div><label>Obiettivo %</label><input data-c="target" data-n="1" inputmode="decimal" value="${num(p.target, 1)}"></div>
      <div><label>Quote possedute</label><input data-c="quote" data-n="1" inputmode="decimal" value="${num(p.quote, 0)}"></div>
      <div><label>Prezzo medio di carico €</label><input data-c="pmc" data-n="1" inputmode="decimal" value="${num(p.pmc, 4)}"></div>
      <div><label>Prezzo attuale €</label><input data-c="prezzo" data-n="1" inputmode="decimal" value="${num(p.prezzo, 4)}"></div>
      <div><label>TER annuo %</label><input data-c="ter" data-n="1" inputmode="decimal" value="${num(p.ter, 2)}"></div>
      <div><label>Rendimento annuo composto %</label><input data-c="mu" data-n="1" inputmode="decimal" value="${num(p.mu, 1)}"></div>
      <div><label>Volatilità annua %</label><input data-c="sigma" data-n="1" inputmode="decimal" value="${num(p.sigma, 1)}"></div>
      <div><label>Tipo</label><select data-c="classe">${Object.entries(CLASSI).map(([k, c]) => `<option value="${k}" ${p.classe === k ? 'selected' : ''}>${c.nome}</option>`).join('')}</select></div>
      <div><label>Tasse sul guadagno %</label><input data-c="aliquota" data-n="1" inputmode="decimal" value="${num(p.aliquota ?? 26, 1)}"></div>
    </div>
    <button class="secondario apri-vendi">Vendi</button>
    <div class="vendi nascosto">
      <div class="modifica">
        <div><label>Quote da vendere</label><input class="v-quote" inputmode="numeric" value="${num(p.quote, 0)}"></div>
        <div><label>Prezzo di vendita €</label><input class="v-prezzo" inputmode="decimal" value="${num(p.prezzo, 4)}"></div>
        <div><label>Commissione €</label><input class="v-comm" inputmode="decimal" value="${num(stato.impostazioni.commissione)}"></div>
        <div><label>Tasse stimate €</label><input class="v-tasse" inputmode="decimal"></div>
        <div class="intera"><label>Incassati sul conto €</label><input class="v-netto" inputmode="decimal"></div>
      </div>
      <p class="piccolo v-info"></p>
      <button class="primario v-ok">Ho venduto, conferma</button>
    </div>
    <button class="pericolo elimina">Elimina questo ETF</button>
  </details>`).join('')}
  <div class="scheda">
    <label>Liquidità non investita (€)</label>
    <input id="liq" inputmode="decimal" value="${num(stato.liquidita)}">
  </div>
  <div class="scheda" id="nuovo-etf">
    <h2>Aggiungi un ETF</h2>
    <div class="modifica">
      <div><label>Sigla di Borsa</label><input id="n-sigla" placeholder="SWDA" autocapitalize="characters"></div>
      <div><label>Codice ISIN</label><input id="n-isin" placeholder="IE00B4L5Y983" autocapitalize="characters"></div>
      <div class="intera"><label>Nome</label><input id="n-nome" placeholder="iShares Core MSCI World"></div>
      <div><label>Tipo</label><select id="n-tipo">${Object.entries(CLASSI).map(([k, c]) => `<option value="${k}">${c.nome}</option>`).join('')}</select></div>
      <div><label>Obiettivo %</label><input id="n-target" inputmode="decimal" placeholder="0"></div>
      <div><label>Quote possedute</label><input id="n-quote" inputmode="decimal" placeholder="0"></div>
      <div><label>Prezzo medio di carico €</label><input id="n-pmc" inputmode="decimal" placeholder="0"></div>
      <div><label>TER annuo %</label><input id="n-ter" inputmode="decimal" placeholder="0,20"></div>
    </div>
    <p class="errore" id="n-errore"></p>
    <button id="aggiungi" class="primario">Aggiungi</button>
    <p class="tenue piccolo">Sigla e ISIN li trovi su Directa o su Borsa Italiana. Il prezzo arriva da solo entro una ventina di minuti; intanto puoi scriverlo a mano.</p>
  </div>`;
}
function aPosizioni() {
  if (apriPosizione) {
    const d = document.querySelector(`details[data-id="${apriPosizione}"]`);
    apriPosizione = null;
    if (d) { d.open = true; setTimeout(() => d.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50); }
  } else window.scrollTo(0, 0);
  document.querySelectorAll('details').forEach(d => {
    const p = stato.posizioni.find(x => x.id === d.dataset.id);
    d.querySelectorAll('[data-c]').forEach(inp => inp.onchange = () => {
      const c = inp.dataset.c;
      if (c === 'classe') { p.classe = inp.value; p.aliquota = CLASSI[p.classe].aliquota; d.querySelector('[data-c=aliquota]').value = num(p.aliquota, 1); }
      else if (inp.dataset.n) p[c] = c === 'quote' ? leggiNum(inp.value) : leggiNumSemplice(inp.value.replace(/\.(?=\d{3}(\D|$))/g, ''));
      else p[c] = c === 'isin' || c === 'simbolo' ? inp.value.trim().toUpperCase() : inp.value.trim();
      if (c === 'isin' || c === 'simbolo') registraSimboli();
      salva();
      d.querySelector('summary span').innerHTML = `${esc(p.nome)} <span class="tenue piccolo">· ${num(p.target, 1)}% · ${num(p.quote, 0)} quote</span>`;
      const somma = stato.posizioni.reduce((s, x) => s + (x.target || 0), 0);
      const sc = document.querySelector('.scheda.piccolo');
      sc.innerHTML = `Somma degli obiettivi: <b>${num(somma, 1)}%</b>`;
      sc.className = 'scheda piccolo ' + (Math.abs(somma - 100) > 0.01 ? 'negativo' : 'tenue');
    });
    const vd = d.querySelector('.vendi');
    const ricalcola = (daNetto = false) => {
      const q = Math.min(p.quote, Math.max(0, leggiNum(vd.querySelector('.v-quote').value)));
      const pr = leggiNumSemplice(vd.querySelector('.v-prezzo').value);
      const comm = leggiNumSemplice(vd.querySelector('.v-comm').value);
      const guadagno = q * (pr - p.pmc) - comm;
      if (!daNetto) {
        const tasse = guadagno > 0 ? guadagno * 0.26 : 0;
        vd.querySelector('.v-tasse').value = num(tasse);
        vd.querySelector('.v-netto').value = num(q * pr - comm - tasse);
      }
      const info = vd.querySelector('.v-info');
      info.className = 'piccolo v-info ' + segno(guadagno);
      info.textContent = (guadagno >= 0 ? 'Guadagno realizzato ' : 'Perdita realizzata ') + euro(guadagno) + ' prima delle tasse';
      return { q, pr, comm, guadagno };
    };
    d.querySelector('.apri-vendi').onclick = () => { vd.classList.toggle('nascosto'); ricalcola(); };
    vd.querySelectorAll('.v-quote,.v-prezzo,.v-comm').forEach(i => i.oninput = () => ricalcola());
    vd.querySelector('.v-tasse').oninput = () => {
      const { q, pr, comm } = ricalcola(true);
      vd.querySelector('.v-netto').value = num(q * pr - comm - leggiNumSemplice(vd.querySelector('.v-tasse').value));
    };
    vd.querySelector('.v-ok').onclick = () => {
      const { q, pr, comm, guadagno } = ricalcola(true);
      if (!(q > 0)) { avviso('Scrivi quante quote hai venduto'); return; }
      const netto = leggiNum(vd.querySelector('.v-netto').value);
      const tasse = leggiNumSemplice(vd.querySelector('.v-tasse').value);
      p.quote -= q;
      if (p.quote <= 0) { p.quote = 0; p.pmc = 0; }
      stato.liquidita += netto;
      stato.storico.unshift({ tipo: 'vendita', data: new Date().toISOString(), nome: p.nome, quote: q, prezzo: pr, commissione: comm, tasse, netto, guadagno, valoreDopo: riepilogo(stato).totale });
      salva(); avviso('Vendita registrata: ' + euro(netto) + ' in liquidità', 3500); disegna();
    };
    d.querySelector('.elimina').onclick = () => {
      if (!confirm('Eliminare ' + p.nome + '?')) return;
      stato.posizioni = stato.posizioni.filter(x => x !== p); salva(); disegna();
    };
  });
  $('#liq').onchange = e => { stato.liquidita = leggiNum(e.target.value); salva(); };
  $('#aggiungi').onclick = () => {
    const sigla = $('#n-sigla').value.trim().toUpperCase().replace(/\.MI$/, '');
    const isin = $('#n-isin').value.trim().toUpperCase();
    const err = t => { $('#n-errore').textContent = t; };
    if (!sigla) return err('Scrivi la sigla di Borsa');
    if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) return err('Il codice ISIN ha 12 caratteri, per esempio IE00B4L5Y983');
    if (stato.posizioni.some(p => p.nome.toUpperCase() === sigla)) return err('Questo ETF c\'è già');
    const classe = $('#n-tipo').value, [mu, sigma] = STIME[classe];
    const id = 'p' + Date.now();
    stato.posizioni.push({ id, nome: sigla, descr: $('#n-nome').value.trim(), isin, simbolo: sigla + '.MI', target: leggiNumSemplice($('#n-target').value), quote: leggiNum($('#n-quote').value), pmc: leggiNumSemplice($('#n-pmc').value), prezzo: 0, ter: leggiNumSemplice($('#n-ter').value), mu, sigma, classe, aliquota: CLASSI[classe].aliquota });
    registraSimboli(); salva(); apriPosizione = id; disegna();
    avviso(sigla + ' aggiunto');
  };

}

function vSimulazione() {
  const imp = stato.impostazioni;
  const s = ultimaSimulazione;
  let risultato = '';
  if (s) {
    const min = Math.min(...s.finali), lim = s.netto[95];
    const classi = 30, passo = (lim - min) / classi || 1, conte = Array(classi).fill(0);
    for (const v of s.finali) if (v <= lim) conte[Math.max(0, Math.min(classi - 1, Math.floor((v - min) / passo)))]++;
    const top = Math.max(...conte);
    const riga = (nome, ogg, fmt, cls = () => '') => `<tr><td>${nome}</td>${[10, 25, 50, 75, 90].map(q => `<td class="${cls(ogg[q])}">${fmt(ogg[q])}</td>`).join('')}</tr>`;
    risultato = `
    <div class="scheda">
      <h2>Fra ${s.anni} anni</h2>
      <div class="tenue piccolo">Valore mediano netto tasse</div>
      <div class="grande">${euro(s.netto[50], 0)}</div>
      <div class="tenue piccolo">In euro di oggi ${euro(s.reale[50], 0)} · versati ${euro(s.versatoTotale, 0)}</div>
      <div class="istogramma">${conte.map(c => `<div style="height:${(c / top) * 100}%"></div>`).join('')}</div>
      <div class="banda"><span>${euro(min, 0)}</span><span>${euro(lim, 0)}+</span></div>
    </div>
    <div class="scheda" style="overflow-x:auto">
      <h2>Scenari</h2>
      <table><tr><th></th><th>10°</th><th>25°</th><th>50°</th><th>75°</th><th>90°</th></tr>
      ${riga('Rendimento annuo', s.rendimento, x => pct(x, 1), x => segno(x * 100))}
      ${riga('Tolta l\'inflazione', s.rendimentoReale, x => pct(x, 1), x => segno(x * 100))}
      ${riga('Valore lordo', s.lordo, x => num(x / 1000, 0) + 'k')}
      ${riga('Netto tasse', s.netto, x => num(x / 1000, 0) + 'k')}
      ${riga('Euro di oggi', s.reale, x => num(x / 1000, 0) + 'k')}
      ${riga('Ribasso massimo', s.ribasso, x => '−' + pct(x, 0), () => 'negativo')}
      </table>
      <p class="tenue piccolo">10° = va peggio in 1 caso su 10 · 50° = mediano · 90° = va meglio solo in 1 caso su 10.</p>
    </div>
    <div class="scheda">
      <h2>Per ogni ETF (mediana)</h2>
      <table><tr><th>ETF</th><th>Rendimento annuo</th><th>Ribasso massimo</th></tr>
      ${s.asset.map(a => `<tr><td><b>${esc(a.nome)}</b></td><td class="${segno(a.rendimento * 100)}">${pct(a.rendimento)}</td><td class="negativo">−${pct(a.ribasso)}</td></tr>`).join('')}
      </table>
      <p class="tenue piccolo">Rendimenti al netto di TER e bollo, prima delle tasse.</p>
    </div>`;
  }
  return `
  <div class="scheda">
    <h2>Impostazioni simulazione</h2>
    <div class="modifica">
      <div><label>Anni</label><input id="s-anni" inputmode="numeric" value="${imp.anni}"></div>
      <div><label>Versamento mensile €</label><input id="s-vers" inputmode="decimal" value="${num(imp.versamentoMensile, 0)}"></div>
      <div><label>Inflazione annua %</label><input id="s-infl" inputmode="decimal" value="${num(imp.inflazione, 1)}"></div>
      <div><label>Numero simulazioni</label><input id="s-num" inputmode="numeric" value="${imp.simulazioni}"></div>
      <div class="intera"><label>Ribilanciamento</label><select id="s-rib">
        <option value="versamenti" ${imp.ribilanciamento !== 'anno' ? 'selected' : ''}>Solo con i versamenti (non vendo mai)</option>
        <option value="anno" ${imp.ribilanciamento === 'anno' ? 'selected' : ''}>Una volta l'anno vendendo (pago le tasse)</option></select></div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--testo)"><input id="s-cresce" type="checkbox" style="width:auto;margin:0" ${imp.versamentoCresce ? 'checked' : ''}> Il versamento cresce ogni anno con l'inflazione</label>
    <p class="tenue piccolo">Stime per ogni ETF (rendimento composto, volatilità, tipo, tasse) in Posizioni. Il modello tiene conto di TER, bollo, costi extra, crolli che arrivano insieme, tasse e inflazione.</p>
    <button id="simula" class="primario">Avvia la simulazione</button>
  </div>
  ${risultato}`;
}
function aSimulazione() {
  $('#simula').onclick = e => {
    const imp = stato.impostazioni;
    imp.anni = Math.max(1, Math.min(60, Math.round(leggiNumSemplice($('#s-anni').value))));
    imp.versamentoMensile = leggiNum($('#s-vers').value);
    imp.inflazione = Math.max(0, Math.min(15, leggiNumSemplice($('#s-infl').value)));
    imp.simulazioni = Math.max(200, Math.min(20000, Math.round(leggiNum($('#s-num').value))));
    imp.ribilanciamento = $('#s-rib').value;
    imp.versamentoCresce = $('#s-cresce').checked;
    e.target.disabled = true; e.target.textContent = 'Calcolo…';
    setTimeout(() => {
      ultimaSimulazione = simula(stato, { ...imp, seme: Date.now() & 0xffff });
      const { finali, ...riassunto } = ultimaSimulazione;
      stato.ultimaSim = { ...riassunto, data: new Date().toISOString() };
      salva(); disegna();
    }, 30);
  };
}

function vAltro() {
  const imp = stato.impostazioni;
  return `
  <div class="scheda">
    <h2>Registro movimenti</h2>
    ${stato.storico.length ? stato.storico.map((v, i) => `
      <div class="riga" style="display:block">
        <div style="display:flex;justify-content:space-between">
          <div><div class="nome">${new Date(v.data).toLocaleDateString('it-IT')} · ${v.tipo === 'vendita' ? 'Vendita' : v.tipo === 'deposito' ? 'Soldi sul conto' : v.tipo === 'prelievo' ? 'Soldi tolti' : 'Acquisti'}</div>
          <div class="sotto">${v.tipo === 'vendita' ? `${num(v.quote, 0)} ${esc(v.nome)} a ${num(v.prezzo)} · <span class="${segno(v.guadagno)}">${v.guadagno >= 0 ? '+' : ''}${euro(v.guadagno)}</span>${v.tasse ? ' · tasse ' + euro(v.tasse) : ''}`
            : v.tipo === 'deposito' ? 'Aggiunti alla liquidità' : v.tipo === 'prelievo' ? 'Tolti dalla liquidità'
            : (v.acquisti.map(a => `${a.quote} ${esc(a.nome)} a ${num(a.prezzo)}`).join(' · ') || 'nessun acquisto')}</div></div>
          <div class="destra"><div class="nome ${v.tipo === 'vendita' || v.tipo === 'deposito' ? 'positivo' : v.tipo === 'prelievo' ? 'negativo' : ''}">${v.tipo === 'vendita' ? '+' + euro(v.netto) : v.tipo === 'deposito' ? '+' + euro(v.importo) : v.tipo === 'prelievo' ? '−' + euro(v.importo) : euro(v.spesa ?? v.versamento)}</div><div class="sotto">valore dopo ${euro(v.valoreDopo, 0)}</div></div>
        </div>
        <a href="#" data-i="${i}" class="elimina-vers piccolo" style="color:var(--tenue)">elimina dal registro</a>
      </div>`).join('') : '<p class="tenue piccolo">Nessun movimento registrato.</p>'}
    <p class="tenue piccolo">Eliminare una riga dal registro non cambia quote e prezzi di carico.</p>
  </div>
  <div class="scheda">
    <h2>Costi</h2>
    <label>Imposta di bollo annua %</label>
    <input id="i-bollo" inputmode="decimal" value="${num(imp.bollo, 2)}">
    <h2 style="margin-top:16px">Altri costi</h2>
    ${imp.costiExtra.map((c, i) => `<div class="modifica costo" data-i="${i}" style="grid-template-columns:2fr 1fr 1fr auto;align-items:end">
      <div><label>Voce</label><input data-k="nome" value="${esc(c.nome)}"></div>
      <div><label>Euro</label><input data-k="importo" inputmode="decimal" value="${num(c.importo)}"></div>
      <div><label>Ogni</label><select data-k="frequenza"><option value="mese" ${c.frequenza === 'mese' ? 'selected' : ''}>mese</option><option value="anno" ${c.frequenza !== 'mese' ? 'selected' : ''}>anno</option></select></div>
      <button class="togli-costo" aria-label="Togli" style="background:none;border:0;color:var(--rosso);font-size:22px;padding:10px 4px">×</button>
    </div>`).join('') || '<p class="tenue piccolo">Nessun altro costo. Per esempio il bonifico mensile verso Directa.</p>'}
    <button id="agg-costo" class="secondario">Aggiungi un costo</button>
    <p class="tenue piccolo">Totale altri costi: ${euro(imp.costiExtra.reduce((s, c) => s + (c.importo || 0) * (c.frequenza === 'mese' ? 12 : 1), 0))} l'anno. Entrano nei costi annui e nella simulazione.</p>
  </div>
  <div class="scheda">
    <h2>Copia di sicurezza</h2>
    <button id="esporta" class="secondario">Scarica i dati</button>
    <button id="importa" class="secondario">Carica dati da file</button>
    <input id="file-imp" type="file" accept=".json,application/json" class="nascosto">
  </div>
  <div class="scheda">
    <h2>Profilo</h2>
    <p class="tenue piccolo">${usaFirebase ? (utente ? 'Collegato come ' + esc(utente.email) : '') : 'Modalità locale: i dati restano su questo dispositivo. Collega Firebase per averli ovunque.'}</p>
    ${usaFirebase && utente ? '<button id="esci" class="secondario">Esci</button>' : ''}
    <button id="azzera" class="pericolo">Cancella tutti i dati</button>
  </div>`;
}
function aAltro() {
  document.querySelectorAll('.elimina-vers').forEach(a => a.onclick = e => {
    e.preventDefault();
    if (!confirm('Eliminare questa riga dal registro?')) return;
    stato.storico.splice(+a.dataset.i, 1); salva(); disegna();
  });
  $('#i-bollo').onchange = e => { stato.impostazioni.bollo = leggiNumSemplice(e.target.value); salva(); };
  document.querySelectorAll('.costo').forEach(r => {
    const c = stato.impostazioni.costiExtra[+r.dataset.i];
    r.querySelectorAll('[data-k]').forEach(inp => inp.onchange = () => {
      const k = inp.dataset.k;
      c[k] = k === 'importo' ? leggiNumSemplice(inp.value) : inp.value.trim();
      salva(); disegna();
    });
    r.querySelector('.togli-costo').onclick = () => { stato.impostazioni.costiExtra.splice(+r.dataset.i, 1); salva(); disegna(); };
  });
  $('#agg-costo').onclick = () => { stato.impostazioni.costiExtra.push({ nome: 'Bonifico', importo: 0, frequenza: 'mese' }); salva(); disegna(); };
  $('#esporta').onclick = () => {
    const b = new Blob([JSON.stringify(stato, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(b);
    a.download = 'portafoglio-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
  };
  $('#importa').onclick = () => $('#file-imp').click();
  $('#file-imp').onchange = async e => {
    try { stato = unisci(JSON.parse(await e.target.files[0].text())); salva(); avviso('Dati caricati'); disegna(); }
    catch { avviso('File non valido'); }
  };
  const esci = $('#esci'); if (esci) esci.onclick = () => authMod.signOut(auth);
  $('#azzera').onclick = () => {
    if (!confirm('Cancellare tutto il portafoglio? Non si può annullare.')) return;
    stato = statoVuoto(); salva(); disegna();
  };
}

// ---------- Avvio ----------
document.querySelectorAll('nav button').forEach(b => b.onclick = () => { vista = b.dataset.vista; window.scrollTo(0, 0); disegna(); });

function mostraApp() { $('#accesso').classList.add('nascosto'); $('#app').classList.remove('nascosto'); disegna(); }

async function avvia() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!usaFirebase) { await carica(); segnaSalvato('Modalità locale'); mostraApp(); return; }
  const v = '10.14.1';
  let app;
  try {
    app = await import(`https://www.gstatic.com/firebasejs/${v}/firebase-app.js`);
    authMod = await import(`https://www.gstatic.com/firebasejs/${v}/firebase-auth.js`);
    fs = await import(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore.js`);
  } catch (e) {
    $('#accesso').classList.remove('nascosto');
    $('#acc-errore').textContent = 'Non riesco a collegarmi al server. Controlla la connessione e riapri l\'app.';
    return;
  }
  const fa = app.initializeApp(firebaseConfig);
  auth = authMod.getAuth(fa); db = fs.getFirestore(fa);
  const errore = t => { $('#acc-errore').textContent = t; };
  const traduci = c => ({ 'auth/invalid-credential': 'Indirizzo o parola d\'ordine sbagliati', 'auth/weak-password': 'Parola d\'ordine troppo corta (almeno 6 caratteri)', 'auth/email-already-in-use': 'Esiste già un profilo con questo indirizzo', 'auth/invalid-email': 'Indirizzo non valido', 'auth/user-not-found': 'Nessun profilo con questo indirizzo', 'auth/missing-password': 'Scrivi la parola d\'ordine', 'auth/too-many-requests': 'Troppi tentativi, riprova tra poco' }[c] || 'Errore: ' + c);
  // Due modi della stessa schermata: «accedi» e «crea un profilo nuovo»
  let creo = false;
  const modo = c => {
    creo = c; errore('');
    $('#acc-sotto').textContent = c ? 'Scegli la mail e la parola d\'ordine del nuovo profilo' : 'Accedi per vedere i tuoi dati';
    $('#acc-pw2-box').classList.toggle('nascosto', !c);
    $('#acc-pw').setAttribute('autocomplete', c ? 'new-password' : 'current-password');
    $('#acc-entra').textContent = c ? 'Crea il profilo' : 'Accedi';
    $('#acc-crea').textContent = c ? 'Ho già un profilo: accedi' : 'Crea un nuovo profilo';
    $('#acc-reset').classList.toggle('nascosto', c);
    $('#acc-mail').focus();
  };
  $('#acc-crea').onclick = () => modo(!creo);
  $('#acc-form').onsubmit = e => {
    e.preventDefault(); $('#acc-errore').style.color = '';
    const mail = $('#acc-mail').value.trim(), pw = $('#acc-pw').value;
    if (!mail) return errore('Scrivi il tuo indirizzo di posta');
    if (!pw) return errore('Scrivi la parola d\'ordine');
    if (creo) {
      if (pw.length < 6) return errore('La parola d\'ordine deve avere almeno 6 caratteri');
      if (pw !== $('#acc-pw2').value) return errore('Le due parole d\'ordine non sono uguali');
      // profilo creato: arriva una mail di conferma (in italiano) all'indirizzo scelto
      auth.languageCode = 'it';
      authMod.createUserWithEmailAndPassword(auth, mail, pw)
        .then(c => authMod.sendEmailVerification(c.user).then(() => avviso('Profilo creato. Ti ho mandato una mail di conferma.', 4500)).catch(() => {}))
        .catch(e => errore(traduci(e.code)));
    } else authMod.signInWithEmailAndPassword(auth, mail, pw).catch(e => errore(traduci(e.code)));
  };
  $('#acc-reset').onclick = () => {
    const mail = $('#acc-mail').value.trim();
    if (!mail) { errore('Scrivi prima il tuo indirizzo di posta'); return; }
    authMod.sendPasswordResetEmail(auth, mail).then(() => { $('#acc-errore').style.color = 'var(--verde)'; errore('Ti ho mandato una mail per sceglierne una nuova'); }).catch(e => errore(traduci(e.code)));
  };
  authMod.onAuthStateChanged(auth, async u => {
    utente = u;
    if (!u) { $('#app').classList.add('nascosto'); $('#accesso').classList.remove('nascosto'); return; }
    try { await carica(); } catch (e) { avviso('Non riesco a leggere i dati: ' + e.message, 5000); }
    segnaSalvato('Salvato');
    mostraApp();
  });
}
avvia();
// Blocca il pizzico per ingrandire anche su Safari (che ignora le impostazioni della pagina).
document.addEventListener('gesturestart', e => e.preventDefault());
let ultimoTocco = 0;
document.addEventListener('touchend', e => { const ora = Date.now(); if (ora - ultimoTocco < 300) e.preventDefault(); ultimoTocco = ora; }, { passive: false });

// Occhio per vedere la parola d'ordine mentre la scrivi
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-occhio]'); if (!b) return;
  e.preventDefault(); const p = b.parentNode.querySelector('input'); const vedo = p.type === 'password';
  p.type = vedo ? 'text' : 'password';
  b.innerHTML = vedo ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A9.9 9.9 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7c1.8 0 3.4-.5 4.7-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>' : '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  b.setAttribute('aria-label', vedo ? "Nascondi la parola d'ordine" : "Mostra la parola d'ordine");
});
