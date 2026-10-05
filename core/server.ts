import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Arquivo, Estado } from '../src/types.ts';
import './platforms/inhire/index.ts';
import './platforms/indeed/index.ts';
import { cancelarLogin, entrarNaJanela } from './sessao.ts';
import { plataformasConhecidas, vagaDaUrl } from './importar.ts';
import { autorizado, dadosParaExtensao, perfilParaExtensao, receberCandidaturas, registrarCamposFaltando, registrarPlataformaDetectada, responderParaExtensao, tokenDaExtensao } from './extensao.ts';
import './platforms/vagaspj/index.ts';
import './platforms/divulgavagas/index.ts';
import './platforms/workable/index.ts';
import './platforms/quickin/index.ts';
import './platforms/arbeitnow/index.ts';
import './platforms/programathor/index.ts';
import { PORTA, DIRS } from './config.ts';
import { eventos, emitir, type Evento } from './events.ts';
import { apagarTudo, kv, log, vagas } from './storage/db.ts';
import { migrarCaminhosDaPastaAntiga } from './migracoes.ts';
import { evento } from './diario.ts';
import { ler, montarEstado, salvarParcial } from './estado.ts';
import {
  buscarVagas,
  candidatarAgora,
  decidirPreview,
  enfileirarCompativeis,
  iniciarLaco,
  ligarRobo,
  limparDuplicatasDaFila,
  removerDaFila,
  repontuar,
  repontuarComIA,
  responder,
  devolverAFila,
} from './queue.ts';
import { pdfParaMarkdown } from './resume/pdfToMd.ts';
import { analisarCurriculo } from './resume/analyzer.ts';
import { markdownParaPdf } from './resume/mdToPdf.ts';
import { traduzirCurriculoParaIngles } from './resume/traducao.ts';
import { encerrarIrmasEnviadas, gerarAdaptacao } from './candidatura.ts';
import { fecharNavegador } from './browser.ts';
import { migrarModelo, salvarIA, testarIA } from './ia.ts';
import { adicionarEmpresa, importarSeed, migrarTenantsAntigos, salvarDescoberta } from './platforms/inhire/discovery.ts';
import { empresas } from './storage/db.ts';

const SCORE_VERSAO = 10; // suba ao mudar calcularScore: as vagas abertas são repontuadas ao iniciar
import { buscarEmpresas } from './queue.ts';

const registrar = log.registrar;

function corpo(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = [];
    req.on('data', c => partes.push(c));
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, dados: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(dados));
}

/** Upload de currículo: bytes crus no corpo, nome no query. Extrai Markdown e monta o perfil de busca. */
async function receberCurriculo(nome: string, bytes: Buffer): Promise<Arquivo> {
  const id = Date.now();
  const caminho = join(DIRS.curriculos, `${id}-${nome.replace(/[^\w.-]+/g, '_')}`);
  await writeFile(caminho, bytes);
  const arquivo: Arquivo = { id, nome, tamanho: bytes.length, enviadoEm: new Date().toISOString(), caminho };
  if (/\.pdf$/i.test(nome)) {
    try {
      arquivo.markdown = await pdfParaMarkdown(caminho);
      arquivo.perfilBusca = analisarCurriculo(arquivo.markdown);
      registrar('sucesso', `Currículo ${nome} analisado: ${arquivo.perfilBusca.area}, ${arquivo.perfilBusca.senioridade}, ${arquivo.perfilBusca.skills.length} competências.`);
    } catch (e) {
      registrar('alerta', `Não consegui ler o texto de ${nome}: ${(e as Error).message}. A busca de vagas precisa de um PDF com texto.`);
    }
  } else {
    registrar('alerta', `${nome} salvo, mas só PDFs são analisados por enquanto. Envie o currículo em PDF para a busca funcionar.`);
  }
  return arquivo;
}

/**
 * O perfil de busca (área, cargos, competências, senioridade) é calculado no upload e fica gravado junto ao
 * currículo. Quando a análise melhora, o que está gravado continua velho — foi assim que um currículo de
 * "Full Stack há mais de 3 anos" seguiu marcado como Estágio depois da correção. Recalcula na subida do núcleo.
 */
/** `intervalo` era em minutos e virou `intervaloSegundos`: sem converter, 8 minutos viraria 8 segundos. */
function migrarIntervalo() {
  const salvo = kv.get<Record<string, unknown>>('automacao', {});
  if (typeof salvo.intervalo !== 'number' || salvo.intervaloSegundos !== undefined) return;
  const segundos = Math.round(salvo.intervalo * 60);
  kv.set('automacao', { ...salvo, intervaloSegundos: segundos });
  registrar('info', `Intervalo entre candidaturas convertido de ${salvo.intervalo} min para ${segundos} s.`);
}

function migrarPerfilBusca(): boolean {
  const lista = ler.curriculos();
  let mudou = false;
  const nova = lista.map(c => {
    if (!c.markdown) return c;
    const perfilBusca = analisarCurriculo(c.markdown);
    if (JSON.stringify(perfilBusca) === JSON.stringify(c.perfilBusca)) return c;
    mudou = true;
    if (perfilBusca.senioridade !== c.perfilBusca?.senioridade) {
      registrar('info', `Currículo ${c.nome} reanalisado: senioridade ${c.perfilBusca?.senioridade ?? '—'} → ${perfilBusca.senioridade}.`);
    }
    return { ...c, perfilBusca };
  });
  if (mudou) kv.set('curriculos', nova);
  return mudou;
}

const rotas: Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void> = {
  'GET /estado': (_r, res) => json(res, 200, montarEstado()),
  'POST /estado': async (req, res) => {
    const parcial = JSON.parse((await corpo(req)).toString('utf8')) as Partial<Estado>;
    const antes = ler.automacao();
    const localAntes = JSON.stringify(ler.localizacao());
    const cargoAntes = ler.perfil()?.cargo ?? '';
    salvarParcial(parcial);
    const a = parcial.automacao;
    const filtrosMudaram = a && (a.area !== antes.area || a.senioridade !== antes.senioridade || a.scoreMinimo !== antes.scoreMinimo || a.cargoRigido !== antes.cargoRigido);
    // Mudou o perfil profissional, a localização ou o cargo: a compatibilidade de todas as vagas muda junto
    if (filtrosMudaram || (parcial.perfil && JSON.stringify(ler.localizacao()) !== localAntes) || (parcial.perfil && (parcial.perfil.cargo ?? '') !== cargoAntes)) repontuar();
    // Trocou para automático (ou mexeu nos filtros/limite) com o robô ligado: a fila é reavaliada na hora,
    // senão salvar a configuração não teria efeito nenhum até a próxima varredura.
    if (a && (filtrosMudaram || a.modo !== antes.modo || a.regimes.join() !== antes.regimes.join() || a.limiteDiario !== antes.limiteDiario || a.filaAlvo !== antes.filaAlvo))
      enfileirarCompativeis('configuração salva');
    json(res, 200, montarEstado());
  },
  // Login manual assistido (qualquer plataforma com `adapter.sessao`): a pessoa entra na janela do robô; o ACV
  // não vê nem guarda a senha. Só fica conectada depois da prova de login (core/sessao.ts grava em `conexoes`).
  'POST /sessao/entrar': async (req, res) => {
    const { plataforma } = JSON.parse((await corpo(req)).toString('utf8')) as { plataforma: string };
    try {
      const r = await entrarNaJanela(plataforma);
      if (!r.ok) return json(res, 400, { erro: r.motivo });
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 400, { erro: (e as Error).message });
    }
  },
  'POST /sessao/cancelar': async (_req, res) => {
    cancelarLogin();
    json(res, 200, { ok: true });
  },
  // ─── Extensão de navegador (extensao/) ───────────────────────────────────────────────────────
  // O núcleo é um servidor local sem senha: estas rotas exigem o token que a pessoa cola no popup da extensão.
  'GET /extensao/token': (_req, res) => json(res, 200, { token: tokenDaExtensao() }),
  'GET /extensao/perfil': (req, res) => {
    if (!autorizado(req.headers.authorization)) return json(res, 401, { erro: 'token inválido: abra o popup da extensão e cole o token de Plataformas › Extensão' });
    json(res, 200, perfilParaExtensao());
  },
  // A extensão preenche formulários: aqui vão os valores de verdade (ver core/extensao.ts)
  'GET /extensao/dados': (req, res, url) => {
    if (!autorizado(req.headers.authorization)) return json(res, 401, { erro: 'token inválido' });
    json(res, 200, dadosParaExtensao(url.searchParams.get('curriculo') === '1'));
  },
  'POST /extensao/candidaturas': async (req, res) => {
    if (!autorizado(req.headers.authorization)) return json(res, 401, { erro: 'token inválido' });
    const { candidaturas: lista } = JSON.parse((await corpo(req)).toString('utf8'));
    json(res, 200, { novas: receberCandidaturas(lista) });
  },
  'POST /extensao/pergunta': async (req, res) => {
    if (!autorizado(req.headers.authorization)) return json(res, 401, { erro: 'token inválido' });
    json(res, 200, await responderParaExtensao(JSON.parse((await corpo(req)).toString('utf8'))));
  },
  // A extensão pergunta onde o núcleo tem adapter próprio — nesses sites o botão dela chama o ACV
  'GET /extensao/plataformas': (req, res) => {
    if (!autorizado(req.headers.authorization)) return json(res, 401, { erro: 'token inválido' });
    json(res, 200, { plataformas: plataformasConhecidas() });
  },
  /**
   * "Candidata nesta vaga que está aberta no meu navegador" — com o motor do núcleo, não o da extensão.
   * Acha (ou importa) a vaga, põe na fila como um clique em "Quero me candidatar" e ESPERA o desfecho, para a
   * extensão poder dizer o que aconteceu. Todas as travas do núcleo valem: duplicidade, ensaio, pendência.
   */
  'POST /extensao/candidatar': async (req, res) => {
    if (!autorizado(req.headers.authorization)) return json(res, 401, { erro: 'token inválido' });
    const { url } = JSON.parse((await corpo(req)).toString('utf8')) as { url: string };
    try {
      const vaga = await vagaDaUrl(String(url ?? ''));
      // O aviso sai ANTES do trabalho: é ele que diz, na tela do ACV, em qual vaga a extensão mandou mexer
      emitir({ tipo: 'aviso', nivel: 'info', msg: `Veio da extensão: candidatando em "${vaga.titulo}" (${vaga.empresa}).` });
      await candidatarAgora(vaga.id);
      const depois = vagas.get(vaga.id);
      json(res, 200, {
        status: depois?.status ?? 'desconhecido',
        titulo: vaga.titulo,
        empresa: vaga.empresa,
        score: vaga.score,
        pergunta: depois?.pendencia?.tipo === 'pergunta' ? depois.pendencia.pergunta.rotulo : undefined,
        erro: depois?.erro,
      });
    } catch (e) {
      json(res, 400, { erro: (e as Error).message });
    }
  },
  'POST /extensao/plataforma': async (req, res) => {
    if (!autorizado(req.headers.authorization)) return json(res, 401, { erro: 'token inválido' });
    json(res, 200, registrarPlataformaDetectada(JSON.parse((await corpo(req)).toString('utf8'))));
  },
  'POST /extensao/campos': async (req, res) => {
    if (!autorizado(req.headers.authorization)) return json(res, 401, { erro: 'token inválido' });
    json(res, 200, registrarCamposFaltando(JSON.parse((await corpo(req)).toString('utf8'))));
  },
  'POST /log': async (req, res) => {
    const { tipo, msg } = JSON.parse((await corpo(req)).toString('utf8'));
    json(res, 200, registrar(tipo, msg));
  },
  'POST /curriculos': async (req, res, url) => {
    const nome = url.searchParams.get('nome') ?? 'curriculo.pdf';
    const arquivo = await receberCurriculo(nome, await corpo(req));
    kv.set('curriculos', [arquivo, ...ler.curriculos()]);
    emitir({ tipo: 'estado' });
    json(res, 200, arquivo);
  },
  'DELETE /curriculos': async (_r, res, url) => {
    const id = Number(url.searchParams.get('id'));
    const lista = ler.curriculos();
    const alvo = lista.find(c => c.id === id);
    if (alvo?.caminho) await rm(alvo.caminho, { force: true });
    kv.set(
      'curriculos',
      lista.filter(c => c.id !== id),
    );
    emitir({ tipo: 'estado' });
    json(res, 200, { ok: true });
  },
  'GET /arquivo': (_r, res, url) => {
    // Serve PDFs/capturas gerados localmente (só dentro das pastas do ACV)
    const caminho = url.searchParams.get('caminho') ?? '';
    const permitido = Object.values(DIRS).some(d => caminho.startsWith(d));
    if (!permitido || !existsSync(caminho)) return json(res, 404, { erro: 'arquivo não encontrado' });
    const baixar = url.searchParams.get('baixar') === '1' || url.searchParams.get('download') === '1';
    const nome = url.searchParams.get('nome') || (caminho.endsWith('.png') ? 'imagem.png' : 'curriculo.pdf');
    const headers: Record<string, string> = {
      'content-type': caminho.endsWith('.png') ? 'image/png' : 'application/pdf',
    };
    if (baixar) {
      headers['content-disposition'] = `attachment; filename="${encodeURIComponent(nome)}"`;
    }
    res.writeHead(200, headers);
    res.end(readFileSync(caminho));
  },
  'POST /curriculo/ingles': async (req, res) => {
    const { id, refazer } = JSON.parse((await corpo(req)).toString('utf8') || '{}');
    const lista = ler.curriculos();
    const alvo = id ? lista.find(c => c.id === Number(id)) : lista[0];
    if (!alvo?.markdown) {
      return json(res, 400, { erro: 'nenhum currículo com texto encontrado para traduzir' });
    }

    if (alvo.inglesMarkdown && alvo.inglesPdf && existsSync(alvo.inglesPdf) && !refazer) {
      return json(res, 200, {
        ok: true,
        inglesMarkdown: alvo.inglesMarkdown,
        pdf: alvo.inglesPdf,
        caminho: alvo.inglesPdf,
        nome: `${alvo.nome.replace(/\.[^.]+$/, '')}-EN.pdf`,
      });
    }

    registrar('info', `Iniciando tradução do currículo ${alvo.nome} para inglês...`);
    const inglesMarkdown = await traduzirCurriculoParaIngles(alvo.markdown);
    if (!inglesMarkdown.trim()) {
      return json(res, 500, { erro: 'não foi possível traduzir o currículo' });
    }

    const caminhoPdf = join(DIRS.curriculos, `${alvo.id}-en.pdf`);
    await markdownParaPdf(inglesMarkdown, caminhoPdf, false);

    alvo.inglesMarkdown = inglesMarkdown;
    alvo.inglesPdf = caminhoPdf;
    alvo.traduzidoEm = new Date().toISOString();

    kv.set(
      'curriculos',
      lista.map(c => (c.id === alvo.id ? alvo : c)),
    );
    registrar('sucesso', `Currículo ${alvo.nome} traduzido para inglês com sucesso.`);
    emitir({ tipo: 'estado' });

    json(res, 200, {
      ok: true,
      inglesMarkdown,
      pdf: caminhoPdf,
      caminho: caminhoPdf,
      nome: `${alvo.nome.replace(/\.[^.]+$/, '')}-EN.pdf`,
    });
  },
  'POST /curriculo/salvar-markdown': async (req, res) => {
    const { nome, markdown } = JSON.parse((await corpo(req)).toString('utf8') || '{}');
    if (!markdown?.trim()) return json(res, 400, { erro: 'markdown ausente' });
    const nomeFinal = `${(nome?.trim() || 'curriculo-en.pdf').replace(/\.pdf$/i, '')}.pdf`;
    const id = Date.now();
    const caminho = join(DIRS.curriculos, `${id}-${nomeFinal.replace(/[^\w.-]+/g, '_')}`);
    await markdownParaPdf(markdown, caminho, false);
    const bytes = readFileSync(caminho);
    const perfilBusca = analisarCurriculo(markdown);
    const arquivo: Arquivo = {
      id,
      nome: nomeFinal,
      tamanho: bytes.length,
      enviadoEm: new Date().toISOString(),
      caminho,
      markdown,
      perfilBusca,
    };
    kv.set('curriculos', [arquivo, ...ler.curriculos()]);
    registrar('sucesso', `Currículo ${nomeFinal} salvo como novo arquivo.`);
    emitir({ tipo: 'estado' });
    json(res, 200, arquivo);
  },
  'POST /buscar': async (_r, res) => {
    // Varredura forçada; roda em segundo plano e o front acompanha por eventos/log
    void buscarVagas(true).catch(e => registrar('erro', `Varredura falhou: ${(e as Error).message}`));
    json(res, 200, { ok: true });
  },
  'POST /empresas': async (req, res) => {
    const { entrada } = JSON.parse((await corpo(req)).toString('utf8'));
    try {
      json(res, 200, await adicionarEmpresa(String(entrada ?? ''), 'manual', registrar));
    } catch (e) {
      json(res, 400, { erro: (e as Error).message }); // validação esperada: não vai para o log de atividade
    }
  },
  'DELETE /empresas': (_r, res, url) => {
    empresas.remover(url.searchParams.get('subdominio') ?? '');
    emitir({ tipo: 'estado' });
    json(res, 200, { ok: true });
  },
  'POST /empresas/ativar': async (req, res) => {
    const { subdominio, ativo } = JSON.parse((await corpo(req)).toString('utf8'));
    empresas.atualizar(subdominio, { ativo: !!ativo, falhas: 0 });
    emitir({ tipo: 'estado' });
    json(res, 200, { ok: true });
  },
  'POST /empresas/seed': (_r, res) => {
    importarSeed(registrar, true);
    emitir({ tipo: 'estado' });
    json(res, 200, { total: empresas.listar().length });
  },
  'POST /descoberta': async (req, res) => {
    salvarDescoberta(JSON.parse((await corpo(req)).toString('utf8')));
    emitir({ tipo: 'estado' });
    json(res, 200, montarEstado().descoberta);
  },
  'POST /descoberta/buscar': (_r, res) => {
    // Demora minutos (Common Crawl + validação); roda em segundo plano e o front acompanha por eventos/log
    void buscarEmpresas().catch(e => registrar('alerta', `Descoberta de empresas falhou: ${(e as Error).message}`));
    json(res, 200, { ok: true });
  },
  'POST /repontuar-ia': async (req, res) => {
    // Demora minutos (uma chamada a cada 6 vagas); roda em segundo plano e o front acompanha pelo log
    const { limite } = JSON.parse((await corpo(req)).toString('utf8') || '{}');
    void repontuarComIA(Number(limite) || 50).catch(e => registrar('alerta', `Reavaliação por IA falhou: ${(e as Error).message}`));
    json(res, 200, { ok: true });
  },
  'POST /candidatar': async (req, res) => {
    candidatarAgora(JSON.parse((await corpo(req)).toString('utf8')).id);
    json(res, 200, { ok: true });
  },
  'POST /fila/remover': async (req, res) => {
    removerDaFila(JSON.parse((await corpo(req)).toString('utf8')).id);
    json(res, 200, { ok: true });
  },
  // Desfazer o "esta não": sem isto um clique errado tiraria a vaga do jogo para sempre
  'POST /fila/devolver': async (req, res) => {
    devolverAFila(JSON.parse((await corpo(req)).toString('utf8')).id);
    json(res, 200, { ok: true });
  },
  'POST /responder': async (req, res) => {
    const { id, resposta, salvar } = JSON.parse((await corpo(req)).toString('utf8'));
    responder(id, resposta, !!salvar);
    json(res, 200, { ok: true });
  },
  'POST /preview': async (req, res) => {
    const { id, decisao } = JSON.parse((await corpo(req)).toString('utf8'));
    decidirPreview(id, decisao);
    json(res, 200, { ok: true });
  },
  'POST /preview/gerar': async (req, res) => {
    // Adaptação sob demanda (botão "Currículo adaptado"): gera (IA se houver, senão regras), guarda na vaga, não envia nada
    const { id, refazer } = JSON.parse((await corpo(req)).toString('utf8'));
    const vaga = vagas.get(id);
    const md = ler.curriculos()[0]?.markdown;
    if (!vaga || !md) return json(res, 400, { erro: 'vaga ou currículo principal ausente' });
    const a = vaga.adaptado && !refazer ? vaga.adaptado : await gerarAdaptacao(md, vaga);
    emitir({ tipo: 'estado' });
    json(res, 200, { ...a, original: md });
  },
  'POST /preview/pdf': async (req, res) => {
    // Gera (ou regenera) o PDF da adaptação guardada e devolve o caminho para abrir
    const { id } = JSON.parse((await corpo(req)).toString('utf8'));
    const vaga = vagas.get(id);
    const md = ler.curriculos()[0]?.markdown;
    if (!vaga || !md) return json(res, 400, { erro: 'vaga ou currículo principal ausente' });
    const a = vaga.adaptado ?? (await gerarAdaptacao(md, vaga));
    const pdf = join(DIRS.gerados, `preview_${vaga.id.replace(/[^a-z0-9]/gi, '_')}.pdf`);
    await markdownParaPdf(a.markdown, pdf, ler.automacao().mostrarNavegador);
    vagas.atualizar(id, { adaptado: { ...a, pdf } });
    emitir({ tipo: 'estado' });
    json(res, 200, { pdf });
  },
  'POST /ia': async (req, res) => {
    salvarIA(JSON.parse((await corpo(req)).toString('utf8')));
    registrar('info', 'Configuração de IA atualizada.');
    emitir({ tipo: 'estado' });
    json(res, 200, montarEstado().ia);
  },
  'POST /ia/testar': async (_r, res) => {
    try {
      json(res, 200, { ok: true, msg: await testarIA() });
    } catch (e) {
      json(res, 200, { ok: false, msg: (e as Error).message });
    }
  },
  'POST /robo': async (req, res) => {
    ligarRobo(!!JSON.parse((await corpo(req)).toString('utf8')).ligar);
    json(res, 200, { ok: true });
  },
  'POST /limpar': async (_r, res) => {
    apagarTudo();
    await fecharNavegador();
    emitir({ tipo: 'estado' });
    json(res, 200, { ok: true });
  },
  'GET /eventos': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(':ok\n\n');
    const enviar = (e: Evento) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    eventos.on('evento', enviar);
    const ping = setInterval(() => res.write(':ping\n\n'), 25000);
    req.on('close', () => {
      eventos.off('evento', enviar);
      clearInterval(ping);
    });
  },
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORTA}`);
  const origem = req.headers.origin ?? '';
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origem)) {
    res.setHeader('access-control-allow-origin', origem);
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
  }
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const rota = rotas[`${req.method} ${url.pathname}`];
  if (!rota) return json(res, 404, { erro: 'rota não encontrada' });
  try {
    await rota(req, res, url);
  } catch (e) {
    registrar('erro', `${req.method} ${url.pathname}: ${(e as Error).message}`);
    if (!res.headersSent) json(res, 500, { erro: (e as Error).message });
  }
}).listen(PORTA, '127.0.0.1', () => {
  console.log(`ACV núcleo em http://localhost:${PORTA} — dados em ${DIRS.curriculos.replace(/[\\/]curriculos$/, '')}`);
  migrarTenantsAntigos(registrar);
  migrarModelo(registrar);
  if (ler.conexoes().inhire) importarSeed(registrar);
  migrarCaminhosDaPastaAntiga();
  migrarIntervalo();
  // Perfil recalculado muda a compatibilidade de todas as vagas: repontua junto, sem esperar a próxima varredura
  const perfilMudou = migrarPerfilBusca();
  if (perfilMudou || kv.get<number>('scoreVersao', 0) < SCORE_VERSAO) {
    repontuar(); // vagas gravadas por versões anteriores do score ou de um perfil desatualizado
    kv.set('scoreVersao', SCORE_VERSAO);
  }
  // Higiene da fila na subida: publicação repetida da mesma vaga pode ter entrado antes desta regra existir,
  // e com o robô pausado o enfileiramento (que também limpa) nem roda.
  limparDuplicatasDaFila();
  const irmas = encerrarIrmasEnviadas(); // vagas repetidas de algo já enviado, de antes desta regra existir
  if (irmas) registrar('info', `${irmas} vaga(s) repetida(s) de candidaturas já enviadas saíram da lista.`);
  iniciarLaco();
});

/**
 * Queda do processo: o diário precisa dizer o que foi, senão o servidor morre em silêncio.
 *
 * Isto estava no histórico como feito e NÃO estava no código — um `unhandledRejection` derrubava o núcleo sem
 * deixar uma linha, e o sintoma que a pessoa vê é "o robô parou". Como são os erros mais difíceis de
 * reproduzir, eles vão para o diário de texto E para os eventos, com a pilha.
 *
 * Não encerra o processo: o Node já decide isso. Aqui é só não perder a causa.
 */
for (const sinal of ['unhandledRejection', 'uncaughtException'] as const) {
  process.on(sinal, (e: unknown) => {
    const erro = e instanceof Error ? e : new Error(String(e));
    const mensagem = erro.message.split('\n')[0].slice(0, 200);
    try {
      registrar('erro', `[${sinal}] ${mensagem}`);
      evento('erro.processo', { dados: { sinal, mensagem, pilha: (erro.stack ?? '').slice(0, 2000) } });
    } catch {
      console.error(`[ACV] ${sinal}:`, erro);
    }
  });
}

process.on('SIGINT', async () => {
  await fecharNavegador();
  process.exit(0);
});
