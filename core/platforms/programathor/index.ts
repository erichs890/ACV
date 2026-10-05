// Adapter do ProgramaThor (programathor.com.br): mural brasileiro de vagas de tecnologia.
//
// A busca é HTTP puro e pública (busca.ts); a candidatura EXIGE conta, e por isso este é o segundo adapter
// com `sessao` (o primeiro foi o Indeed): você entra uma vez numa janela do robô, a sessão fica no perfil do
// navegador dele e a partir daí ele candidata sozinho.
//
// O que foi e o que não foi confirmado ao vivo está em seletores.ts. O formulário logado NÃO foi observado:
// a primeira candidatura deve ser em modo ensaio.
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ConfigAutomacao, PerfilBusca, ResumoFormulario, Vaga } from '../../../src/types.ts';
import { registrarAdapter, type DadosCandidatura, type Log, type PlatformAdapter, type ResultadoCandidatura, type ProvaDeEnvio } from '../adapter.ts';
import type { ProvaDeLogin } from '../../sessao.ts';
import { navegador } from '../../browser.ts';
import { DIRS } from '../../config.ts';
import { ler } from '../../estado.ts';
import { formularios } from '../../storage/db.ts';
import { executarFormulario } from '../inhire/formulario.ts';
import { buscarNoProgramaThor } from './busca.ts';
import { PROGRAMATHOR, ROTA_ENVIO, ROTA_ENVIO_GLOB } from './seletores.ts';

const buscarVagas = (perfil: PerfilBusca, cfg: ConfigAutomacao, log: Log): Promise<Vaga[]> => buscarNoProgramaThor(perfil, cfg, log, ler.localizacao());

/**
 * Prova de login.
 *
 * O sinal sai da página deslogada observada ao vivo: ali TODO caminho de candidatura aponta para
 * `/users/sign_up` — inclusive o botão grande "Quero me candidatar". Logado, esse botão tem de virar outra
 * coisa. Então "o CTA não aponta mais para o cadastro" é a prova, e ela não depende de achar um avatar ou um
 * nome de menu, que mudam de lugar a cada redesenho do site.
 */
const sessao: ProvaDeLogin = {
  urlLogin: `${PROGRAMATHOR.base}/users/sign_in`,
  // Cobre TAMBÉM o caminho do OAuth e o domínio do LinkedIn. O site oferece "Login com LinkedIn", que sai
  // para /users/auth/linkedin e dali para linkedin.com — se a regex não reconhecer essas URLs como "ainda
  // entrando", o robô acha que o login terminou e fecha a janela com a pessoa digitando a senha.
  telasDeLogin: /programathor\.com\.br\/users\/(sign_in|sign_up|password|confirmation|auth)|linkedin\.com/i,
  urlProva: `${PROGRAMATHOR.base}/jobs`,
  logado: async (page: Page) => {
    const html = await page.content();
    return !PROGRAMATHOR.ctaDeslogado.test(html) && !/href="\/users\/sign_in"/i.test(html);
  },
};

async function candidatar(vaga: Vaga, dados: DadosCandidatura, log: Log): Promise<ResultadoCandidatura> {
  const ctx = await navegador(dados.mostrarNavegador);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const captura = async (nome: string) => {
    const caminho = join(DIRS.gerados, `${nome}-${Date.now()}.png`);
    await page.screenshot({ path: caminho, fullPage: true }).catch(() => {});
    return caminho;
  };

  // Prova de envio (invariante 1): vale a resposta HTTP, não o texto da tela
  let envioAceito = false;
  let prova: ProvaDeEnvio | null = null;
  let envioTentado = false;
  let recusa = '';
  let corpoDaRecusa: Promise<string> | null = null;
  const ehEnvio = (url: string, metodo: string) => ROTA_ENVIO.test(url) && metodo.toUpperCase() === 'POST';
  page.on('dialog', d => void d.dismiss().catch(() => {}));
  page.on('request', req => {
    if (ehEnvio(req.url(), req.method())) envioTentado = true;
  });
  page.on('response', res => {
    if (!ehEnvio(res.url(), res.request().method())) return;
    if (res.status() >= 400) {
      recusa = `o ProgramaThor recusou a candidatura (HTTP ${res.status()})`;
      corpoDaRecusa = res.text().catch(() => '');
    } else if (!envioAceito) {
      envioAceito = true;
      prova = { metodo: res.request().method(), rota: new URL(res.url()).pathname, http: res.status() };
      log('sucesso', `O ProgramaThor aceitou a candidatura (HTTP ${res.status()}).`);
    }
  });

  try {
    // Modo ensaio: corta só o POST que cria, nunca o caminho inteiro (invariante 5)
    if (dados.ensaio) await page.route(ROTA_ENVIO_GLOB, rota => (ehEnvio(rota.request().url(), rota.request().method()) ? rota.abort() : rota.continue()));

    log('info', `Abrindo ${vaga.url}`);
    await page.goto(vaga.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const html = await page.content();
    if (PROGRAMATHOR.encerrada.test(html)) return { status: 'erro', motivo: 'a vaga foi encerrada no ProgramaThor', captura: await captura('programathor-encerrada') };

    // Sem sessão o site devolve o cadastro em vez do formulário. Dizer isso é melhor do que o robô tentar
    // preencher uma tela de cadastro — e criar conta é coisa que ele não faz.
    if (await sessao.logado(page).then(ok => !ok)) {
      return {
        status: 'erro',
        motivo: 'o ProgramaThor exige conta para candidatar e a sessão do robô não está ativa — entre em Plataformas › ProgramaThor',
        captura: await captura('programathor-deslogado'),
      };
    }

    const r = await executarFormulario(page, dados, log, { convencoes: PROGRAMATHOR.convencoes, envioComprovado: () => envioAceito });
    const resumo: ResumoFormulario = {
      etapas: r.etapas.length,
      campos: r.etapas.reduce((soma, e) => soma + e.campos.length, 0),
      perguntas: r.perguntasRespondidas,
      typeform: r.typeform,
      incomum: r.etapas.length > 3 || r.etapas.some(e => e.campos.some(c => c.tipo === 'desconhecido')),
    };
    formularios.salvar(vaga.id, { etapas: r.etapas, resumo, em: new Date().toISOString() });
    log('info', `Estrutura do formulário do ProgramaThor: ${resumo.etapas} etapa(s), ${resumo.campos} campo(s).`);

    // Recusa do servidor ganha de tudo, menos de um envio já comprovado
    if (recusa && !envioAceito) {
      const detalhe = (await (corpoDaRecusa ?? Promise.resolve(''))).replace(/\s+/g, ' ').trim().slice(0, 160);
      // O corpo da resposta diz qual campo faltou; "HTTP 400" sozinho não conserta nada (lição do Quickin)
      if (detalhe) log('alerta', `Resposta do ProgramaThor à recusa: ${detalhe}`);
      return { status: 'erro', motivo: detalhe ? `${recusa}: ${detalhe}` : recusa, captura: await captura('programathor-recusa'), formulario: resumo };
    }
    if (envioAceito) return { status: 'enviada', formulario: resumo, prova: prova ?? undefined };
    if (r.resultado.status === 'pergunta') return r.resultado;
    if (r.resultado.status === 'ensaio') return { ...r.resultado, captura: await captura('programathor-ensaio'), formulario: resumo };
    if (r.resultado.status === 'erro') return { ...r.resultado, captura: await captura('programathor-erro'), formulario: resumo };
    return { ...r.resultado, formulario: resumo };
  } catch (e) {
    // Nunca reportar erro depois de um envio comprovado (invariante 1)
    if (envioAceito) {
      log('alerta', `A página quebrou depois do envio (${(e as Error).message.split('\n')[0]}), mas o ProgramaThor já tinha aceitado a candidatura.`);
      return { status: 'enviada' };
    }
    const motivo = (e as Error).message.split('\n')[0];
    return {
      status: 'erro',
      // POST que saiu sem resposta vista não volta para a fila sozinho: seria um segundo currículo na mesa
      // do mesmo recrutador. `core/falhas.ts` trata "revise manualmente" como permanente.
      motivo: envioTentado ? `${motivo} — o envio chegou a sair, revise manualmente antes de tentar de novo` : motivo,
      captura: await captura('programathor-erro'),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export const programathor: PlatformAdapter = { id: 'programathor', nome: 'ProgramaThor', buscarVagas, candidatar, sessao };
registrarAdapter(programathor);
