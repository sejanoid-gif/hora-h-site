// Coletor da apuração do TSE.
// Busca o JSON de Presidente do TSE e grava uma cópia normalizada em ../site/apuracao.json.
// Os visitantes leem só essa cópia, nunca o TSE direto (o TSE bloqueia IP com mais de
// 100 req/s e com muitos 404).
//
// Uso:
//   node coletor.mjs --fonte=simulado --uma-vez      (teste, dados fictícios do TSE)
//   node coletor.mjs --fonte=oficial                 (loop, a cada 20 s)
//
// Regras seguidas (Resolução TSE 23.751/2026):
//  - Resultado de Presidente só a partir das 17h de Brasília (art. 265 §1º): antes disso
//    o modo oficial NÃO consulta o TSE e grava "aguardando".
//  - Os valores do TSE não são alterados (art. 267 §4º): só são reorganizados.

import { writeFile, rename, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));

const URLS = {
  simulado:
    'https://resultados-sim.tse.jus.br/simulado/simulado2026/ele2026/21270/dados/br/br-c0001-e021270-u.json',
  // Padrão confirmado em 24/10/2026 pelo ele-c.jws do próprio TSE (2º turno = eleição 6258, pleito 3221) e pelo arquivo do 1º turno
  // (…/ele2026/6257/dados/br/br-c0001-e006257-u.json, 200 OK, o coletor o processou). O arquivo 6258 só existe depois das 17h de 25/10.
  oficial:
    'https://resultados.tse.jus.br/oficial/ele2026/6258/dados/br/br-c0001-e006258-u.json',
};

// 25/10/2026, 17h de Brasília (UTC-03:00)
const LIBERADO_EM = Date.parse('2026-10-25T17:00:00-03:00');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const fonte = args.fonte === 'oficial' ? 'oficial' : 'simulado';
const url = args.url || URLS[fonte];
const intervalo = Number(args.intervalo || 20) * 1000;
const saida = resolve(AQUI, args.saida || '../site/apuracao.json');
const umaVez = Boolean(args['uma-vez']);

const num = (s) => {
  const n = Number(String(s ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// Reorganiza o JSON do TSE sem mudar nenhum valor.
function normalizar(j) {
  const cargo = (j.carg || []).find((c) => c.cd === '1') || j.carg?.[0];
  if (!cargo) throw new Error('JSON sem cargo de Presidente');
  const candidatos = (cargo.agr || [])
    .flatMap((a) => a.par || [])
    .flatMap((p) => p.cand || [])
    .map((c) => ({
      numero: c.n,
      nome: c.nmu || c.nm,
      votos: num(c.vap),
      votosTexto: c.vap,
      pct: num(c.pvapn),
      situacao: c.st,
      situacaoCandidatura: c.dvt,
      eleito: c.e === 's',
    }));
  return {
    estado: 'ok',
    fonte: 'TSE',
    ambiente: fonte,
    geradoTseData: j.dg,
    geradoTseHora: j.hg,
    secoesTotalizadasPct: num(j.s?.pstn),
    secoesTotal: num(j.s?.ts),
    secoesTotalizadas: num(j.s?.st),
    votosTotais: num(j.v?.tv),
    votosValidos: num(j.v?.vv),
    candidatos,
  };
}

// ---- por estado (27 UFs) ----
const UFS = ['ac', 'al', 'ap', 'am', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mt', 'ms', 'mg', 'pa', 'pb', 'pr', 'pe', 'pi', 'rj', 'rn', 'rs', 'ro', 'rr', 'sc', 'sp', 'se', 'to'];
// .../dados/br/br-c0001-eXXXXXX-u.json  ->  .../dados/ac/ac-c0001-eXXXXXX-u.json
const urlUf = (base, uf) => base.replace('/br/br-', `/${uf}/${uf}-`);
const candidatosDe = (j) => ((j.carg || []).find((c) => c.cd === '1') || j.carg?.[0])?.agr?.flatMap((a) => a.par || []).flatMap((p) => p.cand || []) || [];

// Quais dois candidatos acompanhar: 13 e 22; se não existirem (simulação), os dois mais votados.
function escolherNumeros(candidatos) {
  const tem = (n) => candidatos.some((c) => c.numero === n);
  if (tem('13') && tem('22')) return ['13', '22'];
  return [...candidatos].sort((a, b) => (b.votos || 0) - (a.votos || 0)).slice(0, 2).map((c) => c.numero).sort((a, b) => Number(a) - Number(b));
}
function resumoUf(uf, j, numeros) {
  const cand = candidatosDe(j);
  const por = (n) => cand.find((c) => c.n === n);
  return {
    uf: uf.toUpperCase(),
    secoesPct: num(j.s?.pstn),
    secoes: num(j.s?.ts),
    eleitorado: num(j.e?.te),
    votos: Object.fromEntries(numeros.map((n) => [n, num(por(n)?.vap)])),
    pct: Object.fromEntries(numeros.map((n) => [n, num(por(n)?.pvapn)])),
  };
}
let ufPausaAte = 0;
async function buscarUfs(numeros) {
  if (Date.now() < ufPausaAte) return null;
  let faltando = 0;
  const lista = await Promise.all(UFS.map(async (uf) => {
    try {
      const r = await fetch(urlUf(url, uf), { headers: { 'cache-control': 'no-cache' } });
      if (r.status === 404) { faltando++; return null; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return resumoUf(uf, await r.json(), numeros);
    } catch (e) { return null; }
  }));
  // muitos 404 podem bloquear o IP: se vários estados ainda não existem, espera 2 min antes de tentar de novo
  if (faltando >= 4) { ufPausaAte = Date.now() + 120_000; console.warn(`[ufs] ${faltando} estados ainda sem arquivo. Pausando 2 min.`); }
  return lista.filter(Boolean);
}

async function gravar(obj) {
  await mkdir(dirname(saida), { recursive: true });
  const tmp = saida + '.tmp';
  await writeFile(tmp, JSON.stringify({ ...obj, coletadoEm: new Date().toISOString() }, null, 1));
  await rename(tmp, saida);
}

let erros404 = 0;

async function ciclo() {
  if (fonte === 'oficial' && Date.now() < LIBERADO_EM) {
    await gravar({ estado: 'aguardando', fonte: 'TSE', ambiente: fonte, liberadoEm: '2026-10-25T17:00:00-03:00' });
    console.log('[aguardando] resultado só é liberado às 17h de 25/10 (Brasília)');
    return intervalo;
  }
  try {
    const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    if (r.status === 404) {
      erros404++;
      console.warn(`[404] ${erros404}x — arquivo ainda não existe. Pausando para não ser bloqueado.`);
      // se já há uma cópia boa (estado ok), um 404 passageiro não pode apagá-la: o site voltaria para "aguardando"
      const atual = await readFile(saida, 'utf8').then(JSON.parse).catch(() => null);
      if (!(atual && atual.estado === 'ok' && atual.ambiente === fonte)) await gravar({ estado: 'aguardando', fonte: 'TSE', ambiente: fonte, motivo: 'arquivo ainda não publicado' });
      // 404 repetido pode bloquear o IP: espera cada vez mais, no mínimo 60 s.
      return Math.min(60_000 * erros404, 600_000);
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    erros404 = 0;
    const dados = normalizar(await r.json());
    dados.numeros = escolherNumeros(dados.candidatos);
    const ufs = await buscarUfs(dados.numeros);
    if (ufs) dados.ufs = ufs;
    await gravar(dados);
    console.log(`[ok] ${dados.secoesTotalizadasPct ?? '?'}% apurado · ${dados.candidatos.length} candidatos · ${dados.ufs ? dados.ufs.length + ' estados' : 'sem estados'} · TSE ${dados.geradoTseHora}`);
  } catch (e) {
    console.error('[erro]', e.message, '— mantendo a última cópia.');
  }
  return intervalo;
}

console.log(`Coletor · fonte=${fonte} · ${url}\nSaída: ${saida}`);
if (umaVez) {
  await ciclo();
} else {
  for (;;) {
    const espera = await ciclo();
    await new Promise((r) => setTimeout(r, espera));
  }
}
