// Adapter do Vagas PJ (vagaspj.com.br): vagas de contratação PJ, sem login, candidatura no próprio site.
// A busca é HTTP puro (busca.ts); a candidatura reusa o motor de formulário do InHire com as convenções daqui.
// O que foi e o que não foi confirmado ao vivo está em seletores.ts.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigAutomacao, PerfilBusca, ResumoFormulario, Vaga } from '../../../src/types.ts';
import { registrarAdapter, type DadosCandidatura, type Log, type PlatformAdapter, type ResultadoCandidatura, type ProvaDeEnvio } from '../adapter.ts';
import { navegador } from '../../browser.ts';
import { DIRS } from '../../config.ts';
import { ler } from '../../estado.ts';
import { formularios } from '../../storage/db.ts';
import { executarFormulario } from '../inhire/formulario.ts';
import { buscarNoVagasPJ } from './busca.ts';
import { ESPERA_ENVIO_MS, MAX_PDF_BYTES, ROTA_ENVIO, ROTA_ENVIO_GLOB, VAGASPJ } from './seletores.ts';

const buscarVagas = (perfil: PerfilBusca, cfg: ConfigAutomacao, log: Log): Promise<Vaga[]> => buscarNoVagasPJ(perfil, cfg, ler.localizacao(), log);

async function candidatar(vaga: Vaga, dados: DadosCandidatura, log: Log): Promise<ResultadoCandidatura> {
  // O site recusa PDF acima de 5 MB apagando o arquivo do campo, sem dizer nada ao robô: melhor barrar aqui,
  // com um motivo que a pessoa consegue resolver, do que descobrir depois que o formulário não deixou enviar.
  const tamanho = statSync(dados.curriculoPdf).size;
  if (tamanho > MAX_PDF_BYTES) return { status: 'erro', motivo: `o Vagas PJ só aceita currículo em PDF de até 5 MB e o seu tem ${(tamanho / 1024 / 1024).toFixed(1)} MB; gere um PDF mais leve` };

  const ctx = await navegador(dados.mostrarNavegador);
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  const captura = async (nome: string) => {
    const caminho = join(DIRS.gerados, `${nome}-${Date.now()}.png`);
    await page.screenshot({ path: caminho, fullPage: true }).catch(() => {});
    return caminho;
  };

  // Prova de envio (invariante 1: vale a resposta HTTP, não o texto da tela). Aqui o envio é um POST de página
  // inteira, e o Laravel responde a POST com redirect. Voltar para a própria vaga é o jeito do Laravel devolver
  // erro de validação (`back()->withErrors()`); qualquer outro destino é a candidatura criada.
  let envioAceito = false;
  let prova: ProvaDeEnvio | null = null;
  let envioTentado = false;
  let recusaDoServidor = '';
  const ehEnvio = (url: string, metodo: string) => ROTA_ENVIO.test(url) && metodo.toUpperCase() === 'POST';
  // O site usa alert() para reclamar de arquivo inválido; sem isto o diálogo travaria a página do robô
  page.on('dialog', d => void d.dismiss().catch(() => {}));
  page.on('request', req => {
    if (ehEnvio(req.url(), req.method())) envioTentado = true;
  });
  page.on('response', res => {
    if (!ehEnvio(res.url(), res.request().method())) return;
    const destino = res.headers().location ?? '';
    if (res.status() >= 400) recusaDoServidor = `o Vagas PJ recusou o envio (HTTP ${res.status()})`;
    else if (res.status() >= 300 && destino && destino.replace(/\?.*$/, '') === vaga.url.replace(/\?.*$/, ''))
      recusaDoServidor = 'o Vagas PJ devolveu o formulário para a própria vaga: algum dado foi recusado na validação';
    else if (!envioAceito) {
      envioAceito = true;
      prova = { metodo: res.request().method(), rota: new URL(res.url()).pathname, http: res.status() };
      log('sucesso', `O Vagas PJ aceitou a candidatura (HTTP ${res.status()} em /candidaturas).`);
    }
  });

  /**
   * Entre o clique em "Candidatar" e o envio existe um anúncio ("Receba as vagas por WhatsApp") que intercepta o
   * submit: o POST só sai no clique em "Continuar candidatura". Antes disso o site roda a validação do navegador —
   * se um campo obrigatório ficou inválido, o clique não faz absolutamente nada (nem anúncio, nem envio), e sem
   * este aviso o robô ficaria esperando uma tela que nunca muda.
   */
  const aposBotaoFinal = async (): Promise<void> => {
    const anuncio = page.locator(VAGASPJ.anuncio);
    const apareceu = await anuncio.waitFor({ state: 'visible', timeout: 6000 }).then(
      () => true,
      () => false,
    );
    if (!apareceu) {
      const invalido = await page
        .locator(VAGASPJ.formulario)
        .evaluate(f => {
          const campo = [...(f as HTMLFormElement).elements].find(el => typeof (el as HTMLInputElement).checkValidity === 'function' && !(el as HTMLInputElement).checkValidity()) as
            | HTMLInputElement
            | undefined;
          return campo ? campo.name || campo.id || 'um campo' : '';
        })
        .catch(() => '');
      if (invalido) throw new Error(`o navegador barrou o envio: o campo "${invalido}" ficou vazio ou fora do formato exigido pelo Vagas PJ`);
      return; // sem anúncio e sem campo inválido: o site enviou direto
    }
    log('info', 'Dispensando o anúncio do WhatsApp para concluir o envio.');
    // `noWaitAfter`: este clique dispara um POST de página inteira COM o upload do PDF. Esperar a navegação
    // dentro do clique estourava os 12 s do padrão e derrubava tudo por exceção — numa candidatura que o site
    // tinha ACEITADO (23/09/2026: a captura do "erro" mostrava "Candidatura enviada"). O desfecho é esperado
    // logo abaixo, com prazo de upload, em vez de virar timeout de clique.
    await page.locator(VAGASPJ.dispensarAnuncio).click({ noWaitAfter: true, timeout: 20000 });
    await page.waitForResponse(res => ehEnvio(res.url(), res.request().method()), { timeout: ESPERA_ENVIO_MS }).catch(() => {});
  };

  try {
    // Invariante 5: em ensaio a rota que cria a candidatura fica abortada no navegador
    // Aborta só o POST que cria a candidatura: bloquear o caminho inteiro derrubaria leituras da própria página
    if (dados.ensaio) await page.route(ROTA_ENVIO_GLOB, rota => (ehEnvio(rota.request().url(), rota.request().method()) ? rota.abort() : rota.continue()));
    log('info', `Abrindo ${vaga.url}`);
    await page.goto(vaga.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (
      await page
        .locator(VAGASPJ.externa)
        .first()
        .isVisible()
        .catch(() => false)
    )
      return { status: 'erro', motivo: 'a candidatura desta vaga é no site da empresa, fora do Vagas PJ; envie manualmente', captura: await captura('vagaspj-externa') };

    // No desktop o site já abre o formulário sozinho; no mobile (e se isso mudar) é este botão que o revela
    const expandir = page.locator(VAGASPJ.expandir);
    if (await expandir.isVisible().catch(() => false)) await expandir.click().catch(() => {});

    const apareceu = await page
      .locator(`${VAGASPJ.formulario} input[name="name"]`)
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!apareceu) {
      const texto = await page.evaluate(() => document.body.innerText).catch(() => '');
      const motivo = VAGASPJ.encerrada.test(texto) ? 'a vaga foi encerrada no Vagas PJ' : 'o formulário de candidatura não apareceu (vaga encerrada ou layout mudou)';
      return { status: 'erro', motivo, captura: await captura('vagaspj-sem-formulario') };
    }

    const r = await executarFormulario(page, dados, log, { convencoes: VAGASPJ.convencoes, envioComprovado: () => envioAceito, aposBotaoFinal });
    const resumo: ResumoFormulario = {
      etapas: r.etapas.length,
      campos: r.etapas.reduce((s, e) => s + e.campos.length, 0),
      perguntas: r.perguntasRespondidas,
      typeform: r.typeform,
      incomum: r.etapas.length > 3 || r.etapas.some(e => e.campos.some(c => c.tipo === 'desconhecido')),
    };
    formularios.salvar(vaga.id, { etapas: r.etapas, resumo, em: new Date().toISOString() });
    log('info', `Estrutura do formulário do Vagas PJ: ${resumo.etapas} etapa(s), ${resumo.campos} campo(s).`);

    if (r.resultado.status === 'pergunta') return r.resultado;
    if (r.resultado.status === 'ensaio') return { ...r.resultado, captura: await captura('vagaspj-ensaio'), formulario: resumo };
    if (r.resultado.status === 'erro') return { ...r.resultado, motivo: motivoDoErro(r.resultado.motivo, envioTentado, recusaDoServidor), captura: await captura('vagaspj-erro'), formulario: resumo };
    return { ...r.resultado, formulario: resumo, prova: prova ?? undefined };
  } catch (e) {
    if (envioAceito) {
      log('alerta', `A página quebrou depois do envio (${(e as Error).message.split('\n')[0]}), mas o Vagas PJ já tinha aceitado a candidatura.`);
      return { status: 'enviada', prova: prova ?? undefined };
    }
    // Rede de segurança do invariante 1: o envio pode concluir DEPOIS da exceção (upload lento). Antes de
    // dizer "erro", pergunte à tela — foi assim que uma candidatura enviada de verdade virou erro em 23/09/2026.
    const naTela = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (VAGASPJ.convencoes.sucesso.test(naTela)) {
      log('alerta', `Deu erro no meio do caminho (${(e as Error).message.split('\n')[0]}), mas a tela do Vagas PJ mostra a candidatura enviada. Contando como enviada.`);
      return { status: 'enviada', prova: prova ?? undefined };
    }
    return { status: 'erro', motivo: motivoDoErro((e as Error).message.split('\n')[0], envioTentado, recusaDoServidor), captura: await captura('vagaspj-erro') };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * O POST saiu mas ninguém respondeu (rede caiu no meio): a candidatura pode ter sido criada. Repetir arriscaria
 * um segundo envio para a mesma vaga, então a mensagem carrega "revise manualmente", que `core/falhas.ts`
 * classifica como permanente — a vaga espera por uma decisão sua em vez de voltar sozinha para a fila.
 */
export function motivoDoErro(motivo: string, envioTentado: boolean, recusaDoServidor: string): string {
  if (recusaDoServidor) return recusaDoServidor;
  if (envioTentado) return `${motivo} — o envio chegou a sair sem resposta do site; confira em vagaspj.com.br e revise manualmente antes de reenviar`;
  return motivo;
}

export const vagaspj: PlatformAdapter = { id: 'vagaspj', nome: 'Vagas PJ', buscarVagas, candidatar };
registrarAdapter(vagaspj);
