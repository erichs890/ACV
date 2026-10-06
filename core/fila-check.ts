// Verificação executável da FILA (o que faz o robô enviar um currículo atrás do outro sozinho):
//   node core/fila-check.ts   — ou `npm run check`, que roda este arquivo junto
//
// Não toca em plataforma nenhuma: usa um adapter falso e um banco temporário (ACV_DIR), então cada cenário
// é determinístico e roda em segundos. O que é verificado aqui é exatamente o que quebrou na prática:
// encadeamento, portões de agendamento, pedido do usuário durante uma candidatura, nova tentativa e duplicidade.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ACV_DIR = mkdtempSync(join(tmpdir(), 'acv-fila-'));

const { kv, vagas, candidaturas, log, apagarTudo } = await import('./storage/db.ts');
const { registrarAdapter } = await import('./platforms/adapter.ts');
const { processarProxima, candidatarAgora, responder, ligarRobo, enfileirarCompativeis, limparDuplicatasDaFila, removerDaFila, devolverAFila, repontuar, esvaziarFila, buscarVagas } = await import(
  './queue.ts'
);
const { AUTOMACAO_PADRAO, ler } = await import('./estado.ts');
const { executarCandidatura } = await import('./candidatura.ts');
import type { PerguntaExtra, Vaga } from '../src/types.ts';
import type { DadosCandidatura, ResultadoCandidatura } from './platforms/adapter.ts';

// ─── Adapter falso: devolve o resultado combinado por vaga e conta as chamadas ───────────────────
// O roteiro recebe `dados` para poder chamar `dados.responder`, que é por onde uma plataforma de verdade
// pergunta ao núcleo "já sei responder isto?" — e é o caminho que resolve autodeclaração sem IA nenhuma.
type Roteiro = ResultadoCandidatura | ((tentativa: number, dados: DadosCandidatura) => ResultadoCandidatura);
const roteiro = new Map<string, Roteiro>();
const chamadas = new Map<string, number>();

registrarAdapter({
  id: 'teste',
  nome: 'Teste',
  buscarVagas: async () => [],
  candidatar: async (vaga, dados) => {
    const n = (chamadas.get(vaga.id) ?? 0) + 1;
    chamadas.set(vaga.id, n);
    const r = roteiro.get(vaga.id) ?? { status: 'enviada' as const };
    return typeof r === 'function' ? r(n, dados) : r;
  },
});

// ─── Cenário base ────────────────────────────────────────────────────────────────────────────────
const curriculo = join(process.env.ACV_DIR, 'cv.pdf');
writeFileSync(curriculo, '%PDF-1.4 teste');

function cenario(automacao: Partial<typeof AUTOMACAO_PADRAO> = {}) {
  apagarTudo();
  roteiro.clear();
  chamadas.clear();
  kv.set('perfil', {
    nome: 'Marina Pitanga',
    email: 'm@exemplo.com',
    telefone: '11982324410',
    linkedin: 'https://linkedin.com/in/marina',
    cidade: 'Campinas - SP',
    cpf: '52998224725',
    pretensao: '4500',
  });
  kv.set('curriculos', [{ id: 1, nome: 'cv.pdf', tamanho: 10, enviadoEm: new Date().toISOString(), caminho: curriculo, markdown: '# Marina' }]);
  kv.set('conexoes', { teste: { conectadaEm: new Date().toISOString() } });
  // adaptar: false para não abrir navegador; janela e intervalo abertos para o encadeamento aparecer
  kv.set('automacao', {
    ...AUTOMACAO_PADRAO,
    configurada: true,
    modo: 'automatico',
    ensaio: false,
    adaptar: false,
    preview: 'direto',
    regimePreferido: 'CLT',
    janela: '00:00-23:59',
    intervaloSegundos: 0,
    limiteDiario: 20,
    // Explícito de propósito: o padrão de `filaAlvo` é 10, e deixá-lo implícito faria os cenários antigos
    // (que contam quantas vagas entram na fila) mudarem de resultado sem ninguém mexer neles
    filaAlvo: 20,
    ...automacao,
  });
  kv.set('robo', 'ativo');
}

let n = 0;
function enfileirar(patch: Partial<Vaga> = {}): string {
  const id = `teste:acme:vaga-${++n}`;
  vagas.salvar({
    id,
    plataforma: 'teste',
    tenant: 'acme',
    titulo: `Vaga ${n}`,
    empresa: 'Acme',
    descricao: '',
    requisitos: '',
    regime: 'CLT',
    modelo: 'remoto',
    local: 'Remoto',
    url: `https://acme.exemplo/vagas/${n}`,
    skills: [],
    camposConhecidos: [],
    score: 80,
    status: 'na_fila',
    posicao: vagas.proximaPosicao(),
    encontradaEm: new Date().toISOString(),
    atualizadaEm: new Date().toISOString(),
    ...patch,
  });
  return id;
}

const st = (id: string) => vagas.get(id)!.status;
const enviadas = () => candidaturas.listar().filter(c => c.resultado === 'enviada').length;

// ─── 1) Encadeamento: a fila inteira anda sozinha, não uma vaga por vez ──────────────────────────
cenario();
const tres = [enfileirar(), enfileirar(), enfileirar()];
await processarProxima();
assert.deepEqual(tres.map(st), ['enviada', 'enviada', 'enviada'], 'as três deviam ter sido enviadas na mesma rodada');
assert.equal(enviadas(), 3);
console.log('✓ Encadeamento: 3 vagas enviadas numa rodada só');

// ─── 2) Portões de agendamento ───────────────────────────────────────────────────────────────────
cenario({ modo: 'manual' });
let id = enfileirar();
await processarProxima();
assert.equal(st(id), 'na_fila', 'modo manual não deve enviar sozinho');

cenario();
kv.set('robo', 'pausado');
id = enfileirar();
await processarProxima();
assert.equal(st(id), 'na_fila', 'robô pausado não deve enviar');

cenario({ janela: '03:00-03:01' });
id = enfileirar();
await processarProxima();
assert.equal(st(id), 'na_fila', 'fora da janela não deve enviar');

cenario({ limiteDiario: 2 });
const quatro = [enfileirar(), enfileirar(), enfileirar(), enfileirar()];
await processarProxima();
assert.equal(enviadas(), 2, 'o limite diário deve parar a fila em 2');
assert.deepEqual(quatro.map(st), ['enviada', 'enviada', 'na_fila', 'na_fila']);

cenario({ intervaloSegundos: 900 });
const duas = [enfileirar(), enfileirar()];
await processarProxima();
assert.deepEqual(duas.map(st), ['enviada', 'na_fila'], 'o intervalo entre envios deve segurar a segunda');
const espera = new Date(kv.get<string>('proximoEnvioEm', '')).getTime() - Date.now();
assert.ok(espera > 890_000 && espera <= 900_000, `próximo envio deveria estar ~900 s à frente, está a ${Math.round(espera / 1000)} s`);
console.log('✓ Portões: modo manual, robô pausado, janela, limite diário e intervalo seguram a fila');

// ─── 3) Modo manual: "Quero me candidatar" envia mesmo com os portões fechados ───────────────────
cenario({ modo: 'manual' });
id = enfileirar({ status: 'encontrada', posicao: undefined });
candidatarAgora(id);
await new Promise(r => setTimeout(r, 60));
assert.equal(st(id), 'enviada', 'pedido manual deve furar os portões');
console.log('✓ Pedido manual envia mesmo em modo manual');

// ─── 4) Pendência não trava a fila, e responder retoma a vaga ────────────────────────────────────
cenario();
const pergunta: PerguntaExtra = { rotulo: 'Quantos anos de experiência?', tipo: 'texto', obrigatoria: true };
const comPergunta = enfileirar();
const depois = enfileirar();
roteiro.set(comPergunta, t => (t === 1 ? { status: 'pergunta', pergunta } : { status: 'enviada' }));
await processarProxima();
assert.equal(st(comPergunta), 'aguardando_pergunta', 'a vaga que perguntou deve ficar aguardando');
assert.equal(st(depois), 'enviada', 'a fila NÃO pode parar por causa de uma pendência');
responder(comPergunta, '2 anos', true);
await new Promise(r => setTimeout(r, 60));
assert.equal(st(comPergunta), 'enviada', 'responder deve retomar a vaga');
assert.equal(enviadas(), 2);
console.log('✓ Pendência pausa só a vaga; responder retoma e envia');

// ─── 5) Nova tentativa: falha transitória volta à fila; permanente não se repete ─────────────────
cenario();
const transitoria = enfileirar();
roteiro.set(transitoria, { status: 'erro', motivo: 'Timeout 12000ms exceeded' });
await processarProxima();
let v = vagas.get(transitoria)!;
assert.equal(v.status, 'na_fila', 'falha de rede deve voltar para a fila');
assert.equal(v.tentativas, 1);
assert.ok(v.proximaTentativaEm && new Date(v.proximaTentativaEm) > new Date(), 'deve haver espera antes da próxima tentativa');
await processarProxima();
assert.equal(chamadas.get(transitoria), 1, 'não pode tentar de novo antes da hora');

cenario();
const permanente = enfileirar();
roteiro.set(permanente, { status: 'erro', motivo: 'o InHire pediu verificação (captcha); envie esta vaga manualmente' });
await processarProxima();
v = vagas.get(permanente)!;
assert.equal(v.status, 'erro', 'captcha não deve ser repetido');
assert.equal(chamadas.get(permanente), 1);
console.log('✓ Nova tentativa: rede volta à fila com espera; captcha para de uma vez');

// ─── 6) Desiste depois do limite de tentativas ───────────────────────────────────────────────────
cenario();
const teimosa = enfileirar({ tentativas: 3 });
roteiro.set(teimosa, { status: 'erro', motivo: 'net::ERR_CONNECTION_RESET' });
await processarProxima();
v = vagas.get(teimosa)!;
assert.equal(v.status, 'erro', 'depois de 3 tentativas deve desistir');
assert.equal(v.tentativas, 4);
console.log('✓ Desiste após 3 tentativas seguidas');

// ─── 7) NUNCA candidata duas vezes na mesma vaga ─────────────────────────────────────────────────
// Mandar o mesmo currículo duas vezes para a mesma vaga queima o candidato com o recrutador.
cenario();
const unica = enfileirar();
await processarProxima();
assert.equal(chamadas.get(unica), 1);

// a) clique manual numa vaga já enviada é recusado antes de entrar na fila
assert.throws(() => candidatarAgora(unica), /já se candidatou/, 'o clique manual devia ser recusado');

// b) e se algo recolocar a vaga na fila por fora (estado antigo, bug futuro), a trava do núcleo segura
vagas.atualizar(unica, { status: 'na_fila', posicao: vagas.proximaPosicao() });
await processarProxima();
assert.equal(chamadas.get(unica), 1, 'a plataforma NÃO pode ser chamada de novo para uma vaga já enviada');
assert.equal(st(unica), 'enviada');
assert.equal(candidaturas.listar().filter(c => c.vagaId === unica).length, 1, 'uma única candidatura registrada');
console.log('✓ Vaga já enviada não é candidatada de novo (clique manual e fila)');

// ─── 7b) Ligar o robô enfileira as vagas JÁ encontradas ──────────────────────────────────────────
// Antes, só vaga recém-descoberta entrava na fila: ligar o robô com 178 encontradas não fazia nada.
cenario({ limiteDiario: 20 });
kv.set('robo', 'pausado');
const alta = enfileirar({ status: 'encontrada', posicao: undefined, score: 90 });
const media = enfileirar({ status: 'encontrada', posicao: undefined, score: 55 });
const baixa = enfileirar({ status: 'encontrada', posicao: undefined, score: 10 }); // abaixo do scoreMinimo (30)
const presencial = enfileirar({ status: 'encontrada', posicao: undefined, score: 80, modelo: 'presencial' });
kv.set('automacao', { ...ler.automacao(), regimes: ['remoto'] }); // só remoto
ligarRobo(true);
await new Promise(r => setTimeout(r, 80));
assert.equal(st(baixa), 'encontrada', 'abaixo do score mínimo não entra na fila');
assert.equal(st(presencial), 'encontrada', 'modelo fora do filtro de regime não entra na fila');
assert.ok(['enviada', 'na_fila', 'em_andamento'].includes(st(alta)), `a mais compatível devia entrar na fila, está ${st(alta)}`);
assert.ok(['enviada', 'na_fila', 'em_andamento'].includes(st(media)), 'a compatível também devia entrar');
console.log('✓ Ligar o robô enfileira as já encontradas (respeitando score mínimo e filtro de regime)');

// ─── 7c) A fila respeita o que ainda cabe no limite diário ───────────────────────────────────────
cenario({ limiteDiario: 3, intervaloSegundos: 60000 }); // intervalo alto: enfileira, mas envia só a primeira
kv.set('robo', 'pausado');
const dez = Array.from({ length: 10 }, (_, k) => enfileirar({ status: 'encontrada', posicao: undefined, score: 90 - k }));
ligarRobo(true);
await new Promise(r => setTimeout(r, 120));
const ocupadas = dez.filter(id => ['na_fila', 'em_andamento', 'enviada'].includes(st(id))).length;
assert.equal(ocupadas, 3, `deviam entrar 3 (limite diário), entraram ${ocupadas}`);
assert.equal(
  dez.slice(3).every(id => st(id) === 'encontrada'),
  true,
  'as demais ficam de fora até abrir espaço',
);
console.log('✓ Enfileira só o que cabe no limite diário, da mais compatível para a menos');

// ─── 7d) Modo manual não enfileira; robô pausado ENFILEIRA e não envia ──────────────────────────
// A segunda metade era o contrário até 05/10/2026 ("robô pausado não enfileira"), e era isso que impedia a
// fase de mapeamento: não havia como ver o plano antes de dar o start. Formar fila é planejar; o portão de
// envio continua em `motivoDeEspera`, dentro de `girarFila`.
cenario({ modo: 'manual' });
const emManual = enfileirar({ status: 'encontrada', posicao: undefined, score: 90 });
assert.equal(enfileirarCompativeis('teste'), 0, 'modo manual não enfileira sozinho: ali quem escolhe é você');
assert.equal(st(emManual), 'encontrada');

cenario();
kv.set('robo', 'pausado');
const pausadas = [90, 85, 80].map(score => enfileirar({ status: 'encontrada', posicao: undefined, score }));
assert.equal(enfileirarCompativeis('teste'), 3, 'com o robô pausado a fila SE FORMA — é a fase de mapeamento');
for (const id of pausadas) assert.equal(st(id), 'na_fila');
await processarProxima();
assert.equal(enviadas(), 0, 'e nada sai enquanto o robô está pausado');
assert.equal(chamadas.size, 0, 'o adapter não pode nem ser chamado');
// `kv.set` e não `ligarRobo`: ligarRobo dispara `processarProxima()` SEM await, e o `await` daqui entraria
// num `girarFila` já em voo — a guarda `rodando` devolveria na hora e o teste mediria a corrida, não a regra
kv.set('robo', 'ativo');
await processarProxima();
assert.ok(enviadas() > 0, 'o start é que libera o envio da fila que você já revisou');
console.log('✓ Modo manual não enfileira; com o robô pausado a fila se forma e nada é enviado até o start');

// ─── 7e) Vaga já enviada nunca volta para a fila ─────────────────────────────────────────────────
cenario({ intervaloSegundos: 60000 });
const jaFoi = enfileirar();
await processarProxima();
assert.equal(st(jaFoi), 'enviada');
vagas.atualizar(jaFoi, { status: 'encontrada', posicao: undefined }); // estado antigo/bug futuro
assert.equal(enfileirarCompativeis('teste'), 0, 'vaga já enviada não pode voltar para a fila');
console.log('✓ Vaga já enviada não é reenfileirada');

// ─── 7g) Publicação repetida da mesma vaga (empresa + título) entra UMA vez só ───────────────────
// Caso real (21/09/2026): a Radix apareceu 2x com "Profissional Desenvolvedor de Software Pleno" e a BIX 2x
// com o mesmo banco de talentos — ids diferentes no InHire, mesma vaga para o recrutador.
cenario({ limiteDiario: 20, intervaloSegundos: 60000 });
kv.set('robo', 'pausado');
const radixA = enfileirar({ status: 'encontrada', posicao: undefined, score: 90, empresa: 'Radix', titulo: 'Profissional Desenvolvedor de Software Pleno' });
const radixB = enfileirar({ status: 'encontrada', posicao: undefined, score: 86, empresa: 'Radix', titulo: 'Profissional Desenvolvedor de Software Pleno' });
const outra = enfileirar({ status: 'encontrada', posicao: undefined, score: 88, empresa: 'Radix', titulo: 'Profissional Desenvolvedor FullStack Pleno' });
ligarRobo(true);
await new Promise(r => setTimeout(r, 120));
const naFilaRadix = [radixA, radixB].filter(id => ['na_fila', 'em_andamento', 'enviada'].includes(st(id)));
assert.equal(naFilaRadix.length, 1, `só uma das duas publicações pode entrar, entraram ${naFilaRadix.length}`);
assert.equal(naFilaRadix[0], radixA, 'a que entra é a mais compatível');
assert.ok(['na_fila', 'em_andamento', 'enviada'].includes(st(outra)), 'título diferente na mesma empresa continua entrando');
console.log('✓ Publicação repetida da mesma vaga entra uma vez só (a mais compatível)');

// Depois de enviada, a publicação irmã não pode ser candidatada por nenhum caminho
cenario({ intervaloSegundos: 60000 });
const primeira = enfileirar({ empresa: 'BIX', titulo: 'Banco de Talentos - Desenvolvedor(a) Back End' });
const irma = enfileirar({ status: 'encontrada', posicao: undefined, empresa: 'BIX', titulo: 'Banco de talentos - desenvolvedor(a) back end' });
await processarProxima();
assert.equal(st(primeira), 'enviada');
// A irmã sai da lista NA HORA do envio. Antes ela ficava em 'encontrada' para sempre: a fila nunca a pega
// (`jaCandidatado` barra) e ela seguia na tela como se ainda fosse acontecer alguma coisa.
assert.equal(st(irma), 'encerrada', 'enviou = a publicação irmã é descartada na hora');
assert.throws(() => candidatarAgora(irma), /outra publica/, 'clique manual na publicação irmã tem de ser recusado');
vagas.atualizar(irma, { status: 'na_fila', posicao: vagas.proximaPosicao() }); // forçado por fora
await processarProxima(true); // o intervalo alto seguraria a fila; aqui o que se testa e a trava
assert.equal(chamadas.get(irma), undefined, 'a plataforma NÃO pode ser aberta para a publicação irmã');
assert.equal(st(irma), 'encerrada');
assert.equal(enviadas(), 1, 'uma candidatura só para a mesma vaga');
console.log('✓ Publicação irmã de uma vaga já enviada nunca recebe currículo');

// Limpeza de fila montada antes da regra
cenario({ limiteDiario: 20 });
const d1 = enfileirar({ empresa: 'Acme', titulo: 'Dev Pleno', score: 70 });
const d2 = enfileirar({ empresa: 'Acme', titulo: 'Dev Pleno', score: 90 });
const d3 = enfileirar({ empresa: 'Acme', titulo: 'Dev Sênior', score: 80 });
assert.equal(limparDuplicatasDaFila(), 1, 'deve tirar exatamente a repetida de menor score');
assert.equal(st(d2), 'na_fila', 'a de maior score fica');
assert.equal(st(d1), 'encontrada', 'a repetida volta a ser candidata');
assert.equal(st(d3), 'na_fila', 'título diferente não é mexido');
console.log('✓ Fila montada antes da regra é limpa, mantendo a mais compatível');

// ─── 7f) Modo Sem Piedade: a IA responde a pergunta e a vaga segue sozinha ───────────────────────
// A IA de verdade é substituída por uma chave falsa + `completar` mockado? Não: aqui o que se verifica é o
// fluxo da fila. Sem IA configurada, o modo tem de se comportar como o manual — pausar em vez de fingir.
cenario({ modoPerguntas: 'sem_piedade' });
const semIA = enfileirar();
roteiro.set(semIA, t => (t === 1 ? { status: 'pergunta', pergunta: { rotulo: 'Qual seu nível de inglês?', tipo: 'texto', obrigatoria: true } } : { status: 'enviada' }));
await processarProxima();
assert.equal(st(semIA), 'aguardando_pergunta', 'sem IA configurada, Sem Piedade não pode inventar: pausa como o modo manual');
console.log('✓ Sem Piedade sem IA configurada pausa em vez de fingir');

// Autodeclaração nunca vai para a IA, mesmo em Sem Piedade
cenario({ modoPerguntas: 'sem_piedade' });
const sensivel = enfileirar();
roteiro.set(sensivel, t =>
  t === 1
    ? { status: 'pergunta', pergunta: { rotulo: 'Qual é a sua identidade de gênero?', tipo: 'opcoes', opcoes: ['Homem Cisgênero', 'Mulher Cisgênero'], obrigatoria: true } }
    : { status: 'enviada' },
);
await processarProxima();
assert.equal(st(sensivel), 'aguardando_pergunta', 'autodeclaração jamais é respondida pela IA');
assert.equal(chamadas.get(sensivel), 1, 'não pode reabrir a vaga tentando responder sozinha');
// O que se garante acima é que a IA não INVENTA característica dele — não que ela não possa RECUSAR a
// declarar. A diferença é o que os três cenários seguintes fixam.
console.log('✓ Autodeclaração continua fora do alcance da IA no modo Sem Piedade');

// ─── 7h) Sem Piedade: autodeclaração com "prefiro não declarar" é marcada e a fila não para ──────
// Antes isto pausava mesmo tendo saída na própria vaga: `decidirSensivel` exigia a pergunta ser opcional.
// Marcar a recusa satisfaz o formulário e não afirma nada sobre a pessoa — e quem escolheu isso foi ela, ao
// ligar o Sem Piedade. Note que a resposta vem de `dados.responder`, dentro do formulário: a IA não entra.
const COM_RECUSA = ['Homem Cisgênero', 'Mulher Cisgênero', 'Prefiro não declarar'];
const perguntaGenero = (opcoes: string[], obrigatoria: boolean): PerguntaExtra => ({ rotulo: 'Qual é a sua identidade de gênero?', tipo: 'opcoes', opcoes, obrigatoria });
/** Imita uma plataforma de verdade: pergunta ao núcleo e só pausa se ele não souber. */
const roteiroQuePergunta = (pergunta: PerguntaExtra) => (_t: number, dados: DadosCandidatura) => {
  const r = dados.responder(pergunta);
  return r !== null ? ({ status: 'enviada' } as const) : ({ status: 'pergunta', pergunta } as const);
};

cenario({ modoPerguntas: 'sem_piedade' });
const comSaida = enfileirar();
roteiro.set(comSaida, roteiroQuePergunta(perguntaGenero(COM_RECUSA, true)));
await processarProxima();
assert.equal(st(comSaida), 'enviada', 'obrigatória COM opção de recusa: o Sem Piedade marca a recusa e segue');
assert.ok(!ler.perguntas().some(p => /identidade de g[êe]nero/i.test(p.pergunta)), 'e a recusa NÃO vira resposta salva: autodeclaração nunca é reaproveitada por outro caminho');

// 7i) Sem a opção de recusa, pausa — e a mensagem diz por que nem o Sem Piedade responde
cenario({ modoPerguntas: 'sem_piedade' });
const semSaida = enfileirar();
roteiro.set(semSaida, roteiroQuePergunta(perguntaGenero(['Homem Cisgênero', 'Mulher Cisgênero'], true)));
await processarProxima();
assert.equal(st(semSaida), 'aguardando_pergunta', 'sem opção de recusa não existe resposta segura');
assert.ok(
  log.listar(50).some(l => /n[ãa]o oferece "prefiro n[ãa]o declarar"/i.test(l.msg)),
  'e o log explica o motivo, em vez de a pessoa achar que o modo está quebrado',
);

// 7j) Nos outros modos a regra não vale: a vaga espera por ela, como sempre
for (const modo of ['manual', 'duvida'] as const) {
  cenario({ modoPerguntas: modo });
  const noutroModo = enfileirar();
  roteiro.set(noutroModo, roteiroQuePergunta(perguntaGenero(COM_RECUSA, true)));
  await processarProxima();
  assert.equal(st(noutroModo), 'aguardando_pergunta', `em "${modo}" a autodeclaração continua voltando para você`);
}

// 7k) E a resposta que ELA já deu ganha da recusa, em qualquer modo
cenario({ modoPerguntas: 'sem_piedade' });
kv.set('perguntas', [{ id: 1, icone: '', pergunta: 'Qual é a sua identidade de gênero?', resposta: 'Mulher Cisgênero', personalizada: true }]);
const comRespostaDela = enfileirar();
let escolhida: string | null = null;
roteiro.set(comRespostaDela, (_t, dados) => {
  escolhida = dados.responder(perguntaGenero(COM_RECUSA, true));
  return { status: 'enviada' };
});
await processarProxima();
assert.equal(escolhida, 'Mulher Cisgênero', 'o que ela respondeu ganha da recusa automática');
console.log('✓ Sem Piedade: a única autodeclaração que ele responde é a RECUSA a declarar, e só quando a vaga oferece');

// ─── 8) Ensaio não cria candidatura enviada ──────────────────────────────────────────────────────
cenario({ ensaio: true });
const emEnsaio = enfileirar();
roteiro.set(emEnsaio, { status: 'ensaio', captura: '', pronto: true });
await processarProxima();
assert.equal(st(emEnsaio), 'ensaio');
assert.equal(enviadas(), 0, 'ensaio NUNCA pode contar como enviada');
console.log('✓ Ensaio preenche e não envia');

// ─── 9) Falta currículo ou perfil: erro claro, sem repetir ───────────────────────────────────────
cenario();
kv.set('curriculos', []);
const semCv = enfileirar();
await processarProxima();
assert.equal(st(semCv), 'erro');
assert.equal(chamadas.get(semCv), undefined, 'nem deve abrir a plataforma sem currículo');
console.log('✓ Sem currículo: erro claro e nenhuma chamada à plataforma');

// ─── 10) Filtro de portal: envio desligado numa plataforma tira as vagas dela da fila ────────────
cenario();
kv.set('conexoes', { teste: { conectadaEm: new Date().toISOString(), enviar: false } });
const semEnvio = enfileirar({ status: 'encontrada', posicao: undefined });
assert.equal(enfileirarCompativeis('teste'), 0, 'plataforma com envio desligado não põe vaga na fila');
assert.equal(st(semEnvio), 'encontrada', 'a vaga continua na lista, só não entra na fila');
// Desligar o envio não é desconectar: um clique seu em "Candidatar" continua valendo.
// `candidatarAgora` é síncrono e dispara o trabalhador em segundo plano: espere ele terminar, senão o
// `rodando` dele ainda estaria de pé e engoliria o `processarProxima` do cenário seguinte.
candidatarAgora(semEnvio);
await new Promise(r => setTimeout(r, 150));
assert.equal(st(semEnvio), 'enviada', 'o filtro é do robô, não seu: o envio manual continua funcionando');

cenario();
kv.set('conexoes', { teste: { conectadaEm: new Date().toISOString(), enviar: true } });
const comEnvio = enfileirar({ status: 'encontrada', posicao: undefined });
assert.equal(enfileirarCompativeis('teste'), 1);
assert.equal(st(comEnvio), 'na_fila');

// Conexão antiga, gravada antes deste campo existir, continua enviando
cenario();
kv.set('conexoes', { teste: { conectadaEm: new Date().toISOString() } });
const semCampo = enfileirar({ status: 'encontrada', posicao: undefined });
assert.equal(enfileirarCompativeis('teste'), 1, 'conexão sem o campo `enviar` continua enviando');
assert.equal(st(semCampo), 'na_fila');
console.log('✓ Filtro por portal: envio desligado tira da fila, mantém na lista e não bloqueia o envio manual');

// ─── 11) Vaga ensaiada volta para a fila quando o ensaio é desligado ─────────────────────────────
// Caso real (23/09/2026): ensaio já desligado, modo automático, e 13 vagas presas em `ensaio` — entre elas as
// 8 de maior compatibilidade da lista. A fila só aceitava `encontrada` e nada jamais tirava a vaga de `ensaio`.
cenario({ ensaio: true });
const ensaiada = enfileirar();
roteiro.set(ensaiada, { status: 'ensaio', captura: '', pronto: true });
await processarProxima();
assert.equal(st(ensaiada), 'ensaio');
assert.equal(enviadas(), 0);

// com o ensaio ainda ligado ela NÃO volta: seria ensaiar a mesma vaga para sempre
assert.equal(enfileirarCompativeis('ensaio ligado'), 0, 'com ensaio ligado a vaga ensaiada não pode voltar à fila');
assert.equal(st(ensaiada), 'ensaio');

// desligou o ensaio = "agora manda": ela volta e é enviada de verdade
kv.set('automacao', { ...ler.automacao(), ensaio: false });
roteiro.set(ensaiada, { status: 'enviada' });
assert.equal(enfileirarCompativeis('ensaio desligado'), 1, 'com ensaio desligado a vaga ensaiada tem de voltar à fila');
assert.equal(st(ensaiada), 'na_fila');
await processarProxima(true);
assert.equal(st(ensaiada), 'enviada');
assert.equal(enviadas(), 1, 'o ensaio não contava como envio; agora existe uma candidatura de verdade');

// e depois de enviada de verdade, continua valendo a trava de duplicidade
assert.throws(() => candidatarAgora(ensaiada), /já se candidatou/);
console.log('✓ Vaga ensaiada volta à fila ao desligar o ensaio (e nunca com ele ligado)');

// ─── Regressões que já aconteceram de verdade ────────────────────────────────────────────────────
// Estes quatro cenários se perderam numa mesclagem (03/10/2026). O código dos consertos continuou no lugar,
// mas teste removido é bug que volta em silêncio — e dois destes o usuário sentiu na pele, com currículo
// enviado para vaga que ele tinha acabado de excluir.

// Bug real (28/09/2026): InHire desmarcado em Automação e o robô mandou currículo para três vagas do InHire —
// elas já estavam `na_fila` de antes, e o foco só era checado na ENTRADA da fila. Agora vale no ponto de uso.
cenario();
kv.set('conexoes', { teste: { conectadaEm: new Date().toISOString(), enviar: true } });
const jaNaFila = enfileirar();
assert.equal(st(jaNaFila), 'na_fila');
kv.set('conexoes', { teste: { conectadaEm: new Date().toISOString(), enviar: false } }); // desmarcou DEPOIS
await processarProxima();
assert.equal(chamadas.get(jaNaFila), undefined, 'vaga de plataforma fora do foco não pode ser enviada');
assert.equal(st(jaNaFila), 'encontrada', 'e tem de sair da fila, não ficar presa nela');
// Marcar de novo devolve a vaga à fila pelo caminho normal
kv.set('conexoes', { teste: { conectadaEm: new Date().toISOString(), enviar: true } });
assert.equal(enfileirarCompativeis('voltou ao foco'), 1);
assert.equal(st(jaNaFila), 'na_fila');
console.log('✓ Fora do foco: vaga que já estava na fila sai dela e não é enviada');

// ─── 12) Varredura agendada vale para QUALQUER plataforma conectada ──────────────────────────────
// Era um `else if` por plataforma; adapter novo que esquecesse de entrar na cadeia ficava sem varredura
// agendada (aconteceu com Quickin, Workable e Arbeitnow, que só varriam de carona com o InHire).
const { plataformaVencida, algumaPlataformaVencida } = await import('./queue.ts');
cenario();
kv.set('conexoes', { teste: { conectadaEm: new Date().toISOString() } });
assert.ok(plataformaVencida('teste', 6), 'plataforma que nunca varreu está vencida');
assert.ok(algumaPlataformaVencida(6), 'com uma conectada e nunca varrida, a varredura tem de rolar');
kv.set('teste:ultimaBusca', new Date().toISOString());
assert.ok(!plataformaVencida('teste', 6), 'acabou de varrer: não vence de novo agora');
assert.ok(!algumaPlataformaVencida(6));
kv.set('teste:ultimaBusca', new Date(Date.now() - 7 * 3600_000).toISOString());
assert.ok(algumaPlataformaVencida(6), 'passadas as horas do intervalo, vence de novo');
// InHire e Indeed têm agenda própria e não entram por aqui
kv.set('conexoes', { inhire: { conectadaEm: new Date().toISOString() }, indeed: { conectadaEm: new Date().toISOString() } });
assert.ok(!algumaPlataformaVencida(6), 'InHire e Indeed têm agenda própria; não podem disparar por esta regra');
console.log('✓ Varredura agendada: regra única, serve para qualquer adapter novo');

// ─── 13) Progresso da varredura: a barra do botão "Procurar vagas" ───────────────────────────────
// Só o InHire dava sinal de vida, e numa tela diferente do botão. As outras seis varriam em silêncio.
const { lerVarredura, iniciarVarredura, plataformaAtual, passo, vistas, terminarPlataforma, terminarVarredura } = await import('./varredura.ts');
cenario();
assert.equal(lerVarredura().rodando, false, 'parada por padrão');

iniciarVarredura(['inhire', 'vagaspj', 'teste']);
let prog = lerVarredura();
assert.equal(prog.rodando, true);
assert.deepEqual(prog.restantes, ['inhire', 'vagaspj', 'teste'], 'a fila inteira aparece desde o início: a tela mostra o tamanho do trabalho');
assert.deepEqual(prog.feitas, []);

plataformaAtual('inhire');
prog = lerVarredura();
assert.equal(prog.plataforma, 'inhire');
assert.deepEqual(prog.restantes, ['vagaspj', 'teste'], 'quem está sendo varrida sai da fila de espera');

passo('abrindo as vagas novas', 3, 40);
prog = lerVarredura();
assert.deepEqual([prog.etapa, prog.atual, prog.total], ['abrindo as vagas novas', 3, 40]);
passo('lendo o feed');
assert.equal(lerVarredura().total, 0, 'total 0 = tamanho desconhecido; a barra não finge uma porcentagem');

// `conhecidas` é o número que responde "clicar de novo vai repetir vaga?"
vistas(50);
terminarPlataforma('inhire', 8);
prog = lerVarredura();
assert.deepEqual(prog.feitas, ['inhire']);
assert.equal(prog.novas, 8);
assert.equal(prog.conhecidas, 42, '50 examinadas menos 8 inéditas = 42 que o robô já tinha');

// A contagem de examinadas não vaza de uma plataforma para a outra
plataformaAtual('vagaspj');
terminarPlataforma('vagaspj', 2);
prog = lerVarredura();
assert.equal(prog.conhecidas, 42, 'sem `vistas`, a plataforma seguinte não inventa conhecidas');
assert.equal(prog.novas, 10, 'as novas somam entre plataformas');

terminarVarredura();
prog = lerVarredura();
assert.equal(prog.rodando, false);
assert.deepEqual(prog.feitas, ['inhire', 'vagaspj'], 'o resumo continua legível depois de terminar');
assert.equal(prog.novas, 10);
console.log('✓ Progresso da varredura: fila, etapa, e o contador de já-conhecidas');

// ─── Filtro de agora, não o de quando a vaga entrou na fila ──────────────────────────────────────
// Bug real (28/09/2026): "sap" entrou na lista de nichos a evitar e, minutos depois, saiu uma candidatura
// para "Pessoa Desenvolvedora SAP ABAP Pleno" — a vaga já estava na fila com a nota antiga.
cenario();
kv.set('conexoes', { teste: { conectadaEm: new Date().toISOString(), enviar: true } });
const comSap = enfileirar({ titulo: 'Pessoa Desenvolvedora SAP ABAP Pleno' });
assert.equal(st(comSap), 'na_fila');
kv.set('automacao', { ...ler.automacao(), excluir: ['sap'] }); // o nicho entra DEPOIS
await processarProxima();
assert.equal(chamadas.get(comSap), undefined, 'vaga de nicho recusado não pode ser enviada');
assert.equal(st(comSap), 'ignorada', 'e sai da fila');

// A mesma rede pega a nota que caiu abaixo do mínimo
cenario();
kv.set('conexoes', { teste: { conectadaEm: new Date().toISOString(), enviar: true } });
const notaBaixa = enfileirar({ score: 55 });
kv.set('automacao', { ...ler.automacao(), scoreMinimo: 80 });
await processarProxima();
assert.equal(chamadas.get(notaBaixa), undefined, 'vaga abaixo do mínimo de agora não é enviada');
assert.equal(st(notaBaixa), 'ignorada');

// Mas o que VOCÊ pediu vai, mesmo fora dos filtros: o filtro é do robô, não seu
cenario();
kv.set('conexoes', { teste: { conectadaEm: new Date().toISOString(), enviar: true } });
const pedida = enfileirar({ titulo: 'Desenvolvedor SAP ABAP', status: 'encontrada', posicao: undefined });
kv.set('automacao', { ...ler.automacao(), excluir: ['sap'] });
candidatarAgora(pedida);
await new Promise(r => setTimeout(r, 150));
assert.equal(st(pedida), 'enviada', 'clique seu passa por cima dos filtros do robô');
console.log('✓ Filtros valem na hora do envio: nicho e nota novos tiram da fila, e o seu clique passa');

// Ligar o robô fora da janela tem de DIZER isso na hora: sem o aviso, a pessoa liga, pausa e liga de novo
// achando que o robô quebrou (aconteceu em 24/09/2026, às 23h, com a janela em 08:00-20:00). Fica por último
// porque `ligarRobo` dispara um envio que não dá para esperar daqui, e ele vazaria para o cenário seguinte.
cenario({ janela: '03:00-03:01' });
enfileirar();
ligarRobo(true);
assert.ok(
  log.listar().some(l => /janela de envio é 03:00-03:01/.test(l.msg)),
  'ligar fora da janela precisa avisar na hora',
);
console.log('✓ Ligar o robô fora da janela avisa na hora, em vez de ficar parado em silêncio');

// ─── 12) A fila como PLANO: alvo, reposição ao excluir, e a excluída que não volta ───────────────
// O pedido: "ele vai mapear e colocar na fila, eu vejo e posso excluir, se eu excluir ele já tem que correr
// atrás de outra para substituir, tem que encher a fila até o número máximo de vaga".

// 11a) O alvo manda no tamanho da fila — antes quem mandava era o limite diário, e não havia como dizer
// "me mostre 3 e mantenha 3"
cenario({ filaAlvo: 3, limiteDiario: 20 });
kv.set('robo', 'pausado');
const dezNoAlvo = [95, 92, 90, 88, 86, 84, 82, 80, 78, 76].map(score => enfileirar({ status: 'encontrada', posicao: undefined, score }));
assert.equal(enfileirarCompativeis('teste'), 3, 'entra exatamente o alvo');
assert.deepEqual(
  dezNoAlvo.filter(id => st(id) === 'na_fila'),
  dezNoAlvo.slice(0, 3),
  'e são as três mais compatíveis',
);
assert.equal(dezNoAlvo.filter(id => st(id) === 'encontrada').length, 7, 'o resto fica de reserva, não some');

// 11b) Quando o limite diário aperta mais que o alvo, é ele que manda: é o que protege você
cenario({ filaAlvo: 10, limiteDiario: 2 });
kv.set('robo', 'pausado');
const cincoDoLimite = [95, 92, 90, 88, 86].map(score => enfileirar({ status: 'encontrada', posicao: undefined, score }));
assert.equal(enfileirarCompativeis('teste'), 2, 'o menor dos dois limites vence');
assert.equal(cincoDoLimite.filter(id => st(id) === 'na_fila').length, 2);

// 11c) Excluir repõe na hora, e a reposta nunca é a que você tirou
cenario({ filaAlvo: 2, limiteDiario: 20 });
kv.set('robo', 'pausado');
const quatroDoAlvo = [95, 92, 90, 88].map(score => enfileirar({ status: 'encontrada', posicao: undefined, score }));
enfileirarCompativeis('teste');
const naFilaAgora = () => quatroDoAlvo.filter(id => st(id) === 'na_fila');
assert.deepEqual(naFilaAgora(), quatroDoAlvo.slice(0, 2), 'a fila nasce com as duas melhores');
removerDaFila(quatroDoAlvo[0]);
assert.equal(naFilaAgora().length, 2, 'a fila volta ao alvo na mesma chamada: excluir não deixa buraco');
assert.ok(!naFilaAgora().includes(quatroDoAlvo[0]), 'e a reposta NÃO é a que você acabou de tirar');
assert.equal(vagas.get(quatroDoAlvo[0])!.recusadaPorVoce, true);

// 11d) A excluída não volta nem depois de `repontuar()`.
// Este é o teste que mata a ideia de marcar a excluída com `status: 'ignorada'`: `repontuar` reescreve o
// status de TODA vaga `encontrada`/`ignorada` em função da nota, e apagaria a decisão dele dias depois, numa
// troca de filtro, sem ninguém ligar uma coisa à outra.
assert.equal(enfileirarCompativeis('de novo'), 0, 'a fila já está no alvo');
removerDaFila(quatroDoAlvo[1]);
assert.ok(!naFilaAgora().includes(quatroDoAlvo[1]));
repontuar();
assert.equal(vagas.get(quatroDoAlvo[0])!.recusadaPorVoce, true, 'a sua decisão sobrevive à repontuação');
assert.ok(!naFilaAgora().includes(quatroDoAlvo[0]), 'e ela continua fora da fila');
assert.equal(enfileirarCompativeis('depois de repontuar'), 0, 'nem uma repontuação a traz de volta');

// 11e) Mas o seu clique passa por cima do filtro do robô
// A asserção é sobre a DECISÃO, não sobre o envio: `ligarRobo` de um cenário anterior dispara
// `processarProxima()` sem await, e a guarda `rodando` pode engolir este pedido — quem prova o envio em si é
// o cenário 10. Aqui o que importa é que o clique desfaz a recusa.
await candidatarAgora(quatroDoAlvo[0]);
assert.equal(vagas.get(quatroDoAlvo[0])!.recusadaPorVoce, undefined, 'o seu clique apaga a marca: o filtro é do robô, não seu');
assert.notEqual(st(quatroDoAlvo[0]), 'encontrada', 'e a vaga volta a valer — na fila ou já enviada, conforme o portão');

// 11f) Desfazer devolve a vaga ao jogo — clique errado não pode ser definitivo
cenario({ filaAlvo: 1, limiteDiario: 20 });
kv.set('robo', 'pausado');
const duasDoDesfazer = [95, 90].map(score => enfileirar({ status: 'encontrada', posicao: undefined, score }));
enfileirarCompativeis('teste');
removerDaFila(duasDoDesfazer[0]);
assert.equal(st(duasDoDesfazer[1]), 'na_fila', 'a segunda entrou no lugar da primeira');
removerDaFila(duasDoDesfazer[1]);
assert.equal(duasDoDesfazer.filter(id => st(id) === 'na_fila').length, 0, 'tirou as duas: não há o que repor, e a fila fica vazia');
devolverAFila(duasDoDesfazer[0]);
assert.equal(st(duasDoDesfazer[0]), 'na_fila', 'devolver traz a vaga de volta para a fila');
assert.equal(vagas.get(duasDoDesfazer[0])!.recusadaPorVoce, undefined);

// 11g) Candidatura em voo não se cancela pela fila (invariante 4: o currículo pode já estar no servidor)
cenario();
const emVooNaFila = enfileirar({ status: 'em_andamento' });
assert.throws(() => removerDaFila(emVooNaFila), /sendo enviada/, 'a trava mora na rota, não só na tela que desabilita o botão');
assert.equal(st(emVooNaFila), 'em_andamento');

// 11h) Fila cheia não vira ruído: o laço chama isto a cada 20 segundos
cenario({ filaAlvo: 1, limiteDiario: 20 });
kv.set('robo', 'pausado');
enfileirar({ status: 'encontrada', posicao: undefined, score: 95 });
enfileirar({ status: 'encontrada', posicao: undefined, score: 90 });
enfileirarCompativeis('1');
const linhasNoAlvo = () => log.listar(200).filter(l => /j[áa] est[áa] no alvo/.test(l.msg)).length;
assert.equal(linhasNoAlvo(), 0, 'a primeira chamada ENCHE a fila: ela loga o que entrou, não "fila cheia"');
for (const rodada of ['2', '3', '4']) enfileirarCompativeis(rodada);
assert.equal(linhasNoAlvo(), 1, 'e nas três chamadas seguintes a linha de fila cheia sai UMA vez, não três — o laço roda a cada 20 s');
console.log('✓ Fila como plano: o alvo manda, excluir repõe na hora, e a excluída não volta nem após repontuar');

// ─── 13) Plataforma SÓ DESCOBERTA: nenhum caminho leva ao envio ──────────────────────────────────
// O Jobbol proíbe candidatura automatizada nos termos de uso (cláusula 5.3), então o ACV só acha e ranqueia
// lá. Este projeto já pagou três vezes por filtro conferido num ponto do ciclo de vida e não no ponto de uso
// (foco de plataforma, nicho a evitar, nota mínima — todos no agentlog). Então cada porta tem a sua trava, e
// este cenário tenta abrir TODAS, inclusive as que só um bug futuro abriria.
let chamadasSoAcha = 0;
registrarAdapter({
  id: 'soacha',
  nome: 'Só Acha',
  somenteDescoberta: true,
  motivoSomenteDescoberta: 'os termos de uso do Só Acha proíbem candidatura automatizada: a inscrição é feita por você, no site',
  buscarVagas: async () => [],
  // Tem `candidatar` DE PROPÓSITO: é justamente este contador que precisa ficar em zero. Se a trava
  // dependesse de o método não existir, o teste provaria menos do que precisa provar.
  candidatar: async () => {
    chamadasSoAcha++;
    return { status: 'enviada' };
  },
});

cenario();
kv.set('conexoes', { teste: { conectadaEm: new Date().toISOString() }, soacha: { conectadaEm: new Date().toISOString() } });
const soAcha = enfileirar({ plataforma: 'soacha', status: 'encontrada', posicao: undefined, score: 99 });

// 13a) A fila automática não pega — nem sendo a vaga de maior nota da lista
assert.equal(enfileirarCompativeis('teste'), 0, 'plataforma só-descoberta não entra na fila');
assert.equal(st(soAcha), 'encontrada');

// 13b) O clique manual é recusado ANTES de gravar qualquer coisa
assert.throws(() => candidatarAgora(soAcha), /proíbem candidatura automatizada/, 'e o motivo que aparece é o real, não um erro genérico');
assert.equal(st(soAcha), 'encontrada', 'a recusa acontece antes do `vagas.atualizar`');

// 13c) Forçada para dentro da fila por fora (estado antigo no banco, caminho novo que alguém acrescentou):
// a tranca do ponto de uso, em `executarCandidatura`, é a que vale
// `executarCandidatura` direto, e não pelo trabalhador: a guarda `rodando` de um `processarProxima` solto de
// outro cenário engoliria o pedido, e o teste mediria a corrida em vez da tranca.
vagas.atualizar(soAcha, { status: 'na_fila', posicao: vagas.proximaPosicao() });
await executarCandidatura(soAcha);
assert.equal(chamadasSoAcha, 0, 'o adapter de uma plataforma só-descoberta NUNCA pode ser chamado');
assert.equal(enviadas(), 0);
assert.equal(st(soAcha), 'encontrada', 'e a vaga volta a ser útil: é só abrir e enviar à mão');

// 13d) O pior caminho: `pedidaPorVoce` fura o `filtroAindaVale`, então a tranca precisa ser independente dele
vagas.atualizar(soAcha, { status: 'na_fila', pedidaPorVoce: true, posicao: vagas.proximaPosicao() });
await executarCandidatura(soAcha);
assert.equal(chamadasSoAcha, 0, 'nem com pedidaPorVoce, que fura todos os outros filtros');
assert.equal(enviadas(), 0);

// 13e) E o motivo é dito em voz alta, para o bug gritar em vez de sumir
assert.ok(
  log.listar(50).some(l => /proíbem candidatura automatizada/.test(l.msg)),
  'chegar ao ponto de uso é bug: o log tem de contar',
);
console.log('✓ Plataforma só-descoberta: fila, clique manual e ponto de uso — nenhum caminho envia currículo');

// ─── 14) Achados da auditoria do codex (05/10/2026) ──────────────────────────────────────────────

// 14a) O seu clique durante uma candidatura libera A SUA vaga, não a da frente da fila.
// `pedidoForcado` era um booleano: a exceção dos portões ia para quem `proximaNaFila()` escolhesse — a da
// FRENTE — então uma vaga automática passava por cima da janela de horário, do intervalo e do limite diário,
// e a vaga clicada (que entra no fim) continuava esperando. Agora o pedido carrega o id.
cenario({ janela: '03:00-03:01' }); // portão FECHADO: fora da janela, nada automático pode sair
const aDaFrente = enfileirar({ score: 95 });
const aQuePedi = enfileirar({ status: 'encontrada', posicao: undefined, score: 10 });
await processarProxima();
assert.equal(st(aDaFrente), 'na_fila', 'fora da janela, a fila não anda');
await candidatarAgora(aQuePedi);
await new Promise(r => setTimeout(r, 120)); // deixa o trabalhador assentar: `ligarRobo` de outro cenário dispara `processarProxima` sem await
assert.equal(st(aQuePedi), 'enviada', 'o seu pedido fura o portão');
assert.equal(st(aDaFrente), 'na_fila', 'e a vaga automática da frente NÃO herda a sua exceção');
assert.equal(enviadas(), 1, 'exatamente uma saiu: a que você pediu');

// 14b) Mudar os regimes aceitos tira da fila a vaga que não serve mais.
// `modeloAceito` era conferido só na entrada da fila; no ponto de uso, `filtroAindaVale` olhava apenas nicho e
// nota. É a quinta vez que este projeto encontra o mesmo padrão (filtro no ciclo de vida, não no ponto de uso).
cenario({ regimes: ['remoto', 'presencialNaFila'] });
const presencialNaFila = enfileirar({ modelo: 'presencial', score: 90 });
kv.set('automacao', { ...ler.automacao(), regimes: ['remoto'] }); // "agora só aceito remoto"
await processarProxima();
assert.equal(enviadas(), 0, 'vaga presencial não pode mais ser enviada depois de você só aceitar remoto');
assert.equal(st(presencialNaFila), 'ignorada');
assert.ok(
  log.listar(50).some(l => /n[ãa]o aceita mais vaga presencial/.test(l.msg)),
  'e o log diz o motivo, em vez de a vaga sumir em silêncio',
);

// 14c) Mas o seu clique continua passando por cima disso também: o filtro é do robô, não seu
cenario({ regimes: ['remoto'] });
const presencialQuePedi = enfileirar({ modelo: 'presencial', status: 'encontrada', posicao: undefined, score: 90 });
await candidatarAgora(presencialQuePedi);
await new Promise(r => setTimeout(r, 120));
assert.equal(st(presencialQuePedi), 'enviada', 'se VOCÊ pede uma presencial, vai');
console.log('✓ Auditoria: o seu pedido libera a SUA vaga (não a da frente), e o regime é reconferido no envio');

// ─── 15) Regime "qualquer modalidade": não escolhe e não pausa ───────────────────────────────────
// A vaga que aceita CLT e PJ tinha três saídas: prefiro CLT, prefiro PJ, ou pausar para perguntar. Faltava a
// quarta, que é a mais comum na prática — tanto faz, marque o que o formulário oferecer e siga.
// `decidirRegime` devolve `null` nesse caso, e `null` é o que o motor de formulário já entende como "sem
// preferência": ele marca a primeira opção da vaga (papel `regime` em `formulario.ts`).

// 15a) "perguntar" pausa a vaga, e a fila continua com as outras
cenario({ regimePreferido: 'perguntar' });
const pausaNoRegime = enfileirar({ regime: 'ambos' });
const seguinte = enfileirar({ regime: 'CLT' });
await processarProxima();
assert.equal(st(pausaNoRegime), 'aguardando_pergunta', 'com "perguntar", a vaga que aceita os dois espera por você');
assert.equal(st(seguinte), 'enviada', 'e a fila não para por causa dela');

// 15b) "qualquer" não pausa: o regime vai como null e o formulário resolve
cenario({ regimePreferido: 'qualquer' });
const tantoFaz = enfileirar({ regime: 'ambos' });
let regimeRecebido: string | null | undefined = 'não chamou';
roteiro.set(tantoFaz, (_t, dados) => {
  regimeRecebido = dados.regime;
  return { status: 'enviada' };
});
await processarProxima();
assert.equal(st(tantoFaz), 'enviada', '"qualquer modalidade" não pode parar a fila');
assert.equal(regimeRecebido, null, 'e o adapter recebe null, que é "sem preferência" para o motor de formulário');

// 15c) Preferir um dos dois continua mandando a escolha para o adapter
cenario({ regimePreferido: 'PJ' });
const comPreferencia = enfileirar({ regime: 'ambos' });
let regimeDaPreferencia: string | null | undefined = 'não chamou';
roteiro.set(comPreferencia, (_t, dados) => {
  regimeDaPreferencia = dados.regime;
  return { status: 'enviada' };
});
await processarProxima();
assert.equal(regimeDaPreferencia, 'PJ', 'quem escolheu PJ continua mandando PJ');

// 15d) E o regime declarado NA VAGA ganha da preferência, em qualquer modo: a vaga é que manda
for (const pref of ['qualquer', 'perguntar', 'PJ'] as const) {
  cenario({ regimePreferido: pref });
  const declarada = enfileirar({ regime: 'CLT' });
  let recebido: string | null | undefined = 'não chamou';
  roteiro.set(declarada, (_t, dados) => {
    recebido = dados.regime;
    return { status: 'enviada' };
  });
  await processarProxima();
  assert.equal(recebido, 'CLT', `vaga que declara CLT manda CLT, mesmo com a preferência em "${pref}"`);
}
console.log('✓ Regime: "qualquer modalidade" não pausa e deixa o formulário escolher; a vaga declarada sempre ganha');

// ─── 16) Esvaziar a fila, e a pausa que impede o laço de desfazer isso em 20 s ───────────────────
cenario({ filaAlvo: 3, limiteDiario: 20 });
kv.set('robo', 'pausado');
const cinco = [95, 92, 90, 88, 86].map(score => enfileirar({ status: 'encontrada', posicao: undefined, score }));
assert.equal(enfileirarCompativeis('teste'), 3);

const removidas = esvaziarFila();
assert.equal(removidas, 3, 'tira todas da fila');
assert.equal(cinco.filter(id => st(id) === 'na_fila').length, 0, 'a fila fica vazia');
// E as vagas voltam a ser CANDIDATAS, não recusadas: é isso que faz esvaziar + mapear dar uma fila nova
for (const id of cinco) assert.equal(vagas.get(id)!.recusadaPorVoce, undefined, 'esvaziar não é recusar: elas voltam a concorrer');

// Sem a pausa, o laço de 20 s reencheria em segundos e o botão pareceria quebrado
assert.equal(enfileirarCompativeis('reposição da fila'), 0, 'a reposição automática fica pausada');
assert.equal(kv.get('fila:pausada', false), true);

// Mapear é ordem sua: libera. (`buscarVagas(true)` sem plataforma conectada não varre nada, mas a pausa sai.)
kv.set('conexoes', {});
await buscarVagas(true);
assert.equal(kv.get('fila:pausada', false), false, 'mandar mapear desfaz a pausa');
kv.set('conexoes', { teste: { conectadaEm: new Date().toISOString() } });
assert.equal(enfileirarCompativeis('depois de mapear'), 3, 'e a fila volta a montar, com os critérios de agora');

// Ligar o robô também libera: dar start é dizer "pode encher"
esvaziarFila();
assert.equal(kv.get('fila:pausada', false), true);
ligarRobo(true);
assert.equal(kv.get('fila:pausada', false), false, 'o start desfaz a pausa');

// Candidatura em voo não sai da fila por aqui (invariante 4: o currículo pode já estar no servidor)
cenario();
const voando = enfileirar({ status: 'em_andamento' });
const paradinha = enfileirar();
assert.equal(esvaziarFila(), 1, 'só a que não está sendo enviada sai');
assert.equal(st(voando), 'em_andamento', 'a candidatura em voo fica onde está');
assert.equal(st(paradinha), 'encontrada');
console.log('✓ Esvaziar a fila: devolve as vagas ao jogo, pausa a reposição, e mapear ou o start liberam de novo');

apagarTudo();
log.listar(0);
console.log('\nFila: tudo certo.');
