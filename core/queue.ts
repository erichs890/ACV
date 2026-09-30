import type { Vaga } from '../src/types.ts';
import { adapters, PERGUNTA_CIDADE, PERGUNTA_CPF } from './platforms/adapter.ts';
import { candidaturas, kv, log, vagas } from './storage/db.ts';
import { ler } from './estado.ts';
import { emitir } from './events.ts';
import { chaveDaVaga, executarCandidatura, jaCandidatado, jaEnviada, PERGUNTA_LINKEDIN, PERGUNTA_PRETENSAO, PERGUNTA_REGIME } from './candidatura.ts';
import { avaliarVagas, iaAtiva, lerIA, responderPergunta } from './ia.ts';
import { descobrirEmpresas, lerDescoberta } from './platforms/inhire/discovery.ts';
import { empresas } from './storage/db.ts';
import { calcularScore } from './resume/score.ts';
import { vagaCompativelComLocalizacao } from './localizacao.ts';
import { indeedVencido } from './platforms/indeed/busca.ts';
import { vagaspjVencido } from './platforms/vagaspj/busca.ts';
import { divulgaVencido } from './platforms/divulgavagas/busca.ts';
import { inferirSenioridade } from './resume/analyzer.ts';
import { esperaDaTentativa, falhaRepetivel, MAX_TENTATIVAS } from './falhas.ts';
import { fecharNavegador } from './browser.ts';
import { sessaoValida } from './sessao.ts';
import { DADO_PESSOAL, categoriaSensivel } from '../src/sensiveis.ts';
import { dentroDaJanela, perguntaSoDestaVaga, textoIntervalo } from '../src/dados.ts';

const registrar = log.registrar;
let ocupado = false; // uma candidatura por vez, sempre

function enviosHoje() {
  const hoje = new Date().toDateString();
  return candidaturas.listar().filter(c => c.resultado === 'enviada' && new Date(c.enviadaEm).toDateString() === hoje).length;
}

/** Recalcula o score léxico das vagas abertas com o perfil e os filtros atuais (área, cargo, senioridade). */
export function repontuar(): number {
  const cfg = ler.automacao();
  const perfil = ler.curriculos()[0]?.perfilBusca;
  if (!perfil) return 0;
  const filtros = {
    area: cfg.area,
    cargo: ler.perfil()?.cargo ?? '', // o cargo desejado mora no perfil: um campo, um dono
    senioridade: cfg.senioridade,
    localizacao: ler.localizacao(), // cidade e países aceitos: regra compartilhada com o Indeed
    cargoRigido: cfg.cargoRigido,
  };
  const abertas = vagas.listar().filter(v => v.status === 'encontrada' || v.status === 'ignorada');
  for (const v of abertas) {
    const a = calcularScore(v, perfil, filtros);
    vagas.atualizar(v.id, { score: a.score, motivo: a.motivo, senioridade: v.senioridade ?? inferirSenioridade(v.titulo, v.descricao), status: a.score < cfg.scoreMinimo ? 'ignorada' : 'encontrada' });
  }

  // Fila, ensaio e erro também precisam da nota nova: uma vaga enfileirada com o score antigo continuaria
  // sendo candidatada depois de o critério mudar, e uma já processada exibiria uma compatibilidade que não
  // existe mais. Status preservado; só sai da fila quem ficou abaixo do mínimo.
  const REPONTUAR_TAMBEM: Vaga['status'][] = [...NA_FILA, 'ensaio', 'erro'];
  let removidas = 0;
  for (const v of vagas.listar().filter(x => REPONTUAR_TAMBEM.includes(x.status))) {
    const a = calcularScore(v, perfil, filtros);
    if (a.score < cfg.scoreMinimo && v.status === 'na_fila') {
      vagas.atualizar(v.id, { score: a.score, motivo: a.motivo, status: 'ignorada', posicao: undefined, pendencia: undefined });
      removidas++;
    } else {
      vagas.atualizar(v.id, { score: a.score, motivo: a.motivo });
    }
  }
  if (removidas) registrar('alerta', `${removidas} vaga(s) saíram da fila por ficarem abaixo de ${cfg.scoreMinimo}% com o critério atual.`);
  if (abertas.length) {
    registrar(
      'info',
      `${abertas.length} vaga(s) repontuadas com senioridade ${cfg.senioridade || perfil.senioridade}${cfg.area ? `, área ${cfg.area}` : ''}${ler.perfil()?.cargo ? `, cargo "${ler.perfil()?.cargo}"` : ''}.`,
    );
    emitir({ tipo: 'estado' });
  }
  return abertas.length;
}

/**
 * Manda a IA reavaliar as vagas JÁ gravadas, das mais compatíveis (pelo score léxico) para baixo.
 *
 * O score léxico é um filtro grosseiro: ele conta palavras, não entende a função. Quem separa
 * "Analista de Processos" de "Engenheiro de Software" com confiança é o modelo lendo o currículo e a vaga.
 * Até aqui a IA só pontuava vaga recém-descoberta, e uma falha de cota na varredura deixava tudo no léxico
 * para sempre, sem como refazer. `limite` existe porque avaliar milhares de vagas queima qualquer cota.
 */
export async function repontuarComIA(limite = 50): Promise<number> {
  const principal = ler.curriculos()[0];
  if (!principal?.markdown) throw new Error('envie um currículo em PDF antes de avaliar por IA');
  if (!iaAtiva()) throw new Error('configure o provedor e a chave em Configurações › Inteligência Artificial');

  const cfg = ler.automacao();
  const alvo = vagas
    .listar()
    .filter(v => v.status === 'encontrada' || v.status === 'ignorada')
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limite));
  if (!alvo.length) return 0;

  const nome = lerIA().provedor === 'gemini' ? 'Gemini' : 'Claude';
  registrar('info', `${nome} vai reavaliar ${alvo.length} vaga(s) contra o seu currículo. Isso leva alguns minutos.`);
  const notas = await avaliarVagas(principal.markdown, alvo, cfg.senioridade || principal.perfilBusca?.senioridade || '', {
    aoProgredir: (feitas, total) => {
      if (feitas % 30 === 0 || feitas === total) registrar('info', `${nome}: ${feitas} de ${total} vaga(s) avaliadas.`);
    },
    aoPausar: (motivo, avaliadas) => registrar('alerta', `A cota do ${nome} acabou depois de ${avaliadas} vaga(s) (${motivo.slice(0, 90)}). As demais ficam com o score por competências.`),
  });

  let subiram = 0;
  let cairam = 0;
  for (const v of alvo) {
    const n = notas.get(v.id);
    if (!n) continue;
    if (n.score > v.score) subiram++;
    if (n.score < v.score) cairam++;
    vagas.atualizar(v.id, { score: n.score, motivo: `${nome}: ${n.motivo}`, status: n.score < cfg.scoreMinimo ? 'ignorada' : 'encontrada' });
  }
  registrar('sucesso', `${nome} reavaliou ${notas.size} vaga(s): ${subiram} subiram, ${cairam} caíram. A fila passa a usar essas notas.`);
  emitir({ tipo: 'estado' });
  enfileirarCompativeis('reavaliação por IA');
  return notas.size;
}

/**
 * Varredura completa: descoberta (lista de empresas → vagas novas gravadas com score léxico),
 * depois IA re-pontua as novas (se configurada) e, em modo automático com robô ligado, as compatíveis entram na fila.
 */
export async function buscarVagas(manual = false): Promise<number> {
  const cfg = ler.automacao();
  const principal = ler.curriculos()[0];
  if (!principal?.perfilBusca) {
    registrar('alerta', 'Varredura cancelada: envie um currículo para o AutoCV montar o perfil de busca.');
    return 0;
  }
  let novas: Vaga[] = [];
  for (const id of Object.keys(ler.conexoes())) {
    const adapter = adapters[id];
    if (adapter) novas = novas.concat(await adapter.buscarVagas(principal.perfilBusca, cfg, registrar, { manual }));
  }

  // Com IA configurada, ela lê o currículo e pontua cada vaga nova (o léxico já gravado fica de reserva)
  if (novas.length && iaAtiva() && principal.markdown) {
    try {
      const notas = await avaliarVagas(principal.markdown, novas, cfg.senioridade || principal.perfilBusca.senioridade);
      for (const v of novas) {
        const n = notas.get(v.id);
        if (n) {
          // A localização é regra, não opinião: a IA não devolve à lista uma vaga em outro estado/país
          const lugar = vagaCompativelComLocalizacao(v, ler.localizacao());
          if (!lugar.compativel) continue;
          v.score = n.score;
          v.motivo = [n.motivo, lugar.motivo].filter(Boolean).join(' · ');
          vagas.atualizar(v.id, { score: n.score, motivo: v.motivo, status: n.score < cfg.scoreMinimo ? 'ignorada' : 'encontrada' });
        }
      }
      registrar('info', `${lerIA().provedor === 'gemini' ? 'Gemini' : 'Claude'} avaliou ${notas.size} de ${novas.length} vaga(s) nova(s) contra o seu currículo.`);
    } catch (e) {
      registrar('alerta', `Avaliação por IA falhou (${(e as Error).message}); valendo o score por competências.`);
    }
  }

  enfileirarCompativeis('varredura');
  kv.set('ultimaBusca', new Date().toISOString());
  emitir({ tipo: 'estado' });
  return novas.length;
}

// Status que já ocupam uma vaga de trabalho do robô (não podem ser enfileirados de novo nem contar duas vezes)
const NA_FILA: Vaga['status'][] = ['na_fila', 'em_andamento', 'aguardando_pergunta', 'aguardando_aprovacao'];

/** A vaga cabe no filtro de modelo de trabalho do usuário? Modelo indefinido passa (o robô descobre na página). */
const modeloAceito = (v: Vaga, cfg: ReturnType<typeof ler.automacao>) => v.modelo === 'indefinido' || cfg.regimes.includes(v.modelo);

/**
 * O robô pode enviar currículo pela plataforma desta vaga? (Plataformas › "Enviar currículo por aqui".)
 * Vale só para a fila automática: clicar em "Candidatar" numa vaga é um ato seu, e um filtro do robô não
 * manda em você. Conexão sem o campo = pode, para as conexões criadas antes disto continuarem funcionando.
 */
export const plataformaEnviaCurriculo = (v: Vaga) => ler.conexoes()[v.plataforma]?.enviar !== false && sessaoValida(v.plataforma);

/**
 * Vaga que a fila pode pegar.
 *
 * `ensaio` entra de novo quando o modo ensaio está DESLIGADO: ensaiar é preencher sem enviar, então desligar o
 * ensaio quer dizer "agora manda". Sem isto a vaga ensaiada ficava órfã para sempre — ela continuava na tela,
 * mas nenhum caminho automático a pegava, porque nada no núcleo jamais tira uma vaga do status `ensaio`.
 * (Caso real: 13 vagas presas, entre elas as 8 de maior compatibilidade da lista.)
 *
 * Com o ensaio LIGADO ela não volta, senão a mesma vaga seria ensaiada sem parar.
 */
const podeEntrarNaFila = (v: Vaga, cfg: ReturnType<typeof ler.automacao>) => v.status === 'encontrada' || (v.status === 'ensaio' && !cfg.ensaio);

/**
 * Põe na fila as vagas JÁ ENCONTRADAS que passam nos filtros atuais, da mais compatível para a menos.
 *
 * Antes, só vaga recém-descoberta entrava na fila: ligar o modo automático com 178 vagas encontradas não fazia
 * nada, porque a fila nascia vazia e só uma varredura futura a alimentaria. Agora "ligar o robô" significa algo.
 *
 * Enfileira no máximo o que ainda cabe no limite diário (descontando o que já foi enviado hoje e o que já está
 * na fila): a fila fica legível, o limite é respeitado na origem, e amanhã o restante entra sozinho.
 */
/**
 * Tira da fila as publicações repetidas da mesma vaga (empresa + título), deixando só a mais compatível.
 * Existe porque a fila já podia estar montada antes desta regra — e porque uma varredura nova pode trazer
 * a publicação irmã depois de a primeira já estar enfileirada.
 */
export function limparDuplicatasDaFila(): number {
  const naFila = vagas
    .listar()
    .filter(v => NA_FILA.includes(v.status))
    .sort((a, b) => b.score - a.score);
  const vistas = new Set<string>();
  let removidas = 0;
  for (const v of naFila) {
    const chave = chaveDaVaga(v);
    if (!vistas.has(chave)) {
      vistas.add(chave);
      continue;
    }
    vagas.atualizar(v.id, { status: 'encontrada', posicao: undefined, pendencia: undefined });
    removidas++;
  }
  if (removidas) registrar('alerta', `${removidas} publicação(ões) repetida(s) da mesma vaga saíram da fila — só a mais compatível de cada uma fica.`);
  return removidas;
}

export function enfileirarCompativeis(motivo: string): number {
  const cfg = ler.automacao();
  if (ler.robo() !== 'ativo' || cfg.modo !== 'automatico') return 0;

  limparDuplicatasDaFila();
  const todas = vagas.listar();
  const naFila = todas.filter(v => NA_FILA.includes(v.status));
  const restantes = cfg.limiteDiario - enviosHoje() - naFila.length;
  // Uma publicação por empresa+título: o InHire repete a mesma vaga com outro id, e três currículos iguais
  // chegando ao mesmo recrutador é pior do que não se candidatar
  const jaVistas = new Set(naFila.map(chaveDaVaga));
  const candidatas = todas
    .filter(v => podeEntrarNaFila(v, cfg) && v.score >= cfg.scoreMinimo && modeloAceito(v, cfg) && plataformaEnviaCurriculo(v) && !jaCandidatado(v))
    .sort((a, b) => b.score - a.score)
    .filter(v => {
      const chave = chaveDaVaga(v);
      if (jaVistas.has(chave)) return false; // fica de reserva: se a escolhida falhar, ela ainda está "encontrada"
      jaVistas.add(chave);
      return true;
    });

  if (!candidatas.length) {
    // "liguei o robô e a fila continua vazia": se o que barrou foi o filtro de plataformas, diga isso
    const barradas = todas.filter(v => podeEntrarNaFila(v, cfg) && v.score >= cfg.scoreMinimo && modeloAceito(v, cfg) && !jaCandidatado(v) && !plataformaEnviaCurriculo(v));
    if (barradas.length)
      registrar(
        'info',
        barradas.some(v => !sessaoValida(v.plataforma))
          ? `${barradas.length} vaga(s) compatível(is) ficaram de fora: a sessão da plataforma delas expirou (entre de novo em Plataformas).`
          : `${barradas.length} vaga(s) compatível(is) ficaram de fora: o envio está desligado para a plataforma delas (Plataformas).`,
      );
    // Ensaiadas esperando o ensaio ser desligado: é a explicação mais provável para "tenho vaga boa e a fila não anda"
    const ensaiadas = todas.filter(v => v.status === 'ensaio' && v.score >= cfg.scoreMinimo && !jaCandidatado(v));
    if (cfg.ensaio && ensaiadas.length) registrar('info', `${ensaiadas.length} vaga(s) já ensaiada(s) esperam o modo ensaio ser desligado para entrarem na fila de verdade.`);
    return 0;
  }
  if (restantes <= 0) {
    registrar('info', `${candidatas.length} vaga(s) compatível(is) aguardando: o limite de ${cfg.limiteDiario} por dia já está tomado (${enviosHoje()} enviada(s), ${naFila.length} na fila).`);
    return 0;
  }

  const escolhidas = candidatas.slice(0, restantes);
  const deEnsaio = escolhidas.filter(v => v.status === 'ensaio').length;
  for (const v of escolhidas) vagas.atualizar(v.id, { status: 'na_fila', posicao: vagas.proximaPosicao() });
  const sobra = candidatas.length - escolhidas.length;
  registrar(
    'info',
    `${escolhidas.length} vaga(s) compatível(is) entraram na fila (${motivo})${deEnsaio ? `, ${deEnsaio} dela(s) já ensaiada(s) e agora para envio de verdade` : ''}${sobra ? `; outras ${sobra} ficam para quando abrir espaço no limite diário` : ''}.`,
  );
  emitir({ tipo: 'estado' });
  return escolhidas.length;
}

/** Fonte B sob demanda ou agendada (1x/dia): acha empresas novas no InHire pela API de busca. */
export async function buscarEmpresas(): Promise<number> {
  const n = await descobrirEmpresas(ler.curriculos()[0]?.perfilBusca, registrar);
  emitir({ tipo: 'estado' });
  return n;
}

/** Modo manual: "Quero me candidatar" — entra na fila e roda em seguida. */
export function candidatarAgora(id: string) {
  const v = vagas.get(id);
  if (!v) throw new Error('vaga não encontrada');
  if (jaEnviada(id)) throw new Error('você já se candidatou a esta vaga');
  if (jaCandidatado(v)) throw new Error(`você já se candidatou a "${v.titulo}" em ${v.empresa} (outra publicação da mesma vaga)`);
  vagas.atualizar(id, { status: 'na_fila', posicao: vagas.proximaPosicao(), pendencia: undefined, erro: undefined, tentativas: undefined, proximaTentativaEm: undefined });
  registrar('info', `"${v.titulo}" entrou na fila.`);
  emitir({ tipo: 'estado' });
  void processarProxima(true);
}

export function removerDaFila(id: string) {
  vagas.atualizar(id, { status: 'encontrada', posicao: undefined, pendencia: undefined });
  emitir({ tipo: 'estado' });
}

/** Resposta do usuário a uma pergunta pendente; opcionalmente salva para perguntas parecidas. */
export function responder(id: string, resposta: string, salvar: boolean) {
  const v = vagas.get(id);
  if (v?.pendencia?.tipo !== 'pergunta') throw new Error('nada pendente nesta vaga');
  const rotulo = v.pendencia.pergunta.rotulo;
  const perfil = ler.perfil();
  if (rotulo === PERGUNTA_LINKEDIN && perfil) {
    kv.set('perfil', { ...perfil, linkedin: resposta });
    vagas.atualizar(id, { status: 'na_fila', pendencia: undefined, proximaTentativaEm: undefined });
  } else if (rotulo === PERGUNTA_PRETENSAO && perfil) {
    kv.set('perfil', { ...perfil, pretensao: resposta });
    vagas.atualizar(id, { status: 'na_fila', pendencia: undefined, proximaTentativaEm: undefined });
  } else if (rotulo === PERGUNTA_CIDADE && perfil) {
    kv.set('perfil', { ...perfil, cidade: resposta });
    vagas.atualizar(id, { status: 'na_fila', pendencia: undefined, proximaTentativaEm: undefined });
  } else if (rotulo === PERGUNTA_CPF && perfil) {
    kv.set('perfil', { ...perfil, cpf: resposta.replace(/\D/g, '') });
    vagas.atualizar(id, { status: 'na_fila', pendencia: undefined, proximaTentativaEm: undefined });
  } else if (rotulo.startsWith(PERGUNTA_REGIME)) {
    // Regime escolhido para esta vaga; se for para guardar, vira a preferência padrão
    if (salvar) kv.set('automacao', { ...ler.automacao(), regimePreferido: resposta as 'CLT' | 'PJ' });
    vagas.atualizar(id, { status: 'na_fila', pendencia: undefined, proximaTentativaEm: undefined, regime: resposta as 'CLT' | 'PJ' });
  } else {
    const perguntas = ler.perguntas();
    const existente = perguntas.find(p => p.pergunta === rotulo);
    if (existente) existente.resposta = resposta;
    else perguntas.push({ id: Date.now(), icone: '', pergunta: rotulo, resposta, personalizada: true });
    // Se não for para guardar, a resposta vale só para esta tentativa: removemos depois de usar
    kv.set('perguntas', perguntas);
    vagas.atualizar(id, { status: 'na_fila', pendencia: undefined, proximaTentativaEm: undefined, respostaTemporaria: salvar ? undefined : rotulo });
  }
  registrar('info', `Resposta registrada para "${rotulo}".`);
  emitir({ tipo: 'estado' });
  void processarProxima(true);
}

/** Decisão do preview: usar o adaptado, o original, ou desistir desta vaga. */
export function decidirPreview(id: string, decisao: 'adaptado' | 'original' | 'cancelar') {
  const v = vagas.get(id);
  if (v?.pendencia?.tipo !== 'aprovacao') throw new Error('nada para aprovar nesta vaga');
  if (decisao === 'cancelar') {
    vagas.atualizar(id, { status: 'encontrada', pendencia: undefined, posicao: undefined });
    registrar('alerta', `Candidatura a "${v.titulo}" cancelada por você.`);
  } else {
    vagas.atualizar(id, { status: 'na_fila', decisaoPreview: decisao, proximaTentativaEm: undefined, pendencia: decisao === 'adaptado' ? v.pendencia : undefined });
    registrar('info', `Você escolheu enviar o currículo ${decisao} para "${v.titulo}".`);
  }
  emitir({ tipo: 'estado' });
  void processarProxima(true);
}

/** Decide entre desistir (fica em `erro`) ou devolver à fila com espera crescente. */
function tratarFalha(vaga: Vaga, motivo: string) {
  const tentativas = (vaga.tentativas ?? 0) + 1;
  const repetivel = falhaRepetivel(motivo);
  if (!repetivel || tentativas > MAX_TENTATIVAS) {
    vagas.atualizar(vaga.id, { status: 'erro', erro: motivo, tentativas, proximaTentativaEm: undefined });
    if (repetivel) registrar('erro', `"${vaga.titulo}" falhou ${MAX_TENTATIVAS}x seguidas (${motivo}); desisti desta vaga.`);
    return;
  }
  const minutos = esperaDaTentativa(tentativas);
  vagas.atualizar(vaga.id, { status: 'na_fila', erro: motivo, tentativas, proximaTentativaEm: new Date(Date.now() + minutos * 60000).toISOString() });
  registrar('alerta', `"${vaga.titulo}": ${motivo}. Tentativa ${tentativas} de ${MAX_TENTATIVAS}; volto a tentar em ${minutos} min.`);
}

/** Por que a fila não anda agora — mensagem única, para o usuário não ficar no escuro. */
function motivoDeEspera(cfg: ReturnType<typeof ler.automacao>): string | null {
  if (ler.robo() !== 'ativo') return 'o robô está pausado';
  if (cfg.modo !== 'automatico') return 'o modo é manual (use "Quero me candidatar" em cada vaga)';
  if (!dentroDaJanela(cfg.janela)) return `estamos fora da janela de envio (${cfg.janela})`;
  if (enviosHoje() >= cfg.limiteDiario) return `o limite diário de ${cfg.limiteDiario} envio(s) foi atingido`;
  const prox = ler.proximoEnvioEm();
  if (prox && new Date(prox) > new Date()) return `o próximo envio está agendado para ${new Date(prox).toLocaleTimeString('pt-BR')} (intervalo de ${textoIntervalo(cfg.intervaloSegundos)})`;
  return null;
}

// Quantas perguntas a IA já respondeu nesta vaga (modo Sem Piedade). Teto por vaga: formulário que não para de
// perguntar é sinal de que algo fugiu do previsto, e reabrir a página sem fim não ajuda ninguém.
const respostasIA = new Map<string, number>();
const MAX_RESPOSTAS_IA = 8;

/**
 * Modo Sem Piedade: em vez de pausar numa pergunta nova, a IA responde e a vaga volta para a fila.
 *
 * Autodeclaração fica DE FORA por decisão de projeto: gênero, cor/raça, deficiência, religião e saúde nunca
 * são deduzidos do currículo, nem pela IA. Essas seguem a política de Configurações › Autodeclaração.
 * Resposta longa, com cheiro de IA, ou opção que não existe na vaga é recusada e a vaga pausa como antes.
 */
async function responderComIA(vaga: Vaga, cauteloso: boolean): Promise<boolean> {
  if (vaga.pendencia?.tipo !== 'pergunta') return false;
  const q = vaga.pendencia.pergunta;
  const sensivel = categoriaSensivel(q.rotulo);
  if (sensivel) {
    registrar('aguardo', `"${vaga.titulo}": ${sensivel.rotulo.toLowerCase()} é autodeclaração — a IA não responde isso. Defina em Configurações › Autodeclaração ou responda aqui.`);
    return false;
  }
  // Dado pessoal não é dúvida de currículo, é fato: a IA não chuta CPF, endereço nem pretensão. Nem chega nela.
  if (DADO_PESSOAL.test(q.rotulo)) {
    registrar('aguardo', `"${vaga.titulo}" pergunta um dado pessoal ("${q.rotulo.slice(0, 50)}") — isso é com você, a IA não adivinha.`);
    return false;
  }
  const usadas = respostasIA.get(vaga.id) ?? 0;
  if (usadas >= MAX_RESPOSTAS_IA) {
    registrar('alerta', `"${vaga.titulo}" já teve ${usadas} perguntas respondidas pela IA; parei para você conferir.`);
    return false;
  }
  const curriculo = ler.curriculos()[0]?.markdown;
  if (!curriculo || !iaAtiva()) return false;

  try {
    const resposta = await responderPergunta(curriculo, vaga, { rotulo: q.rotulo, tipo: q.tipo, opcoes: q.opcoes }, { cauteloso });
    if (!resposta) {
      registrar(
        'aguardo',
        cauteloso
          ? `"${q.rotulo.slice(0, 60)}": a IA não achou no seu currículo o que essa pergunta pede e preferiu não chutar. Ficou para você.`
          : `A IA não deu uma resposta confiável para "${q.rotulo.slice(0, 60)}"; ficou para você.`,
      );
      return false;
    }
    respostasIA.set(vaga.id, usadas + 1);
    // Pergunta sobre a própria empresa não vira resposta padrão: vale só para esta tentativa
    const soDaqui = perguntaSoDestaVaga(q.rotulo, vaga.empresa);
    const perguntas = ler.perguntas();
    const existente = perguntas.find(p => p.pergunta === q.rotulo);
    if (existente) existente.resposta = resposta;
    else perguntas.push({ id: Date.now(), icone: '', pergunta: q.rotulo, resposta, personalizada: true });
    kv.set('perguntas', perguntas);
    vagas.atualizar(vaga.id, { status: 'na_fila', pendencia: undefined, proximaTentativaEm: undefined, respostaTemporaria: soDaqui ? q.rotulo : undefined });
    registrar('info', `IA respondeu "${q.rotulo.slice(0, 55)}": ${resposta.slice(0, 70)}${soDaqui ? ' (só para esta vaga)' : ''}`);
    emitir({ tipo: 'estado' });
    return true;
  } catch (e) {
    registrar('alerta', `A IA falhou ao responder "${q.rotulo.slice(0, 50)}" (${(e as Error).message.slice(0, 70)}); a vaga ficou aguardando você.`);
    return false;
  }
}

const ESPERA_CURTA_MS = 45_000;

/**
 * Fecha o navegador quando a fila vai ficar parada por um tempo.
 *
 * Sem isto, a janela do robô (com "Mostrar navegador" ligado) fica aberta em `about:blank` durante todo o
 * intervalo entre uma candidatura e a próxima — parece travado, e ainda segura memória à toa. Espera curta
 * não vale a pena: reabrir o perfil custa alguns segundos.
 */
async function liberarNavegador() {
  const prox = ler.proximoEnvioEm();
  const faltam = prox ? new Date(prox).getTime() - Date.now() : Number.POSITIVE_INFINITY;
  if (faltam > ESPERA_CURTA_MS) await fecharNavegador();
}

let ultimaEspera = '';
let rodando = false; // trabalhador da fila ativo (cobre o intervalo entre duas candidaturas)
let pedidoForcado = false; // chegou um pedido manual enquanto o robô estava ocupado: roda assim que liberar

/** Processa UMA candidatura. Retorna true se pode continuar imediatamente para a próxima. */
async function processarUma(proxima: Vaga): Promise<boolean> {
  ocupado = true;
  try {
    await executarCandidatura(proxima.id);
    const depois = vagas.get(proxima.id);
    if (depois?.respostaTemporaria && depois.status !== 'aguardando_pergunta') {
      kv.set(
        'perguntas',
        ler.perguntas().filter(p => p.pergunta !== depois.respostaTemporaria),
      );
      vagas.atualizar(proxima.id, { respostaTemporaria: undefined });
    }
    if (depois?.status === 'erro' && depois.erro) tratarFalha(depois, depois.erro);
    // Enviada ou em ensaio: a contagem de tentativas desta vaga não interessa mais
    if (depois?.status === 'enviada' || depois?.status === 'ensaio') {
      vagas.atualizar(proxima.id, { tentativas: undefined, proximaTentativaEm: undefined, erro: undefined });
      respostasIA.delete(proxima.id);
    }
    // Sem Piedade: a pergunta nova não para a fila — a IA responde e a vaga volta para o início do fluxo
    const modoP = ler.automacao().modoPerguntas;
    if (depois?.status === 'aguardando_pergunta' && modoP !== 'manual') await responderComIA(depois, modoP === 'duvida');
    // Pendência (pergunta/aprovação) não bloqueia a fila: seguimos para a próxima vaga na mesma rodada
    return true;
  } catch (e) {
    tratarFalha(proxima, (e as Error).message);
    return true;
  } finally {
    ocupado = false;
    emitir({ tipo: 'estado' });
  }
}

/**
 * Trabalhador da fila: processa uma candidatura atrás da outra até acabar a fila ou um portão fechar
 * (intervalo entre envios, limite diário, janela, robô pausado). Uma de cada vez, sempre.
 *
 * `forcar` = pedido manual do usuário: roda a próxima da fila ignorando os portões de agendamento.
 */
export async function processarProxima(forcar = false) {
  // `ocupado` é a candidatura em si; `rodando` é o trabalhador — sem ele, o laço de 20 s entraria entre duas
  // candidaturas do mesmo trabalhador (quando `ocupado` já voltou a false) e abriria uma segunda fila em paralelo.
  if (rodando || ocupado) {
    // Não perde o pedido: quem está rodando agora reavalia a fila ao terminar
    if (forcar) pedidoForcado = true;
    return;
  }
  rodando = true;
  try {
    await girarFila(forcar);
  } finally {
    rodando = false;
  }
  // Um pedido manual que chegou durante a rodada: atende agora, sem esperar os 20 s
  if (pedidoForcado) await processarProxima(true);
}

async function girarFila(forcar: boolean) {
  for (let rodada = 0; rodada < 50; rodada++) {
    const cfg = ler.automacao();
    const forcarAgora = forcar || pedidoForcado;
    pedidoForcado = false;
    if (!forcarAgora) {
      const espera = motivoDeEspera(cfg);
      if (espera) {
        await liberarNavegador();
        // Só avisa quando há fila de verdade e o motivo mudou (senão vira ruído a cada 20 s)
        if (vagas.proximaNaFila() && espera !== ultimaEspera) {
          registrar('info', `Fila parada: ${espera}.`);
          ultimaEspera = espera;
        }
        return;
      }
      ultimaEspera = '';
    }
    const proxima = vagas.proximaNaFila();
    if (!proxima) {
      await liberarNavegador();
      return;
    }
    if (cfg.ensaio) registrar('alerta', `Modo ensaio LIGADO: "${proxima.titulo}" será preenchida mas NÃO enviada. Desligue o ensaio em Automação para candidatar de verdade.`);
    if (!(await processarUma(proxima))) return;
    forcar = false; // um pedido manual libera uma candidatura; as seguintes respeitam os portões
  }
}

let agendando = false;

/**
 * Laço do núcleo, a cada 20 s:
 *  - revarredura das empresas (Fonte A) a cada `intervaloHoras`, independente do robô estar ligado;
 *  - descoberta de empresas novas (Fonte B) 1x/dia, se ligada e com chave;
 *  - com o robô ligado, processa a próxima candidatura da fila.
 */
export function iniciarLaco() {
  setInterval(async () => {
    if (!agendando) {
      agendando = true;
      try {
        const conectado = !!ler.conexoes().inhire;
        let d = lerDescoberta();
        // Primeiro descobre empresas novas (1x/dia), depois varre — assim as recém-achadas já entram na varredura
        const fonteBVencida = conectado && d.fonteB && (!d.ultimaFonteB || Date.now() - new Date(d.ultimaFonteB).getTime() > 24 * 3600000);
        if (fonteBVencida) await buscarEmpresas().catch(e => registrar('alerta', `Descoberta de empresas falhou: ${(e as Error).message}`));
        d = lerDescoberta();
        const temEmpresas = empresas.listar().some(e => e.ativo);
        const vencida = !d.ultimaVarredura || Date.now() - new Date(d.ultimaVarredura).getTime() > d.intervaloHoras * 3600000;
        if (conectado && vencida && temEmpresas && ler.curriculos()[0]?.perfilBusca) {
          await buscarVagas().catch(e => registrar('erro', `Varredura agendada falhou: ${(e as Error).message}`));
        } else if (ler.conexoes().indeed && indeedVencido() && ler.curriculos()[0]?.perfilBusca) {
          // Só o Indeed conectado (ou o InHire em dia): a varredura diária dele não depende da do InHire
          await buscarVagas().catch(e => registrar('erro', `Varredura agendada falhou: ${(e as Error).message}`));
        } else if (ler.conexoes().vagaspj && vagaspjVencido(d.intervaloHoras) && ler.curriculos()[0]?.perfilBusca) {
          // Idem para o Vagas PJ: quem está conectado sozinho também precisa que a varredura role
          await buscarVagas().catch(e => registrar('erro', `Varredura agendada falhou: ${(e as Error).message}`));
        } else if (ler.conexoes().divulgavagas && divulgaVencido(d.intervaloHoras) && ler.curriculos()[0]?.perfilBusca) {
          await buscarVagas().catch(e => registrar('erro', `Varredura agendada falhou: ${(e as Error).message}`));
        }
      } finally {
        agendando = false;
      }
    }
    if (ler.robo() !== 'ativo') return;
    // Fila vazia: repõe com as compatíveis que ainda cabem no limite (é assim que o dia seguinte recomeça sozinho).
    // A checagem é barata — só a consulta da próxima da fila; o levantamento completo só roda quando ela não acha nada.
    if (!vagas.proximaNaFila()) enfileirarCompativeis('reposição da fila');
    await processarProxima();
  }, 20000);
}

export function ligarRobo(ligar: boolean) {
  kv.set('robo', ligar ? 'ativo' : 'pausado');
  if (!ligar) void fecharNavegador(); // pausou: a janela do robô não fica aberta à toa
  const cfg = ler.automacao();
  registrar(ligar ? 'sucesso' : 'alerta', ligar ? `Robô ligado em modo ${cfg.modo === 'automatico' ? 'automático' : 'manual'}.` : 'Robô pausado.');
  // Avisos que explicam "liguei o robô e nada acontece" antes de o usuário ficar esperando
  if (ligar && cfg.ensaio)
    registrar('alerta', 'Atenção: o modo ensaio está LIGADO. O robô preenche o formulário inteiro mas NÃO envia nada. Desligue o ensaio em Automação para candidatar de verdade.');
  if (ligar && cfg.modo !== 'automatico') registrar('info', 'Modo manual: a fila só anda quando você clica em "Quero me candidatar". Mude para automático em Automação para o robô andar sozinho.');
  // "Liguei o robô às 23h e não aconteceu nada": a janela fechada só aparecia num info no meio do log, e a pessoa
  // ligava e pausava sem entender. Quem liga o robô precisa ouvir isto na hora.
  if (ligar && cfg.modo === 'automatico' && !dentroDaJanela(cfg.janela))
    registrar(
      'alerta',
      `Atenção: são ${new Date().toTimeString().slice(0, 5)} e a janela de envio é ${cfg.janela}. O robô fica parado até as ${cfg.janela.split('-')[0]}. Para enviar agora, mude a janela em Automação.`,
    );
  emitir({ tipo: 'estado' });
  ultimaEspera = '';
  if (!ligar) return;
  enfileirarCompativeis('robô ligado'); // as vagas já encontradas entram agora, sem esperar a próxima varredura
  void processarProxima(); // e começa já, sem esperar os 20 s do laço
}

export const statusFila = (): Vaga[] => vagas.listar();
