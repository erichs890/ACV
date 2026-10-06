import type { Vaga } from '../src/types.ts';
import { evento } from './diario.ts';
import { adapters, PERGUNTA_CIDADE, PERGUNTA_CPF, soDescobre } from './platforms/adapter.ts';
import { candidaturas, kv, log, vagas } from './storage/db.ts';
import { filtrosDaAutomacao, ler } from './estado.ts';
import { emitir } from './events.ts';
import { iniciarVarredura, plataformaAtual, terminarPlataforma, terminarVarredura } from './varredura.ts';
import { chaveDaVaga, executarCandidatura, jaCandidatado, jaEnviada, PERGUNTA_LINKEDIN, PERGUNTA_PRETENSAO, PERGUNTA_REGIME } from './candidatura.ts';
import { avaliarVagas, iaAtiva, lerIA, responderPergunta } from './ia.ts';
import { descobrirEmpresas, lerDescoberta } from './platforms/inhire/discovery.ts';
import { empresas } from './storage/db.ts';
import { calcularScore, termoExcluido } from './resume/score.ts';
import { vagaCompativelComLocalizacao } from './localizacao.ts';
import { indeedVencido } from './platforms/indeed/busca.ts';
import { inferirSenioridade } from './resume/analyzer.ts';
import { esperaDaTentativa, falhaRepetivel, MAX_TENTATIVAS } from './falhas.ts';
import { fecharNavegador } from './browser.ts';
import { sessaoValida } from './sessao.ts';
import { DADO_PESSOAL, categoriaSensivel } from '../src/sensiveis.ts';
import { dentroDaJanela, motivoDeEspera, perguntaSoDestaVaga } from '../src/dados.ts';

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
  const filtros = filtrosDaAutomacao(cfg, ler.localizacao());
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
  // Mapear é uma ordem sua: desfaz a pausa que `esvaziarFila` deixou
  if (manual) retomarFila();
  const principal = ler.curriculos()[0];
  if (!principal?.perfilBusca) {
    registrar('alerta', 'Varredura cancelada: envie um currículo para o ACV montar o perfil de busca.');
    return 0;
  }
  const conectadas = Object.keys(ler.conexoes()).filter(id => adapters[id]);
  if (!conectadas.length) {
    registrar('alerta', 'Varredura cancelada: nenhuma plataforma conectada. Conecte uma em Plataformas.');
    return 0;
  }
  let novas: Vaga[] = [];
  iniciarVarredura(conectadas);
  try {
    for (const id of conectadas) {
      plataformaAtual(id);
      const antes = vagas.listar().length;
      try {
        const achadas = await adapters[id].buscarVagas(principal.perfilBusca, cfg, registrar, { manual });
        novas = novas.concat(achadas);
        terminarPlataforma(id, vagas.listar().length - antes);
      } catch (e) {
        registrar('erro', `${id}: a varredura falhou (${(e as Error).message.slice(0, 90)}).`);
        terminarPlataforma(id, 0);
      }
    }
  } finally {
    terminarVarredura();
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

/**
 * Um aviso explicativo só sai quando muda de verdade.
 *
 * O laço da fila roda a cada 20 s e reenfileira: a mesma linha ("60 vagas ficaram de fora") apareceu 13 vezes
 * em 5 minutos num caso real e empurrou para fora do log as linhas das candidaturas, que era o que importava.
 */
const avisosDados = new Map<string, number>();
const JANELA_AVISO_MS = 30 * 60_000;
function avisoNovo(chave: string): boolean {
  const agora = Date.now();
  if ((avisosDados.get(chave) ?? 0) > agora - JANELA_AVISO_MS) return false;
  avisosDados.set(chave, agora);
  return true;
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
export const plataformaEnviaCurriculo = (v: Vaga) => !soDescobre(v.plataforma) && plataformaNoFoco(v.plataforma) && sessaoValida(v.plataforma);

/**
 * A plataforma está no foco da automação? (Automação › quais plataformas entram na fila.)
 *
 * Separado de `plataformaEnviaCurriculo` de propósito: foco é escolha do usuário e vale na hora do envio;
 * sessão vencida é uma situação passageira, que segura a vaga na fila até o login, sem tirá-la de lá.
 */
export const plataformaNoFoco = (id: string) => ler.conexoes()[id]?.enviar !== false;

/**
 * Devolve para "encontrada" as vagas que estão na fila mas cuja plataforma saiu do foco.
 *
 * O filtro de foco só existia na ENTRADA da fila (`enfileirarCompativeis`). Quem já estava na fila continuava
 * sendo enviado: desmarcar o InHire com três vagas dele enfileiradas não impedia nada — o robô mandava as três
 * assim mesmo. Caso real do usuário. Filtro que vale num ponto do ciclo de vida e não no ponto de uso é mentira.
 *
 * Volta para "encontrada" (e não para um status novo): marcar a plataforma de novo devolve a vaga à fila pelo
 * caminho normal, sem nada especial para desfazer.
 */
/**
 * Candidatura que ficou em `em_andamento` sem ninguém tocando nela (o núcleo caiu ou foi fechado no meio).
 *
 * Caso real (28/09/2026): o Vagas PJ clicou em "Candidatar", dispensou o anúncio, e a vaga ficou `em_andamento`
 * para sempre — a fila seguiu adiante e ninguém mais olhou para ela.
 *
 * NÃO volta para a fila: o envio pode ter chegado ao servidor sem o robô ver a resposta, e reenviar seria o
 * segundo currículo na mesa do mesmo recrutador (invariante 4). Vira `erro` com a dúvida escrita, para você
 * decidir — o botão "Candidatar" continua ali se quiser tentar de novo.
 */
export function resgatarInterrompidas(): number {
  const presas = vagas.listar().filter(v => v.status === 'em_andamento');
  for (const v of presas) {
    vagas.atualizar(v.id, {
      status: 'erro',
      pedidaPorVoce: undefined,
      posicao: undefined,
      erro: 'o robô foi interrompido no meio desta candidatura — confira no site se ela entrou antes de tentar de novo',
    });
    registrar('alerta', `"${v.titulo}" ficou pela metade quando o robô parou. Não reenviei por conta própria: confira no site se a candidatura entrou.`);
  }
  if (presas.length) emitir({ tipo: 'estado' });
  return presas.length;
}

/**
 * A vaga que está na frente da fila ainda passa nos filtros de AGORA?
 *
 * Nota e nicho a evitar eram conferidos só na entrada da fila, como o foco das plataformas era. Resultado real
 * (28/09/2026): o usuário colocou "sap" na lista de nichos e, minutos depois, saiu uma candidatura para
 * "Pessoa Desenvolvedora SAP ABAP Pleno" — a vaga já estava na fila com a nota velha.
 *
 * `repontuar` tira essas vagas da fila quando o filtro muda; esta função é a rede embaixo: se algum caminho
 * futuro esquecer de repontuar, o envio não acontece do mesmo jeito. Vaga que VOCÊ pediu passa sempre.
 */
function filtroAindaVale(v: Vaga, cfg: ReturnType<typeof ler.automacao>): string {
  if (v.pedidaPorVoce) return '';
  const excluido = termoExcluido(v.titulo, cfg.excluir);
  if (excluido) return `"${excluido}" está na sua lista de nichos a evitar`;
  if (v.score < cfg.scoreMinimo) return `a compatibilidade dela (${v.score}%) ficou abaixo do seu mínimo (${cfg.scoreMinimo}%)`;
  // O modelo de trabalho era conferido SÓ na entrada da fila: passar a aceitar apenas remoto não tirava a
  // vaga presencial que já estava enfileirada, e ela saía. É a quinta vez que este projeto encontra o mesmo
  // padrão (filtro no ciclo de vida em vez do ponto de uso). Achado pela auditoria do codex em 05/10/2026.
  if (!modeloAceito(v, cfg)) return `você não aceita mais vaga ${v.modelo} (Automação › regimes)`;
  return '';
}

export function limparForaDoFoco(): number {
  const fora = vagas.listar().filter(v => NA_FILA.includes(v.status) && !v.pedidaPorVoce && !plataformaNoFoco(v.plataforma));
  for (const v of fora) vagas.atualizar(v.id, { status: 'encontrada', pedidaPorVoce: undefined, posicao: undefined, pendencia: undefined });
  if (fora.length) {
    const nomes = [...new Set(fora.map(v => v.plataforma))].join(', ');
    registrar('alerta', `${fora.length} vaga(s) saíram da fila: ${nomes} está fora do foco da automação. Elas voltam se você marcar a plataforma de novo.`);
    emitir({ tipo: 'estado' });
  }
  return fora.length;
}

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
const podeEntrarNaFila = (v: Vaga, cfg: ReturnType<typeof ler.automacao>) => !v.recusadaPorVoce && (v.status === 'encontrada' || (v.status === 'ensaio' && !cfg.ensaio));

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
  /**
   * A fila se forma com o robô PAUSADO. Isto é de propósito, e é o que a torna um plano.
   *
   * Antes esta linha também exigia `ler.robo() === 'ativo'`, então a fila só existia depois do start: não
   * havia como mapear, olhar o que vai sair e só então mandar. Agora o mapeamento enche a fila até `filaAlvo`,
   * você revisa, e o start só libera o envio.
   *
   * E isto NÃO afrouxa invariante nenhuma: o portão de envio nunca morou aqui. Ele está em `motivoDeEspera`,
   * conferido em `girarFila` a cada rodada — `robo !== 'ativo'` continua sendo a primeira linha de lá. Formar
   * fila é planejar; enviar é outra coisa, e quem decide é o ponto de uso.
   *
   * O modo manual continua de fora: ali quem escolhe cada vaga é você, e uma fila se formando sozinha seria
   * uma lista que nunca anda.
   */
  if (cfg.modo !== 'automatico') return 0;
  // Você esvaziou a fila de propósito: nada entra até mandar mapear ou ligar o robô
  if (kv.get<boolean>('fila:pausada', false)) return 0;

  limparDuplicatasDaFila();
  const todas = vagas.listar();
  const naFila = todas.filter(v => NA_FILA.includes(v.status));
  /**
   * Quantas ainda entram agora: o MENOR entre o que você pediu para ver e o que cabe hoje.
   *
   * São duas perguntas diferentes, com donos diferentes — `filaAlvo` é quantas você quer na tela para revisar,
   * `limiteDiario` é quantos currículos podem sair hoje. E o menor sempre vence, que é o limite diário, porque
   * é ele que protege você: uma fila com 10 itens dos quais 3 não poderiam sair seria a tela prometendo o que o
   * núcleo não faz. Quando é o limite que aperta, o log diz isso em voz alta, em vez de a fila parecer quebrada.
   */
  const faltamNoAlvo = cfg.filaAlvo - naFila.length;
  const cabemHoje = cfg.limiteDiario - enviosHoje() - naFila.length;
  const restantes = Math.min(faltamNoAlvo, cabemHoje);
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
    if (barradas.length && avisoNovo(`barradas:${barradas.length}`))
      registrar(
        'info',
        barradas.some(v => !sessaoValida(v.plataforma))
          ? `${barradas.length} vaga(s) compatível(is) ficaram de fora: a sessão da plataforma delas expirou (entre de novo em Plataformas).`
          : `${barradas.length} vaga(s) compatível(is) ficaram de fora: o envio está desligado para a plataforma delas (Plataformas).`,
      );
    // Ensaiadas esperando o ensaio ser desligado: é a explicação mais provável para "tenho vaga boa e a fila não anda"
    const ensaiadas = todas.filter(v => v.status === 'ensaio' && v.score >= cfg.scoreMinimo && !jaCandidatado(v));
    if (cfg.ensaio && ensaiadas.length && avisoNovo(`ensaiadas:${ensaiadas.length}`))
      registrar('info', `${ensaiadas.length} vaga(s) já ensaiada(s) esperam o modo ensaio ser desligado para entrarem na fila de verdade.`);
    return 0;
  }
  if (restantes <= 0) {
    // Com o laço rodando a cada 20 s, esta linha sairia três vezes por minuto para sempre: `avisoNovo` é o que
    // impede a fila cheia de afogar no log as linhas das candidaturas, que é o que importa ali
    if (avisoNovo(`fila-cheia:${naFila.length}:${cabemHoje}`))
      registrar(
        'info',
        cabemHoje <= 0
          ? `A fila tem ${naFila.length} vaga(s) e para hoje já deu: ${enviosHoje()} enviada(s) de um limite de ${cfg.limiteDiario}. Ela completa sozinha amanhã.`
          : `A fila já está no alvo de ${cfg.filaAlvo} vaga(s); outras ${candidatas.length} compatível(is) esperam uma sair.`,
      );
    return 0;
  }

  const escolhidas = candidatas.slice(0, restantes);
  const deEnsaio = escolhidas.filter(v => v.status === 'ensaio').length;
  for (const v of escolhidas) vagas.atualizar(v.id, { status: 'na_fila', posicao: vagas.proximaPosicao() });
  const sobra = candidatas.length - escolhidas.length;
  registrar(
    'info',
    `${escolhidas.length} vaga(s) entraram na fila, que agora tem ${naFila.length + escolhidas.length} de ${cfg.filaAlvo} (${motivo})${deEnsaio ? `, ${deEnsaio} dela(s) já ensaiada(s) e agora para envio de verdade` : ''}${sobra ? `; outras ${sobra} ficam para quando abrir espaço na fila` : ''}.`,
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
export function candidatarAgora(id: string): Promise<void> {
  const v = vagas.get(id);
  if (!v) throw new Error('vaga não encontrada');
  // Este caminho grava `na_fila` DIRETO, sem passar por `enfileirarCompativeis` — foi por aqui que o bug do
  // foco de plataforma escapou em setembro. Plataforma só-descoberta recusa antes de gravar qualquer coisa.
  if (soDescobre(v.plataforma)) throw new Error(adapters[v.plataforma]?.motivoSomenteDescoberta ?? `o ACV só acha vagas do ${v.plataforma}; a candidatura é feita por você, no site`);
  if (jaEnviada(id)) throw new Error('você já se candidatou a esta vaga');
  if (jaCandidatado(v)) throw new Error(`você já se candidatou a "${v.titulo}" em ${v.empresa} (outra publicação da mesma vaga)`);
  // `recusadaPorVoce: undefined` porque o filtro é do robô, não seu: se você clicou, você quer esta vaga —
  // mesmo que a tenha tirado da fila cinco minutos antes
  vagas.atualizar(id, {
    status: 'na_fila',
    pedidaPorVoce: true,
    recusadaPorVoce: undefined,
    posicao: vagas.proximaPosicao(),
    pendencia: undefined,
    erro: undefined,
    tentativas: undefined,
    proximaTentativaEm: undefined,
  });
  registrar('info', `"${v.titulo}" entrou na fila.`);
  emitir({ tipo: 'estado' });
  // Devolve a promessa: quem clicou na extensão espera o desfecho; a tela do ACV continua ignorando.
  // O id vai junto: é ele que faz a exceção dos portões valer para ESTA vaga e não para a da frente da fila.
  return processarProxima(true, id);
}

/**
 * "Esta não" — você tira a vaga da fila e o robô repõe com outra, na mesma chamada.
 *
 * Duas coisas que não são óbvias:
 *
 * 1. A marca `recusadaPorVoce` é obrigatória, senão excluir vira um laço. `podeEntrarNaFila` aceita
 *    `encontrada`, e a vaga que você acabou de recusar costuma ser justamente a candidata mais compatível que
 *    sobrou — a reposição a traria de volta no mesmo segundo.
 * 2. Candidatura em voo não se cancela por aqui (invariante 4): o currículo pode já estar no servidor sem o
 *    robô ter visto a resposta. A tela desabilita o X nesse estado, mas a rota é alcançável, e trava que só
 *    existe na tela não é trava.
 */
export function removerDaFila(id: string) {
  const v = vagas.get(id);
  if (!v) throw new Error('vaga não encontrada');
  if (v.status === 'em_andamento') throw new Error('esta vaga já está sendo enviada; não dá para tirar da fila agora');
  vagas.atualizar(id, { status: 'encontrada', recusadaPorVoce: true, pedidaPorVoce: undefined, posicao: undefined, pendencia: undefined });
  registrar('info', `"${v.titulo}" saiu da fila por sua decisão e não volta sozinha.`);
  if (!enfileirarCompativeis('você tirou uma vaga da fila')) registrar('info', 'Não achei outra compatível para repor agora; a fila completa na próxima varredura.');
  emitir({ tipo: 'estado' });
}

/**
 * "Apaga essa fila, quero montar de novo."
 *
 * Tira todas da fila e **não** marca `recusadaPorVoce`: elas voltam a ser candidatas, e é isso que faz a dupla
 * esvaziar + mapear dar uma fila nova ordenada pelos critérios de agora. O que seria errado aqui:
 *
 *  - ligar no `POST /limpar`: aquele apaga o banco inteiro, **candidaturas inclusive** — ou seja, cegaria
 *    `jaCandidatado` e o robô recomeçaria mandando currículo repetido para quem já recebeu. Fica onde está,
 *    na zona de perigo das Configurações.
 *  - marcar `recusadaPorVoce` em todas: você perderia 20 vagas boas de vista por um clique de limpeza.
 *  - esvaziar e deixar o laço de 20 s reencher: o botão pareceria quebrado. Daí a pausa abaixo.
 *
 * Candidatura em voo não entra: o currículo pode já estar no servidor (invariante 4).
 */
export function esvaziarFila(): number {
  const naFila = vagas.listar().filter(v => NA_FILA.includes(v.status) && v.status !== 'em_andamento');
  for (const v of naFila) vagas.atualizar(v.id, { status: 'encontrada', posicao: undefined, pendencia: undefined, pedidaPorVoce: undefined });
  // Pausa a reposição automática: esvaziar quer dizer "espere a minha ordem". Mapear ou ligar o robô liberam
  // de novo — e a tela diz que está pausada, para ninguém achar que a fila quebrou.
  kv.set('fila:pausada', true);
  registrar('alerta', `${naFila.length} vaga(s) saíram da fila. Ela não se reenche sozinha até você mapear de novo ou ligar o robô.`);
  emitir({ tipo: 'estado' });
  return naFila.length;
}

/** Libera a reposição automática depois de um `esvaziarFila`. */
export const retomarFila = () => kv.set('fila:pausada', false);

/** "Mudei de ideia": desfaz a exclusão e devolve a vaga ao jogo. */
export function devolverAFila(id: string): void {
  const v = vagas.get(id);
  if (!v) throw new Error('vaga não encontrada');
  vagas.atualizar(id, { recusadaPorVoce: undefined });
  registrar('info', `"${v.titulo}" voltou a concorrer a uma posição na fila.`);
  enfileirarCompativeis('você devolveu uma vaga');
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
  // Você destravou a vaga à mão: o orçamento de respostas da IA dela recomeça. Sem isto o teto continuava
  // gasto e a vaga voltava a parar no próximo formulário, agora por um motivo que não era mais verdade.
  respostasIA.delete(id);
  emitir({ tipo: 'estado' });
  void processarProxima(true);
}

/** Decisão do preview: usar o adaptado, o original, ou desistir desta vaga. */
export function decidirPreview(id: string, decisao: 'adaptado' | 'original' | 'cancelar') {
  const v = vagas.get(id);
  if (v?.pendencia?.tipo !== 'aprovacao') throw new Error('nada para aprovar nesta vaga');
  if (decisao === 'cancelar') {
    // Mesma decisão de `removerDaFila`, e precisa da mesma marca: sem ela a reposição recoloca esta vaga na
    // rodada seguinte, e o "cancelar" que você clicou não teria significado nenhum
    vagas.atualizar(id, { status: 'encontrada', recusadaPorVoce: true, pendencia: undefined, posicao: undefined });
    registrar('alerta', `Candidatura a "${v.titulo}" cancelada por você; ela não volta para a fila sozinha.`);
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

/** Por que a fila não anda agora. A regra mora em `src/dados.ts`: a tela mostra o mesmo motivo. */
const porQueParada = (cfg: ReturnType<typeof ler.automacao>) => motivoDeEspera({ robo: ler.robo(), cfg, enviadasHoje: enviosHoje(), proximoEnvioEm: ler.proximoEnvioEm() });

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
    /**
     * Chegar aqui no Sem Piedade quer dizer uma coisa específica: a pergunta é obrigatória E a vaga não
     * oferece "prefiro não declarar" (se oferecesse, `respostaSalva` já teria marcado, pela regra 4 de
     * `decidirSensivel`, e isto nem seria alcançado). Então não existe resposta segura, e a mensagem precisa
     * dizer isso — senão a pessoa fica achando que o modo está quebrado.
     */
    const semPiedade = ler.automacao().modoPerguntas === 'sem_piedade';
    registrar(
      'aguardo',
      semPiedade
        ? `"${vaga.titulo}": ${sensivel.rotulo.toLowerCase()} é autodeclaração obrigatória e esta vaga não oferece "prefiro não declarar". Nem no Sem Piedade eu respondo isso por você — seria inventar uma característica sua num formulário real. Responda aqui, ou defina em Configurações › Autodeclaração e nenhuma vaga para por isso de novo.`
        : `"${vaga.titulo}": ${sensivel.rotulo.toLowerCase()} é autodeclaração — a IA não responde isso. Defina em Configurações › Autodeclaração ou responda aqui.`,
    );
    return false;
  }
  // Dado pessoal não é dúvida de currículo, é fato: a IA não chuta CPF, endereço nem pretensão. Nem chega nela.
  if (DADO_PESSOAL.test(q.rotulo)) {
    registrar(
      'aguardo',
      `"${vaga.titulo}" pergunta um dado pessoal ("${q.rotulo.slice(0, 50)}"). Nem o Sem Piedade chuta isso: a IA erraria num formulário de uma empresa real. Responda aqui, ou preencha em Configurações › Meus Dados e nenhuma vaga para por causa disso de novo.`,
    );
    return false;
  }
  const usadas = respostasIA.get(vaga.id) ?? 0;
  if (usadas >= MAX_RESPOSTAS_IA) {
    // O teto não é cautela com a IA: é quebra-laço. Formulário que não para de perguntar é sinal de que o
    // motor está relendo a mesma etapa — e aí nenhum número salva, então o que falta é dizer onde travou.
    registrar(
      'alerta',
      `"${vaga.titulo}" já teve ${usadas} perguntas respondidas pela IA e travou em "${q.rotulo.slice(0, 60)}". Parei para você conferir: formulário que não para de perguntar costuma ser sinal de que algo saiu do previsto.`,
    );
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
/**
 * A vaga que VOCÊ pediu enquanto o trabalhador estava ocupado — o id, não um booleano.
 *
 * Era `let pedidoForcado = false`, e isso liberava a vaga errada: `forcarAgora` dispensava os portões e
 * `proximaNaFila()` escolhia pela posição, que é a da FRENTE da fila. Ou seja, clicar em "Quero me
 * candidatar" durante uma candidatura empurrava uma vaga AUTOMÁTICA por cima da janela de horário, do
 * intervalo e do limite diário — e a vaga que você clicou, que entra no fim da fila, continuava esperando.
 * Achado pela auditoria do codex em 05/10/2026.
 */
let pedidoForcado: string | null = null; // chegou um pedido manual enquanto o robô estava ocupado: roda assim que liberar

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
export async function processarProxima(forcar = false, idPedido?: string) {
  // `ocupado` é a candidatura em si; `rodando` é o trabalhador — sem ele, o laço de 20 s entraria entre duas
  // candidaturas do mesmo trabalhador (quando `ocupado` já voltou a false) e abriria uma segunda fila em paralelo.
  if (rodando || ocupado) {
    // Não perde o pedido: quem está rodando agora reavalia a fila ao terminar
    if (forcar) pedidoForcado = idPedido ?? pedidoForcado ?? '*';
    return;
  }
  rodando = true;
  try {
    await girarFila(forcar ? (idPedido ?? '*') : null);
  } finally {
    rodando = false;
  }
  // Um pedido manual que chegou durante a rodada: atende agora, sem esperar os 20 s
  if (pedidoForcado) {
    const pendente = pedidoForcado;
    pedidoForcado = null;
    await processarProxima(true, pendente === '*' ? undefined : pendente);
  }
}

/** `forcadoPara`: null = rodada normal · id = a vaga que você pediu · '*' = pedido sem id (retomada). */
async function girarFila(forcadoPara: string | null) {
  for (let rodada = 0; rodada < 50; rodada++) {
    const cfg = ler.automacao();
    const pedido = forcadoPara ?? pedidoForcado;
    pedidoForcado = null;
    limparForaDoFoco(); // o foco pode ter mudado depois que a vaga entrou na fila

    /**
     * A vaga que você pediu vem PRIMEIRO, e só ela dispensa os portões.
     *
     * Antes a ordem era outra: o portão era dispensado e então `proximaNaFila()` escolhia pela posição — a
     * da FRENTE da fila. Duas consequências, as duas erradas: uma vaga AUTOMÁTICA passava por cima da janela
     * de horário, do intervalo e do limite diário herdando a sua exceção, e a vaga que você clicou (que entra
     * no fim da fila) continuava esperando. Achado pela auditoria do codex em 05/10/2026.
     *
     * `pedidaPorVoce` entra na conta porque é a marca persistente do seu clique: ela sobrevive a uma
     * reinicialização do núcleo, e o `pedido` em memória não.
     */
    const pedida = pedido && pedido !== '*' ? vagas.get(pedido) : null;
    const proxima = pedida && NA_FILA.includes(pedida.status) ? pedida : vagas.proximaNaFila();
    if (!proxima) {
      await liberarNavegador();
      return;
    }
    if (!(pedido === '*' || pedido === proxima.id || proxima.pedidaPorVoce === true)) {
      const espera = porQueParada(cfg);
      if (espera) {
        await liberarNavegador();
        // Só avisa quando há fila de verdade e o motivo mudou (senão vira ruído a cada 20 s)
        if (espera !== ultimaEspera) {
          registrar('info', `Fila parada: ${espera}.`);
          ultimaEspera = espera;
        }
        return;
      }
      ultimaEspera = '';
    }
    // Filtro de agora, não o de quando ela entrou na fila
    const desatualizada = filtroAindaVale(proxima, cfg);
    if (desatualizada) {
      vagas.atualizar(proxima.id, { status: 'ignorada', posicao: undefined, pendencia: undefined });
      registrar('alerta', `"${proxima.titulo}" saiu da fila sem ser enviada: ${desatualizada}.`);
      evento('fila.recusa', { plataforma: proxima.plataforma, vaga: proxima.id, dados: { motivo: desatualizada, titulo: proxima.titulo, empresa: proxima.empresa, score: proxima.score } });
      emitir({ tipo: 'estado' });
      continue;
    }
    if (cfg.ensaio) registrar('alerta', `Modo ensaio LIGADO: "${proxima.titulo}" será preenchida mas NÃO enviada. Desligue o ensaio em Automação para candidatar de verdade.`);
    if (!(await processarUma(proxima))) return;
    forcadoPara = null; // um pedido manual libera UMA candidatura; as seguintes respeitam os portões
  }
}

let agendando = false;

/**
 * Laço do núcleo, a cada 20 s:
 *  - revarredura das empresas (Fonte A) a cada `intervaloHoras`, independente do robô estar ligado;
 *  - descoberta de empresas novas (Fonte B) 1x/dia, se ligada e com chave;
 *  - com o robô ligado, processa a próxima candidatura da fila.
 */
/**
 * Hora de revarrer esta plataforma? Vale para qualquer adapter que grave `<id>:ultimaBusca` ao terminar a busca
 * — que é o que todos fazem. InHire e Indeed ficam de fora porque têm agenda própria: o InHire tem a descoberta
 * de empresas (Fonte A/B) e o Indeed tem uma varredura por dia por causa do bloqueio dele.
 */
const COM_AGENDA_PROPRIA = ['inhire', 'indeed'];

export function plataformaVencida(id: string, horas: number): boolean {
  const ultima = kv.get<string | null>(`${id}:ultimaBusca`, null);
  return !ultima || Date.now() - new Date(ultima).getTime() >= horas * 3_600_000;
}

export const algumaPlataformaVencida = (horas: number) => Object.keys(ler.conexoes()).some(id => !COM_AGENDA_PROPRIA.includes(id) && adapters[id] && plataformaVencida(id, horas));

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
        } else if (algumaPlataformaVencida(d.intervaloHoras) && ler.curriculos()[0]?.perfilBusca) {
          // Qualquer outra plataforma conectada vencida. Era um `else if` por plataforma, e cada adapter novo
          // que esquecesse de entrar na cadeia ficava sem varredura agendada — foi o que aconteceu com o
          // Quickin, o Workable e o Arbeitnow, que só varriam de carona quando o InHire estava vencido.
          await buscarVagas().catch(e => registrar('erro', `Varredura agendada falhou: ${(e as Error).message}`));
        }
      } finally {
        agendando = false;
      }
    }
    /**
     * A reposição vem ANTES do portão do robô, e a ordem é o requisito.
     *
     * Estava depois: com o robô pausado o `return` acontecia primeiro e a fila nunca completava sozinha — ou
     * seja, a fase de mapeamento (olhar o plano se formar com o robô parado) não existiria de fato, mesmo com
     * `enfileirarCompativeis` já aceitando trabalhar pausado. Repor é planejar; enviar é o que vem depois.
     *
     * O gatilho é a CONTAGEM da fila, não "a fila está vazia": com alvo de 10 e 9 enfileiradas, `proximaNaFila`
     * acha alguém e a fila ficaria eternamente com 9.
     */
    const naFila = vagas.listar().filter(v => NA_FILA.includes(v.status)).length;
    if (naFila < ler.automacao().filaAlvo) enfileirarCompativeis('reposição da fila');
    if (ler.robo() !== 'ativo') return;
    await processarProxima();
  }, 20000);
}

export function ligarRobo(ligar: boolean) {
  kv.set('robo', ligar ? 'ativo' : 'pausado');
  if (ligar) retomarFila(); // dar start é dizer "pode encher a fila"
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
