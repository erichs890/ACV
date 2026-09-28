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
import type { CampoFaltando, PlataformaDetectada } from '../src/types.ts';
import { emitir } from './events.ts';
import { ler } from './estado.ts';
import { kv, log } from './storage/db.ts';

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

/** Uma plataforma foi vista pela extensão. `precisaLogin: null` = a detecção não teve certeza (ver conteudo.js). */
export function registrarPlataformaDetectada(e: { dominio: string; precisaLogin: boolean | null; logadoAtualmente: boolean; motivo: string; handler: string; url?: string }): PlataformaDetectada {
  if (!e.dominio) throw new Error('domínio ausente');
  const antes = kv.get<Record<string, PlataformaDetectada>>('deteccoes', {})[e.dominio];
  const nova: PlataformaDetectada = {
    dominio: e.dominio,
    precisaLogin: e.precisaLogin,
    logadoAtualmente: e.logadoAtualmente === true,
    motivo: String(e.motivo ?? '').slice(0, 200),
    handler: e.handler === 'generico' ? 'generico' : String(e.handler).slice(0, 40),
    detectadaEm: new Date().toISOString(),
    camposFaltando: antes?.camposFaltando,
    camposEm: antes?.camposEm,
  };
  gravar(nova);
  const conta = nova.precisaLogin === true ? 'exige conta' : nova.precisaLogin === false ? 'não exige conta' : 'não deu para saber se exige conta';
  log.registrar(
    'info',
    `[extensão · ${nova.dominio}] ${conta}${nova.logadoAtualmente ? ', você está logado' : ''} — ${nova.motivo}. Motor: ${nova.handler === 'generico' ? 'genérico' : nova.handler}.`,
  );
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
