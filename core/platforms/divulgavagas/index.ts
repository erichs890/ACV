// Adapter do Divulga Vagas: sem login, sem captcha, e a candidatura é só o PDF.
// O formulário é tão curto que não vale chamar o motor adaptativo — são um anexo e um aceite. O que exige
// cuidado aqui não é preencher, é a caixa de PcD: ver seletores.ts e `vagaExclusivaPcD` abaixo.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigAutomacao, PerfilBusca, Vaga } from '../../../src/types.ts';
import { registrarAdapter, type DadosCandidatura, type Log, type PlatformAdapter, type ResultadoCandidatura } from '../adapter.ts';
import { navegador } from '../../browser.ts';
import { DIRS } from '../../config.ts';
import { ler } from '../../estado.ts';
import { buscarNoDivulgaVagas } from './busca.ts';
import { DIVULGA, ESPERA_ENVIO_MS, ROTA_ENVIO, ROTA_ENVIO_GLOB } from './seletores.ts';

const MAX_PDF_BYTES = 5 * 1024 * 1024; // o campo declara 5 MB

const buscarVagas = (perfil: PerfilBusca, cfg: ConfigAutomacao, log: Log): Promise<Vaga[]> => buscarNoDivulgaVagas(perfil, cfg, ler.localizacao(), log);

/** O id da vaga é o número no fim do slug — é ele que abre o formulário direto, sem a tela de aviso. */
export const idDaVaga = (vaga: { id: string; url: string }) => vaga.id.replace(/^divulgavagas:/, '') || (vaga.url.match(/-(\d+)\/?$/)?.[1] ?? '');

async function candidatar(vaga: Vaga, dados: DadosCandidatura, log: Log): Promise<ResultadoCandidatura> {
  const id = idDaVaga(vaga);
  if (!id) return { status: 'erro', motivo: 'não consegui achar o número desta vaga na URL do Divulga Vagas; envie manualmente' };
  const tamanho = statSync(dados.curriculoPdf).size;
  if (tamanho > MAX_PDF_BYTES) return { status: 'erro', motivo: `o Divulga Vagas aceita currículo de até 5 MB e o seu tem ${(tamanho / 1024 / 1024).toFixed(1)} MB; gere um PDF mais leve` };

  const ctx = await navegador(dados.mostrarNavegador);
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  const captura = async (nome: string) => {
    const caminho = join(DIRS.gerados, `${nome}-${Date.now()}.png`);
    await page.screenshot({ path: caminho, fullPage: true }).catch(() => {});
    return caminho;
  };

  // Prova de envio (invariante 1): a resposta HTTP do POST que cria a candidatura, não o texto da tela.
  let envioAceito = false;
  let envioTentado = false;
  let recusa = '';
  const ehEnvio = (url: string, metodo: string) => ROTA_ENVIO.test(url) && metodo.toUpperCase() === 'POST';
  page.on('dialog', d => void d.dismiss().catch(() => {}));
  page.on('request', req => {
    if (ehEnvio(req.url(), req.method())) envioTentado = true;
  });
  page.on('response', res => {
    if (!ehEnvio(res.url(), res.request().method())) return;
    if (res.status() >= 400) recusa = `o Divulga Vagas recusou o envio (HTTP ${res.status()})`;
    else if (!envioAceito) {
      envioAceito = true;
      log('sucesso', `O Divulga Vagas aceitou a candidatura (HTTP ${res.status()} em /envioCV).`);
    }
  });

  try {
    if (dados.ensaio) await page.route(ROTA_ENVIO_GLOB, rota => (ehEnvio(rota.request().url(), rota.request().method()) ? rota.abort() : rota.continue()));
    const url = vaga.url.startsWith('http://127.0.0.1') || vaga.url.startsWith('http://localhost') ? vaga.url : DIVULGA.formulario(id);
    log('info', `Abrindo ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const apareceu = await page
      .locator(DIVULGA.arquivo)
      .waitFor({ state: 'attached', timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!apareceu) {
      const texto = await page.evaluate(() => document.body.innerText).catch(() => '');
      const motivo = DIVULGA.encerrada.test(texto) ? 'a vaga foi encerrada no Divulga Vagas' : 'o formulário de candidatura não apareceu (vaga encerrada ou layout mudou)';
      return { status: 'erro', motivo, captura: await captura('divulga-sem-formulario') };
    }

    // Invariante 3. A caixa só aparece em vaga exclusiva para PcD, e o texto dela é uma declaração sobre a
    // pessoa ("me enquadro nos requisitos"). O robô não declara isso por ninguém, nem toma vaga reservada.
    if (
      await page
        .locator(DIVULGA.pcdContainer)
        .isVisible()
        .catch(() => false)
    )
      return {
        status: 'erro',
        motivo: 'esta vaga é exclusiva para PcD e exige que você declare que se enquadra nos requisitos — o robô não assina isso por você; se for o seu caso, envie manualmente',
        captura: await captura('divulga-pcd'),
      };

    await page.setInputFiles(DIVULGA.arquivo, dados.curriculoPdf);
    log('info', `Currículo anexado (${dados.curriculoPdf.split(/[\\/]/).pop()}).`);
    // A caixa real é escondida por CSS (0x0, opacity 0) e o desenho por cima dela fica coberto por um <div>,
    // então clique de ponteiro dá timeout. `label.click()` é o caminho honesto: dispara um clique de verdade
    // no rótulo e quem marca a caixa é a ativação nativa do navegador, igual ao que o clique da pessoa faria.
    const termos = page.locator(DIVULGA.termos);
    await page.evaluate(sel => (document.querySelector(sel)?.closest('label') as HTMLElement | null)?.click(), DIVULGA.termos);
    if (!(await termos.isChecked().catch(() => false))) throw new Error('não consegui marcar o aceite dos termos do Divulga Vagas');
    log('info', 'Aceite dos termos marcado.');
    // O site só manda o PDF: nome e e-mail vão como texto de enfeite, gerados por ele mesmo
    log('info', 'O Divulga Vagas envia apenas o PDF — seus dados de perfil não entram neste formulário.');

    if (dados.ensaio) return { status: 'ensaio', captura: await captura('divulga-ensaio'), pronto: true };

    const botao = page.locator(`${DIVULGA.form} button`).filter({ hasText: DIVULGA.enviar }).first();
    const alvo = (await botao.count()) ? botao : page.locator(`${DIVULGA.form} button[type="submit"], ${DIVULGA.form} input[type="submit"]`).first();
    log('info', 'Enviando currículo.');
    // `noWaitAfter`: o POST leva o PDF junto e a espera da navegação dentro do clique estoura o padrão
    const respPromise = page.waitForResponse(res => ehEnvio(res.url(), res.request().method()), { timeout: ESPERA_ENVIO_MS }).catch(() => null);
    await alvo.click({ noWaitAfter: true, timeout: 20000 });

    if (!envioAceito && !recusa) {
      await respPromise;
    }
    if (!envioAceito && !recusa) {
      await page
        .waitForFunction(re => new RegExp(re, 'i').test(document.body.innerText), DIVULGA.sucesso.source, { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
    }

    if (recusa) return { status: 'erro', motivo: recusa, captura: await captura('divulga-erro') };
    if (envioAceito) return { status: 'enviada' };
    const naTela = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (DIVULGA.sucesso.test(naTela)) {
      log('alerta', 'A resposta do POST não foi vista, mas a tela do Divulga Vagas confirma o envio. Contando como enviada.');
      return { status: 'enviada' };
    }
    return { status: 'erro', motivo: motivoDoErro('sem confirmação do Divulga Vagas após o envio', envioTentado, recusa), captura: await captura('divulga-sem-confirmacao') };
  } catch (e) {
    if (envioAceito) {
      log('alerta', `A página quebrou depois do envio (${(e as Error).message.split('\n')[0]}), mas o Divulga Vagas já tinha aceitado a candidatura.`);
      return { status: 'enviada' };
    }
    const naTela = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (DIVULGA.sucesso.test(naTela)) {
      log('alerta', `Deu erro no meio do caminho (${(e as Error).message.split('\n')[0]}), mas a tela mostra o currículo enviado. Contando como enviada.`);
      return { status: 'enviada' };
    }
    return { status: 'erro', motivo: motivoDoErro((e as Error).message.split('\n')[0], envioTentado, recusa), captura: await captura('divulga-erro') };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * POST que saiu sem resposta: a candidatura pode existir. Repetir arriscaria um segundo envio, então a
 * mensagem carrega "revise manualmente", que `core/falhas.ts` classifica como permanente.
 */
export function motivoDoErro(motivo: string, envioTentado: boolean, recusa: string): string {
  if (recusa) return recusa;
  if (envioTentado) return `${motivo} — o envio chegou a sair sem resposta do site; confira em divulgavagas.com.br e revise manualmente antes de reenviar`;
  return motivo;
}

export const divulgavagas: PlatformAdapter = { id: 'divulgavagas', nome: 'Divulga Vagas', buscarVagas, candidatar };
registrarAdapter(divulgavagas);
