// Adapter do Workable (jobs.workable.com).
// Sem login, busca pública via API REST com schema JSON de formulário por vaga,
// e candidatura via modal em Playwright com interceptação de prova de rede (POST /apply).
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigAutomacao, PerfilBusca, PerguntaExtra, Vaga } from '../../../src/types.ts';
import { registrarAdapter, type DadosCandidatura, type Log, type PlatformAdapter, type ResultadoCandidatura } from '../adapter.ts';
import { navegador } from '../../browser.ts';
import { DIRS } from '../../config.ts';
import { ler } from '../../estado.ts';
import { buscarNoWorkable } from './busca.ts';
import { ESPERA_ENVIO_MS, WORKABLE } from './seletores.ts';

const MAX_PDF_BYTES = 10 * 1024 * 1024; // Workable declara 12 MB max

const buscarVagas = (perfil: PerfilBusca, cfg: ConfigAutomacao, log: Log): Promise<Vaga[]> => buscarNoWorkable(perfil, cfg, ler.localizacao(), log);

export const idDaVaga = (vaga: { id: string; url: string }): string => vaga.id.replace(/^workable:/, '') || (vaga.url.match(/\/view\/([^/]+)/)?.[1] ?? '');

interface WorkableFormField {
  id: string;
  label?: string;
  type: string;
  required?: boolean;
  choices?: { label: string; value: string }[];
  fields?: WorkableFormField[];
}

interface WorkableFormSection {
  name?: string;
  fields?: WorkableFormField[];
}

const CAMPOS_PADRAO = new Set(['firstname', 'lastname', 'email', 'headline', 'phone', 'address', 'city', 'postcode', 'country', 'summary', 'resume', 'cover_letter', 'education', 'experience']);

/** Lê o schema do formulário via API para adiantar perguntas obrigatórias da empresa antes de abrir o navegador. */
async function perguntasPrevias(vaga: Vaga): Promise<PerguntaExtra[]> {
  const id = idDaVaga(vaga);
  if (!id) return [];

  try {
    const url = WORKABLE.api.form(id);
    const resp = await fetch(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'user-agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];

    const secoes = (await resp.json()) as WorkableFormSection[];
    const extras: PerguntaExtra[] = [];

    for (const sec of secoes) {
      if (!Array.isArray(sec.fields)) continue;
      for (const f of sec.fields) {
        if (!f.id || CAMPOS_PADRAO.has(f.id.toLowerCase())) continue;
        const obrigatoria = f.required === true;
        const rotulo = f.label || f.id;
        const opcoes = f.choices?.map(c => c.label || c.value).filter(Boolean);

        extras.push({
          rotulo,
          tipo: opcoes && opcoes.length > 0 ? 'opcoes' : 'texto',
          opcoes: opcoes && opcoes.length > 0 ? opcoes : undefined,
          obrigatoria,
        });
      }
    }

    return extras;
  } catch {
    return [];
  }
}

async function candidatar(vaga: Vaga, dados: DadosCandidatura, log: Log): Promise<ResultadoCandidatura> {
  const id = idDaVaga(vaga);
  if (!id) return { status: 'erro', motivo: 'não consegui achar o ID desta vaga no Workable; envie manualmente' };

  const tamanho = statSync(dados.curriculoPdf).size;
  if (tamanho > MAX_PDF_BYTES) {
    return {
      status: 'erro',
      motivo: `o Workable aceita currículo de até 10 MB e o seu tem ${(tamanho / 1024 / 1024).toFixed(1)} MB; gere um PDF mais leve`,
    };
  }

  const ctx = await navegador(dados.mostrarNavegador);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  const captura = async (nome: string) => {
    const caminho = join(DIRS.gerados, `${nome}-${Date.now()}.png`);
    await page.screenshot({ path: caminho, fullPage: true }).catch(() => {});
    return caminho;
  };

  let envioAceito = false;
  let envioTentado = false;
  let recusa = '';
  const ehEnvio = (url: string, metodo: string) => WORKABLE.rotaEnvio.test(url) && metodo.toUpperCase() === 'POST';

  page.on('dialog', d => void d.dismiss().catch(() => {}));
  page.on('request', req => {
    if (ehEnvio(req.url(), req.method())) envioTentado = true;
  });
  page.on('response', res => {
    if (!ehEnvio(res.url(), res.request().method())) return;
    if (res.status() >= 400) recusa = `o Workable recusou o envio (HTTP ${res.status()})`;
    else if (!envioAceito) {
      envioAceito = true;
      log('sucesso', `O Workable aceitou a candidatura (HTTP ${res.status()} em /apply).`);
    }
  });

  try {
    if (dados.ensaio) {
      await page.route(WORKABLE.rotaEnvioGlob, rota => (ehEnvio(rota.request().url(), rota.request().method()) ? rota.abort() : rota.continue()));
    }

    log('info', `Abrindo ${vaga.url}`);
    await page.goto(vaga.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Aceita cookies caso apareça o banner
    const cookiesBtn = page.locator(WORKABLE.cookies).first();
    if (await cookiesBtn.isVisible().catch(() => false)) {
      await cookiesBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
    }

    // Clica no botão "Apply now"
    const botaoAplicar = page.locator(WORKABLE.botaoAplicar).first();
    const apareceuBotao = await botaoAplicar
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (!apareceuBotao) {
      const texto = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (/no longer available|position has been filled|job expired/i.test(texto)) {
        return { status: 'erro', motivo: 'a vaga foi encerrada no Workable', captura: await captura('workable-encerrada') };
      }
      return { status: 'erro', motivo: 'o botão de candidatura não apareceu na página do Workable', captura: await captura('workable-sem-botao') };
    }

    await botaoAplicar.click({ force: true });

    // Espera o modal de candidatura
    const modalApareceu = await page
      .locator(WORKABLE.modal)
      .first()
      .waitFor({ state: 'visible', timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    if (!modalApareceu) {
      return { status: 'erro', motivo: 'o formulário de candidatura do Workable não abriu após clicar em Apply', captura: await captura('workable-sem-modal') };
    }

    log('info', 'Preenchendo formulário do Workable.');

    // Preenche campos fixos
    const partesNome = dados.nome.trim().split(/\s+/);
    const primeiroNome = partesNome[0] || 'Candidato';
    const sobrenome = partesNome.slice(1).join(' ') || primeiroNome;

    const fnLoc = page.locator(WORKABLE.campos.firstname).first();
    if (await fnLoc.isVisible().catch(() => false)) await fnLoc.fill(primeiroNome);

    const lnLoc = page.locator(WORKABLE.campos.lastname).first();
    if (await lnLoc.isVisible().catch(() => false)) await lnLoc.fill(sobrenome);

    const emailLoc = page.locator(WORKABLE.campos.email).first();
    if (await emailLoc.isVisible().catch(() => false)) await emailLoc.fill(dados.email);

    const telLoc = page.locator(WORKABLE.campos.phone).first();
    if (await telLoc.isVisible().catch(() => false)) await telLoc.fill(dados.celular);

    const addrLoc = page.locator(WORKABLE.campos.address).first();
    if (await addrLoc.isVisible().catch(() => false)) {
      const valorEndereco = (await addrLoc.inputValue().catch(() => '')) || dados.cidade || 'Brasil';
      await addrLoc.fill(valorEndereco);
    }

    const cityLoc = page.locator(WORKABLE.campos.city).first();
    if ((await cityLoc.isVisible().catch(() => false)) && dados.cidade) {
      await cityLoc.fill(dados.cidade);
    }

    // Anexa o currículo
    const fileLoc = page.locator(WORKABLE.campos.arquivo).first();
    if (await fileLoc.count()) {
      await fileLoc.setInputFiles(dados.curriculoPdf);
      log('info', `Currículo anexado (${dados.curriculoPdf.split(/[\\/]/).pop()}).`);
    } else {
      throw new Error('campo de anexo de currículo não encontrado no modal do Workable');
    }

    // Perguntas adicionais no modal: se houver campo obrigatório não preenchido, tenta responder
    const camposExtras = await page.evaluate(() => {
      const inputs = Array.from(
        document.querySelectorAll(
          'input:not([type="hidden"]):not([type="file"]):not([name="firstname"]):not([name="lastname"]):not([name="email"]):not([name="phone"]):not([name="address"]):not([name="city"]), textarea:not([name="summary"]):not([name="cover_letter"]), select',
        ),
      );
      return inputs.map((el, i) => {
        const inp = el as HTMLInputElement;
        const label = inp.labels?.[0]?.textContent?.trim() || inp.getAttribute('aria-label') || inp.placeholder || inp.name || `campo_${i}`;
        return {
          idx: i,
          tag: el.tagName.toLowerCase(),
          type: inp.type || 'text',
          name: inp.name || '',
          id: inp.id || '',
          label,
          required: inp.required || inp.getAttribute('aria-required') === 'true' || /\*/.test(label),
        };
      });
    });

    for (const extra of camposExtras) {
      if (!extra.required) continue;
      const resp = dados.responder({ rotulo: extra.label, tipo: 'texto', obrigatoria: true });
      if (resp === null) {
        return {
          status: 'pergunta',
          pergunta: { rotulo: extra.label, tipo: 'texto', obrigatoria: true },
        };
      }
      const loc = extra.id ? page.locator(`#${CSS.escape(extra.id)}`) : extra.name ? page.locator(`[name="${CSS.escape(extra.name)}"]`) : null;
      if (loc && (await loc.isVisible().catch(() => false))) {
        await loc.fill(resp).catch(() => {});
        log('info', `Pergunta "${extra.label}": ${resp}.`);
      }
    }

    if (dados.ensaio) {
      log('info', 'Modo ensaio: formulário do Workable preenchido sem submeter.');
      return { status: 'ensaio', captura: await captura('workable-ensaio'), pronto: true };
    }

    // Submete a candidatura
    const submitBtn = page.locator(WORKABLE.campos.submit).first();
    const btnAtivo = await submitBtn
      .waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!btnAtivo) throw new Error('botão de envio do Workable não encontrado no modal');

    log('info', 'Enviando candidatura no Workable.');
    const respPromise = page.waitForResponse(res => ehEnvio(res.url(), res.request().method()), { timeout: ESPERA_ENVIO_MS }).catch(() => null);
    await submitBtn.click({ force: true, timeout: 15000 });

    // Aguarda confirmação de rede ou texto de sucesso caso ainda não tenha sido capturado
    if (!envioAceito && !recusa) {
      await respPromise;
    }
    if (!envioAceito && !recusa) {
      await page
        .waitForFunction(re => new RegExp(re, 'i').test(document.body.innerText), WORKABLE.sucesso.source, { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
    }

    if (recusa) return { status: 'erro', motivo: recusa, captura: await captura('workable-recusa') };
    if (envioAceito) return { status: 'enviada' };

    const naTela = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (WORKABLE.sucesso.test(naTela)) {
      log('alerta', 'A resposta HTTP do envio não foi capturada, mas a tela do Workable confirmou a candidatura.');
      return { status: 'enviada' };
    }

    return {
      status: 'erro',
      motivo: motivoDoErro('sem confirmação do Workable após o envio', envioTentado, recusa),
      captura: await captura('workable-sem-confirmacao'),
    };
  } catch (e) {
    if (envioAceito) {
      log('alerta', `Erro após envio (${(e as Error).message.split('\n')[0]}), mas a candidatura já foi confirmada pela rota de envio.`);
      return { status: 'enviada' };
    }
    const naTela = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (WORKABLE.sucesso.test(naTela)) {
      log('alerta', `Ocorreu uma exceção (${(e as Error).message.split('\n')[0]}), mas o Workable exibiu tela de confirmação.`);
      return { status: 'enviada' };
    }
    return {
      status: 'erro',
      motivo: motivoDoErro((e as Error).message.split('\n')[0], envioTentado, recusa),
      captura: await captura('workable-erro'),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export function motivoDoErro(motivo: string, envioTentado: boolean, recusa: string): string {
  if (recusa) return recusa;
  if (envioTentado) return `${motivo} — a requisição chegou a sair; revise a vaga no Workable antes de reenviar`;
  return motivo;
}

export const workable: PlatformAdapter = {
  id: 'workable',
  nome: 'Workable',
  buscarVagas,
  candidatar,
  perguntasPrevias,
};

registrarAdapter(workable);
