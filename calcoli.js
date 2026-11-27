// Calcoli puri del portafoglio: nessun accesso alla pagina, così si possono provare a parte.

export const valorePos = p => (p.quote || 0) * (p.prezzo || 0);
export const caricoPos = p => (p.quote || 0) * (p.pmc || 0);

export function riepilogo(stato) {
  const pos = stato.posizioni;
  const valoreTitoli = pos.reduce((s, p) => s + valorePos(p), 0);
  const totale = valoreTitoli + (stato.liquidita || 0);
  const carico = pos.reduce((s, p) => s + caricoPos(p), 0);
  const guadagno = valoreTitoli - carico;
  const bollo = valoreTitoli * (stato.impostazioni.bollo / 100);
  const ter = pos.reduce((s, p) => s + valorePos(p) * ((p.ter || 0) / 100), 0);
  const extra = costiExtraAnnui(stato);
  const tasseLatenti = pos.reduce((s, p) => s + Math.max(0, valorePos(p) - caricoPos(p)) * ((p.aliquota ?? 26) / 100), 0);
  return {
    extra, tasseLatenti, nettoOggi: totale - tasseLatenti,
    valoreTitoli, totale, carico, guadagno,
    guadagnoPct: carico > 0 ? guadagno / carico : 0,
    bollo, ter, costiAnnui: bollo + ter + extra,
    costiPct: totale > 0 ? (bollo + ter + extra) / totale : 0,
    sommaTarget: pos.reduce((s, p) => s + (p.target || 0), 0),
    pesi: pos.map(p => ({ id: p.id, peso: totale > 0 ? valorePos(p) / totale : 0 }))
  };
}

// Divide il versamento tra gli ETF per avvicinarsi ai pesi obiettivo, senza vendere.
// Compra una quota alla volta dell'ETF più lontano dal suo obiettivo finché i soldi bastano.
export function calcolaAcquisti(stato, versamento, usaLiquidita = false) {
  const pos = stato.posizioni.filter(p => p.prezzo > 0);
  let cassa = versamento + (usaLiquidita ? (stato.liquidita || 0) : 0);
  const liquiditaFinale = usaLiquidita ? 0 : (stato.liquidita || 0);
  const quote = Object.fromEntries(pos.map(p => [p.id, 0]));
  const valoreTitoli = pos.reduce((s, p) => s + valorePos(p), 0);
  const totaleDopo = valoreTitoli + cassa + liquiditaFinale;
  const sommaT = pos.reduce((s, p) => s + (p.target || 0), 0) || 1;
  const investibile = totaleDopo - liquiditaFinale;
  const obiettivo = p => (p.target / sommaT) * investibile;
  const attuale = p => valorePos(p) + quote[p.id] * p.prezzo;
  for (let giri = 0; giri < 100000; giri++) {
    let migliore = null, mancanza = -Infinity;
    for (const p of pos) {
      if (p.prezzo > cassa + 1e-9 || !(p.target > 0)) continue;
      // si compra solo se dopo l'acquisto l'ETF non supera il suo obiettivo di più di mezza quota
      if (attuale(p) + p.prezzo / 2 > obiettivo(p)) continue;
      const m = (obiettivo(p) - attuale(p)) / obiettivo(p);
      if (m > mancanza) { mancanza = m; migliore = p; }
    }
    if (!migliore) break;
    // Quello che avanza resta in liquidità: non si compra un ETF già sopra il suo obiettivo.
    quote[migliore.id]++;
    cassa -= migliore.prezzo;
  }
  const righe = stato.posizioni.map(p => {
    const q = quote[p.id] || 0;
    return { id: p.id, quote: q, spesa: q * (p.prezzo || 0) };
  });
  return { righe, residuo: cassa };
}

// Nuovo prezzo medio di carico dopo un acquisto.
export function nuovoPmc(quoteVecchie, pmcVecchio, quoteNuove, prezzo, commissione = 0) {
  const tot = quoteVecchie + quoteNuove;
  if (tot <= 0) return 0;
  return (quoteVecchie * pmcVecchio + quoteNuove * prezzo + commissione) / tot;
}

// Generatore casuale con seme, per avere risultati ripetibili.
function generatore(seme) {
  let s = seme >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function cholesky(M) {
  const n = M.length, L = M.map(() => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = M[i][j];
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
  }
  return L;
}

const percentile = (arr, q) => { const a = [...arr].sort((x, y) => x - y); const i = (a.length - 1) * q, b = Math.floor(i); return a[b] + (a[Math.min(b + 1, a.length - 1)] - a[b]) * (i - b); };

// Tipi di ETF: servono per le correlazioni e per le tasse.
export const CLASSI = {
  azioni: { nome: 'Azioni', aliquota: 26 },
  obbligazioni: { nome: 'Obbligazioni di Stato', aliquota: 12.5 },
  inflazione: { nome: 'Obbligazioni indicizzate', aliquota: 12.5 },
  oro: { nome: 'Oro', aliquota: 26 },
  liquidita: { nome: 'Liquidità in euro', aliquota: 26 },
  dollaro: { nome: 'Titoli di Stato in dollari', aliquota: 12.5 },
  leva: { nome: 'A leva / speculativo', aliquota: 26 }
};
// Correlazioni tipiche per un investitore in euro (stime di lungo periodo).
const CORR = {
  'azioni|azioni': 0.9, 'azioni|obbligazioni': 0.1, 'azioni|inflazione': 0.2, 'azioni|oro': 0.1, 'azioni|liquidita': 0, 'azioni|dollaro': 0.3, 'azioni|leva': 0.85,
  'obbligazioni|obbligazioni': 0.9, 'obbligazioni|inflazione': 0.6, 'obbligazioni|oro': 0.2, 'obbligazioni|liquidita': 0, 'obbligazioni|dollaro': 0.15, 'obbligazioni|leva': 0,
  'inflazione|inflazione': 0.9, 'inflazione|oro': 0.3, 'inflazione|liquidita': 0, 'inflazione|dollaro': 0.1, 'inflazione|leva': 0.1,
  'oro|oro': 0.9, 'oro|liquidita': 0, 'oro|dollaro': 0.3, 'oro|leva': 0.05,
  'liquidita|liquidita': 0.5, 'liquidita|dollaro': 0, 'liquidita|leva': 0,
  'dollaro|dollaro': 0.9, 'dollaro|leva': 0.3, 'leva|leva': 0.9
};
export const correlazione = (a, b) => CORR[a + '|' + b] ?? CORR[b + '|' + a] ?? 0;
export const PERCENTILI = [5, 10, 25, 50, 75, 90, 95];

// Simulazione Monte Carlo mensile, il più possibile vicina alla realtà:
// - rendimento annuo composto e volatilità per ETF, correlazioni per tipo di ETF;
// - crolli più frequenti del modello «normale» (distribuzione t di Student, i crolli colpiscono insieme);
// - TER e bollo tolti ogni mese, più i costi extra (per esempio i bonifici);
// - versamenti mensili, se vuoi crescenti con l'inflazione;
// - ribilanciamento solo con i versamenti (niente vendite) oppure una volta l'anno vendendo, con le tasse;
// - risultato lordo, al netto delle tasse se vendessi tutto alla fine, e in euro di oggi.
export function simula(stato, opz) {
  const { anni, versamentoMensile, simulazioni, seme = 42 } = opz;
  const inflazione = (opz.inflazione ?? 2) / 100;
  const versCresce = !!opz.versamentoCresce;
  const ribilanciaVendendo = opz.ribilanciamento === 'anno';
  const gl = 5; // gradi di libertà: più basso = crolli più frequenti
  const pos = stato.posizioni.filter(p => (p.target || 0) > 0 || valorePos(p) > 0);
  const n = pos.length, mesi = Math.round(anni * 12);
  const rnd = generatore(seme);
  const normale = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const M = pos.map((a, i) => pos.map((b, j) => i === j ? 1 : correlazione(a.classe, b.classe)));
  const L = cholesky(M);
  const bollo = stato.impostazioni.bollo / 100;
  const deriva = pos.map(p => (Math.log(1 + p.mu / 100) - (p.ter || 0) / 100 - bollo) / 12);
  const vol = pos.map(p => (p.sigma / 100) / Math.sqrt(12));
  const aliquote = pos.map(p => (p.aliquota ?? CLASSI[p.classe]?.aliquota ?? 26) / 100);
  const sommaT = pos.reduce((s, p) => s + (p.target || 0), 0) || 1;
  const pesi = pos.map(p => (p.target || 0) / sommaT);
  const costoExtraMese0 = costiExtraAnnui(stato) / 12;
  const inizio = pos.map(valorePos);
  const carico0 = pos.map(p => caricoPos(p) || valorePos(p));
  const lordi = [], netti = [], reali = [], ribassi = [], rendimenti = [];
  const rendAsset = pos.map(() => []), ribAsset = pos.map(() => []);
  const z = new Array(n), e = new Array(n), voluto = new Array(n);
  const scalaT = Math.sqrt((gl - 2) / gl);
  let versatoTot = 0;
  for (let s = 0; s < simulazioni; s++) {
    const v = inizio.slice(), base = carico0.slice();
    const unita = new Array(n).fill(1), picchiA = new Array(n).fill(1), ddA = new Array(n).fill(0);
    let indice = 1, picco = 1, dd = 0, versato = 0;
    for (let m = 0; m < mesi; m++) {
      // shock comune: nei mesi «brutti» tutti gli ETF si muovono di più insieme
      let chi = 0; for (let k = 0; k < gl; k++) { const q = normale(); chi += q * q; }
      const fattore = scalaT * Math.sqrt(gl / chi);
      for (let i = 0; i < n; i++) e[i] = normale();
      for (let i = 0; i < n; i++) { let t = 0; for (let k = 0; k <= i; k++) t += L[i][k] * e[k]; z[i] = t * fattore; }
      let prima = 0, dopo = 0, crescitaPesata = 0;
      for (let i = 0; i < n; i++) {
        const f = Math.exp(deriva[i] + vol[i] * z[i]);
        prima += v[i]; v[i] *= f; dopo += v[i]; crescitaPesata += pesi[i] * f;
        unita[i] *= f;
        if (unita[i] > picchiA[i]) picchiA[i] = unita[i];
        const d = 1 - unita[i] / picchiA[i]; if (d > ddA[i]) ddA[i] = d;
      }
      indice *= prima > 0 ? dopo / prima : crescitaPesata;
      if (indice > picco) picco = indice;
      const d = 1 - indice / picco; if (d > dd) dd = d;
      const fInfl = Math.pow(1 + inflazione, Math.floor(m / 12));
      // costi extra: escono dal portafoglio in proporzione
      const costo = costoExtraMese0 * fInfl;
      if (costo > 0 && dopo > 0) for (let i = 0; i < n; i++) { const quota = v[i] / dopo; v[i] -= costo * quota; base[i] -= costo * quota * (base[i] / Math.max(v[i] + costo * quota, 1e-9)); }
      // versamento: va agli ETF sotto obiettivo
      const vers = versamentoMensile * (versCresce ? fInfl : 1);
      versato += vers;
      let tot = 0; for (let i = 0; i < n; i++) tot += v[i];
      const totDopo = tot + vers;
      let mancanza = 0;
      for (let i = 0; i < n; i++) { voluto[i] = Math.max(0, pesi[i] * totDopo - v[i]); mancanza += voluto[i]; }
      for (let i = 0; i < n; i++) {
        const q = mancanza > 0 ? vers * voluto[i] / mancanza : vers * pesi[i];
        v[i] += q; base[i] += q;
      }
      if (ribilanciaVendendo && (m + 1) % 12 === 0) {
        let t2 = 0; for (let i = 0; i < n; i++) t2 += v[i];
        let incasso = 0;
        for (let i = 0; i < n; i++) {
          const eccesso = v[i] - pesi[i] * t2;
          if (eccesso > 0 && v[i] > 0) {
            const quotaGuadagno = Math.max(0, 1 - base[i] / v[i]);
            const tassa = eccesso * quotaGuadagno * aliquote[i];
            base[i] *= 1 - eccesso / v[i];
            v[i] -= eccesso; incasso += eccesso - tassa;
          }
        }
        let sotto = 0; for (let i = 0; i < n; i++) sotto += Math.max(0, pesi[i] * t2 - v[i]);
        for (let i = 0; i < n; i++) {
          const manca = Math.max(0, pesi[i] * t2 - v[i]);
          if (sotto > 0 && manca > 0) { const q = incasso * manca / sotto; v[i] += q; base[i] += q; }
        }
      }
    }
    if (s === 0) versatoTot = versato;
    let lordo = 0, tasse = 0;
    for (let i = 0; i < n; i++) { lordo += v[i]; tasse += Math.max(0, v[i] - base[i]) * aliquote[i]; }
    lordi.push(lordo); netti.push(lordo - tasse); reali.push((lordo - tasse) / Math.pow(1 + inflazione, anni));
    ribassi.push(dd); rendimenti.push(Math.pow(indice, 1 / anni) - 1);
    for (let i = 0; i < n; i++) { rendAsset[i].push(Math.pow(unita[i], 1 / anni) - 1); ribAsset[i].push(ddA[i]); }
  }
  const tabella = arr => Object.fromEntries(PERCENTILI.map(q => [q, percentile(arr, q / 100)]));
  return {
    anni, inflazione: inflazione * 100,
    lordo: tabella(lordi), netto: tabella(netti), reale: tabella(reali),
    rendimento: tabella(rendimenti),
    rendimentoReale: Object.fromEntries(PERCENTILI.map(q => [q, (1 + percentile(rendimenti, q / 100)) / (1 + inflazione) - 1])),
    ribasso: tabella(ribassi),
    versatoTotale: inizio.reduce((a, b) => a + b, 0) + versatoTot,
    finali: netti,
    asset: pos.map((p, i) => ({ id: p.id, nome: p.nome, rendimento: percentile(rendAsset[i], 0.5), ribasso: percentile(ribAsset[i], 0.5) }))
  };
}

export function costiExtraAnnui(stato) {
  return (stato.impostazioni.costiExtra || []).reduce((s, c) => s + (c.importo || 0) * (c.frequenza === 'mese' ? 12 : 1), 0);
}

// Ribilanciamento completo: con la liquidità che hai, cosa comprare e cosa vendere per tornare agli obiettivi.
// Quote intere; le vendite in guadagno pagano le tasse (stimate) e i soldi incassati servono per gli acquisti.
export function ribilancia(stato) {
  const pos = stato.posizioni.filter(p => p.prezzo > 0 && ((p.target || 0) > 0 || (p.quote || 0) > 0));
  const liq = stato.liquidita || 0;
  const totale = pos.reduce((s, p) => s + valorePos(p), 0) + liq;
  const sommaT = pos.reduce((s, p) => s + (p.target || 0), 0) || 100;
  const obiettivo = p => ((p.target || 0) / sommaT) * totale;
  const q = {};
  for (const p of pos) {
    let n = Math.round((obiettivo(p) - valorePos(p)) / p.prezzo);
    if (n < 0) n = Math.max(n, -(p.quote || 0));
    q[p.id] = n;
  }
  const tasseVendita = p => q[p.id] < 0 ? -q[p.id] * Math.max(0, p.prezzo - (p.pmc || 0)) * ((p.aliquota ?? 26) / 100) : 0;
  const cassa = () => liq - pos.reduce((s, p) => s + q[p.id] * p.prezzo + tasseVendita(p), 0);
  // se i soldi non bastano, tolgo una quota dall'acquisto che sfora di più l'obiettivo
  for (let giri = 0; giri < 10000 && cassa() < -0.005; giri++) {
    let peggiore = null, sforo = -Infinity;
    for (const p of pos) {
      if (q[p.id] <= 0) continue;
      const s = valorePos(p) + q[p.id] * p.prezzo - obiettivo(p);
      if (s > sforo) { sforo = s; peggiore = p; }
    }
    if (!peggiore) break;
    q[peggiore.id]--;
  }
  const dopo = cassa();
  const righe = pos.map(p => ({
    id: p.id, nome: p.nome, quote: q[p.id], euro: q[p.id] * p.prezzo, tasse: tasseVendita(p),
    pesoPrima: totale > 0 ? valorePos(p) / totale : 0,
    pesoDopo: totale > 0 ? (valorePos(p) + q[p.id] * p.prezzo) / totale : 0,
    obiettivo: (p.target || 0) / sommaT
  }));
  return { righe, liquiditaDopo: dopo, tasse: righe.reduce((s, r) => s + r.tasse, 0),
    comprato: righe.filter(r => r.quote > 0).reduce((s, r) => s + r.euro, 0),
    venduto: righe.filter(r => r.quote < 0).reduce((s, r) => s - r.euro, 0) };
}
