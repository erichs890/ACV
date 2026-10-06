import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Pendencia, PerguntaExtra, Vaga } from '../src/types.ts';
import { adapters, soDescobre } from './platforms/adapter.ts';
import { candidaturas, kv, log, vagas } from './storage/db.ts';
import { ler } from './estado.ts';
import { emitir } from './events.ts';
import { idiomaDaVaga } from './idioma.ts';
import { evento } from './diario.ts';
import { DIRS } from './config.ts';
import { adaptarComIA, adaptarCurriculo, validarAdaptacao } from './resume/adapter.ts';
import { completar, iaAtiva, lerIA } from './ia.ts';
import { markdownParaPdf } from './resume/mdToPdf.ts';
import { normalizar, similaridade } from './resume/texto.ts';
import { categoriaSensivel, decidirSensivel } from '../src/sensiveis.ts';

const registrar = log.registrar;

// Perguntas cuja resposta vai para o perfil (Configurações → Meus Dados), não para a lista de perguntas automáticas
export const PERGUNTA_LINKEDIN = 'Link do seu perfil no LinkedIn (a vaga exige)';
export const PERGUNTA_PRETENSAO = 'Sua pretensão salarial (ex.: R$ 4.500,00)';
export const PERGUNTA_REGIME = 'Regime de contratação';

/** Aproxima uma resposta às opções da vaga ("A | B" para múltipla); texto livre passa direto. */
function casarComOpcoes(pergunta: PerguntaExtra, resposta: string): string | null {
  if ((pergunta.tipo === 'opcoes' || pergunta.tipo === 'multipla') && pergunta.opcoes?.length) {
    const casar = (r: string) => pergunta.opcoes!.find(o => similaridade(o, r) >= 0.7) ?? null;
    if (pergunta.tipo === 'opcoes') return casar(resposta);
    const casadas = resposta
      .split(/\s*\|\s*|\s*;\s*/)
      .map(casar)
      .filter((o): o is string => o !== null);
    return casadas.length ? [...new Set(casadas)].join(' | ') : null;
  }
  return resposta;
}

/**
 * Resposta salva (Configurações → Perguntas Automáticas) para uma pergunta parecida, ou null.
 * Perguntas de autodeclaração (src/sensiveis.ts) NÃO entram na similaridade: só resposta dada para a pergunta literal
 * ou a política de Configurações → Autodeclaração; senão null, e a pendência avisa que é dado sensível.
 */
export function respostaSalva(pergunta: PerguntaExtra): string | null {
  if (categoriaSensivel(pergunta.rotulo))
    // No Sem Piedade a autodeclaração é resolvida AQUI, marcando "prefiro não declarar" quando a vaga
    // oferece — e então ela nem chega a virar pendência nem passa perto da IA. É o que faz a fila não parar
    // sem ninguém inventar característica de ninguém (ver `decidirSensivel`, regra 4).
    return decidirSensivel(pergunta, ler.perguntas(), ler.sensiveis(), r => casarComOpcoes(pergunta, r), {
      aceitarPreferirNao: ler.automacao().modoPerguntas === 'sem_piedade',
    });
  let melhor: { resposta: string; s: number } | null = null;
  for (const p of ler.perguntas()) {
    if (!p.resposta.trim()) continue;
    const s = similaridade(p.pergunta, pergunta.rotulo);
    if (s >= PARECENCA_MINIMA && (!melhor || s > melhor.s)) melhor = { resposta: p.resposta.trim(), s };
  }
  if (!melhor) return null;
  const casada = casarComOpcoes(pergunta, melhor.resposta);
  if (casada === null) return null;
  /**
   * **Resposta dada para ESTA pergunta, literalmente, não passa pela trava de tipo.**
   *
   * A trava existe para impedir que uma resposta seja HERDADA de outra pergunta parecida — foi ela que parou
   * o "Sim" de ir para o campo do LinkedIn. Mas quando a similaridade é 1,00 não houve herança nenhuma: você
   * salvou aquela resposta para aquela pergunta, e isso é decisão sua, não dedução minha. Sem esta linha, a
   * pergunta "Photo" (que você respondeu "yes") era recusada porque "yes" num campo de texto cujo rótulo não
   * começa com "você/possui/do you" parecia herança errada — e a vaga parava à toa (visto em 06/10/2026).
   */
  if (melhor.s >= 1) return casada;
  return respostaFazSentido(pergunta, casada) ? casada : null;
}

/**
 * Quanto duas perguntas têm de se parecer para uma herdar a resposta da outra.
 *
 * Era 0,55 e isso é **parecença, não equivalência**. Medido contra as 173 respostas salvas reais em
 * 06/10/2026: "Informe o seu Linkedin (Insira o Link):" casou com "Esta é uma posição de pipeline contínuo,
 * o que significa..." a 0,58 e herdou o "Sim" dela. Num envio de verdade isso escreve **Sim** no campo do
 * LinkedIn dele, e "Sim" no campo de última remuneração (0,63 com a mesma pergunta).
 *
 * 0,8 é "a mesma pergunta escrita de outro jeito" — o casamento legítimo que eu vi no mesmo teste foi 1,00
 * (pergunta idêntica). O que cai fora daqui não para a fila: vai para a IA (no Sem Piedade) e, se ela também
 * não souber, volta para você uma vez e fica salvo. Resposta errada num formulário real não tem desfazer.
 */
const PARECENCA_MINIMA = 0.8;

/**
 * A resposta serve para ESTA pergunta? Parecença de texto não garante isso — e tipo de dado, sim.
 *
 * O segundo portão, e o que de fato pega o caso do LinkedIn: campo que pede um LINK não aceita "Sim", campo
 * que pede um VALOR não aceita resposta sem número nenhum. Vale só para texto livre: pergunta com opções já
 * é resolvida por `casarComOpcoes`, que devolve null quando nada casa.
 */
const PEDE_LINK = /\blink\b|\burl\b|linkedin|github|portf[óo]lio|\bsite\b|perfil online/i;
const PEDE_VALOR = /quanto|\bvalor\b|remunera|sal[áa]ri|pretens|quantos anos|\bidade\b|\bcep\b|\bcpf\b|telefone|celular/i;
const SO_SIM_OU_NAO = /^(sim|n[ãa]o|yes|no)$/i;

export function respostaFazSentido(pergunta: PerguntaExtra, resposta: string): boolean {
  if (pergunta.tipo !== 'texto') return true;
  const r = resposta.trim();
  if (PEDE_LINK.test(pergunta.rotulo) && !/https?:\/\/|\w\.\w{2,}\//i.test(r)) return false;
  if (PEDE_VALOR.test(pergunta.rotulo) && !/\d/.test(r)) return false;
  // "Sim" num campo aberto que não é pergunta de sim-ou-não é sempre resposta herdada errado
  if (SO_SIM_OU_NAO.test(r) && !/^(possui|tem\b|voc[êe]\s|aceita|concorda|h[áa]\s|j[áa]\s|est[áa]\s|teria|tens\b|disponib|dispon[íi]vel|is |do you|are you|have you)/i.test(pergunta.rotulo.trim()))
    return false;
  return true;
}

function decidirRegime(vaga: Vaga): 'CLT' | 'PJ' | null | 'perguntar' {
  if (vaga.regime === 'CLT' || vaga.regime === 'PJ') return vaga.regime;
  const pref = ler.automacao().regimePreferido;
  if (pref === 'perguntar') return 'perguntar';
  // `qualquer` devolve null, que é o que o motor de formulário já entende como "não tenho preferência":
  // ele marca a primeira opção que a vaga oferece (`formulario.ts`, papel `regime`) e segue sem parar.
  if (pref === 'qualquer') return null;
  return pref;
}

function pendente(vaga: Vaga, pendencia: Pendencia) {
  const status = pendencia.tipo === 'pergunta' ? 'aguardando_pergunta' : 'aguardando_aprovacao';
  // Autodeclaração: a interface mostra que é dado sensível e a resposta vale só para esta pergunta literal
  const sensivel = pendencia.tipo === 'pergunta' ? categoriaSensivel(pendencia.pergunta.rotulo) : null;
  if (pendencia.tipo === 'pergunta' && sensivel) pendencia = { ...pendencia, pergunta: { ...pendencia.pergunta, sensivel: sensivel.id } };
  vagas.atualizar(vaga.id, { status, pendencia });
  const rotulo = pendencia.tipo === 'pergunta' ? pendencia.pergunta.rotulo : '';
  registrar(
    'aguardo',
    pendencia.tipo === 'pergunta'
      ? `"${vaga.titulo}" aguarda sua resposta${sensivel ? ` (autodeclaração — ${sensivel.rotulo.toLowerCase()}, dado sensível)` : ''}: ${rotulo}`
      : `"${vaga.titulo}" aguarda sua aprovação do currículo adaptado.`,
  );
  emitir({
    tipo: 'aviso',
    nivel: 'info',
    msg: pendencia.tipo === 'pergunta' ? `${sensivel ? 'Autodeclaração pedida pelo InHire' : 'O InHire perguntou'}: ${rotulo}` : `Currículo adaptado pronto para revisão: ${vaga.titulo}`,
  });
}

/** IA (se configurada) com validação de entidades; qualquer problema → cai para a adaptação por regras. Guarda o resultado na vaga. */
export async function gerarAdaptacao(original: string, vaga: Vaga): Promise<{ markdown: string; diff: string[]; viaIA: boolean }> {
  const r = await gerarAdaptacaoBruta(original, vaga);
  vagas.atualizar(vaga.id, { adaptado: { markdown: r.markdown, diff: r.diff, viaIA: r.viaIA, pdf: vaga.adaptado?.pdf } });
  return r;
}

async function gerarAdaptacaoBruta(original: string, vaga: Vaga): Promise<{ markdown: string; diff: string[]; viaIA: boolean }> {
  if (iaAtiva()) {
    const { provedor, modelo } = lerIA();
    try {
      const r = await adaptarComIA(original, vaga, completar);
      if (r.problemas.length === 0) {
        registrar('sucesso', `Currículo reescrito por ${provedor === 'gemini' ? 'Gemini' : 'Claude'} (${modelo}) para "${vaga.titulo}" e validado: nenhuma entidade nova.`);
        return { ...r, viaIA: true };
      }
      registrar('alerta', `Reescrita por IA descartada para "${vaga.titulo}": ${r.problemas.slice(0, 5).join('; ')}. Usando adaptação por regras.`);
    } catch (e) {
      registrar('alerta', `IA indisponível (${(e as Error).message}). Usando adaptação por regras.`);
    }
  }
  return { ...adaptarCurriculo(original, vaga), viaIA: false };
}

/**
 * Fluxo completo de uma candidatura. Ordem obrigatória: preencher → anexar → enviar → só então confirmar.
 * Pausa (sem travar as outras) quando falta resposta de pergunta ou aprovação de preview.
 */
/**
 * Identidade prática de uma vaga: empresa + título.
 *
 * O InHire publica a mesma função mais de uma vez, com `jobId` diferente — a Radix apareceu duas vezes com
 * "Profissional Desenvolvedor de Software Pleno" e a BIX duas com o mesmo banco de talentos. Para o recrutador
 * são a mesma coisa, e receber dois ou três currículos iguais do mesmo candidato pega muito mal.
 * Travar só por `id` não resolvia isso.
 */
export const chaveDaVaga = (v: { empresa: string; titulo: string }) => `${normalizar(v.empresa)}|${normalizar(v.titulo)}`;

/** Já existe candidatura ENVIADA para esta vaga? (ensaio não conta: é justamente o passo antes do envio real) */
export const jaEnviada = (vagaId: string) => candidaturas.listar().some(c => c.vagaId === vagaId && c.resultado === 'enviada');

/**
 * Fecha as publicações irmãs de algo já enviado (mesma empresa + título, outro id — o InHire e o Divulga Vagas
 * republicam a mesma vaga).
 *
 * Elas ficavam abertas para sempre: `enfileirarCompativeis` nunca as pega (`jaCandidatado` barra) e só seriam
 * encerradas se a fila tentasse mandar de novo. Resultado na tela: vaga que parece esperando e nunca anda.
 * Como "uma vaga, uma candidatura" (invariante 4) já decidiu que elas não serão enviadas, o lugar delas é
 * `encerrada`, não a lista de pendentes.
 */
export function encerrarIrmasEnviadas(): number {
  const enviadas = new Set(
    candidaturas
      .listar()
      .filter(c => c.resultado === 'enviada')
      .map(chaveDaVaga),
  );
  if (!enviadas.size) return 0;
  const abertas = vagas.listar().filter(v => v.status !== 'encerrada' && v.status !== 'enviada' && v.status !== 'ignorada');
  let fechadas = 0;
  for (const v of abertas) {
    if (!enviadas.has(chaveDaVaga(v))) continue;
    vagas.atualizar(v.id, { status: 'encerrada', posicao: undefined, pendencia: undefined, motivo: 'você já se candidatou a esta vaga (outra publicação da mesma empresa e título)' });
    fechadas++;
  }
  return fechadas;
}

/** Já se candidatou a esta vaga OU a outra com o mesmo título na mesma empresa. */
export function jaCandidatado(vaga: { id: string; empresa: string; titulo: string }): boolean {
  const chave = chaveDaVaga(vaga);
  return candidaturas.listar().some(c => c.resultado === 'enviada' && (c.vagaId === vaga.id || chaveDaVaga(c) === chave));
}

/**
 * O desfecho de uma tentativa, em forma de dado (ver `core/diario.ts`).
 *
 * Uma linha por tentativa, sempre com plataforma, id da vaga e motivo — que é exatamente o que a frase em
 * português não tem e o que faz falta na hora de agrupar 200 falhas e achar a que se repete. `core/relato.ts`
 * lê isto. Nada de dado pessoal aqui: título e empresa são públicos, currículo e contato não entram.
 */
const anotarDesfecho = (vaga: Vaga, status: string, extra: Record<string, unknown> = {}) =>
  evento('candidatura.desfecho', {
    plataforma: vaga.plataforma,
    vaga: vaga.id,
    dados: { status, titulo: vaga.titulo, empresa: vaga.empresa, score: vaga.score, ...extra },
  });

export async function executarCandidatura(id: string) {
  const vaga = vagas.get(id);
  if (!vaga) return;

  // Trava dura contra candidatura repetida: mandar o currículo duas vezes para a mesma vaga queima o candidato
  // com o recrutador. Vale para qualquer caminho — fila automática, clique manual, retomada de pendência.
  if (jaCandidatado(vaga)) {
    // A própria vaga volta a "enviada"; a publicação irmã é encerrada, para não reaparecer na fila
    const mesmaVaga = jaEnviada(id);
    vagas.atualizar(id, { status: mesmaVaga ? 'enviada' : 'encerrada', pendencia: undefined, posicao: undefined, erro: undefined });
    registrar(
      'alerta',
      mesmaVaga
        ? `"${vaga.titulo}" já tinha sido enviada para ${vaga.empresa}; não vou candidatar de novo.`
        : `Você já se candidatou a "${vaga.titulo}" em ${vaga.empresa} (outra publicação da mesma vaga); não vou mandar o currículo duas vezes.`,
    );
    anotarDesfecho(vaga, 'repetida', { motivo: mesmaVaga ? 'já enviada antes' : 'outra publicação da mesma vaga já foi enviada' });
    emitir({ tipo: 'estado' });
    return;
  }

  /**
   * Plataforma só de descoberta nunca candidata — e esta é a trava que VALE, porque está no ponto de uso.
   *
   * As outras (a fila, pelo `plataformaEnviaCurriculo`; o clique manual, em `candidatarAgora`) são as portas;
   * esta é a tranca. Este projeto já pagou TRÊS vezes por filtro conferido num ponto do ciclo de vida e não
   * no ponto de uso — foco de plataforma, nicho a evitar e nota mínima, todos registrados no agentlog.
   * Chegar aqui é bug, e é por isso que a mensagem diz "bug": vaga em estado antigo, caminho novo que alguém
   * acrescentou sem lembrar disto. A vaga volta a `encontrada` porque ela continua ÚTIL (é só abrir e enviar
   * à mão), e isso não é `erro` (não falhou nada dela) nem `encerrada` (não acabou).
   */
  if (soDescobre(vaga.plataforma)) {
    const motivo = adapters[vaga.plataforma]?.motivoSomenteDescoberta ?? `o ACV só acha e ranqueia vagas do ${vaga.plataforma}; a candidatura é feita por você, no site`;
    vagas.atualizar(id, { status: 'encontrada', posicao: undefined, pendencia: undefined });
    registrar('alerta', `"${vaga.titulo}" chegou à candidatura, mas ${motivo}. Nada foi enviado.`);
    anotarDesfecho(vaga, 'somente_descoberta', { motivo });
    emitir({ tipo: 'estado' });
    return;
  }

  const perfil = ler.perfil();
  const cfg = ler.automacao();
  const adapter = adapters[vaga.plataforma];
  const principal = ler.curriculos()[0];
  if (!perfil || !principal?.caminho || !existsSync(principal.caminho)) {
    vagas.atualizar(id, { status: 'erro', erro: 'perfil ou currículo principal ausente' });
    registrar('erro', `"${vaga.titulo}": perfil ou currículo principal ausente.`);
    // `curriculoPresente`, e não o caminho: um caminho absoluto carrega o nome de usuário e a estrutura de
    // pastas dele, e o diário existe para ser colado num chat. Achado pela auditoria do codex em 05/10/2026.
    anotarDesfecho(vaga, 'erro', { motivo: 'perfil ou currículo principal ausente', perfilPresente: !!perfil, curriculoPresente: !!principal?.caminho && existsSync(principal.caminho) });
    return;
  }
  if (!adapter) {
    vagas.atualizar(id, { status: 'erro', erro: `plataforma ${vaga.plataforma} sem adapter` });
    return;
  }

  // Campos que o InHire exige e o cadastro inicial não pediu: pergunta uma vez e guarda no perfil
  const exige = (campo: string) => vaga.camposConhecidos.length === 0 || vaga.camposConhecidos.includes(campo);
  if (exige('linkedin') && !perfil.linkedin?.trim()) return pendente(vaga, { tipo: 'pergunta', pergunta: { rotulo: PERGUNTA_LINKEDIN, tipo: 'texto' } });
  if (exige('salary') && !perfil.pretensao?.trim()) return pendente(vaga, { tipo: 'pergunta', pergunta: { rotulo: PERGUNTA_PRETENSAO, tipo: 'texto' } });

  // Perguntas que a vaga com certeza vai fazer (schema via API): resolve antes de abrir o navegador ou adaptar o currículo
  if (adapter.perguntasPrevias && vaga.status !== 'em_andamento') {
    try {
      for (const p of await adapter.perguntasPrevias(vaga)) if (respostaSalva(p) === null) return pendente(vaga, { tipo: 'pergunta', pergunta: p });
    } catch (e) {
      registrar('alerta', `Não consegui ler as perguntas de "${vaga.titulo}" pela API (${(e as Error).message}); vou descobrir no formulário.`);
    }
  }

  const regime = decidirRegime(vaga);
  if (regime === 'perguntar') {
    pendente(vaga, {
      tipo: 'pergunta',
      pergunta: { rotulo: `${PERGUNTA_REGIME} para "${vaga.titulo}" (a vaga ${vaga.regime === 'ambos' ? 'aceita CLT e PJ' : 'não informou o regime'})`, tipo: 'opcoes', opcoes: ['CLT', 'PJ'] },
    });
    return;
  }

  vagas.atualizar(id, { status: 'em_andamento', pendencia: undefined, erro: undefined });
  emitir({ tipo: 'estado' });

  /**
   * 0) O IDIOMA da vaga decide qual currículo vai — e isto fica antes de tudo, no ponto de uso.
   *
   * Até 06/10/2026 o ACV mandava sempre o PDF principal, em português, mesmo numa vaga escrita em inglês. O
   * PDF traduzido já existia (`Arquivo.inglesPdf`) e só servia para download manual: nenhum caminho
   * automático o alcançava. Medido no banco real: 4 vagas em inglês estavam NA FILA, três com pagamento em
   * dólar — as que mais pagam são justamente as que o currículo errado mais custa.
   *
   * Vaga em inglês sem PDF traduzido PARA, em vez de mandar o português: o desfecho silencioso (o recrutador
   * descarta e você nunca sabe por quê) é pior que um erro na tela. Desde 06/10 a tradução nasce junto com o
   * upload do currículo, então este caminho é exceção — currículo enviado antes disso, ou tradução que falhou.
   */
  const idioma = idiomaDaVaga(vaga);
  if (idioma === 'en' && !(principal.inglesPdf && existsSync(principal.inglesPdf))) {
    const motivo = 'esta vaga está escrita em inglês e você ainda não tem o currículo traduzido. Gere em Currículo › Internacional e eu mando o certo.';
    vagas.atualizar(id, { status: 'erro', erro: motivo });
    registrar('aguardo', `"${vaga.titulo}": ${motivo}`);
    anotarDesfecho(vaga, 'erro', { motivo: 'vaga em inglês sem currículo traduzido', idioma });
    emitir({ tipo: 'estado' });
    return;
  }

  // 1) Currículo: original, traduzido ou adaptado (com validação anti-invenção)
  let curriculoPdf = idioma === 'en' ? (principal.inglesPdf as string) : principal.caminho;
  let versao: 'original' | 'adaptada' = 'original';
  if (idioma === 'en') registrar('info', `"${vaga.titulo}" está em inglês: mandando o currículo traduzido.`);
  const aprovacao = vaga.pendencia?.tipo === 'aprovacao' ? vaga.pendencia : null;
  /**
   * Adaptação só no português, de propósito.
   *
   * `validarAdaptacao` compara palavra a palavra com o markdown ORIGINAL (em português) para garantir que
   * nada foi inventado — rodar isso contra um texto em inglês reprovaria tudo e, pior, poderia aprovar um
   * currículo meio traduzido. Vaga em inglês leva o PDF traduzido inteiro, sem recorte por vaga.
   */
  if (idioma === 'pt' && cfg.adaptar && principal.markdown && vaga.decisaoPreview !== 'original') {
    const adaptacao = aprovacao ? { markdown: aprovacao.adaptado, diff: aprovacao.diff, viaIA: false } : await gerarAdaptacao(principal.markdown, vaga);
    // Aprovado pelo usuário ou gerado por IA: validação de entidades (sinônimos ok, dado novo não). Regras: validação palavra a palavra.
    const novas = aprovacao || adaptacao.viaIA ? [] : validarAdaptacao(principal.markdown, adaptacao.markdown);
    if (novas.length) {
      registrar('alerta', `Adaptação descartada para "${vaga.titulo}": introduziria termos ausentes do original (${novas.slice(0, 5).join(', ')}). Usando o original.`);
    } else if (adaptacao.diff.length === 0) {
      registrar('info', `Nada a adaptar para "${vaga.titulo}": currículo original enviado.`);
    } else {
      if (cfg.preview === 'mostrar' && !aprovacao && vaga.decisaoPreview !== 'adaptado') {
        pendente(vaga, { tipo: 'aprovacao', original: principal.markdown, adaptado: adaptacao.markdown, diff: adaptacao.diff });
        return;
      }
      curriculoPdf = join(DIRS.gerados, `${vaga.id.replace(/[^a-z0-9]/gi, '_')}.pdf`);
      await markdownParaPdf(adaptacao.markdown, curriculoPdf, cfg.mostrarNavegador);
      vagas.atualizar(id, { adaptado: { markdown: adaptacao.markdown, diff: adaptacao.diff, viaIA: adaptacao.viaIA, pdf: curriculoPdf } });
      versao = 'adaptada';
      registrar('sucesso', `Currículo adaptado para "${vaga.titulo}" (${adaptacao.diff.length} mudança(s), nada inventado).`);
    }
  }

  // 2) Preencher, anexar e enviar
  // `candidatar!` é seguro aqui: `soDescobre` já barrou acima quem não tem o método
  const resultado = await adapter.candidatar!(
    vaga,
    {
      nome: perfil.nome,
      email: perfil.email,
      celular: perfil.telefone,
      linkedin: perfil.linkedin ?? '',
      cidade: perfil.cidade ?? '',
      cpf: perfil.cpf ?? '',
      pretensao: perfil.pretensao ?? '',
      regime,
      curriculoPdf,
      responder: respostaSalva,
      ensaio: cfg.ensaio,
      mostrarNavegador: cfg.mostrarNavegador,
    },
    registrar,
  );

  // 3) Só depois do resultado real: confirmação ou erro
  if (resultado.status === 'pergunta') {
    anotarDesfecho(vaga, 'pergunta', { pergunta: resultado.pergunta.rotulo });
    return pendente(vaga, { tipo: 'pergunta', pergunta: resultado.pergunta });
  }
  if (resultado.formulario) vagas.atualizar(id, { formulario: resultado.formulario });
  if (resultado.status === 'erro') {
    vagas.atualizar(id, { status: 'erro', erro: resultado.motivo, captura: resultado.captura });
    registrar('erro', `Falha em "${vaga.titulo}" (${vaga.empresa}): ${resultado.motivo}`);
    anotarDesfecho(vaga, 'erro', { motivo: resultado.motivo, captura: !!resultado.captura, etapas: resultado.formulario?.etapas ?? null });
    emitir({ tipo: 'aviso', nivel: 'erro', msg: `Falha ao candidatar: ${vaga.titulo}` });
    return;
  }
  const enviadaEm = new Date().toISOString();
  candidaturas.inserir({
    vagaId: vaga.id,
    titulo: vaga.titulo,
    empresa: vaga.empresa,
    plataforma: vaga.plataforma,
    url: vaga.url,
    enviadaEm,
    nome: perfil.nome,
    email: perfil.email,
    celular: perfil.telefone,
    curriculo: curriculoPdf,
    versao,
    regime: regime ?? '',
    resultado: resultado.status,
  });
  vagas.atualizar(id, { status: resultado.status === 'ensaio' ? 'ensaio' : 'enviada', pendencia: undefined, captura: resultado.status === 'ensaio' ? resultado.captura : undefined });
  anotarDesfecho(vaga, resultado.status === 'ensaio' ? 'ensaio' : 'enviada', { versao, regime: regime ?? null, prova: resultado.status === 'enviada' ? (resultado.prova ?? null) : null });
  if (resultado.status === 'ensaio') {
    // A plataforma da VAGA, não "InHire" fixo: esta mensagem é compartilhada por todas, e dizer "aceito pelo
    // InHire" num ensaio do Vagas PJ faz a pessoa duvidar do resto do log (visto no ensaio de 06/10/2026).
    if (resultado.pronto)
      registrar('sucesso', `Ensaio concluído para "${vaga.titulo}": formulário do ${adapters[vaga.plataforma]?.nome ?? vaga.plataforma} aceito, NADA foi enviado (modo ensaio ligado).`);
    else registrar('alerta', `Ensaio de "${vaga.titulo}" preenchido, mas ${resultado.observacao}. Veja a captura.`);
    emitir({ tipo: 'aviso', nivel: resultado.pronto ? 'sucesso' : 'info', msg: `Ensaio: ${vaga.titulo} ${resultado.pronto ? 'pronta para envio' : 'com pendência no formulário'}` });
  } else {
    registrar('sucesso', `Candidatura confirmada: "${vaga.titulo}" em ${vaga.empresa} — currículo ${versao}, regime ${regime ?? 'não pedido'}.`);
    emitir({ tipo: 'aviso', nivel: 'sucesso', msg: `Candidatura enviada: ${vaga.titulo} (${vaga.empresa})` });
    const irmas = encerrarIrmasEnviadas();
    if (irmas) registrar('info', `${irmas} publicação(ões) repetida(s) da mesma vaga saíram da lista — o currículo já foi para essa empresa.`);
  }
  kv.set('proximoEnvioEm', new Date(Date.now() + cfg.intervaloSegundos * 1000).toISOString());
}
