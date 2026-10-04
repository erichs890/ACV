// Verificação executável da EXTENSÃO (extensao/) e do que o núcleo faz com o que ela relata:
//   node core/extensao-check.ts   — ou `npm run check`, que roda este arquivo junto
//
// O content script é injetado em páginas falsas servidas aqui, como o navegador faria. Cobre as três decisões
// que a extensão toma sozinha e que, erradas, dariam diagnóstico mentiroso:
//   A) esta plataforma exige conta?  B) quais campos o formulário pede?  C) o que falta no perfil?
// Mais a fronteira de confiança do núcleo (token) e a promessa de não vazar dado pessoal para a extensão.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'acv-extensao-'));
process.env.ACV_DIR = DIR;
process.env.ACV_PERFIL = join(DIR, 'navegador');

const { autorizado, lerDeteccoes, perfilParaExtensao, registrarCamposFaltando, registrarPlataformaDetectada, tokenDaExtensao } = await import('./extensao.ts');
const { fecharNavegador, navegador } = await import('./browser.ts');
const { kv, vagas } = await import('./storage/db.ts');
await import('./platforms/vagaspj/index.ts'); // registra o adapter: a ponte por URL só oferece o que existe
const { plataformaDaUrl, plataformasConhecidas, vagaDaUrl } = await import('./importar.ts');

const CONTEUDO = readFileSync(new URL('../extensao/conteudo.js', import.meta.url), 'utf8');

const VAGA_PUBLICA = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Vaga</title><body>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Pessoa Desenvolvedora"}</script>
<input type="search" name="q" placeholder="Buscar vagas">
<form>
  <label for="nome">Nome completo *</label><input id="nome" name="nome" required>
  <label for="email">E-mail *</label><input id="email" name="email" type="email" required>
  <label for="tel">WhatsApp *</label><input id="tel" name="telefone" required>
  <label for="cv">Anexar currículo *</label><input id="cv" name="cv" type="file" required>
  <label for="port">Link do portfólio *</label><input id="port" name="portfolio" required>
  <label for="cnpj">Tipo de CNPJ</label><select id="cnpj" name="cnpj"><option>MEI</option></select>
  <fieldset><legend>Regime</legend>
    <label><input type="radio" name="regime" value="clt"> CLT</label>
    <label><input type="radio" name="regime" value="pj"> PJ</label>
  </fieldset>
  <!-- Como o InHire faz de verdade: grupo de rádios SEM fieldset, a pergunta é o texto acima -->
  <div><p>Você foi indicado por alguém da empresa?</p>
    <div><label><input type="radio" name="indicacao" value="sim"> Sim</label><label><input type="radio" name="indicacao" value="nao"> Não</label></div>
  </div>
  <button type="submit">Candidatar</button>
</form></body></html>`;

const VAGA_COM_CONTA = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Vaga</title><body>
<script type="application/ld+json">{"@type":"JobPosting","title":"Analista"}</script>
<h1>Analista Fiscal</h1><a href="/login?redirect=/vaga/1">Candidatar-se</a></body></html>`;

const TELA_LOGIN = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Entrar</title><body>
<form><label for="u">E-mail</label><input id="u" name="email"><label for="s">Senha</label><input id="s" type="password"><button>Entrar</button></form></body></html>`;

const VAGA_LOGADO = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Vaga</title><body>
<header><img alt="Avatar de Marina" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><button>Sair</button></header>
<h1>Vaga</h1><button type="button">Candidatar-se facilmente</button></body></html>`;

const CABECALHO_INDEED = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Vaga</title><body>
<header><a href="/x">Carregar o currículo</a><a href="/y">Acessar</a></header><button>Candidate-se facilmente</button></body></html>`;

const CANDIDATURA = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Vaga</title><body>
<script type="application/ld+json">{"@type":"JobPosting","title":"Pessoa Desenvolvedora Back-end","hiringOrganization":{"name":"Acme Tecnologia Ltda"},"description":"Java e Spring"}</script>
<h1>Pessoa Desenvolvedora Back-end</h1>
<button id="abrir">Candidatar-se</button>
<div id="dlg" role="dialog" hidden>
  <div class="etapa" id="e1">
    <label for="nome">Nome completo *</label><input id="nome" name="nome" required>
    <label for="email">E-mail *</label><input id="email" name="email" type="email" required>
    <label for="tel">Celular *</label><input id="tel" name="telefone" required>
    <button type="button" class="prox">Avançar</button>
  </div>
  <div class="etapa" id="e2" hidden>
    <label for="exp">Quantos anos de experiência com React? *</label>
    <select id="exp" name="exp" required><option value="">Selecione</option><option>Menos de 1 ano</option><option>1 a 3 anos</option><option>Mais de 3 anos</option></select>
    <button type="button" class="prox">Revisar</button>
  </div>
  <div class="etapa" id="e3" hidden>
    <p>Revise e envie.</p>
    <button type="button" id="enviar">Enviar candidatura</button>
  </div>
</div>
<p id="fim" hidden>Candidatura enviada com sucesso.</p>
<script>
  document.getElementById('abrir').onclick = () => { document.getElementById('dlg').hidden = false; };
  for (const b of document.querySelectorAll('.prox')) {
    b.onclick = () => {
      const etapa = b.closest('.etapa');
      if ([...etapa.querySelectorAll('[required]')].some(i => !i.value.trim())) return; // a plataforma barra etapa incompleta
      etapa.hidden = true;
      etapa.nextElementSibling.hidden = false;
    };
  }
  document.getElementById('enviar').onclick = async () => {
    document.getElementById('enviar').disabled = true;
    await fetch('/apply', { method: 'POST', body: '{}' });
    document.getElementById('dlg').hidden = true;
    document.getElementById('fim').hidden = false;
  };
</script></body></html>`;

const paginas: Record<string, string> = { '/candidatura': CANDIDATURA, '/vaga': VAGA_PUBLICA, '/conta': VAGA_COM_CONTA, '/login': TELA_LOGIN, '/logado': VAGA_LOGADO, '/indeed': CABECALHO_INDEED };
let envios = 0;
const servidor = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/apply') {
    envios++;
    res.writeHead(201, { 'content-type': 'application/json' });
    return res.end('{"id":"ok"}');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(paginas[(req.url ?? '').split('?')[0]] ?? '<p>nada</p>');
});
await new Promise<void>(r => servidor.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(servidor.address() as { port: number }).port}`;

type Campo = { pergunta: string; tipo: string; obrigatorio: boolean; incerto: boolean };
type Diagnostico = { dominio: string; handler: string; precisaLogin: boolean | null; logadoAtualmente: boolean; motivo: string; telaDeLogin: boolean; campos: Campo[] };

const ctx = await navegador(false); // headless: aqui nenhuma plataforma real é tocada
const page = await ctx.newPage();
const abrir = async (caminho: string): Promise<Diagnostico> => {
  await page.goto(base + caminho, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: CONTEUDO }); // fora da extensão, o script se expõe em globalThis.ACVExtensao
  return page.evaluate(() => (globalThis as unknown as { ACVExtensao: { diagnosticar: () => Diagnostico } }).ACVExtensao.diagnosticar());
};

try {
  // ─── A) Precisa de conta? ──────────────────────────────────────────────────────────────────────
  const publica = await abrir('/vaga');
  assert.equal(publica.precisaLogin, false, `formulário na própria página = sem conta; veio ${publica.precisaLogin} (${publica.motivo})`);
  assert.equal(publica.handler, 'generico', 'domínio desconhecido cai no motor genérico');

  const comConta = await abrir('/conta');
  assert.equal(comConta.precisaLogin, true, 'botão de candidatura apontando para /login = exige conta');
  assert.match(comConta.motivo, /login/i);

  const login = await abrir('/login');
  assert.equal(login.telaDeLogin, true, 'URL /login com campo de senha é tela de login');
  assert.equal(login.precisaLogin, true);

  const logado = await abrir('/logado');
  assert.equal(logado.precisaLogin, null, 'logado e sem pista do destino: não afirmar nada (regra conservadora)');
  assert.equal(logado.logadoAtualmente, true, 'avatar e "Sair" = sessão ativa');
  console.log('✓ Extensão: exige conta, não exige, tela de login e "não sei dizer" — cada um pelo sinal da própria página');

  // Handler dedicado do Indeed: o cabeçalho deslogado diz "Acessar" (não "Entrar")
  await page.goto(`${base}/indeed`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: CONTEUDO });
  const indeed = await page.evaluate(() =>
    (globalThis as unknown as { ACVExtensao: { INDEED: { precisaLogin: () => { precisa: boolean | null; logado: boolean } } } }).ACVExtensao.INDEED.precisaLogin(),
  );
  assert.deepEqual(indeed.precisa, true, 'Indeed sempre exige conta para candidatar');
  assert.equal(indeed.logado, false, '"Acessar" à vista = deslogado');
  const desafiado = await page.evaluate(() => {
    document.body.insertAdjacentHTML('afterbegin', '<p>Verificação adicional necessária</p>');
    return (globalThis as unknown as { ACVExtensao: { INDEED: { precisaLogin: () => { precisa: boolean | null } } } }).ACVExtensao.INDEED.precisaLogin().precisa;
  });
  assert.equal(desafiado, null, 'com a verificação anti-robô na tela, não dá para diagnosticar nada');
  console.log('✓ Extensão: handler dedicado do Indeed (registro por domínio) e recuo diante da verificação anti-robô');

  // Handler dedicado é COMPLEMENTO do genérico, não substituição.
  // O do Indeed define 4 dos 12 campos; antes `handlerDe` devolvia o dedicado puro e o motor ficava sem
  // `abrir`, `botaoProximo`, `botaoFinal` e `sucesso` naquele site — nunca achava o botão de enviar.
  const herdado = await page.evaluate(() => {
    const { handlerDe, GENERICO } = (globalThis as unknown as { ACVExtensao: Record<string, (h: string) => Record<string, unknown>> & { GENERICO: Record<string, unknown> } }).ACVExtensao;
    const h = handlerDe('br.indeed.com') as Record<string, unknown>;
    const g = GENERICO as Record<string, unknown>;
    return {
      dominio: (h.dominios as string[])[0],
      proprio: typeof h.precisaLogin === 'function' && h.precisaLogin !== g.precisaLogin,
      herdados: ['abrir', 'botaoProximo', 'botaoFinal', 'sucesso', 'dialogo', 'tituloDaVaga'].filter(k => h[k] !== undefined),
      generico: Object.keys(handlerDe('sitequalquer.com')).length,
    };
  });
  assert.equal(herdado.dominio, 'indeed.com', 'o domínio vem do handler dedicado');
  assert.ok(herdado.proprio, 'o que o dedicado define continua sendo dele');
  assert.deepEqual(herdado.herdados, ['abrir', 'botaoProximo', 'botaoFinal', 'sucesso', 'dialogo', 'tituloDaVaga'], 'e o que ele não define vem do genérico');
  assert.ok(herdado.generico > 0, 'domínio sem handler dedicado continua caindo no genérico');
  console.log('✓ Extensão: handler dedicado estende o genérico em vez de apagá-lo (o Indeed volta a ter botão de envio)');

  // ─── B) Campos do formulário (leitura, sem preencher) ─────────────────────────────────────────
  const perguntas = publica.campos.map(c => c.pergunta);
  assert.deepEqual(
    perguntas,
    ['Nome completo', 'E-mail', 'WhatsApp', 'Anexar currículo', 'Link do portfólio', 'Tipo de CNPJ', 'Regime', 'Você foi indicado por alguém da empresa?'],
    `campos lidos: ${perguntas.join(' | ')}`,
  );
  // Caso real do InHire: sem <fieldset>, a pergunta virava "Não" (o rótulo da primeira opção)
  assert.ok(!perguntas.includes('Não') && !perguntas.includes('Sim'), 'a pergunta de um grupo de rádios nunca é o texto de uma opção');
  assert.ok(!perguntas.some(p => /buscar vagas/i.test(p)), 'a caixa de busca do site não é campo de candidatura');
  assert.equal(publica.campos.filter(c => c.obrigatorio).length, 5, 'required e rótulo com * contam como obrigatório');
  assert.equal(publica.campos.find(c => c.pergunta === 'Anexar currículo')?.tipo, 'arquivo');
  assert.equal(publica.campos.filter(c => c.pergunta === 'Regime').length, 1, 'rádios do mesmo grupo são uma pergunta só');
  console.log('✓ Extensão: descoberta dos campos por rótulo, com tipo, obrigatoriedade e grupo de rádio');

  // ─── C) O que falta no meu perfil ──────────────────────────────────────────────────────────────
  const perfilFalso = {
    tem: { nome: true, email: true, celular: true, curriculo: true, regime: true, linkedin: false, cidade: false, cpf: false, pretensao: false },
    perguntas: [{ pergunta: 'Tipo de CNPJ', resposta: 'MEI' }],
  };
  const faltando = await page.evaluate(
    ([campos, perfil]) => {
      const api = (globalThis as unknown as { ACVExtensao: { temDado: (c: unknown, p: unknown) => boolean } }).ACVExtensao;
      return (campos as Campo[]).filter(c => (c.obrigatorio || c.incerto) && !api.temDado(c, perfil)).map(c => c.pergunta);
    },
    [publica.campos, perfilFalso] as const,
  );
  // Portfólio: obrigatório e sem lugar no perfil. Indicação: pergunta da empresa sem resposta salva (vai como
  // 'talvez opcional', porque o DOM não a marcou obrigatória). O resto o perfil ou uma resposta salva cobre.
  assert.deepEqual(faltando, ['Link do portfólio', 'Você foi indicado por alguém da empresa?'], `o que falta: ${faltando.join(' | ')}`);
  console.log('✓ Extensão: campo obrigatório sem dado é acusado; o que o perfil ou uma resposta salva cobre, não');

  // ─── Núcleo: fronteira de confiança e o que ele devolve ────────────────────────────────────────
  const token = tokenDaExtensao();
  assert.equal(token.length, 32, 'token de 16 bytes em hex');
  assert.equal(tokenDaExtensao(), token, 'o token não muda a cada leitura');
  assert.equal(autorizado(`Bearer ${token}`), true);
  assert.equal(autorizado(`Bearer ${'0'.repeat(32)}`), false, 'token errado não entra');
  assert.equal(autorizado(undefined), false, 'sem cabeçalho não entra');

  registrarPlataformaDetectada({ dominio: 'infojobs.com.br', precisaLogin: true, logadoAtualmente: false, motivo: 'o botão de candidatura leva para a tela de login', handler: 'generico' });
  registrarCamposFaltando({ dominio: 'infojobs.com.br', camposFaltando: [{ pergunta: 'Pretensão salarial', obrigatorio: true }] });
  const [detectada] = lerDeteccoes();
  assert.equal(detectada.dominio, 'infojobs.com.br');
  assert.equal(detectada.precisaLogin, true, 'a validação de campos não pode apagar o que já se sabia do login');
  assert.deepEqual(
    detectada.camposFaltando?.map(c => c.pergunta),
    ['Pretensão salarial'],
  );

  // Dado pessoal não sai do núcleo: a extensão recebe só "tenho isso?" e os enunciados das perguntas
  kv.set('perfil', { nome: 'Marina Pitanga', email: 'marina@exemplo.com', telefone: '11982324410', cpf: '52998224725', pretensao: 'R$ 4.500,00' });
  const paraExtensao = perfilParaExtensao();
  assert.deepEqual(paraExtensao.tem.nome, true);
  assert.deepEqual(paraExtensao.tem.linkedin, false, 'campo vazio do perfil conta como ausente');
  assert.deepEqual(paraExtensao.tem.regime, true, 'o regime preferido vem da Automação, não do perfil');
  const serializado = JSON.stringify(paraExtensao);
  for (const segredo of ['Marina', 'marina@exemplo.com', '11982324410', '52998224725', '4.500']) assert.ok(!serializado.includes(segredo), `valor de dado pessoal vazou para a extensão: ${segredo}`);
  console.log('✓ Núcleo: token protege as rotas da extensão, a detecção se acumula e nenhum dado pessoal vaza');

  // ─── C2) "Candidata nesta vaga daqui pelo ACV": a ponte por URL ─────────────────────────────
  // O caso real: a pessoa acha no LinkedIn uma vaga que leva para uma página do InHire. Lá o núcleo já tem
  // adapter testado, então a extensão manda a URL em vez de usar o motor dela.
  assert.equal(plataformaDaUrl('https://radix.inhire.app/vagas/1fe8ca9c/profissional-ai-specialist')?.id, 'inhire');
  assert.equal(plataformaDaUrl('https://www.vagaspj.com.br/vagas/empresa/123/')?.id, 'vagaspj');
  assert.equal(plataformaDaUrl('https://br.indeed.com/viewjob?jk=abc')?.id, 'indeed');
  // O LinkedIn passa a ser CONHECIDO (a extensão precisa saber que atende lá), mas com `motor: 'extensao'`:
  // conhecer não é saber candidatar. A ponte do núcleo recusa dizendo de quem é o trabalho.
  const li = plataformaDaUrl('https://www.linkedin.com/jobs/view/42');
  assert.equal(li?.id, 'linkedin', 'a lista única conhece o LinkedIn');
  assert.equal(li?.motor, 'extensao', 'mas quem candidata lá é o motor da extensão');
  await assert.rejects(() => vagaDaUrl('https://www.linkedin.com/jobs/view/42'), /motor da própria extensão/, 'a ponte recusa explicando de quem é o trabalho');
  assert.ok(
    plataformasConhecidas().some(p => p.id === 'linkedin' && p.motor === 'extensao'),
    'e a extensão recebe o LinkedIn na lista, mesmo sem adapter no núcleo — era essa a lista paralela que ela guardava sozinha',
  );
  assert.equal(plataformaDaUrl('não é url'), null);
  assert.ok(
    plataformasConhecidas().some(p => p.id === 'vagaspj' && p.dominios.includes('vagaspj.com.br')),
    'a extensão precisa receber os domínios de quem está carregado no núcleo',
  );

  vagas.salvar({
    id: 'vagaspj:123',
    plataforma: 'vagaspj',
    tenant: '',
    titulo: 'Pessoa Desenvolvedora',
    empresa: 'Acme',
    descricao: '',
    requisitos: '',
    regime: 'PJ',
    modelo: 'remoto',
    local: 'Remoto',
    url: 'https://www.vagaspj.com.br/vagas/acme/123/',
    skills: [],
    camposConhecidos: [],
    score: 70,
    status: 'encontrada',
    encontradaEm: new Date().toISOString(),
    atualizadaEm: new Date().toISOString(),
  });
  // A URL que você tem no navegador quase nunca é idêntica à que o robô gravou: www, barra no fim e rastreio
  const achada = await vagaDaUrl('https://vagaspj.com.br/vagas/acme/123?utm_source=linkedin#topo');
  assert.equal(achada.id, 'vagaspj:123', 'a vaga tem de ser reconhecida apesar de www, barra final e parâmetros');
  await assert.rejects(vagaDaUrl('https://www.vagaspj.com.br/vagas/acme/999/'), /ainda não está na lista/, 'vaga que o ACV não varreu dá instrução, não erro técnico');
  await assert.rejects(vagaDaUrl('https://exemplo.com/vaga/1'), /não tem adapter/, 'site sem adapter é caso do motor da própria extensão');
  console.log('✓ Ponte por URL: reconhece a plataforma do núcleo e acha a vaga mesmo com www, barra e rastreio na URL');

  // ─── D) Regras que a extensão aplica sozinha (sem navegador: é lógica pura) ────────────────────
  const comum = (() => {
    const caixa: Record<string, unknown> = { module: { exports: {} }, URLSearchParams, console };
    const ctx = createContext(caixa);
    caixa.globalThis = caixa;
    runInContext(readFileSync(new URL('../extensao/comum.js', import.meta.url), 'utf8'), ctx);
    return (caixa.module as { exports: unknown }).exports as {
      empresaBloqueada: (e: string, l: string[]) => string | null;
      normalizarEmpresa: (e: string) => string;
      montarUrlBuscaLinkedIn: (f: Record<string, unknown>) => string;
      quantasCabemHoje: (d: string, c: unknown, k: unknown) => { cabem: number; limite: number; aquecendo: boolean };
      proximaEspera: (c: unknown) => number;
      PADRAO: Record<string, unknown>;
    };
  })();

  // Empresa bloqueada: quem digita "Acme" quer barrar a Acme escrita de qualquer jeito
  for (const nome of ['Acme', 'ACME S.A.', 'Acme Ltda.', 'Acme Tecnologia', 'acme  tecnologia do brasil'])
    assert.ok(comum.empresaBloqueada(nome, ['Acme']), `"${nome}" devia bater com o bloqueio "Acme"`);
  assert.equal(comum.empresaBloqueada('Acmezinha Digital', ['Acme']), null, 'nome parecido não é a mesma empresa');
  assert.equal(comum.empresaBloqueada('Nubank', ['Acme', 'Itaú']), null);
  assert.equal(comum.empresaBloqueada('ITAU UNIBANCO', ['Itaú']), 'Itaú', 'acento não pode decidir bloqueio');
  assert.equal(comum.empresaBloqueada('', ['Acme']), null, 'vaga sem empresa não bloqueia por acidente');
  assert.equal(comum.empresaBloqueada('Acme', []), null);
  console.log('✓ Extensão: empresas bloqueadas batem com S.A., Ltda, acento e nome composto — e não com homônimo parecido');

  // URL de busca do LinkedIn: os parâmetros confirmados em uso real
  const url = new URL(comum.montarUrlBuscaLinkedIn({ palavraChave: 'desenvolvedor java', geoId: '106057199', distanciaKm: 25, janelaTempo: 'semana', apenasCandidaturaSimplificada: true }));
  assert.equal(url.origin + url.pathname, 'https://www.linkedin.com/jobs/search/');
  assert.equal(url.searchParams.get('keywords'), 'desenvolvedor java');
  assert.equal(url.searchParams.get('f_AL'), 'true', 'candidatura simplificada é sempre ligada neste projeto');
  assert.equal(url.searchParams.get('f_TPR'), 'r604800', 'última semana = 604800 s');
  assert.equal(url.searchParams.get('geoId'), '106057199');
  assert.equal(url.searchParams.get('distance'), '25');
  assert.equal(new URL(comum.montarUrlBuscaLinkedIn({ palavraChave: 'dev', janelaTempo: '24h' })).searchParams.get('f_TPR'), 'r86400');
  assert.equal(new URL(comum.montarUrlBuscaLinkedIn({ palavraChave: 'dev', modelo: 'remoto' })).searchParams.get('f_WT'), '2');
  console.log('✓ Extensão: URL de busca do LinkedIn com candidatura simplificada, janela de tempo e local');

  // Limite por dia e aquecimento de plataforma nova
  const cfg = { ...comum.PADRAO, limiteDiarioPorPlataforma: { 'linkedin.com': 20 } };
  const hojeIso = new Date().toISOString().slice(0, 10);
  const nova = comum.quantasCabemHoje('linkedin.com', cfg, { 'linkedin.com': { desde: new Date().toISOString(), dia: hojeIso, feitas: 2 } });
  assert.equal(nova.limite, 5, 'plataforma recém-usada fica no teto de aquecimento, não no limite cheio');
  assert.equal(nova.cabem, 3);
  assert.ok(nova.aquecendo);
  const velha = comum.quantasCabemHoje('linkedin.com', cfg, { 'linkedin.com': { desde: new Date(Date.now() - 10 * 86400000).toISOString(), dia: hojeIso, feitas: 20 } });
  assert.equal(velha.limite, 20, 'passado o aquecimento, vale o limite configurado');
  assert.equal(velha.cabem, 0, 'limite do dia alcançado não deixa passar mais nenhuma');
  assert.equal(comum.quantasCabemHoje('linkedin.com', cfg, { 'linkedin.com': { desde: '2020-01-01T00:00:00.000Z', dia: '2020-01-01', feitas: 99 } }).cabem, 20, 'contador de ontem não limita hoje');
  const esperas = Array.from({ length: 40 }, () => comum.proximaEspera({ intervaloMinSegundos: 30, intervaloMaxSegundos: 60 }));
  assert.ok(Math.min(...esperas) >= 30000 && Math.max(...esperas) <= 60000, 'a espera fica na faixa configurada');
  assert.ok(new Set(esperas).size > 20, 'a espera é sorteada, não um relógio certinho');
  console.log('✓ Extensão: limite por dia, aquecimento de plataforma nova e espera sorteada entre candidaturas');

  // ─── D2) Classificação dos sites e decisão do botão (lógica pura, mesmo sandbox) ───────────────
  const puro = <T>(arquivo: string): T => {
    const caixa: Record<string, unknown> = { module: { exports: {} }, console };
    const ctx = createContext(caixa);
    caixa.globalThis = caixa;
    runInContext(readFileSync(new URL(`../extensao/ui/${arquivo}`, import.meta.url), 'utf8'), ctx);
    return (caixa.module as { exports: unknown }).exports as T;
  };

  type Sitio = { nivel: string; nome: string; importa?: boolean; conectada?: boolean; dois?: boolean; nota: string } | null;
  const plat = puro<{
    classificar: (h: string, o: { plataformas?: unknown[]; pareceVaga?: boolean }) => Sitio;
    catalogo: (o: { plataformas?: unknown[] }) => { nome: string; nivel: string; avisos: { texto: string }[] }[];
  }>('plataformas.js');

  // A lista que o núcleo serve de verdade. Aqui só o adapter do Vagas PJ está carregado (linha 22), e é
  // isso mesmo que `plataformasConhecidas` reflete: adapter ausente não aparece como `nucleo`. O LinkedIn
  // aparece mesmo sem adapter — é o conserto de 03/10, a extensão precisa saber dos sites que ELA atende.
  const servidas = plataformasConhecidas();
  assert.ok(
    servidas.some(p => p.id === 'vagaspj' && p.motor === 'nucleo'),
    'o adapter carregado tem de ser servido como do núcleo',
  );
  assert.ok(
    servidas.some(p => p.id === 'linkedin' && p.motor === 'extensao'),
    'e o site sem adapter também, com o motor da extensão',
  );

  assert.equal(plat.classificar('www.vagaspj.com.br', { plataformas: servidas })?.nivel, 'nucleo', 'www. não atrapalha o reconhecimento');
  assert.equal(plat.classificar('www.linkedin.com', { plataformas: servidas })?.nivel, 'extensao', 'LinkedIn não tem adapter: é o motor da extensão');
  assert.equal(plat.classificar('exemplo.com', { plataformas: servidas }), null, 'site desconhecido que não é vaga: o painel não aparece');
  assert.equal(plat.classificar('exemplo.com', { plataformas: servidas, pareceVaga: true })?.nivel, 'generico', 'site desconhecido COM vaga: oferece o genérico');

  // Os ramos que dependem de campos que a lista carregada aqui não exercita (a função é pura, então a lista
  // sintética é legítima): subdomínio, "ambos" e o par importa/conectada.
  const inventadas = [
    { id: 'inhire', nome: 'InHire', dominios: ['inhire.app'], motor: 'nucleo', importa: true, conectada: true },
    { id: 'indeed', nome: 'Indeed', dominios: ['indeed.com'], motor: 'ambos', importa: false, conectada: false },
  ];
  assert.equal(plat.classificar('radix.inhire.app', { plataformas: inventadas })?.nivel, 'nucleo', 'subdomínio cai no adapter do domínio-pai');
  const ind = plat.classificar('br.indeed.com', { plataformas: inventadas });
  assert.equal(ind?.nivel, 'nucleo', 'servindo pelos dois, o núcleo é o caminho melhor');
  assert.ok(ind?.dois, 'mas a tela precisa contar que há dois caminhos');

  const cat = plat.catalogo({ plataformas: inventadas });
  assert.equal(cat[0].nivel, 'nucleo', 'o catálogo começa pelos adapters testados');
  assert.ok(
    cat.find(p => p.nome === 'InHire')?.avisos.some(a => a.texto === 'qualquer vaga'),
    'o InHire importa vaga avulsa, e a tela diz isso ANTES do clique',
  );
  assert.ok(
    cat.find(p => p.nome === 'Indeed')?.avisos.some(a => a.texto === 'vagas já varridas'),
    'quem não importa precisa avisar, senão a pessoa só descobre pelo erro',
  );
  assert.ok(
    cat.find(p => p.nome === 'Indeed')?.avisos.some(a => a.texto === 'conta não ligada'),
    'conta não ligada é a causa número um de "cliquei e não fez nada", e hoje é invisível',
  );
  console.log('✓ Extensão: classifica o site aberto em adapter do núcleo, motor próprio ou modo genérico');

  type Acao = { principal: { id: string; desabilitado: boolean; rotulo: string }; alternativa: { id: string } | null; motivo: string };
  const acao = puro<{ decidir: (s: Record<string, unknown>) => Acao }>('acao.js');
  const cabe = { cabem: 3, feitasHoje: 2, limite: 5, aquecendo: false };
  const nucleo: Sitio = { nivel: 'nucleo', nome: 'InHire', nota: '' };
  const situacaoBase = { temVaga: true, sincronizado: true, cota: cabe, sitio: nucleo };

  assert.equal(acao.decidir(situacaoBase).principal.id, 'nucleo');
  assert.equal(acao.decidir({ ...situacaoBase, sitio: { nivel: 'extensao', nome: 'LinkedIn', nota: '' } }).principal.id, 'extensao');
  assert.equal(acao.decidir({ ...situacaoBase, sitio: { nivel: 'generico', nome: 'exemplo.com', nota: 'posso tentar' } }).principal.id, 'generico');
  assert.equal(acao.decidir({ ...situacaoBase, temVaga: false }).principal.id, 'sem_vaga');
  assert.equal(acao.decidir({ ...situacaoBase, sincronizado: false }).principal.id, 'nucleo_fechado', 'adapter do núcleo com o ACV fechado: oferece a extensão como saída');
  assert.equal(acao.decidir({ ...situacaoBase, sincronizado: false }).alternativa?.id, 'extensao');

  // A regressão que o ternário de cinco ramos podia introduzir em silêncio: um botão ATIVO num estado que
  // impede candidatar. Qualquer um destes quatro tem de desabilitar, e a ordem entre eles não pode importar.
  for (const [nome, impeditivo] of [
    ['restrição anti-robô', { restrita: true }],
    ['ocupado', { ocupado: true }],
    ['empresa bloqueada', { bloqueada: 'Acme' }],
    ['limite do dia', { cota: { cabem: 0, feitasHoje: 5, limite: 5, aquecendo: false } }],
  ] as const) {
    const r = acao.decidir({ ...situacaoBase, ...impeditivo });
    assert.equal(r.principal.desabilitado, true, `${nome} tem de desabilitar o botão`);
    assert.ok(r.principal.rotulo.length > 0, `${nome} precisa dizer por quê no próprio botão`);
  }
  // E impedimento ganha de oferta, mesmo com tudo pronto para candidatar
  assert.equal(acao.decidir({ ...situacaoBase, restrita: true, bloqueada: 'Acme', ocupado: true }).principal.id, 'restrita', 'restrição é o primeiro de todos: o robô para antes de qualquer coisa');
  console.log('✓ Extensão: o botão do painel tem um caso nomeado por estado, e nenhum impedimento deixa botão ativo');

  // ─── E) Candidatura ponta a ponta numa página de várias etapas ─────────────────────────────────
  const MOTOR = readFileSync(new URL('../extensao/motor.js', import.meta.url), 'utf8');
  const COMUM = readFileSync(new URL('../extensao/comum.js', import.meta.url), 'utf8');
  const REDE = readFileSync(new URL('../extensao/rede.js', import.meta.url), 'utf8');

  /** Monta a página com a extensão carregada e o service worker trocado por um dublê controlado pelo teste. */
  const prepararCandidatura = async (stub: Record<string, unknown>) => {
    await page.goto(`${base}/candidatura`, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: REDE });
    await page.evaluate(s => {
      (globalThis as Record<string, unknown>).__stub = s;
      (globalThis as Record<string, unknown>).chrome = {
        runtime: {
          // sem `id`: conteudo.js expõe a api e não tenta falar com o navegador
          sendMessage: (msg: { tipo: string; candidatura?: unknown }, cb: (r: unknown) => void) => {
            const st = (globalThis as unknown as { __stub: Record<string, unknown> }).__stub;
            const resposta =
              (
                {
                  CONFIG: { cfg: st.cfg },
                  DADOS: { dados: st.dados },
                  CABEM: st.cabem,
                  PERGUNTA: st.pergunta ?? { resposta: null, motivo: 'a IA está desligada nas configurações da extensão' },
                  CANDIDATURA: { sincronizado: true },
                } as Record<string, Record<string, unknown>>
              )[msg.tipo] ?? {};
            if (msg.tipo === 'CANDIDATURA') (st.enviadas as unknown[]).push(msg.candidatura);
            cb({ ok: true, ...resposta });
          },
        },
      };
    }, stub);
    await page.addScriptTag({ content: COMUM });
    await page.addScriptTag({ content: CONTEUDO });
    await page.addScriptTag({ content: MOTOR });
  };

  const DADOS_FALSOS = {
    perfil: { nome: 'Marina Pitanga', email: 'marina@exemplo.com', telefone: '(11) 98232-4410', cidade: 'Fortaleza - CE', linkedin: '', cpf: '', pretensao: '' },
    perguntas: [] as { pergunta: string; resposta: string }[],
  };
  const CFG_FALSA = { ...comum.PADRAO, empresasBloqueadas: [] as string[] };
  const CABEM_LIVRE = { cabem: 5, limite: 5, feitasHoje: 0, aquecendo: false };
  const candidatar = () => page.evaluate(() => (globalThis as unknown as { ACVMotor: { candidatar: () => Promise<Record<string, unknown>> } }).ACVMotor.candidatar());

  // Empresa bloqueada: nem abre o formulário
  await prepararCandidatura({ cfg: { ...CFG_FALSA, empresasBloqueadas: ['Acme'] }, dados: DADOS_FALSOS, cabem: CABEM_LIVRE, enviadas: [] });
  let r = await candidatar();
  assert.equal(r.status, 'bloqueada', `empresa bloqueada não pode ser candidatada (veio ${r.status}: ${r.motivo})`);
  assert.equal(envios, 0);

  // Limite do dia alcançado
  await prepararCandidatura({ cfg: CFG_FALSA, dados: DADOS_FALSOS, cabem: { cabem: 0, limite: 5, feitasHoje: 5, aquecendo: false }, enviadas: [] });
  r = await candidatar();
  assert.equal(r.status, 'limite');
  assert.equal(envios, 0, 'nada pode sair com o limite do dia alcançado');

  // Pergunta da empresa sem resposta salva: para e devolve a pergunta, NUNCA chuta
  await prepararCandidatura({ cfg: CFG_FALSA, dados: DADOS_FALSOS, cabem: CABEM_LIVRE, enviadas: [] });
  r = await candidatar();
  assert.equal(r.status, 'pergunta', `esperava parar na pergunta, veio ${r.status}: ${r.motivo}`);
  assert.match(String(r.pergunta), /anos de experi[êe]ncia com React/i);
  assert.equal(envios, 0, 'parar na pergunta não pode ter enviado nada');
  assert.equal(await page.inputValue('#nome'), 'Marina Pitanga', 'o que era conhecido foi preenchido antes de parar');
  assert.equal(await page.inputValue('#email'), 'marina@exemplo.com');
  console.log('✓ Motor: empresa bloqueada e limite do dia barram antes de abrir; pergunta nova para a candidatura em vez de chutar');

  // Com a resposta salva, vai até o fim — e o desfecho sai da resposta HTTP, não do texto da tela
  await prepararCandidatura({
    cfg: CFG_FALSA,
    dados: { ...DADOS_FALSOS, perguntas: [{ pergunta: 'Quantos anos de experiência com React?', resposta: 'Mais de 3 anos' }] },
    cabem: CABEM_LIVRE,
    enviadas: [],
  });
  r = await candidatar();
  assert.equal(r.status, 'enviada', `esperava enviada, veio ${r.status}: ${r.motivo}`);
  assert.equal(envios, 1, 'exatamente um envio');
  assert.equal(await page.inputValue('#exp'), 'Mais de 3 anos', 'a resposta salva escolheu a opção certa da lista');
  const registradas = (await page.evaluate(() => (globalThis as unknown as { __stub: { enviadas: unknown[] } }).__stub.enviadas)) as { titulo: string; empresa: string }[];
  assert.equal(registradas.length, 1, 'a candidatura tem de ser registrada para contar no limite e subir ao ACV');
  assert.match(registradas[0].empresa, /Acme/);
  assert.ok((r.espera as number) >= 5000, 'o motor devolve quanto esperar antes da próxima');

  // Clicar de novo não manda outra: a trava é a mesma do núcleo (uma vaga, uma candidatura)
  const antes = envios;
  r = await candidatar();
  assert.equal(envios, antes, `não pode sair um segundo envio (veio ${r.status}: ${r.motivo})`);
  console.log('✓ Motor: preenche as etapas, envia uma vez só e confirma pela resposta HTTP (prova de rede)');
} finally {
  await page.close().catch(() => {});
  servidor.close();
  await fecharNavegador();
}

console.log('\nExtensão: tudo certo.');
