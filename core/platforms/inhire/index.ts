import { join } from 'node:path';
import type { ConfigAutomacao, PerfilBusca, PerguntaExtra, ResumoFormulario, Vaga } from '../../../src/types.ts';
import { registrarAdapter, type DadosCandidatura, type Log, type PlatformAdapter, type ResultadoCandidatura, type ProvaDeEnvio } from '../adapter.ts';
import { navegador } from '../../browser.ts';
import { DIRS } from '../../config.ts';
import { varrer } from './discovery.ts';
import { filtrosDaAutomacao, ler } from '../../estado.ts';
import { formularios } from '../../storage/db.ts';
import { lerSchemaFormulario, perguntasCertas } from './schema.ts';
import { executarFormulario, type EtapaDescoberta } from './formulario.ts';
import { ROTAS_ENVIO } from './selectors.ts';

export { pretensaoEmReais } from './formulario.ts';

// A busca é o módulo de descoberta (discovery.ts): lista de empresas + API pública. Aqui só a candidatura.
const buscarVagas = (perfil: PerfilBusca, cfg: ConfigAutomacao, log: Log): Promise<Vaga[]> => varrer(perfil, { ...filtrosDaAutomacao(cfg, ler.localizacao()), scoreMinimo: cfg.scoreMinimo }, log);

const jobIdDe = (vaga: Vaga) => vaga.id.replace(/^inhire:[^:]+:/, '');

/** Perguntas que a vaga com certeza vai fazer (diversidade obrigatória + Typeform obrigatório), lidas da API. */
async function perguntasPrevias(vaga: Vaga): Promise<PerguntaExtra[]> {
  const schema = await lerSchemaFormulario(vaga.tenant, jobIdDe(vaga));
  return perguntasCertas(schema).map(p => ({ rotulo: p.rotulo, tipo: p.tipo, opcoes: p.opcoes, obrigatoria: true }));
}

/**
 * Bloqueio do ensaio (invariante 5): aborta só o que CRIA a candidatura.
 *
 * Antes era por glob de caminho (tudo sob `job-talents/public`), e isso derrubava junto as leituras que o questionário faz
 * para se montar: em ensaio o iframe ficava eternamente em branco, e era por isso que o ensaio nunca conseguiu
 * exercitar o questionário de nenhuma empresa (descoberto em 23/09/2026 investigando 15 vagas travadas nele).
 * Agora o critério é o mesmo da prova de envio: a rota certa E um método que escreve.
 */
const criaCandidatura = (url: string, metodo: string) => ROTAS_ENVIO.some(r => r.re.test(url)) && /^(POST|PUT|PATCH)$/i.test(metodo);

async function candidatar(vaga: Vaga, dados: DadosCandidatura, log: Log): Promise<ResultadoCandidatura> {
  const ctx = await navegador(dados.mostrarNavegador);
  const page = await ctx.newPage();
  const captura = async (nome: string) => {
    const caminho = join(DIRS.gerados, `${nome}-${Date.now()}.png`);
    await page.screenshot({ path: caminho, fullPage: true }).catch(() => {});
    return caminho;
  };
  let etapas: EtapaDescoberta[] = [];
  page.setDefaultTimeout(12000); // ações do Playwright (click/fill) esperam no máximo isto; as esperas de fluxo são explícitas

  // Prova dura de envio: a resposta HTTP das rotas que criam a candidatura. Texto de tela muda; isto não.
  // Sem isto, uma mudança de redação na tela de agradecimento faz o robô marcar erro numa vaga que já foi enviada
  // (e, pior, tentar de novo). Também registra recusas (4xx/5xx) com o motivo real que o InHire devolveu.
  let envioAceito = false;
  let prova: ProvaDeEnvio | null = null;
  let recusaDoServidor = '';
  page.on('response', res => {
    const rota = ROTAS_ENVIO.find(r => r.re.test(res.url()));
    if (!rota || !/^(POST|PUT|PATCH)$/i.test(res.request().method())) return;
    if (res.status() >= 200 && res.status() < 300) {
      if (rota.definitiva && !envioAceito) {
        envioAceito = true;
        prova = { metodo: res.request().method(), rota: new URL(res.url()).pathname, http: res.status() };
        log('sucesso', `O InHire aceitou a candidatura (${res.status()} em ${new URL(res.url()).pathname}).`);
      }
    } else if (rota.definitiva) {
      recusaDoServidor = `o InHire recusou o envio (HTTP ${res.status()})`;
      res
        .text()
        .then(t => {
          const m = t.replace(/\s+/g, ' ').slice(0, 160);
          if (m) recusaDoServidor = `o InHire recusou o envio (HTTP ${res.status()}): ${m}`;
        })
        .catch(() => {});
    }
  });

  try {
    if (dados.ensaio)
      await page.route('**/*', rota => {
        const req = rota.request();
        return criaCandidatura(req.url(), req.method()) ? rota.abort() : rota.continue();
      });
    log('info', `Abrindo ${vaga.url}`);
    await page.goto(vaga.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const apareceu = await page
      .locator('form input, form textarea, form .react-dropdown-select')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!apareceu) return { status: 'erro', motivo: 'formulário de candidatura não apareceu (vaga encerrada ou layout mudou)', captura: await captura('sem-formulario') };

    const schema = await lerSchemaFormulario(vaga.tenant, jobIdDe(vaga)).catch(() => null);
    const r = await executarFormulario(page, dados, log, { fluxoCondicional: schema?.fluxoCondicional ?? false, envioComprovado: () => envioAceito });
    etapas = r.etapas;
    const resumo: ResumoFormulario = {
      etapas: r.etapas.length,
      campos: r.etapas.reduce((s, e) => s + e.campos.length, 0),
      perguntas: r.perguntasRespondidas,
      typeform: r.typeform,
      incomum: r.etapas.length > 3 || r.etapas.some(e => e.campos.some(c => c.tipo === 'desconhecido')),
    };
    formularios.salvar(vaga.id, { etapas: r.etapas, resumo, em: new Date().toISOString() });
    log(
      'info',
      `Estrutura do formulário: ${resumo.etapas} etapa(s), ${resumo.campos} campo(s)${resumo.typeform ? ', com Typeform' : ''}${resumo.incomum ? ' — estrutura incomum, vale conferir a captura' : ''}.`,
    );

    if (r.resultado.status === 'ensaio') {
      const valores = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll<HTMLInputElement>('input[name]')].filter(i => i.type !== 'file' && i.type !== 'radio' && i.type !== 'checkbox' && i.value).map(i => [i.name, i.value]),
        ),
      );
      // Só os NOMES dos campos e se têm valor — nunca o valor. O log vai para `diario/acv-DIA.log`, que é o
      // arquivo que a pessoa cola num chat pedindo ajuda: celular, CPF e pretensão saíam junto. Achado pela
      // auditoria do codex em 05/10/2026.
      log('info', `Campos preenchidos no ensaio: ${Object.keys(valores).join(', ').slice(0, 400) || '(nenhum)'}`);
      return { ...r.resultado, captura: await captura('ensaio'), formulario: resumo };
    }
    if (r.resultado.status === 'erro') return { ...r.resultado, motivo: recusaDoServidor || r.resultado.motivo, captura: await captura('erro'), formulario: resumo };
    if (r.resultado.status === 'pergunta') return r.resultado;
    return { ...r.resultado, formulario: resumo, prova: prova ?? undefined };
  } catch (e) {
    // Exceção depois de um envio já aceito (a página fechou, o layout sumiu): a candidatura existe. Não é erro.
    if (envioAceito) {
      log('alerta', `A página quebrou depois do envio (${(e as Error).message.split('\n')[0]}), mas o InHire já tinha aceitado a candidatura.`);
      return { status: 'enviada', prova: prova ?? undefined };
    }
    const motivo = recusaDoServidor || (e as Error).message.split('\n')[0];
    const ultima = etapas.at(-1);
    return {
      status: 'erro',
      motivo: ultima
        ? `${motivo} (etapa ${ultima.etapa}: ${ultima.campos
            .map(c => c.rotulo || c.nome)
            .slice(0, 6)
            .join(', ')})`
        : motivo,
      captura: await captura('erro'),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export const inhire: PlatformAdapter = { id: 'inhire', nome: 'InHire', buscarVagas, candidatar, perguntasPrevias };
registrarAdapter(inhire);
