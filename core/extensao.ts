// O que o núcleo faz com o que a extensão de navegador relata.
//
// A extensão roda no SEU navegador, na sua sessão, e só OLHA as páginas de vaga que você abre: diz se a
// plataforma exige conta e quais campos obrigatórios não têm dado no seu perfil. Nada é preenchido nem enviado
// por ela — quem candidata continua sendo o núcleo, via Playwright.
//
// Fronteira de confiança: o núcleo é um servidor local sem senha, e qualquer extensão instalada no navegador
// poderia falar com ele. Por isso `/extensao/*` exige o token abaixo, que a pessoa cola no popup uma vez. E o
// que o núcleo devolve sobre o perfil são só BOOLEANOS (tenho celular? tenho CPF?) mais os enunciados das
// perguntas salvas — valor de dado pessoal nunca sai daqui.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { CampoFaltando, PlataformaDetectada } from '../src/types.ts';
import { DADO_PESSOAL, categoriaSensivel } from '../src/sensiveis.ts';
import { emitir } from './events.ts';
import { ler } from './estado.ts';
import { iaAtiva, responderPergunta } from './ia.ts';
import { candidaturas, kv, log } from './storage/db.ts';

export function tokenDaExtensao(): string {
  const salvo = kv.get<string>('extensaoToken', '');
  if (salvo) return salvo;
  const novo = randomBytes(16).toString('hex');
  kv.set('extensaoToken', novo);
  return novo;
}

export const autorizado = (cabecalho: string | undefined): boolean => !!cabecalho && cabecalho === `Bearer ${tokenDaExtensao()}`;

export const lerDeteccoes = (): PlataformaDetectada[] => Object.values(kv.get<Record<string, PlataformaDetectada>>('deteccoes', {})).sort((a, b) => (a.dominio < b.dominio ? -1 : 1));

const gravar = (d: PlataformaDetectada) => {
  const todas = kv.get<Record<string, PlataformaDetectada>>('deteccoes', {});
  todas[d.dominio] = d;
  kv.set('deteccoes', todas);
  emitir({ tipo: 'estado' });
};

/** O botão de candidatura em uma linha legível, para o diário. */
function descreverEnvio(e: NonNullable<PlataformaDetectada['envio']>): string {
  const clique = { sim: 'clicar ENVIA', nao: 'clicar navega', talvez: 'não dá para saber daqui o que o clique faz' }[e.clicarEnvia];
  const destino = e.href ? ` → ${e.href}` : '';
  const form = e.form ? ` | form ${e.form.metodo.toUpperCase()} ${e.form.action || '(mesma URL)'} com ${e.form.campos.length} campo(s): ${e.form.campos.join(', ')}` : '';
  return `<${e.tag}${e.classe ? ` class="${e.classe}"` : ''}> "${e.rotulo}"${destino} — ${clique}${form}`;
}

/** Uma plataforma foi vista pela extensão. `precisaLogin: null` = a detecção não teve certeza (ver conteudo.js). */
export function registrarPlataformaDetectada(e: {
  dominio: string;
  precisaLogin: boolean | null;
  logadoAtualmente: boolean;
  motivo: string;
  handler: string;
  url?: string;
  envio?: PlataformaDetectada['envio'];
}): PlataformaDetectada {
  if (!e.dominio) throw new Error('domínio ausente');
  const antes = kv.get<Record<string, PlataformaDetectada>>('deteccoes', {})[e.dominio];
  const nova: PlataformaDetectada = {
    dominio: e.dominio,
    precisaLogin: e.precisaLogin,
    logadoAtualmente: e.logadoAtualmente === true,
    motivo: String(e.motivo ?? '').slice(0, 200),
    handler: e.handler === 'generico' ? 'generico' : String(e.handler).slice(0, 40),
    detectadaEm: new Date().toISOString(),
    envio: e.envio ?? antes?.envio,
    camposFaltando: antes?.camposFaltando,
    camposEm: antes?.camposEm,
  };
  gravar(nova);
  const conta = nova.precisaLogin === true ? 'exige conta' : nova.precisaLogin === false ? 'não exige conta' : 'não deu para saber se exige conta';
  log.registrar(
    'info',
    `[extensão · ${nova.dominio}] ${conta}${nova.logadoAtualmente ? ', você está logado' : ''} — ${nova.motivo}. Motor: ${nova.handler === 'generico' ? 'genérico' : nova.handler}.`,
  );
  // O retrato do botão de candidatura, sem clique nenhum: é com esta linha que eu descubro o formulário logado
  // de uma plataforma sem ter a conta de ninguém. Vai sempre, mesmo sem novidade de login, porque o botão muda
  // quando a sessão muda — é justamente a diferença entre deslogado e logado que interessa.
  if (nova.envio) log.registrar('info', `[extensão · ${nova.dominio}] botão de candidatura: ${descreverEnvio(nova.envio)}`);
  return nova;
}

/**
 * Validação prévia: a extensão leu o formulário SEM preencher e diz o que é obrigatório e não tem dado. Serve
 * para você completar o perfil antes de ligar a automação, em vez de descobrir no meio de uma candidatura.
 */
export function registrarCamposFaltando(e: { dominio: string; url?: string; camposFaltando: CampoFaltando[] }): PlataformaDetectada {
  if (!e.dominio) throw new Error('domínio ausente');
  const antes = kv.get<Record<string, PlataformaDetectada>>('deteccoes', {})[e.dominio];
  const campos = (Array.isArray(e.camposFaltando) ? e.camposFaltando : [])
    .filter(c => c && typeof c.pergunta === 'string' && c.pergunta.trim())
    .slice(0, 30)
    .map(c => ({ pergunta: c.pergunta.trim().slice(0, 120), obrigatorio: c.obrigatorio === true, incerto: c.incerto === true }));
  const nova: PlataformaDetectada = {
    dominio: e.dominio,
    precisaLogin: antes?.precisaLogin ?? null,
    logadoAtualmente: antes?.logadoAtualmente ?? false,
    motivo: antes?.motivo ?? 'vista pela extensão ao ler um formulário de candidatura',
    handler: antes?.handler ?? 'generico',
    detectadaEm: antes?.detectadaEm ?? new Date().toISOString(),
    camposFaltando: campos,
    camposEm: new Date().toISOString(),
  };
  gravar(nova);
  if (campos.length) {
    const certos = campos.filter(c => c.obrigatorio);
    const duvidosos = campos.filter(c => !c.obrigatorio);
    if (certos.length) log.registrar('alerta', `[extensão · ${nova.dominio}] ${certos.length} campo(s) obrigatório(s) sem dado no seu perfil: ${certos.map(c => c.pergunta).join('; ')}.`);
    if (duvidosos.length) log.registrar('info', `[extensão · ${nova.dominio}] não tenho certeza se são obrigatórios, revise manualmente: ${duvidosos.map(c => c.pergunta).join('; ')}.`);
  }
  return nova;
}

/**
 * Tudo o que a extensão precisa para PREENCHER um formulário sozinha, inclusive com o ACV fechado depois
 * (ela guarda isto em cache).
 *
 * Aqui saem valores de verdade — nome, e-mail, telefone, respostas salvas, currículo. É uma mudança de
 * fronteira consciente em relação a `perfilParaExtensao`, que só diz "tem ou não tem": quem preenche precisa
 * do conteúdo. O que protege continua sendo o mesmo: servidor só em 127.0.0.1 e token obrigatório.
 */
export function dadosParaExtensao(comCurriculo: boolean): Record<string, unknown> {
  const p = ler.perfil();
  const cv = ler.curriculos()[0];
  const dados: Record<string, unknown> = {
    perfil: {
      nome: p?.nome ?? '',
      email: p?.email ?? '',
      telefone: p?.telefone ?? '',
      linkedin: p?.linkedin ?? '',
      cidade: p?.cidade ?? '',
      cpf: p?.cpf ?? '',
      pretensao: p?.pretensao ?? '',
      cargo: p?.cargo ?? '',
    },
    regimePreferido: ler.automacao().regimePreferido,
    perguntas: ler
      .perguntas()
      .filter(q => q.resposta.trim())
      .map(q => ({ pergunta: q.pergunta, resposta: q.resposta })),
  };
  if (comCurriculo && cv?.caminho) {
    try {
      dados.curriculo = { nome: basename(cv.caminho), base64: readFileSync(cv.caminho).toString('base64') };
    } catch {
      // currículo apagado do disco: a extensão segue sem anexo e avisa quando o campo for obrigatório
    }
  }
  return dados;
}

/**
 * A extensão candidatou numa plataforma e manda o que fez (inclusive o que aconteceu com o ACV fechado).
 * Entra no histórico junto com as candidaturas do robô: o Painel é a visão consolidada de tudo.
 */
export function receberCandidaturas(lista: { dominio?: string; url?: string; titulo?: string; empresa?: string; enviadaEm?: string }[]): number {
  if (!Array.isArray(lista)) throw new Error('lista de candidaturas inválida');
  const perfil = ler.perfil();
  const jaTem = new Set(candidaturas.listar().map(c => `${c.url}|${c.enviadaEm}`));
  let novas = 0;
  for (const c of lista.slice(0, 200)) {
    const url = String(c.url ?? '').slice(0, 500);
    const enviadaEm = c.enviadaEm && !Number.isNaN(Date.parse(c.enviadaEm)) ? c.enviadaEm : new Date().toISOString();
    if (!url || jaTem.has(`${url}|${enviadaEm}`)) continue; // reenvio da fila de pendentes não duplica o histórico
    candidaturas.inserir({
      vagaId: `extensao:${url}`,
      titulo: String(c.titulo ?? 'vaga').slice(0, 200),
      empresa: String(c.empresa ?? '').slice(0, 120) || 'Empresa não informada',
      plataforma: String(c.dominio ?? 'extensão').slice(0, 60),
      url,
      enviadaEm,
      nome: perfil?.nome ?? '',
      email: perfil?.email ?? '',
      celular: perfil?.telefone ?? '',
      curriculo: '',
      versao: 'original',
      regime: '',
      resultado: 'enviada',
    });
    novas++;
  }
  if (novas) {
    log.registrar('sucesso', `[extensão] ${novas} candidatura(s) feitas por você no navegador entraram no histórico.`);
    emitir({ tipo: 'estado' });
  }
  return novas;
}

/**
 * A extensão achou uma pergunta sem resposta salva e quer a IA. Ela roda AQUI porque é aqui que estão as travas:
 * autodeclaração e dado pessoal nunca chegam na IA (invariante 3), e sem IA configurada ninguém chuta nada.
 */
export async function responderParaExtensao(e: {
  pergunta?: string;
  opcoes?: string[];
  vaga?: { titulo?: string; empresa?: string; descricao?: string };
}): Promise<{ resposta: string | null; motivo?: string }> {
  const pergunta = String(e.pergunta ?? '').trim();
  if (!pergunta) return { resposta: null, motivo: 'pergunta vazia' };
  const sensivel = categoriaSensivel(pergunta);
  if (sensivel) return { resposta: null, motivo: `${sensivel.rotulo.toLowerCase()} é autodeclaração: só você responde (Configurações › Autodeclaração)` };
  if (DADO_PESSOAL.test(pergunta)) return { resposta: null, motivo: 'é um dado pessoal: a IA não adivinha isso' };
  const curriculo = ler.curriculos()[0]?.markdown;
  if (!curriculo || !iaAtiva()) return { resposta: null, motivo: 'IA não configurada no ACV' };
  const vaga = { titulo: String(e.vaga?.titulo ?? '').slice(0, 200), empresa: String(e.vaga?.empresa ?? '').slice(0, 120), descricao: String(e.vaga?.descricao ?? '').slice(0, 4000) };
  const resposta = await responderPergunta(curriculo, vaga, { rotulo: pergunta, tipo: e.opcoes?.length ? 'opcoes' : 'texto', opcoes: e.opcoes }, { cauteloso: true });
  return resposta ? { resposta } : { resposta: null, motivo: 'a IA preferiu não chutar' };
}

/** O que a extensão precisa para cruzar campo × perfil: quais dados EXISTEM, nunca o valor deles. */
export function perfilParaExtensao(): { tem: Record<string, boolean>; perguntas: string[] } {
  const p = ler.perfil();
  const cheio = (v: string | undefined) => !!v?.trim();
  return {
    tem: {
      nome: cheio(p?.nome),
      email: cheio(p?.email),
      celular: cheio(p?.telefone),
      linkedin: cheio(p?.linkedin),
      cidade: cheio(p?.cidade),
      cpf: cheio(p?.cpf),
      pretensao: cheio(p?.pretensao),
      curriculo: !!ler.curriculos()[0],
      regime: cheio(ler.automacao().regimePreferido),
    },
    perguntas: ler
      .perguntas()
      .filter(q => q.resposta.trim())
      .map(q => q.pergunta),
  };
}
