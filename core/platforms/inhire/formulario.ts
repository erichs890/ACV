// Motor de formulário adaptativo (ETAPA 1): descobre os controles da etapa visível, classifica (fixo × pergunta
// extra), preenche por tipo, avança de etapa e repete — sem supor quantas abas a vaga tem. Sem esperas fixas:
// cada espera é condicional (elemento visível/habilitado, campos mudaram, confirmação apareceu).
//
// Caminho adotado: schema via API (schema.ts) para resolver respostas antes de abrir o navegador + DOM aqui para
// preencher o que realmente está na página. Ver o cabeçalho de schema.ts para o porquê.
import type { Frame, Locator, Page } from 'playwright';
import type { PerguntaExtra } from '../../../src/types.ts';
import { PERGUNTA_CIDADE, PERGUNTA_CPF, type DadosCandidatura, type Log, type ResultadoCandidatura } from '../adapter.ts';
import { normalizar, similaridade } from '../../resume/texto.ts';
import { lerLocal, vagaCompativelComLocalizacao } from '../../localizacao.ts';
import { BOTAO_ANEXAR, BOTAO_FINAL, BOTAO_PROXIMO, CAMPO_FIXO, CPF_DE_TERCEIRO, PERGUNTA_CNPJ, ROTULO_FIXO, SEQUENCIAL, SUCESSO, type PapelFixo } from './selectors.ts';

export type Raiz = Page | Frame;
export type TipoCampo = 'texto' | 'textarea' | 'arquivo' | 'radio' | 'checkbox' | 'grupo' | 'select' | 'dropdown' | 'desconhecido';

export interface CampoDom {
  i: number; // índice marcado no DOM (data-autocv)
  tipo: TipoCampo;
  nome: string;
  rotulo: string;
  obrigatorio: boolean;
  opcoes: string[]; // radio/grupo/select; dropdown só depois de aberto
  preenchido: boolean;
  subtipo?: string; // type= do <input> ("url", "tel", "email"...): alguns exigem formato, como o LinkedIn em url
  html: string; // trecho para diagnóstico
}

export interface EtapaDescoberta {
  etapa: number;
  origem: 'inhire' | 'typeform';
  campos: { nome: string; rotulo: string; tipo: string; obrigatorio: boolean }[];
}

export interface Resultado {
  resultado: ResultadoCandidatura;
  etapas: EtapaDescoberta[];
  perguntasRespondidas: number;
  typeform: boolean;
}

// "R$ 4.500,00" | "4500" | "4.500" → dígitos em reais inteiros ("4500"): a máscara do InHire acrescenta ",00" sozinha
export function pretensaoEmReais(valor: string): string {
  const s = valor.replace(/[^\d,.]/g, '');
  if (!s) return '';
  return s.replace(/[,.]\d{1,2}$/, '').replace(/\D/g, '');
}

const pagina = (r: Raiz): Page => ('page' in r && typeof (r as Frame).page === 'function' ? (r as Frame).page() : (r as Page));

/** Espera condicional genérica: até `cond` ser verdadeira ou estourar o tempo. */
async function ate(cond: () => Promise<boolean>, timeoutMs: number, passoMs = 250): Promise<boolean> {
  const fim = Date.now() + timeoutMs;
  do {
    if (await cond().catch(() => false)) return true;
    await new Promise(r => setTimeout(r, passoMs));
  } while (Date.now() < fim);
  return false;
}

// ─── 1.1 Descoberta de campos da etapa visível ──────────────────────────────
export async function descobrirCampos(raiz: Raiz): Promise<CampoDom[]> {
  return raiz.evaluate(() => {
    // Visível de verdade: com área, não escondido e fora de blocos inativos ([inert]/aria-hidden, que questionários
    // sequenciais usam para as telas vizinhas)
    const visivel = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[inert], [aria-hidden="true"]');
    };
    const limpar = (s: string | null | undefined) =>
      (s ?? '')
        .replace(/\s+/g, ' ')
        .replace(/\s*\*\s*$/, '')
        .trim();
    // Primeiro trecho de texto de um rótulo ("Pessoa preta" sem a descrição que vem depois)
    const primeiroTexto = (el: Node): string => {
      for (const filho of el.childNodes) {
        if (filho.nodeType === Node.TEXT_NODE && filho.textContent?.trim()) return filho.textContent.trim();
        if (filho.nodeType === Node.ELEMENT_NODE && (filho as Element).tagName !== 'INPUT') {
          const t = primeiroTexto(filho);
          if (t) return t;
        }
      }
      return '';
    };
    const textoCurto = (el: Element) => limpar(primeiroTexto(el) || el.textContent).slice(0, 160);
    const rotuloDaCaixa = (cb: HTMLInputElement): Element | null => {
      const porFor = cb.id ? document.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : null;
      if (porFor) return porFor;
      const envolto = cb.closest('label');
      if (envolto) return envolto;
      const irmao = cb.nextElementSibling;
      if (irmao && irmao.tagName === 'LABEL') return irmao;
      return cb.parentElement?.querySelector('label') ?? cb.parentElement;
    };
    const temControle = (el: Element) => !!el.querySelector('input, textarea, select, .react-dropdown-select, button');
    // Rótulo bruto (mantém o "*" para saber se é obrigatório)
    const rotuloBruto = (el: Element): string => {
      const id = (el as HTMLInputElement).id;
      const porFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      if (porFor?.textContent?.trim()) return porFor.textContent.replace(/\s+/g, ' ').trim();
      const aria = el.getAttribute('aria-label');
      if (aria && aria !== 'Dropdown select') return aria.trim();
      const envolto = el.closest('label');
      if (envolto && envolto !== el) return envolto.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      let atual: Element | null = el;
      for (let nivel = 0; nivel < 6 && atual; nivel++) {
        let irmao = atual.previousElementSibling;
        while (irmao) {
          if (!temControle(irmao)) {
            const t = irmao.textContent?.replace(/\s+/g, ' ').trim() ?? '';
            if (t && t.length <= 240) return t;
          }
          irmao = irmao.previousElementSibling;
        }
        atual = atual.parentElement;
      }
      return (el as HTMLInputElement).placeholder ?? '';
    };
    for (const el of document.querySelectorAll('[data-autocv], [data-autocv-grupo]')) {
      el.removeAttribute('data-autocv');
      el.removeAttribute('data-autocv-grupo');
      el.removeAttribute('data-autocv-opcao');
    }
    const raizForm = document.querySelector('form') ?? document.body;
    const saida: { i: number; tipo: string; nome: string; rotulo: string; obrigatorio: boolean; opcoes: string[]; preenchido: boolean; subtipo?: string; html: string }[] = [];
    let n = 0;
    const marcar = (el: Element) => {
      el.setAttribute('data-autocv', String(n));
      return n++;
    };
    const vistos = new Set<Element>();

    // Dropdowns customizados (react-dropdown-select) e comboboxes
    // react-dropdown-select (InHire), combobox ARIA e botões que abrem lista ([aria-haspopup]) — inclusive os de opções
    // "ricas" (título + descrição), cujo texto principal é lido em abrirDropdown
    for (const dd of raizForm.querySelectorAll('.react-dropdown-select, [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"]')) {
      const pai = dd.closest('.react-dropdown-select');
      if (pai && pai !== dd) continue; // parte interna de um dropdown já contado
      if (!visivel(dd)) continue;
      const interno = dd.querySelector('input');
      if (interno) vistos.add(interno);
      // Widget que só enfeita um <select> nativo (custom-select.js do Vagas PJ deixa o original no DOM, invisível):
      // é o nativo que carrega name=, required e as opções. Sem ler dele, o campo vira uma pergunta anônima e
      // opcional — e um campo obrigatório que o robô resolveria sozinho acaba parando a candidatura.
      const nativo = (dd.querySelector('select[name]') ?? dd.parentElement?.querySelector('select[name]')) as HTMLSelectElement | null;
      if (nativo) vistos.add(nativo);
      const bruto = rotuloBruto(dd);
      const conteudo = dd.querySelector('.react-dropdown-select-content')?.textContent?.trim() ?? '';
      const preenchido = nativo ? nativo.value !== '' : (interno?.value ?? '') !== '' || (conteudo !== '' && !/^(selecione|informe|pesquise|escolha|selecionar|search|select)/i.test(conteudo));
      saida.push({
        i: marcar(dd),
        tipo: 'dropdown',
        nome: nativo?.getAttribute('name') ?? interno?.getAttribute('name') ?? '',
        rotulo: limpar(bruto),
        obrigatorio: /\*/.test(bruto) || nativo?.required === true || dd.getAttribute('aria-required') === 'true',
        opcoes: nativo
          ? [...nativo.options]
              .filter(op => !op.disabled)
              .map(op => op.text.trim())
              .filter(Boolean)
          : [],
        preenchido,
        html: dd.outerHTML.slice(0, 400),
      });
    }

    const radios = new Map<string, HTMLInputElement[]>();
    const checks: HTMLInputElement[] = [];
    for (const el of raizForm.querySelectorAll('input, textarea, select')) {
      if (vistos.has(el)) continue;
      const input = el as HTMLInputElement;
      const type = (input.type || 'text').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      const bruto = rotuloBruto(el);
      const base = { nome: input.name ?? '', rotulo: limpar(bruto), obrigatorio: input.required || el.getAttribute('aria-required') === 'true' || /\*/.test(bruto), html: el.outerHTML.slice(0, 400) };
      if (type === 'file') {
        saida.push({ i: marcar(el), tipo: 'arquivo', ...base, rotulo: base.rotulo || 'Arquivo', opcoes: [], preenchido: (input.files?.length ?? 0) > 0 });
        continue;
      }
      // Rádios e checkboxes costumam ser <input> invisíveis por trás de um desenho: vale a visibilidade do rótulo
      if (type === 'radio' || type === 'checkbox') {
        const dono = el.closest('label') ?? el.parentElement ?? el;
        if (!visivel(dono)) continue;
        if (type === 'radio') {
          const chave = input.name || `radio-${n}`;
          radios.set(chave, [...(radios.get(chave) ?? []), input]);
        } else checks.push(input);
        continue;
      }
      if (!visivel(el) || getComputedStyle(el).opacity === '0') continue;
      if (el.tagName === 'SELECT') {
        if (!el.closest('form')) continue; // seletor de idioma do topo
        const sel = el as HTMLSelectElement;
        // `disabled` cobre o rótulo-placeholder ("Tipo do CNPJ (MEI ou ME)"): não é resposta, não pode ser oferecido
        saida.push({
          i: marcar(el),
          tipo: 'select',
          ...base,
          opcoes: [...sel.options]
            .filter(o => !o.disabled)
            .map(o => o.text.trim())
            .filter(Boolean),
          preenchido: sel.value !== '' && sel.selectedIndex > 0,
        });
        continue;
      }
      // "+55 " no celular é só o prefixo da máscara, não um valor
      saida.push({
        i: marcar(el),
        tipo: el.tagName === 'TEXTAREA' ? 'textarea' : 'texto',
        ...base,
        subtipo: type,
        opcoes: [],
        preenchido: input.value.trim() !== '' && !/^\+\d{1,3}\s*$/.test(input.value),
      });
    }

    // Rádios agrupados por name: o rótulo é a pergunta do grupo, as opções são os rótulos de cada rádio
    for (const [chave, lista] of radios) {
      const primeiro = lista[0];
      const grupo = primeiro.closest('[role="radiogroup"], fieldset') ?? primeiro.parentElement?.parentElement ?? primeiro;
      const bruto = rotuloBruto(grupo);
      const i = n++;
      const opcoes = lista.map((r, k) => {
        r.setAttribute('data-autocv-grupo', String(i));
        r.setAttribute('data-autocv-opcao', String(k));
        const lab = rotuloDaCaixa(r);
        return (lab ? textoCurto(lab) : '') || r.value || `opção ${k + 1}`;
      });
      saida.push({ i, tipo: 'radio', nome: chave, rotulo: limpar(bruto), obrigatorio: /\*/.test(bruto), opcoes, preenchido: lista.some(r => r.checked), html: (grupo.outerHTML ?? '').slice(0, 400) });
    }

    // Checkboxes: vários irmãos = grupo de múltipla escolha; sozinho = aceite (termos)
    const porContainer = new Map<Element, HTMLInputElement[]>();
    for (const cb of checks) {
      const cont = cb.parentElement?.parentElement ?? cb.parentElement ?? raizForm;
      porContainer.set(cont, [...(porContainer.get(cont) ?? []), cb]);
    }
    for (const [cont, lista] of porContainer) {
      if (lista.length === 1) {
        const cb = lista[0];
        const bruto = rotuloBruto(cb);
        saida.push({
          i: marcar(cb),
          tipo: 'checkbox',
          nome: cb.name,
          rotulo: limpar(bruto).slice(0, 200),
          obrigatorio: cb.required || /\*/.test(bruto),
          opcoes: [],
          preenchido: cb.checked,
          html: cb.outerHTML.slice(0, 400),
        });
        continue;
      }
      const bruto = rotuloBruto(cont);
      const i = n++;
      const opcoes = lista.map((cb, k) => {
        cb.setAttribute('data-autocv-grupo', String(i));
        cb.setAttribute('data-autocv-opcao', String(k));
        const lab = rotuloDaCaixa(cb);
        return (lab ? textoCurto(lab) : '') || (cb.value !== 'on' ? cb.value : '') || `opção ${k + 1}`;
      });
      saida.push({ i, tipo: 'grupo', nome: lista[0].name, rotulo: limpar(bruto), obrigatorio: /\*/.test(bruto), opcoes, preenchido: lista.some(cb => cb.checked), html: cont.outerHTML.slice(0, 400) });
    }
    return saida as { i: number; tipo: TipoCampo; nome: string; rotulo: string; obrigatorio: boolean; opcoes: string[]; preenchido: boolean; subtipo?: string; html: string }[];
  }) as Promise<CampoDom[]>;
}

const assinatura = (campos: CampoDom[]) => campos.map(c => `${c.tipo}:${c.nome}:${c.rotulo}`).join('|');

// ─── Opções: escolher a mais parecida ───────────────────────────────────────
export function melhorOpcao(opcoes: string[], valor: string): number {
  const v = normalizar(valor);
  if (!v) return -1;
  const ns = opcoes.map(normalizar);
  let k = ns.indexOf(v);
  if (k < 0) k = ns.findIndex(o => o.startsWith(v) || v.startsWith(o));
  if (k < 0) k = ns.findIndex(o => o.includes(v) || v.includes(o));
  if (k < 0) {
    let melhor = 0;
    ns.forEach((o, i) => {
      const s = similaridade(o, v);
      if (s > melhor && s >= 0.6) {
        melhor = s;
        k = i;
      }
    });
  }
  return k;
}

const dividirMultipla = (valor: string) =>
  valor
    .split(/\s*\|\s*|\s*;\s*/)
    .map(s => s.trim())
    .filter(Boolean);

// ─── 1.2 Classificação: fixo × pergunta extra ───────────────────────────────
export type Resolucao =
  | { acao: 'valor'; valor: string; mascarado?: boolean }
  | { acao: 'valores'; valores: string[] }
  | { acao: 'arquivo' }
  | { acao: 'marcar' }
  | { acao: 'pular'; motivo: string }
  | { acao: 'pergunta'; pergunta: PerguntaExtra };

/**
 * LinkedIn num campo `type="url"`: o navegador recusa "linkedin.com/in/fulano" sem esquema e o formulário nem
 * envia (Vagas PJ ainda exige `pattern` com linkedin.com/in). Em campo de texto comum o valor vai como está —
 * o InHire guarda só o usuário em `linkedinUsername`.
 */
export function urlDoLinkedin(valor: string): string {
  const v = valor.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (/linkedin\.com/i.test(v)) return `https://${v.replace(/^\/+/, '')}`;
  return `https://www.linkedin.com/in/${v.replace(/^\/+|\/+$/g, '')}`;
}

export function papelDe(campo: Pick<CampoDom, 'nome' | 'rotulo' | 'tipo'>): PapelFixo | null {
  if (campo.nome && CAMPO_FIXO[campo.nome]) return CAMPO_FIXO[campo.nome];
  if (campo.nome.startsWith('questionsDiversity')) return null;
  const porRotulo = ROTULO_FIXO.find(([re]) => re.test(campo.rotulo))?.[1] ?? null;
  if (porRotulo === 'curriculo' && campo.tipo !== 'arquivo') return null;
  // CPF só preenche campo de digitar, e só quando é o do próprio candidato: "Você possui CPF?" (sim/não)
  // ou "CPF do responsável" viram pergunta normal em vez de receberem o número.
  if (porRotulo === 'cpf' && (CPF_DE_TERCEIRO.test(campo.rotulo) || !['texto', 'textarea'].includes(campo.tipo))) return null;
  return porRotulo;
}

/**
 * "Você tem disponibilidade para trabalhar no modelo presencial em São Paulo, Pinheiros - SP?"
 *
 * Responder "Sim" no automático era declarar, em nome do usuário e para um empregador real, uma disponibilidade
 * que pode não existir — a vaga presencial passa pelo filtro de regime mesmo estando do outro lado do país.
 * Regra: sem exigência de presença, ou presença na cidade/estado do usuário → "Sim". Cidade diferente → pergunta.
 */
export function disponibilidadeNoModelo(campo: CampoDom, dados: DadosCandidatura): Resolucao {
  const sim = (): Resolucao => {
    const k = melhorOpcao(campo.opcoes, 'Sim');
    return { acao: 'valor', valor: k >= 0 ? campo.opcoes[k] : 'Sim' };
  };
  const perguntar = (): Resolucao => ({
    acao: 'pergunta',
    pergunta: {
      rotulo: campo.rotulo || 'Você tem disponibilidade para o modelo da vaga?',
      tipo: campo.opcoes.length ? 'opcoes' : 'texto',
      opcoes: campo.opcoes.length ? campo.opcoes : undefined,
      obrigatoria: true,
    },
  });

  // Só entra em dúvida quando há presença física em jogo
  if (!/presencial|h[íi]brid|no escrit[óo]rio|in\s?loco/i.test(campo.rotulo)) return sim();
  // Sem a cidade do usuário não dá para comparar: melhor perguntar do que afirmar
  if (!dados.cidade.trim()) return perguntar();
  // O lugar vem no próprio rótulo, depois do último "em": "... presencial em São Paulo, Brasil, Pinheiros - SP?"
  const local = (campo.rotulo.match(/^.*\bem\s+(.+?)\s*\?*\s*$/i)?.[1] ?? '').trim();
  const lido = local ? lerLocal(local) : { cidade: '', uf: '' };
  if (!lido.cidade && !lido.uf) return perguntar(); // não deu para saber onde é: não afirmo nada
  // Mesma regra do score: mesma cidade ou mesmo estado = dá para ir; fora disso, pergunta em vez de afirmar
  const r = vagaCompativelComLocalizacao({ modelo: 'presencial', local }, { localizacaoPresencial: dados.cidade, paisesRemoto: [] });
  return r.compativel && r.fator >= 0.6 ? sim() : perguntar();
}

export function resolverCampo(campo: CampoDom, dados: DadosCandidatura): Resolucao {
  const papel = papelDe(campo);
  const extra = (tipo: PerguntaExtra['tipo']): Resolucao => {
    const pergunta: PerguntaExtra = { rotulo: campo.rotulo || campo.nome, tipo, opcoes: tipo === 'texto' ? undefined : campo.opcoes, obrigatoria: campo.obrigatorio };
    const resposta = dados.responder(pergunta);
    if (resposta !== null) return tipo === 'multipla' ? { acao: 'valores', valores: dividirMultipla(resposta) } : { acao: 'valor', valor: resposta };
    if (!campo.obrigatorio) return { acao: 'pular', motivo: 'opcional, sem resposta guardada' };
    return { acao: 'pergunta', pergunta };
  };
  switch (papel) {
    case 'ignorar':
      return { acao: 'pular', motivo: 'preenchido pela própria página' };
    case 'nome':
      return { acao: 'valor', valor: dados.nome };
    case 'email':
      return { acao: 'valor', valor: dados.email };
    case 'celular':
      return { acao: 'valor', valor: dados.celular.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, ''), mascarado: true };
    case 'cpf':
      return dados.cpf.replace(/\D/g, '').length === 11
        ? { acao: 'valor', valor: dados.cpf.replace(/\D/g, ''), mascarado: true }
        : { acao: 'pergunta', pergunta: { rotulo: PERGUNTA_CPF, tipo: 'texto' } };
    case 'linkedin':
      if (!dados.linkedin) return extra('texto');
      return { acao: 'valor', valor: campo.subtipo === 'url' ? urlDoLinkedin(dados.linkedin) : dados.linkedin };
    case 'pretensao':
      return dados.pretensao ? { acao: 'valor', valor: pretensaoEmReais(dados.pretensao), mascarado: true } : extra('texto');
    case 'pais':
      return { acao: 'valor', valor: 'Brasil' };
    case 'cidade':
      return dados.cidade.trim() ? { acao: 'valor', valor: dados.cidade.trim() } : { acao: 'pergunta', pergunta: { rotulo: PERGUNTA_CIDADE, tipo: 'texto' } };
    case 'cep':
      return extra('texto');
    case 'modelo':
      return disponibilidadeNoModelo(campo, dados);
    case 'regime': {
      const k = dados.regime ? melhorOpcao(campo.opcoes, dados.regime) : -1;
      return { acao: 'valor', valor: k >= 0 ? campo.opcoes[k] : (dados.regime ?? campo.opcoes[0] ?? '') };
    }
    case 'indicacao': {
      const salva = dados.responder({ rotulo: campo.rotulo || 'Foi indicado por alguém da empresa?', tipo: 'opcoes', opcoes: campo.opcoes });
      return { acao: 'valor', valor: salva ?? campo.opcoes.find(o => /^n[ãa]o/i.test(o)) ?? campo.opcoes[0] ?? 'Não' };
    }
    case 'curriculo':
      return { acao: 'arquivo' };
    case 'cnpj': {
      // Rótulo fixo: respondida uma vez, vale para todas as vagas PJ seguintes
      const pergunta: PerguntaExtra = { rotulo: PERGUNTA_CNPJ, tipo: 'opcoes', opcoes: campo.opcoes.length ? campo.opcoes : ['MEI', 'ME', 'Não tenho'], obrigatoria: true };
      const salva = dados.responder(pergunta);
      return salva !== null ? { acao: 'valor', valor: salva } : { acao: 'pergunta', pergunta };
    }
    case 'termos':
      return { acao: 'marcar' };
    default:
      if (campo.tipo === 'arquivo') return { acao: 'pular', motivo: 'anexo que não é o currículo' };
      if (campo.tipo === 'checkbox') return campo.obrigatorio ? { acao: 'marcar' } : extra('opcoes');
      if (campo.tipo === 'desconhecido') return { acao: 'pergunta', pergunta: { rotulo: campo.rotulo || campo.nome, tipo: 'texto' } };
      return extra(campo.tipo === 'grupo' ? 'multipla' : campo.tipo === 'radio' || campo.tipo === 'select' || campo.tipo === 'dropdown' ? 'opcoes' : 'texto');
  }
}

// ─── 1.3 Preenchimento por tipo ─────────────────────────────────────────────
const campoLoc = (raiz: Raiz, c: CampoDom): Locator => raiz.locator(`[data-autocv="${c.i}"]`).first();
const opcaoLoc = (raiz: Raiz, c: CampoDom, k: number): Locator => raiz.locator(`[data-autocv-grupo="${c.i}"][data-autocv-opcao="${k}"]`).first();

/** Abre um dropdown customizado, opcionalmente filtra digitando, e devolve os textos das opções visíveis. */
/** Opção de dropdown: componentes "ricos" têm título + descrição; a comparação usa só o título. */
export interface OpcaoDropdown {
  textoPrincipal: string;
  textoSecundario?: string;
}

async function abrirDropdown(raiz: Raiz, loc: Locator, filtro?: string): Promise<OpcaoDropdown[]> {
  const opcoes = raiz.locator('[role="option"]');
  const p = pagina(raiz);
  if (!(await loc.getAttribute('aria-expanded').catch(() => null)) || (await loc.getAttribute('aria-expanded')) === 'false') await loc.click();
  await ate(async () => (await opcoes.count()) > 0, 5000);
  if (filtro) {
    await p.keyboard.type(filtro, { delay: 30 });
    // Lista filtrada (ou carregada da API, no caso da cidade) — espera aparecer algo parecido com o filtro
    await ate(
      async () => {
        const t = (await lerOpcoes(opcoes)).map(o => o.textoPrincipal);
        return t.length > 0 && melhorOpcao(t, filtro) >= 0;
      },
      8000,
      300,
    );
  }
  return lerOpcoes(opcoes);
}

// Título = primeiro trecho de texto ("Homem Cisgênero"); o que sobra é a descrição ("Nasceu homem e se identifica...")
function lerOpcoes(opcoes: Locator): Promise<OpcaoDropdown[]> {
  return opcoes.evaluateAll(els =>
    els.map(el => {
      const primeiro = (n: Node): string => {
        for (const f of n.childNodes) {
          if (f.nodeType === Node.TEXT_NODE && f.textContent?.trim()) return f.textContent.trim();
          if (f.nodeType === Node.ELEMENT_NODE) {
            const t = primeiro(f);
            if (t) return t;
          }
        }
        return '';
      };
      const tudo = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const principal = (primeiro(el) || tudo).replace(/\s+/g, ' ').trim();
      const resto = tudo.startsWith(principal) ? tudo.slice(principal.length).trim() : '';
      return { textoPrincipal: principal, ...(resto ? { textoSecundario: resto } : {}) };
    }),
  );
}

async function fecharDropdown(raiz: Raiz) {
  await pagina(raiz)
    .keyboard.press('Escape')
    .catch(() => {});
}

export async function lerOpcoesDropdown(raiz: Raiz, loc: Locator): Promise<string[]> {
  const opcoes = await abrirDropdown(raiz, loc);
  await fecharDropdown(raiz);
  return opcoes.map(o => o.textoPrincipal);
}

async function escolherNoDropdown(raiz: Raiz, c: CampoDom, valor: string) {
  const loc = campoLoc(raiz, c);
  let opcoes = await abrirDropdown(raiz, loc);
  const titulos = () => opcoes.map(o => o.textoPrincipal);
  let k = melhorOpcao(titulos(), valor);
  if (k < 0 || opcoes.length > 30) {
    opcoes = await abrirDropdown(raiz, loc, valor);
    k = melhorOpcao(titulos(), valor);
  }
  if (k < 0) {
    await fecharDropdown(raiz);
    throw new Error(`opção "${valor}" não existe em "${c.rotulo}" (opções: ${titulos().slice(0, 8).join(', ') || 'nenhuma carregou'})`);
  }
  await raiz.locator('[role="option"]').nth(k).click();
  await ate(async () => (await raiz.locator('[role="option"]').count()) === 0, 3000);
  const o = opcoes[k];
  return o.textoSecundario ? `${o.textoPrincipal} (${o.textoSecundario.slice(0, 60)}${o.textoSecundario.length > 60 ? '…' : ''})` : o.textoPrincipal;
}

async function anexar(raiz: Raiz, c: CampoDom, caminho: string, log: Log) {
  const p = pagina(raiz);
  const input = campoLoc(raiz, c);
  // Pelo mesmo caminho do usuário (botão → seletor de arquivo): setInputFiles direto não atualiza a UI do InHire
  const botao = raiz.locator('button').filter({ hasText: BOTAO_ANEXAR }).first();
  if ((await botao.count()) > 0 && (await botao.isVisible())) {
    try {
      const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 5000 }), botao.click()]);
      await chooser.setFiles(caminho);
    } catch {
      await input.setInputFiles(caminho);
    }
  } else {
    await input.setInputFiles(caminho);
  }
  const ok = await ate(async () => input.evaluate(el => ((el as HTMLInputElement).files?.length ?? 0) > 0), 5000);
  if (!ok) throw new Error('o currículo não ficou anexado no formulário');
  log('info', `Currículo anexado (${caminho.split(/[\\/]/).pop()}).`);
}

async function preencherCampo(raiz: Raiz, c: CampoDom, r: Resolucao, dados: DadosCandidatura, log: Log): Promise<boolean> {
  const rotulo = c.rotulo || c.nome;
  switch (r.acao) {
    case 'pular':
      if (!/própria página/.test(r.motivo)) log('info', `Campo "${rotulo}" pulado: ${r.motivo}.`);
      return false;
    case 'arquivo':
      await anexar(raiz, c, dados.curriculoPdf, log);
      return true;
    case 'marcar': {
      const loc = campoLoc(raiz, c);
      if (!(await loc.isChecked().catch(() => false))) await loc.check({ force: true });
      log('info', `Aceite marcado: "${rotulo.slice(0, 90)}".`);
      return true;
    }
    case 'valores':
    case 'valor': {
      const valores = r.acao === 'valores' ? r.valores : [r.valor];
      switch (c.tipo) {
        case 'texto':
        case 'textarea': {
          const loc = campoLoc(raiz, c);
          await loc.click();
          await loc.fill('');
          if (r.acao === 'valor' && r.mascarado) await loc.pressSequentially(valores[0], { delay: 15 });
          else await loc.fill(valores[0]);
          break;
        }
        case 'select':
          await campoLoc(raiz, c).selectOption({ label: c.opcoes[melhorOpcao(c.opcoes, valores[0])] ?? valores[0] });
          break;
        case 'dropdown': {
          const escolhida = await escolherNoDropdown(raiz, c, valores[0]);
          log('info', `"${rotulo}": ${escolhida}.`);
          return true;
        }
        case 'radio':
        case 'grupo':
          for (const v of valores) {
            const k = melhorOpcao(c.opcoes, v);
            if (k < 0) throw new Error(`opção "${v}" não existe em "${rotulo}" (opções: ${c.opcoes.join(', ')})`);
            await opcaoLoc(raiz, c, k).check({ force: true });
          }
          break;
        case 'checkbox': {
          const loc = campoLoc(raiz, c);
          const quer = /^(sim|aceito|yes|true|marcar)/i.test(valores[0]);
          if (quer !== (await loc.isChecked())) await loc.click({ force: true });
          break;
        }
        default:
          throw new Error(`não sei preencher "${rotulo}" (tipo ${c.tipo})`);
      }
      const mostrado = /senha|password/i.test(rotulo) ? '•••' : valores.join(' | ');
      log('info', `"${rotulo}": ${mostrado.length > 60 ? `${mostrado.slice(0, 57)}...` : mostrado}.`);
      return true;
    }
    case 'pergunta':
      return false;
  }
}

// ─── 1.4 Navegação entre etapas ─────────────────────────────────────────────
type Botao = { loc: Locator; texto: string; final: boolean };

/** Textos que identificam "próxima etapa", "envio final" e "candidatura aceita" numa plataforma. */
export interface Convencoes {
  proximo: RegExp;
  final: RegExp;
  sucesso: RegExp;
  nome?: string; // como a plataforma é citada nas mensagens, com artigo: "o InHire", "o Vagas PJ"
}
const CONVENCOES_INHIRE: Convencoes = { proximo: BOTAO_PROXIMO, final: BOTAO_FINAL, sucesso: SUCESSO, nome: 'o InHire' };

/**
 * Botão de avançar/enviar da etapa. Duas sutilezas do InHire real:
 *  - procura primeiro DENTRO do formulário: o cabeçalho da página tem um "Candidatar" que só rola a tela;
 *  - o botão de verdade vem embrulhado num `<div role="button">` com o mesmo texto. O `<button>` interno é o
 *    que habilita/desabilita, então ele tem preferência; o `div` fica de reserva para layouts sem `<button>`.
 * `conv` deixa outra plataforma reaproveitar o motor com os textos dela.
 */
async function acharBotao(raiz: Raiz, conv: Convencoes = CONVENCOES_INHIRE): Promise<Botao | null> {
  for (const escopo of ['form ', '']) {
    const botoes = raiz.locator(`${escopo}button, ${escopo}input[type="submit"], ${escopo}[role="button"]`);
    const total = await botoes.count().catch(() => 0);
    let proximo: Botao | null = null;
    let final: Botao | null = null;
    for (let i = 0; i < total; i++) {
      const b = botoes.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      const texto = ((await b.textContent()) ?? (await b.getAttribute('value')) ?? '').replace(/\s+/g, ' ').trim();
      if (!texto) continue;
      const real = ['BUTTON', 'INPUT'].includes(await b.evaluate(el => el.tagName).catch(() => ''));
      // Primeiro achado vale; um <button> de verdade substitui um [role=button] já guardado com o mesmo papel
      if (conv.proximo.test(texto)) {
        if (!proximo || (real && proximo.texto === texto)) proximo = { loc: b, texto, final: false };
      } else if (conv.final.test(texto)) {
        if (!final || (real && final.texto === texto)) final = { loc: b, texto, final: true };
      }
    }
    if (proximo) return proximo;
    if (final) return final;
  }
  return null;
}

const habilitado = async (loc: Locator) => (await loc.isEnabled()) && (await loc.getAttribute('aria-disabled')) !== 'true' && (await loc.getAttribute('data-disabled')) !== 'true';

async function errosVisiveis(raiz: Raiz): Promise<string[]> {
  return raiz.evaluate(() =>
    [...document.querySelectorAll('[aria-invalid="true"], [role="alert"], [class*="error" i], [class*="Error" i], [data-qa*="error"]')]
      .filter(e => e.getBoundingClientRect().height > 0)
      .map(e => (e.getAttribute('name') || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 6),
  );
}

// ─── Typeform (perguntas da empresa, depois de criar o talento) ─────────────
// O Typeform mantém no DOM só o bloco atual e os vizinhos; o ativo é o único sem `inert`. Tudo acontece nele:
// escolhas são botões role=radio/checkbox (texto "TeclaASim" = atalho + rótulo), texto é input/textarea, e OK avança.
const limparOpcaoTypeform = (t: string) =>
  t
    .replace(/^\s*(tecla|key)\s*[a-z0-9]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

export async function preencherTypeform(frame: Raiz, dados: DadosCandidatura, log: Log, ensaio: boolean): Promise<{ resultado: ResultadoCandidatura; etapa: EtapaDescoberta; respondidas: number }> {
  const etapa: EtapaDescoberta = { etapa: 0, origem: 'typeform', campos: [] };
  let respondidas = 0;
  const start = frame.locator('[data-qa*="start-button"]').first();
  if (await ate(() => start.isVisible(), 4000)) await start.click();
  const ativo = () => frame.locator('[data-qa^="blocktype-"]:not([inert])').first();
  // O último bloco (com o Enviar) já existe no DOM como vizinho do penúltimo: só vale o Enviar do bloco ativo
  const submit = async () => ((await ativo().count()) ? ativo().locator('[data-qa*="submit-button"]').first() : frame.locator('[data-qa*="submit-button"]').first());
  const submitVisivel = async () => (await submit()).isVisible().catch(() => false);
  const tituloDe = async (bloco: Locator) =>
    (
      (await bloco
        .locator('[data-qa*="block-title"]')
        .first()
        .textContent()
        .catch(() => '')) ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim();
  const falha = (motivo: string) => ({ resultado: { status: 'erro' as const, motivo }, etapa, respondidas });

  let anterior = '';
  for (let passo = 0; passo < 60; passo++) {
    if (!(await ate(async () => (await ativo().count()) > 0 || submitVisivel(), 8000))) return falha('o Typeform não mostrou a próxima pergunta');
    if ((await ativo().count()) === 0) break; // só o envio restou
    const bloco = ativo();
    const tipoBloco = ((await bloco.getAttribute('data-qa')) ?? '').replace('blocktype-', '').split(' ')[0];
    const tituloBruto = await tituloDe(bloco);
    const chave = `${tipoBloco}|${tituloBruto}`;
    if (chave === anterior) {
      const erro = await bloco
        .locator('[data-qa*="error-message"]')
        .first()
        .textContent()
        .catch(() => '');
      return falha(`o Typeform não avançou de "${tituloBruto.slice(0, 60)}"${erro?.trim() ? `: ${erro.trim().slice(0, 100)}` : ''}`);
    }
    anterior = chave;
    const obrigatoria = /\*\s*$/.test(tituloBruto);
    const titulo = tituloBruto.replace(/\s*\*\s*$/, '');
    const ok = bloco.locator('[data-qa*="ok-button"], button:has-text("OK")').first();
    const avancar = async () => {
      if (await submitVisivel()) return;
      await ok.click({ timeout: 4000 }).catch(() => {});
      await ate(async () => (await ativo().count()) === 0 || (await tituloDe(ativo())) !== tituloBruto || submitVisivel(), 6000);
    };
    if (['statement', 'group', 'welcome_screen'].includes(tipoBloco) || !titulo) {
      await avancar();
      continue;
    }
    const escolhas = bloco.locator('[role="radio"], [role="checkbox"]');
    const opcoes = (await escolhas.allTextContents()).map(limparOpcaoTypeform);
    const multipla = (await bloco.locator('[role="checkbox"]').count()) > 0;
    const tipo: PerguntaExtra['tipo'] = opcoes.length ? (multipla ? 'multipla' : 'opcoes') : tipoBloco === 'file_upload' ? 'arquivo' : 'texto';
    etapa.campos.push({ nome: tipoBloco, rotulo: titulo, tipo, obrigatorio: obrigatoria });
    if (tipo === 'arquivo') {
      if (obrigatoria) return falha(`o Typeform pede um anexo ("${titulo}") e o robô só anexa o currículo no formulário principal`);
      await avancar();
      continue;
    }
    const pergunta: PerguntaExtra = { rotulo: titulo, tipo, opcoes: tipo === 'texto' ? undefined : opcoes, obrigatoria };
    const resposta = dados.responder(pergunta);
    if (resposta === null) {
      if (obrigatoria) return { resultado: { status: 'pergunta', pergunta }, etapa, respondidas };
      log('info', `Pergunta opcional "${titulo}" pulada (sem resposta guardada).`);
      await avancar();
      continue;
    }
    if (opcoes.length) {
      for (const v of tipo === 'multipla' ? dividirMultipla(resposta) : [resposta]) {
        const idx = melhorOpcao(opcoes, v);
        if (idx < 0) return falha(`resposta "${v}" não bate com as opções de "${titulo}" (${opcoes.join(', ')})`);
        const opcao = escolhas.nth(idx);
        const marcada = () => opcao.getAttribute('aria-checked').then(a => a === 'true');
        // O bloco ainda pode estar deslizando: clica de novo se a marcação não pegou
        for (let tentativa = 0; tentativa < 3 && !(await marcada()); tentativa++) {
          await opcao.click();
          await ate(marcada, 1500);
        }
        if (!(await marcada())) return falha(`não consegui marcar "${v}" em "${titulo}"`);
      }
    } else if (tipoBloco === 'dropdown') {
      await bloco.locator('input').first().fill(resposta);
      const op = frame
        .locator('[role="option"], [data-qa*="dropdown-option"]')
        .filter({ hasText: resposta.slice(0, 30) })
        .first();
      if (!(await ate(() => op.isVisible(), 5000))) return falha(`opção "${resposta}" não apareceu em "${titulo}"`);
      await op.click();
    } else {
      await bloco.locator('input, textarea').first().fill(resposta);
    }
    respondidas++;
    log('info', `Typeform · "${titulo}": ${resposta.length > 60 ? `${resposta.slice(0, 57)}...` : resposta}.`);
    if (await submitVisivel()) break; // era a última pergunta
    await avancar();
  }
  if (!(await ate(submitVisivel, 5000))) return falha('botão de envio do Typeform não apareceu');
  if (ensaio) return { resultado: { status: 'ensaio', captura: '', pronto: true }, etapa, respondidas };
  await (await submit()).click();
  const agradeceu = await ate(
    async () => (await frame.locator('[data-qa*="thankyou"], [data-qa*="thank"]').count()) > 0 || /obrigad|enviad|conclu/i.test(await frame.evaluate(() => document.body.innerText)),
    20000,
    500,
  );
  return agradeceu ? { resultado: { status: 'enviada' }, etapa, respondidas } : falha('o Typeform não confirmou o envio das respostas');
}

// ─── Modo sequencial (uma pergunta por tela) ───────────────────────────────
// ETAPA 0 (confirmada em 18/09/2026): o questionário sequencial NÃO é a página principal. Ele chega como iframe —
// do próprio InHire (form-app.inhire.app/form?…&formId=<typeformId>&type=subscription) nas candidaturas, ou do
// Typeform (form.typeform.com/to/<id>) em /forms/preview. O InHire também pode renderizar nativo; por isso a detecção
// roda a cada etapa e olha frames E a página. A definição das perguntas vem da API pública do Typeform (schema.ts).
export type ModoEtapa = { modo: 'abas' } | { modo: 'sequencial'; raiz: Raiz; motor: 'typeform' | 'generico'; origem: string };

export async function detectarModo(page: Page): Promise<ModoEtapa> {
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    if (SEQUENCIAL.frameTypeform.test(f.url())) return { modo: 'sequencial', raiz: f, motor: 'typeform', origem: 'iframe do Typeform' };
    if (SEQUENCIAL.frameInHire.test(f.url())) return { modo: 'sequencial', raiz: f, motor: 'generico', origem: 'iframe form-app.inhire.app' };
  }
  // O <iframe> pode existir sem o frame ter carregado (erro de rede/CSP): ainda é o modo sequencial, e o motor
  // vai reportar "não carregou" em vez de tentar preencher a página de trás
  for (const el of await page.locator('iframe[src]').elementHandles()) {
    const src = (await el.getAttribute('src')) ?? '';
    const tf = SEQUENCIAL.frameTypeform.test(src);
    if (!tf && !SEQUENCIAL.frameInHire.test(src)) continue;
    const f = await el.contentFrame();
    if (f) return { modo: 'sequencial', raiz: f, motor: tf ? 'typeform' : 'generico', origem: `iframe ${tf ? 'do Typeform' : 'form-app.inhire.app'} (ainda carregando)` };
  }
  const nativo = await page
    .evaluate(() => {
      const texto = document.body.innerText;
      const blocos = document.querySelectorAll('[data-qa^="blocktype-"]').length;
      return { blocos, boasVindas: /responda as perguntas|para finalizar sua inscri/i.test(texto) };
    })
    .catch(() => ({ blocos: 0, boasVindas: false }));
  if (nativo.blocos > 0) return { modo: 'sequencial', raiz: page, motor: 'typeform', origem: 'blocos do Typeform na própria página' };
  if (nativo.boasVindas) return { modo: 'sequencial', raiz: page, motor: 'generico', origem: 'questionário nativo na página' };
  return { modo: 'abas' };
}

const LIMITE_ITERACOES = 50;
type SaidaSequencial = { status: 'concluido' | 'ensaio' } | { status: 'pergunta'; pergunta: PerguntaExtra } | { status: 'erro'; motivo: string };

/**
 * Espera o questionário renderizar algo (o form-app já ficou em branco por deploy quebrado do InHire).
 *
 * 20 s era pouco: em 23/09/2026, 15 vagas de 4 empresas morreram aqui ou na tela seguinte. O iframe carrega
 * uma aplicação inteira (QuillForms) de outro domínio, e desistir cedo transforma lentidão em "erro" numa
 * candidatura que só precisava de mais alguns segundos.
 */
const ESPERA_QUESTIONARIO_MS = 45_000;

async function esperarQuestionario(raiz: Raiz): Promise<boolean> {
  return ate(
    async () => raiz.evaluate(() => document.body.innerText.trim().length > 0 || document.querySelector('input, textarea, button, [role="radio"], [role="option"]') !== null),
    ESPERA_QUESTIONARIO_MS,
    500,
  );
}

const textoVisivel = (raiz: Raiz) => raiz.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());

/** Pergunta em destaque na tela: o maior heading/legenda visível, senão o rótulo do primeiro controle. */
async function perguntaAtual(raiz: Raiz): Promise<string> {
  return raiz.evaluate(() => {
    const vis = (el: Element) => el.getBoundingClientRect().height > 0 && !el.closest('[inert], [aria-hidden="true"]');
    const cands = [...document.querySelectorAll('h1, h2, h3, [role="heading"], legend, [data-qa*="title"], label')].filter(vis);
    let melhor = '';
    let tamanho = 0;
    for (const el of cands) {
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 300) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (fs > tamanho || (!melhor && t)) {
        tamanho = fs;
        melhor = t;
      }
    }
    return melhor.replace(/\s*\*\s*$/, '');
  });
}

// Escolhas que não são <input>: cartões/botões com role radio|option|checkbox, fora de blocos inativos
const SELETOR_ESCOLHAS =
  '[role="radio"]:not(input):not([inert] *):not([aria-hidden="true"] *), [role="option"]:not([inert] *):not([aria-hidden="true"] *), [role="checkbox"]:not(input):not([inert] *):not([aria-hidden="true"] *)';

/** Escolhas visíveis da tela atual (padrão dos questionários sequenciais). */
async function escolhasVisiveis(raiz: Raiz): Promise<{ textos: string[]; multipla: boolean }> {
  const loc = raiz.locator(SELETOR_ESCOLHAS);
  const textos: string[] = [];
  let multipla = false;
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    if ((await el.getAttribute('role')) === 'checkbox') multipla = true;
    textos.push(limparOpcaoTypeform((await el.textContent()) ?? ''));
  }
  return { textos, multipla };
}

async function botaoPor(raiz: Raiz, re: RegExp): Promise<Locator | null> {
  // fora de blocos inativos: o "Enviar" da última tela já existe no DOM enquanto a penúltima está ativa
  const botoes = raiz.locator('button:not([inert] *):not([aria-hidden="true"] *), [role="button"]:not([inert] *):not([aria-hidden="true"] *), input[type="submit"]:not([inert] *)');
  const n = await botoes.count();
  for (let i = 0; i < n; i++) {
    const b = botoes.nth(i);
    if (!(await b.isVisible().catch(() => false))) continue;
    const texto = `${(await b.textContent()) ?? ''} ${(await b.getAttribute('aria-label')) ?? ''}`.replace(/\s+/g, ' ').trim();
    if (re.test(texto) || re.test(((await b.getAttribute('aria-label')) ?? '').trim())) return b;
  }
  return null;
}

/**
 * Motor genérico "uma pergunta por tela", sem depender de atributos de um fornecedor: lê a pergunta em destaque,
 * classifica pelo controle visível, responde, avança com Enter (fallback: botão próximo) e para na tela final.
 */
export async function preencherSequencialGenerico(raiz: Raiz, dados: DadosCandidatura, log: Log, ensaio: boolean, etapa: EtapaDescoberta): Promise<SaidaSequencial & { respondidas: number }> {
  let respondidas = 0;
  if (!(await esperarQuestionario(raiz)))
    return {
      status: 'erro',
      motivo: `o questionário do InHire (form-app) não carregou: ficou em branco por ${ESPERA_QUESTIONARIO_MS / 1000} s. É o InHire que está fora do ar, não a sua vaga; o robô tenta de novo sozinho`,
      respondidas,
    };
  const p = pagina(raiz);

  // ETAPA 1: boas-vindas ("Responda as perguntas para finalizar sua inscrição" → Iniciar). Ausência não é erro.
  // O botão pode ser só uma seta ("→"): na tela de boas-vindas vale o único botão visível; o clique também dá foco
  // ao iframe, que o Enter das próximas telas precisa.
  const semControles = async () => (await descobrirCampos(raiz)).length === 0 && (await escolhasVisiveis(raiz)).textos.length === 0;
  const blocoDeBoasVindas = async () => (await raiz.locator(SEQUENCIAL.boasVindasBloco).count()) > 0;
  const naBoasVindas = async () => ((await blocoDeBoasVindas()) || SEQUENCIAL.boasVindas.test(await textoVisivel(raiz))) && (await semControles());
  // Três tentativas, não uma: o QuillForms entra com animação e o primeiro clique pode cair antes de ele
  // responder — e aí a tela seguinte nunca chega, o que virava "estrutura não reconhecida" (23/09/2026).
  for (let tentativa = 1; tentativa <= 3 && (await naBoasVindas()); tentativa++) {
    const iniciar = (await botaoPor(raiz, SEQUENCIAL.iniciar)) ?? (await botaoPor(raiz, /^(→|>|›)?\s*$|./));
    if (iniciar) await iniciar.click().catch(() => {});
    else await p.keyboard.press('Enter');
    log('info', `Questionário: tela de boas-vindas, iniciando${tentativa > 1 ? ` (tentativa ${tentativa})` : ''}.`);
    await ate(async () => !(await naBoasVindas()), 12000, 300);
  }

  let anterior = '';
  let repetidas = 0;
  for (let iteracao = 1; iteracao <= LIMITE_ITERACOES; iteracao++) {
    const texto = await textoVisivel(raiz);
    if (SEQUENCIAL.concluido.test(texto)) return { status: 'concluido', respondidas };

    const campos = (await descobrirCampos(raiz)).filter(c => c.tipo !== 'arquivo' || c.obrigatorio);
    const escolhas = await escolhasVisiveis(raiz);
    const final = await botaoPor(raiz, SEQUENCIAL.final);
    const pergunta = (await perguntaAtual(raiz)) || campos[0]?.rotulo || '';
    const assinaturaTela = `${pergunta}|${campos.map(c => c.nome + c.rotulo).join(',')}|${escolhas.textos.join(',')}`;

    // ETAPA 2.5: fim do fluxo = botão de envio com a tela já respondida (nada pendente, ou tela de revisão)
    const marcada = async () => (await raiz.locator('[role="radio"][aria-checked="true"], [role="option"][aria-selected="true"], [role="checkbox"][aria-checked="true"]').count()) > 0;
    const telaRespondida = async () => campos.every(c => c.preenchido) && (escolhas.textos.length === 0 || (await marcada()));
    const enviar = async (botao: Locator): Promise<SaidaSequencial & { respondidas: number }> => {
      if (ensaio) return { status: 'ensaio', respondidas };
      await botao.click();
      log('info', 'Questionário: respostas enviadas.');
      const ok = await ate(async () => SEQUENCIAL.concluido.test(await textoVisivel(raiz)) || (await raiz.locator('input, textarea, [role="radio"], [role="option"]').count()) === 0, 20000, 500);
      return ok ? { status: 'concluido', respondidas } : { status: 'erro', motivo: 'o questionário não confirmou o envio das respostas', respondidas };
    };
    if (final && (await telaRespondida())) return enviar(final);
    if (assinaturaTela === anterior && ++repetidas >= 2) {
      const html = await raiz.evaluate(() => (document.querySelector('main, form, [role="main"]') ?? document.body).outerHTML.slice(0, 1500)).catch(() => '');
      return {
        status: 'erro',
        motivo: `o questionário não avançou de "${pergunta.slice(0, 60) || '(tela sem pergunta reconhecível)'}"; revise manualmente. HTML: ${html.replace(/\s+/g, ' ').slice(0, 300)}`,
        respondidas,
      };
    }
    if (assinaturaTela !== anterior) repetidas = 0;
    anterior = assinaturaTela;

    if (!pergunta && !campos.length && !escolhas.textos.length) {
      const html = await raiz.evaluate(() => document.body.innerHTML.slice(0, 1200)).catch(() => '');
      return { status: 'erro', motivo: `tela do questionário sem nada reconhecível (estrutura não reconhecida). HTML: ${html.replace(/\s+/g, ' ').slice(0, 300)}`, respondidas };
    }

    // ETAPA 2.1–2.3: classifica e responde
    let mexeu = false;
    if (escolhas.textos.length) {
      const tipo: PerguntaExtra['tipo'] = escolhas.multipla ? 'multipla' : 'opcoes';
      const obrigatoria = /\*\s*$/.test((await perguntaAtual(raiz)) || '') || true; // sem marcador confiável, trata como obrigatória
      const resposta = dados.responder({ rotulo: pergunta, tipo, opcoes: escolhas.textos });
      if (resposta === null) {
        if (obrigatoria) {
          etapa.campos.push({ nome: 'escolha', rotulo: pergunta, tipo, obrigatorio: true });
          return { status: 'pergunta', pergunta: { rotulo: pergunta, tipo, opcoes: escolhas.textos }, respondidas };
        }
      } else {
        const loc = raiz.locator(SELETOR_ESCOLHAS);
        for (const v of tipo === 'multipla' ? dividirMultipla(resposta) : [resposta]) {
          const idx = melhorOpcao(escolhas.textos, v);
          if (idx < 0) return { status: 'erro', motivo: `resposta "${v}" não bate com as opções de "${pergunta}" (${escolhas.textos.join(', ')})`, respondidas };
          // índice entre as visíveis
          let vis = -1;
          const n = await loc.count();
          for (let i = 0; i < n; i++) {
            const el = loc.nth(i);
            if (!(await el.isVisible().catch(() => false))) continue;
            if (++vis === idx) {
              await el.click();
              break;
            }
          }
        }
        etapa.campos.push({ nome: 'escolha', rotulo: pergunta, tipo, obrigatorio: true });
        respondidas++;
        mexeu = true;
        log('info', `Questionário · "${pergunta.slice(0, 70)}": ${resposta}.`);
      }
    }
    for (const c of campos) {
      if (c.preenchido) continue;
      if (!c.rotulo) c.rotulo = pergunta;
      const r = resolverCampo(c, dados);
      if (r.acao === 'pergunta') {
        etapa.campos.push({ nome: c.nome, rotulo: c.rotulo, tipo: c.tipo, obrigatorio: c.obrigatorio });
        return { status: 'pergunta', pergunta: r.pergunta, respondidas };
      }
      etapa.campos.push({ nome: c.nome, rotulo: c.rotulo, tipo: c.tipo, obrigatorio: c.obrigatorio });
      if (await preencherCampo(raiz, c, r, dados, log)) {
        mexeu = true;
        if (!papelDe(c)) respondidas++;
      }
    }

    // Última pergunta respondida e o botão de envio já está na tela: não é "próxima", é o fim
    const finalAgora = await botaoPor(raiz, SEQUENCIAL.final);
    if (finalAgora && mexeu) return enviar(finalAgora);

    // ETAPA 2.4: avança — Enter primeiro; se a tela não mudou, botão próximo/OK/seta
    const antes = assinaturaTela;
    const mudou = async () => {
      const t = await textoVisivel(raiz);
      if (SEQUENCIAL.concluido.test(t)) return true;
      const c2 = await descobrirCampos(raiz);
      const e2 = await escolhasVisiveis(raiz);
      return `${await perguntaAtual(raiz)}|${c2.map(c => c.nome + c.rotulo).join(',')}|${e2.textos.join(',')}` !== antes;
    };
    // Enter só chega ao questionário se ele tiver o foco (iframe): clicar no título é inofensivo e garante isso
    if ('page' in raiz)
      await raiz
        .locator('h1, h2, h3, legend, [data-qa*="title"]')
        .first()
        .click({ timeout: 1500 })
        .catch(() => {});
    await p.keyboard.press('Enter');
    if (!(await ate(mudou, 3000, 300))) {
      const proximo = await botaoPor(raiz, SEQUENCIAL.proximo);
      if (proximo) {
        await proximo.click();
        await ate(mudou, 5000, 300);
      } else if (!mexeu) {
        // nada respondido e nada para clicar: tela final sem botão reconhecido ou pergunta opcional sem resposta
        const final2 = await botaoPor(raiz, SEQUENCIAL.final);
        if (!final2) return { status: 'erro', motivo: `não achei como avançar de "${pergunta.slice(0, 60)}" (nem Enter, nem botão próximo)`, respondidas };
      }
    }
  }
  return { status: 'erro', motivo: `questionário com mais de ${LIMITE_ITERACOES} telas; revise manualmente`, respondidas };
}

/** ETAPA 3: ponto único de entrada do modo sequencial; escolhe o motor pela origem detectada. */
export async function preencherSequencial(
  modo: Extract<ModoEtapa, { modo: 'sequencial' }>,
  dados: DadosCandidatura,
  log: Log,
  ensaio: boolean,
): Promise<{ saida: SaidaSequencial; etapa: EtapaDescoberta; respondidas: number }> {
  log('info', `Questionário sequencial detectado (${modo.origem}).`);
  if (modo.motor === 'typeform') {
    const t = await preencherTypeform(modo.raiz, dados, log, ensaio);
    const saida: SaidaSequencial =
      t.resultado.status === 'enviada'
        ? { status: 'concluido' }
        : t.resultado.status === 'ensaio'
          ? { status: 'ensaio' }
          : t.resultado.status === 'pergunta'
            ? { status: 'pergunta', pergunta: t.resultado.pergunta }
            : { status: 'erro', motivo: t.resultado.motivo };
    return { saida, etapa: t.etapa, respondidas: t.respondidas };
  }
  const etapa: EtapaDescoberta = { etapa: 0, origem: 'typeform', campos: [] };
  const s = await preencherSequencialGenerico(modo.raiz, dados, log, ensaio, etapa);
  return { saida: s, etapa, respondidas: s.respondidas };
}

// ─── Laço principal: descobrir → preencher → avançar → repetir ─────────────
const MAX_ETAPAS = 8;

export interface OpcoesFormulario {
  /** Empresa com requireCustomFormCompletion: o botão final abre o questionário sem criar o talento (ensaio pode clicar) */
  fluxoCondicional?: boolean;
  /** Outra plataforma usando este motor (Indeed) informa os seus textos de botão e de confirmação */
  convencoes?: Convencoes;
  /**
   * Prova dura de envio: true depois que uma rota de criação da candidatura respondeu 2xx (index.ts escuta a rede).
   * Enquanto o texto da tela é redação do InHire (pode mudar sem aviso), isto é o fato. Duas consequências:
   * nunca reportamos erro depois de um envio comprovado, e nunca clicamos no botão final de novo.
   */
  envioComprovado?: () => boolean;
  /**
   * Tela que se intromete entre o clique no botão final e o envio de verdade. No Vagas PJ o clique em "Candidatar"
   * é interceptado por um anúncio ("Receba as vagas por WhatsApp") e o POST só sai quando se dispensa o anúncio.
   * Roda logo depois do clique; se lançar, a mensagem vira o motivo do erro.
   */
  aposBotaoFinal?: (page: Page, log: Log) => Promise<void>;
}

export async function executarFormulario(page: Page, dados: DadosCandidatura, log: Log, opcoes: OpcoesFormulario = {}): Promise<Resultado> {
  const etapas: EtapaDescoberta[] = [];
  let perguntasRespondidas = 0;
  let typeform = false;
  let talentoCriado = false; // já clicamos no botão final do InHire (POST do talento) nesta candidatura
  const comprovado = () => opcoes.envioComprovado?.() === true;
  const enviada = (): Resultado => ({ resultado: { status: 'enviada' }, etapas, perguntasRespondidas, typeform });
  // Depois de um envio comprovado pela rede, nenhum desvio de layout pode virar "erro": a candidatura existe lá.
  const saidaErro = (motivo: string): Resultado => {
    if (comprovado()) {
      log('alerta', `A tela não confirmou (${motivo}), mas a candidatura foi aceita (resposta da rota de envio). Contando como enviada.`);
      return enviada();
    }
    return { resultado: { status: 'erro', motivo }, etapas, perguntasRespondidas, typeform };
  };
  const conv = opcoes.convencoes ?? CONVENCOES_INHIRE;
  const quem = conv.nome ?? 'a plataforma';
  const sucessoNaTela = async () => conv.sucesso.test(await page.evaluate(() => document.body.innerText).catch(() => ''));

  for (let etapa = 1; etapa <= MAX_ETAPAS; etapa++) {
    // Confirmação pode aparecer a qualquer momento (depois do questionário no fluxo condicional, por exemplo)
    // A prova de rede sozinha NÃO encerra o laço: no fluxo normal o talento é criado antes do questionário, e as
    // perguntas da empresa ainda precisam ser respondidas. Ela vale para não reportar erro e para não reenviar.
    if (await sucessoNaTela()) return enviada();

    // ETAPA 3: a cada etapa, decide o modo — abas (campos simultâneos) ou sequencial (uma pergunta por tela)
    const modo = await detectarModo(page);
    if (modo.modo === 'sequencial') {
      typeform = true;
      const s = await preencherSequencial(modo, dados, log, dados.ensaio);
      etapas.push({ ...s.etapa, etapa });
      perguntasRespondidas += s.respondidas;
      if (s.saida.status === 'pergunta') return { resultado: { status: 'pergunta', pergunta: s.saida.pergunta }, etapas, perguntasRespondidas, typeform };
      if (s.saida.status === 'erro') return saidaErro(s.saida.motivo);
      if (s.saida.status === 'ensaio') return { resultado: { status: 'ensaio', captura: '', pronto: true }, etapas, perguntasRespondidas, typeform };
      // concluído: devolve o controle ao laço principal — espera a confirmação ou a próxima etapa do InHire
      log('info', 'Questionário concluído; de volta ao formulário principal.');
      const desfecho = await ate(
        async () => {
          if (await sucessoNaTela()) return true;
          if (comprovado()) return true; // questionário terminado + envio aceito pela API = acabou
          if ((await detectarModo(page)).modo === 'sequencial') return false;
          return (await descobrirCampos(page)).length > 0 || (await acharBotao(page, conv)) !== null;
        },
        25000,
        500,
      );
      if (desfecho && (comprovado() || (await sucessoNaTela()))) return enviada();
      if (!desfecho && talentoCriado) {
        log('alerta', 'O InHire não mostrou a mensagem de confirmação, mas a candidatura já tinha sido criada antes do questionário.');
        return enviada();
      }
      if (!desfecho) return saidaErro('sem confirmação do InHire depois do questionário');
      continue;
    }

    // Modo abas: preenche o que está visível; repete para pegar campos condicionais (ex.: cidade depois do país)
    const registro: EtapaDescoberta = { etapa, origem: 'inhire', campos: [] };
    const vistos = new Set<string>();
    const pulados = new Set<string>();
    for (let rodada = 0; rodada < 4; rodada++) {
      const campos = await descobrirCampos(page);
      let mexeu = false;
      for (const c of campos) {
        const chave = `${c.tipo}:${c.nome}:${c.rotulo}`;
        if (!vistos.has(chave)) {
          vistos.add(chave);
          registro.campos.push({ nome: c.nome, rotulo: c.rotulo, tipo: c.tipo, obrigatorio: c.obrigatorio });
        }
        if (c.preenchido) continue;
        // Um campo anterior pode ter trocado a página (país → cidade vira dropdown): redescobre em vez de clicar no fantasma
        if ((await page.locator(`[data-autocv="${c.i}"], [data-autocv-grupo="${c.i}"]`).count()) === 0) {
          mexeu = true;
          break;
        }
        if (pulados.has(chave)) continue;
        if (c.tipo === 'dropdown' && !papelDe(c)) c.opcoes = await lerOpcoesDropdown(page, campoLoc(page, c));
        const r = resolverCampo(c, dados);
        if (r.acao === 'pular') pulados.add(chave);
        if (r.acao === 'pergunta') {
          etapas.push(registro);
          return { resultado: { status: 'pergunta', pergunta: r.pergunta }, etapas, perguntasRespondidas, typeform };
        }
        if (await preencherCampo(page, c, r, dados, log)) {
          mexeu = true;
          if (!papelDe(c)) perguntasRespondidas++;
        }
      }
      if (!mexeu) break;
    }
    etapas.push(registro);

    const botao = await acharBotao(page, conv);
    if (!botao) return saidaErro('não achei o botão para avançar ou enviar nesta etapa');
    if (!(await ate(() => habilitado(botao.loc), 10000))) {
      // Diagnóstico útil: qual campo obrigatório ficou vazio (o InHire raramente diz)
      const faltando = (await descobrirCampos(page).catch(() => []))
        .filter(c => c.obrigatorio && !c.preenchido)
        .map(c => c.rotulo || c.nome)
        .filter(Boolean);
      const erros = await errosVisiveis(page);
      const detalhe = faltando.length ? `falta preencher: ${faltando.slice(0, 6).join(', ')}` : erros.length ? erros.join(' · ') : 'algum campo obrigatório ficou inválido ou vazio';
      return saidaErro(`${quem} não liberou "${botao.texto}": ${detalhe}`);
    }

    if (botao.final) {
      // Trava anti-duplicidade: se a candidatura já foi aceita pela API, nunca clicamos no botão final de novo
      if (comprovado()) {
        log('alerta', `"${botao.texto}" reapareceu depois de um envio já aceito por ${quem}; não vou clicar de novo.`);
        return enviada();
      }
      if (talentoCriado) return saidaErro(`${quem} voltou a mostrar "${botao.texto}" depois do envio; parei para não candidatar duas vezes`);
      // Em ensaio, o botão final só é clicado quando ele apenas abre o questionário (fluxo condicional); o POST de
      // criação do talento está abortado pelo navegador de qualquer forma (index.ts)
      if (dados.ensaio && !opcoes.fluxoCondicional) return { resultado: { status: 'ensaio', captura: '', pronto: true }, etapas, perguntasRespondidas, typeform };
      log('info', dados.ensaio ? `Ensaio: "${botao.texto}" abre o questionário sem criar a candidatura; seguindo.` : `Enviando: "${botao.texto}".`);
      if (!opcoes.fluxoCondicional) talentoCriado = true;
      const antes = assinatura(await descobrirCampos(page).catch(() => []));
      await botao.loc.click();
      await opcoes.aposBotaoFinal?.(page, log);
      // Depois do envio: confirmação, questionário sequencial (iframe/nativo) ou mais campos do InHire
      let desfecho: 'sucesso' | 'sequencial' | 'campos' | null = null;
      await ate(
        async () => {
          if (await sucessoNaTela()) desfecho = 'sucesso';
          else if ((await detectarModo(page)).modo === 'sequencial') desfecho = 'sequencial';
          else {
            const agora = await descobrirCampos(page).catch(() => []);
            if (agora.length && assinatura(agora) !== antes) desfecho = 'campos';
          }
          return desfecho !== null;
        },
        25000,
        500,
      );
      if (desfecho === 'sucesso') return enviada();
      if (desfecho === 'sequencial' || desfecho === 'campos') continue; // o topo do laço detecta o modo e segue
      // Nada mudou na tela. Se a API aceitou o envio, acabou bem — o InHire só não trocou a mensagem.
      if (comprovado()) {
        log('alerta', 'O envio foi aceito pela rota de candidatura, mas a tela não trocou a mensagem. Contando como enviada.');
        return enviada();
      }
      const texto = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (/captcha|rob[ôo]|robot|verifica[çc][ãa]o de seguran/i.test(texto)) return saidaErro(`${quem} pediu verificação (captcha); envie esta vaga manualmente`);
      return saidaErro(`sem confirmação de ${quem} após o envio`);
    }

    // Próxima etapa: clica e espera o conjunto de campos mudar
    const antes = assinatura(await descobrirCampos(page));
    await botao.loc.click();
    log('info', `Etapa ${etapa} concluída ("${botao.texto}").`);
    const mudou = await ate(async () => assinatura(await descobrirCampos(page)) !== antes || (await detectarModo(page)).modo === 'sequencial', 15000);
    if (!mudou) return saidaErro(`cliquei em "${botao.texto}" e a página não avançou`);
  }
  return saidaErro(`formulário com mais de ${MAX_ETAPAS} etapas; revise manualmente`);
}
