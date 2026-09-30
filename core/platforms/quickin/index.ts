// Adapter do Quickin (jobs.quickin.io).
// ATS nacional com sitemap público de 628 empresas.
// Formulário direto sem login, com campos mapeados por ID e envio via POST para api.quickin.io.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigAutomacao, PerfilBusca, Vaga } from '../../../src/types.ts';
import { registrarAdapter, type DadosCandidatura, type Log, type PlatformAdapter, type ResultadoCandidatura } from '../adapter.ts';
import { pretensaoEmReais } from '../inhire/formulario.ts';
import { navegador } from '../../browser.ts';
import { DIRS } from '../../config.ts';
import { ler } from '../../estado.ts';
import { buscarNoQuickin } from './busca.ts';
import { ESPERA_ENVIO_MS, QUICKIN } from './seletores.ts';

const MAX_PDF_BYTES = 10 * 1024 * 1024;

const buscarVagas = (perfil: PerfilBusca, cfg: ConfigAutomacao, log: Log): Promise<Vaga[]> => buscarNoQuickin(perfil, cfg, ler.localizacao(), log);

export function extrairEmpresaEId(vaga: { id: string; url: string }): { empresa: string; jobId: string } | null {
  const m = vaga.url.match(/jobs\.quickin\.io\/([^/]+)\/jobs\/([a-z0-9]+)/i);
  if (m) return { empresa: m[1], jobId: m[2] };
  const m2 = vaga.url.match(/jobs\.quickin\.io\/([^/]+)\/apply\?job_id=([a-z0-9]+)/i);
  if (m2) return { empresa: m2[1], jobId: m2[2] };
  const mLocal = vaga.url.match(/(?:127\.0\.0\.1|localhost)(?::\d+)?\/([^/]+)\/apply\?job_id=([a-z0-9]+)/i);
  if (mLocal) return { empresa: mLocal[1], jobId: mLocal[2] };
  const idDireto = vaga.id.replace(/^quickin:/, '');
  if (idDireto) return { empresa: '', jobId: idDireto };
  return null;
}

async function candidatar(vaga: Vaga, dados: DadosCandidatura, log: Log): Promise<ResultadoCandidatura> {
  const info = extrairEmpresaEId(vaga);
  if (!info?.jobId) return { status: 'erro', motivo: 'não consegui extrair o ID da vaga no Quickin; candidate-se manualmente' };

  const tamanho = statSync(dados.curriculoPdf).size;
  if (tamanho > MAX_PDF_BYTES) {
    return {
      status: 'erro',
      motivo: `o Quickin aceita currículo de até 10 MB e o seu tem ${(tamanho / 1024 / 1024).toFixed(1)} MB; gere um PDF mais leve`,
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
  const ehEnvio = (url: string, metodo: string) => QUICKIN.rotaEnvio.test(url) && metodo.toUpperCase() === 'POST';

  page.on('dialog', d => void d.dismiss().catch(() => {}));
  page.on('request', req => {
    if (ehEnvio(req.url(), req.method())) envioTentado = true;
  });
  page.on('response', res => {
    if (!ehEnvio(res.url(), res.request().method())) return;
    if (res.status() >= 400) recusa = `o Quickin recusou a candidatura (HTTP ${res.status()})`;
    else if (!envioAceito) {
      envioAceito = true;
      log('sucesso', `O Quickin aceitou a candidatura (HTTP ${res.status()} em /apply).`);
    }
  });

  try {
    if (dados.ensaio) {
      await page.route(QUICKIN.rotaEnvioGlob, rota => (ehEnvio(rota.request().url(), rota.request().method()) ? rota.abort() : rota.continue()));
    }

    const urlApply = vaga.url.startsWith('http://127.0.0.1') || vaga.url.startsWith('http://localhost') ? vaga.url : info.empresa ? QUICKIN.formulario(info.empresa, info.jobId) : vaga.url;
    log('info', `Abrindo ${urlApply}`);
    await page.goto(urlApply, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Verifica se a vaga está encerrada
    const texto = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (QUICKIN.encerrada.test(texto)) {
      return { status: 'erro', motivo: 'a vaga foi encerrada no Quickin', captura: await captura('quickin-encerrada') };
    }

    // Espera o formulário carregar
    const nomeLoc = page.locator(QUICKIN.campos.nome).first();
    const apareceuForm = await nomeLoc
      .waitFor({ state: 'attached', timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!apareceuForm) {
      return { status: 'erro', motivo: 'o formulário do Quickin não apareceu na página', captura: await captura('quickin-sem-form') };
    }

    log('info', 'Preenchendo formulário do Quickin.');

    // 1. Nome completo
    await nomeLoc.fill(dados.nome);

    // 2. Email
    const emailLoc = page.locator(QUICKIN.campos.email).first();
    if (await emailLoc.isVisible().catch(() => false)) await emailLoc.fill(dados.email);

    // 3. Telefone / Celular
    const telLoc = page.locator(QUICKIN.campos.celular).first();
    if (await telLoc.isVisible().catch(() => false)) {
      const celLimpo = dados.celular.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
      await telLoc.fill(celLimpo);
    }

    // 4. Pretensão salarial
    const salLoc = page.locator(QUICKIN.campos.pretensao).first();
    if ((await salLoc.isVisible().catch(() => false)) && dados.pretensao) {
      await salLoc.fill(pretensaoEmReais(dados.pretensao));
    }

    // 5. Cidade
    const cidLoc = page.locator(QUICKIN.campos.cidade).first();
    if ((await cidLoc.isVisible().catch(() => false)) && dados.cidade) {
      await cidLoc.fill(dados.cidade);
    }

    // 6. Endereço
    const endLoc = page.locator(QUICKIN.campos.endereco).first();
    if (await endLoc.isVisible().catch(() => false)) {
      await endLoc.fill(dados.cidade || 'Brasil');
    }

    // 7. Anexo do currículo
    const fileLoc = page.locator(QUICKIN.campos.curriculo).first();
    if (await fileLoc.count()) {
      await fileLoc.setInputFiles(dados.curriculoPdf);
      log('info', `Currículo anexado (${dados.curriculoPdf.split(/[\\/]/).pop()}).`);
    } else {
      throw new Error('campo de anexo de currículo não encontrado na página do Quickin');
    }

    // 8. Aceite dos termos / consentimento (obrigatório)
    const termosLoc = page.locator(QUICKIN.campos.termos).first();
    if (await termosLoc.count()) {
      if (!(await termosLoc.isChecked().catch(() => false))) {
        await termosLoc.check({ force: true }).catch(() => {});
      }
      log('info', 'Termos de consentimento marcados.');
    }

    // 9. Modo ensaio: para antes de submeter
    if (dados.ensaio) {
      log('info', 'Modo ensaio: formulário do Quickin preenchido sem submeter.');
      return { status: 'ensaio', captura: await captura('quickin-ensaio'), pronto: true };
    }

    // 10. Submeter formulário
    const submitBtn = page.locator(QUICKIN.campos.submit).first();
    const btnAtivo = await submitBtn
      .waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!btnAtivo) throw new Error('botão "Finalizar" não encontrado na página do Quickin');

    log('info', 'Enviando candidatura no Quickin.');
    const respPromise = page.waitForResponse(res => ehEnvio(res.url(), res.request().method()), { timeout: ESPERA_ENVIO_MS }).catch(() => null);
    await submitBtn.click({ force: true, timeout: 15000 });

    // Aguarda confirmação de rede ou texto de sucesso caso ainda não tenha sido capturado
    if (!envioAceito && !recusa) {
      await respPromise;
    }
    if (!envioAceito && !recusa) {
      await page
        .waitForFunction(re => new RegExp(re, 'i').test(document.body.innerText), QUICKIN.sucesso.source, { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
    }

    if (recusa) return { status: 'erro', motivo: recusa, captura: await captura('quickin-recusa') };
    if (envioAceito) return { status: 'enviada' };

    const naTela = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (QUICKIN.sucesso.test(naTela)) {
      log('alerta', 'A resposta HTTP do envio não foi vista, mas a tela do Quickin confirmou a candidatura.');
      return { status: 'enviada' };
    }

    return {
      status: 'erro',
      motivo: motivoDoErro('sem confirmação do Quickin após o envio', envioTentado, recusa),
      captura: await captura('quickin-sem-confirmacao'),
    };
  } catch (e) {
    if (envioAceito) {
      log('alerta', `Erro após envio (${(e as Error).message.split('\n')[0]}), mas a candidatura já foi confirmada pela rota de envio.`);
      return { status: 'enviada' };
    }
    const naTela = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (QUICKIN.sucesso.test(naTela)) {
      log('alerta', `Ocorreu uma exceção (${(e as Error).message.split('\n')[0]}), mas o Quickin exibiu tela de confirmação.`);
      return { status: 'enviada' };
    }
    return {
      status: 'erro',
      motivo: motivoDoErro((e as Error).message.split('\n')[0], envioTentado, recusa),
      captura: await captura('quickin-erro'),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export function motivoDoErro(motivo: string, envioTentado: boolean, recusa: string): string {
  if (recusa) return recusa;
  if (envioTentado) return `${motivo} — o envio chegou a ser disparado; revise no portal da empresa antes de reenviar`;
  return motivo;
}

export const quickin: PlatformAdapter = {
  id: 'quickin',
  nome: 'Quickin',
  buscarVagas,
  candidatar,
};

registrarAdapter(quickin);
