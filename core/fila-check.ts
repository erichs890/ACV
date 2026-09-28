// Verificação executável da FILA (o que faz o robô enviar um currículo atrás do outro sozinho):
//   node core/fila-check.ts   — ou `npm run check`, que roda este arquivo junto
//
// Não toca em plataforma nenhuma: usa um adapter falso e um banco temporário (AUTOCV_DIR), então cada cenário
// é determinístico e roda em segundos. O que é verificado aqui é exatamente o que quebrou na prática:
// encadeamento, portões de agendamento, pedido do usuário durante uma candidatura, nova tentativa e duplicidade.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.AUTOCV_DIR = mkdtempSync(join(tmpdir(), 'autocv-fila-'));

const { kv, vagas, candidaturas, log, apagarTudo } = await import('./storage/db.ts');
const { registrarAdapter } = await import('./platforms/adapter.ts');
const { processarProxima, candidatarAgora, responder, ligarRobo, enfileirarCompativeis, limparDuplicatasDaFila } = await import('./queue.ts');
const { AUTOMACAO_PADRAO, ler } = await import('./estado.ts');
import type { PerguntaExtra, Vaga } from '../src/types.ts';
import type { ResultadoCandidatura } from './platforms/adapter.ts';

// ─── Adapter falso: devolve o resultado combinado por vaga e conta as chamadas ───────────────────
type Roteiro = ResultadoCandidatura | ((tentativa: number) => ResultadoCandidatura);
const roteiro = new Map<string, Roteiro>();
const chamadas = new Map<string, number>();

registrarAdapter({
  id: 'teste',
  nome: 'Teste',
  buscarVagas: async () => [],
  candidatar: async vaga => {
    const n = (chamadas.get(vaga.id) ?? 0) + 1;
    chamadas.set(vaga.id, n);
    const r = roteiro.get(vaga.id) ?? { status: 'enviada' as const };
    return typeof r === 'function' ? r(n) : r;
  },
});

// ─── Cenário base ────────────────────────────────────────────────────────────────────────────────
const curriculo = join(process.env.AUTOCV_DIR, 'cv.pdf');
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

// ─── 7d) Modo manual e robô pausado não enfileiram nada ──────────────────────────────────────────
cenario({ modo: 'manual' });
const emManual = enfileirar({ status: 'encontrada', posicao: undefined, score: 90 });
assert.equal(enfileirarCompativeis('teste'), 0, 'modo manual não enfileira sozinho');
assert.equal(st(emManual), 'encontrada');
cenario();
kv.set('robo', 'pausado');
const comRoboParado = enfileirar({ status: 'encontrada', posicao: undefined, score: 90 });
assert.equal(enfileirarCompativeis('teste'), 0, 'robô pausado não enfileira');
assert.equal(st(comRoboParado), 'encontrada');
console.log('✓ Modo manual e robô pausado não enfileiram nada');

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
console.log('✓ Autodeclaração continua fora do alcance da IA no modo Sem Piedade');

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

apagarTudo();
log.listar(0);
console.log('\nFila: tudo certo.');
