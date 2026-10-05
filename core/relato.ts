// "Me diga o que deu errado nos últimos dias, em uma página."
//
//   npm run relato        — os últimos 7 dias
//   npm run relato -- 2   — só ontem e hoje
//
// Por que isto existe: o diário de texto tem 200 mil caracteres num dia movimentado. Ninguém lê — nem pessoa
// nem IA, que além de tudo chega ao limite de contexto e passa a adivinhar. O que resolve um problema não é o
// histórico inteiro: é a falha AGRUPADA (quantas vezes, em qual plataforma, com qual motivo, desde quando) e
// um exemplo concreto de cada. Isto lê `diario/eventos-*.jsonl` e imprime exatamente isso, em Markdown, para
// ler no terminal ou colar num chat.
//
// Regra do arquivo: ele só LÊ. Nenhum caminho daqui muda estado, para que rodar o relato no meio de uma
// candidatura seja sempre seguro.
import { lerEventos, type Evento } from './diario.ts';

const dias = Math.max(1, Number(process.argv[2]) || 7);
const eventos = lerEventos(dias);

const hora = (iso: string) => new Date(iso).toLocaleString('pt-BR', { hour12: false });
const txt = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** Agrupa por uma chave e devolve os maiores primeiro, com quantidade, primeira e última vez. */
function agrupar(lista: Evento[], chave: (e: Evento) => string) {
  const mapa = new Map<string, Evento[]>();
  for (const e of lista) {
    const k = chave(e);
    if (!k) continue;
    const atual = mapa.get(k);
    if (atual) atual.push(e);
    else mapa.set(k, [e]);
  }
  return [...mapa.entries()].map(([k, es]) => ({ k, n: es.length, primeiro: es[0], ultimo: es.at(-1) as Evento })).sort((a, b) => b.n - a.n);
}

const linhas: string[] = [];
const p = (s = '') => linhas.push(s);
const soma = (lista: Evento[], campo: string) => lista.reduce((t, e) => t + (Number(e.dados?.[campo]) || 0), 0);

p(`# Relato do ACV — últimos ${dias} dia(s)`);
p();

if (!eventos.length) {
  p('Nenhum evento registrado no período.');
  p();
  p('O núcleo grava em `diario/eventos-AAAA-MM-DD.jsonl` a partir de 05/10/2026. Se o servidor subiu antes');
  p('disso, reinicie-o (feche a janela "ACV - servidor" e rode o `start.bat`) e volte aqui.');
  console.log(linhas.join('\n'));
  process.exit(0);
}

p(`${eventos.length} evento(s), de ${hora(eventos[0].em)} a ${hora((eventos.at(-1) as Evento).em)}.`);
p();

// ─── Candidaturas ────────────────────────────────────────────────────────────────────────────────
const desfechos = eventos.filter(e => e.evento === 'candidatura.desfecho');
if (desfechos.length) {
  p('## Candidaturas');
  p();
  p('| desfecho | quantas |');
  p('|---|---|');
  for (const g of agrupar(desfechos, e => txt(e.dados?.status))) p(`| ${g.k} | ${g.n} |`);
  p();

  // Enviada sem prova de rede não é falha — é confirmação mais fraca (invariante 1), e merece olho
  const enviadas = desfechos.filter(e => e.dados?.status === 'enviada');
  if (enviadas.length) {
    const semProva = enviadas.filter(e => !e.dados?.prova);
    p(`**Prova de envio:** ${enviadas.length - semProva.length} de ${enviadas.length} confirmada(s) pela resposta HTTP do servidor.`);
    if (semProva.length) {
      p();
      p(`${semProva.length} enviada(s) **sem** prova de rede — confirmadas pelo texto da própria plataforma, que é o sinal mais fraco:`);
      for (const e of semProva.slice(0, 5)) p(`- ${e.plataforma} · ${txt(e.dados?.titulo)} (${txt(e.dados?.empresa)}) — ${hora(e.em)}`);
    }
    p();
  }

  const falhas = desfechos.filter(e => e.dados?.status === 'erro');
  if (falhas.length) {
    p(`### Falhas agrupadas pelo motivo (${falhas.length})`);
    p();
    for (const g of agrupar(falhas, e => `${e.plataforma ?? '?'} — ${txt(e.dados?.motivo)}`)) {
      p(`**${g.n}× ${g.k}**`);
      p(`- primeira ${hora(g.primeiro.em)}, última ${hora(g.ultimo.em)}`);
      p(`- exemplo: \`${g.ultimo.vaga}\` — ${txt(g.ultimo.dados?.titulo)} (${txt(g.ultimo.dados?.empresa)}), nota ${txt(g.ultimo.dados?.score)}`);
      if (g.ultimo.dados?.captura) p('- há captura de tela da falha na pasta de dados (`gerados`)');
      p();
    }
  }

  const perguntas = desfechos.filter(e => e.dados?.status === 'pergunta');
  if (perguntas.length) {
    p(`### Paradas esperando resposta sua (${perguntas.length})`);
    p();
    for (const g of agrupar(perguntas, e => txt(e.dados?.pergunta)).slice(0, 12)) p(`- ${g.n}× "${g.k}" — ex.: ${g.ultimo.plataforma}, ${txt(g.ultimo.dados?.empresa)}`);
    p();
  }
}

// ─── Fila ────────────────────────────────────────────────────────────────────────────────────────
const recusas = eventos.filter(e => e.evento === 'fila.recusa');
if (recusas.length) {
  p(`## Vagas que saíram da fila sem enviar (${recusas.length})`);
  p();
  for (const g of agrupar(recusas, e => txt(e.dados?.motivo))) p(`- ${g.n}× ${g.k} — ex.: ${g.ultimo.plataforma}, ${txt(g.ultimo.dados?.titulo)}`);
  p();
}

// ─── Varredura ───────────────────────────────────────────────────────────────────────────────────
const varreduras = eventos.filter(e => e.evento === 'varredura.plataforma');
if (varreduras.length) {
  p('## Varredura por plataforma');
  p();
  p('| plataforma | rodadas | vistas | novas | erros |');
  p('|---|---|---|---|---|');
  for (const g of agrupar(varreduras, e => txt(e.plataforma))) {
    const minhas = varreduras.filter(e => txt(e.plataforma) === g.k);
    p(`| ${g.k} | ${g.n} | ${soma(minhas, 'vistas')} | ${soma(minhas, 'novas')} | ${minhas.filter(e => e.dados?.erro).length} |`);
  }
  p();
  const comErro = varreduras.filter(e => e.dados?.erro);
  if (comErro.length) {
    p('Erros de varredura:');
    for (const g of agrupar(comErro, e => `${e.plataforma} — ${txt(e.dados?.erro)}`)) p(`- ${g.n}× ${g.k} (última ${hora(g.ultimo.em)})`);
    p();
  }
}

// ─── Extensão ────────────────────────────────────────────────────────────────────────────────────
const paginas = eventos.filter(e => e.evento === 'extensao.pagina');
if (paginas.length) {
  p('## Extensão: o que ela viu nos sites');
  p();
  for (const g of agrupar(paginas, e => txt(e.dados?.dominio))) {
    const u = g.ultimo.dados ?? {};
    p(`**${g.k}** (${g.n} relato(s), último ${hora(g.ultimo.em)})`);
    p(`- motor: ${txt(u.handler)} · sessão: ${u.logado ? 'ativa' : 'ausente'} — ${txt(u.motivo)}`);
    p(`- botão de candidatura: ${u.envio ? txt(u.envio) : 'não achei nenhum'}`);
    p();
  }
}

// ─── Quedas do processo ──────────────────────────────────────────────────────────────────────────
const quedas = eventos.filter(e => e.evento === 'erro.processo');
if (quedas.length) {
  p(`## Erros não tratados (${quedas.length})`);
  p();
  for (const g of agrupar(quedas, e => txt(e.dados?.mensagem))) {
    p(`**${g.n}× ${g.k}** (última ${hora(g.ultimo.em)})`);
    const pilha = txt(g.ultimo.dados?.pilha);
    if (pilha) {
      p('```');
      p(pilha.split('\n').slice(0, 6).join('\n'));
      p('```');
    }
    p();
  }
}

// ─── O que mais apareceu ─────────────────────────────────────────────────────────────────────────
const conhecidos = new Set(['candidatura.desfecho', 'fila.recusa', 'varredura.plataforma', 'extensao.pagina', 'erro.processo']);
const outros = agrupar(
  eventos.filter(e => !conhecidos.has(e.evento)),
  e => e.evento,
);
if (outros.length) {
  p('## Outros eventos');
  p();
  for (const g of outros) p(`- ${g.n}× \`${g.k}\` (última ${hora(g.ultimo.em)})`);
  p();
}

console.log(linhas.join('\n'));
