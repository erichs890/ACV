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

const { autorizado, jaCandidatou, lerDeteccoes, perfilParaExtensao, receberCandidaturas, registrarCamposFaltando, registrarPlataformaDetectada, tokenDaExtensao } = await import('./extensao.ts');
const { fecharNavegador, navegador } = await import('./browser.ts');
const { candidaturas, kv, log, vagas } = await import('./storage/db.ts');
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

/**
 * ProgramaThor, as duas caras da mesma página — copiadas do site real em 04/10/2026.
 *
 * Deslogado, TODO caminho de candidatura leva ao cadastro, inclusive o CTA grande. Logado eu não vi (não tenho
 * a conta), então a página "dentro" tem só o que é dedutível: o CTA deixou de apontar para o cadastro.
 */
const PT_FORA = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Vaga</title><body>
<header><a href="/users/sign_in">ENTRAR</a><a href="/users/sign_up">CADASTRAR-SE</a></header>
<h1>Desenvolvedor(a) Full Stack Sênior</h1>
<a href="/users/sign_in">ENTRAR COMO CANDIDATO</a>
<a class="btn btn-success btn-lg" href="/users/sign_up">Quero me candidatar</a></body></html>`;

const PT_DENTRO = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Vaga</title><body>
<header><a href="/users/edit">Meu perfil</a><a href="/users/sign_out">Sair</a></header>
<h1>Desenvolvedor(a) Full Stack Sênior</h1>
<a class="btn btn-success btn-lg" href="/jobs/33824/apply">Quero me candidatar</a></body></html>`;

/** Candidatura de um clique por `<form method="post">`: clicar no botão É o envio, não a abertura de nada. */
const UM_CLIQUE_FORM = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Vaga</title><body>
<h1>Vaga</h1><form action="/apply" method="post"><button type="submit">Quero me candidatar</button></form></body></html>`;

/**
 * Candidatura de um clique cujo handler chama `form.submit()` por JavaScript.
 *
 * `HTMLFormElement.prototype.submit()` NÃO dispara o evento `submit` — então o listener de `submit` do
 * `rede.js` não vê nada e o `preventDefault` nunca acontece. Sem o patch no protótipo, a candidatura sairia
 * de verdade no meio de um ensaio, com o painel dizendo que nada foi enviado.
 */
const UM_CLIQUE_SUBMIT_JS = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Vaga</title><body>
<h1>Vaga</h1><form id="f" action="/apply" method="post"></form>
<button type="button" id="ir">Quero me candidatar</button>
<script>document.getElementById('ir').onclick = () => document.getElementById('f').submit();</script></body></html>`;

/** O mesmo de um clique, mas por JavaScript: daqui não há como saber o que o clique faz antes de clicar. */
const UM_CLIQUE_JS = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Vaga</title><body>
<script type="application/ld+json">{"@type":"JobPosting","title":"Pessoa Desenvolvedora Back-end","hiringOrganization":{"name":"Acme Tecnologia Ltda"},"description":"Java"}</script>
<h1>Pessoa Desenvolvedora Back-end</h1><button type="button" id="ir">Quero me candidatar</button>
<script>document.getElementById('ir').onclick = () => fetch('/apply', { method: 'POST', body: '{}' });</script></body></html>`;

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

/**
 * Lever: a tela do `/apply`, recortada do HTML real de 06/10/2026 (jobs.lever.co/neon/.../apply).
 *
 * O que ela reproduz, e é tudo o que importa aqui: **não há `h1`** (o título mora num `h2` dentro de
 * `.posting-headline`), **não há JSON-LD** nesta página (só na da vaga), o `<title>` é
 * `"<Empresa> - <Título>"`, e existe um rótulo "Current company" que é PERGUNTA e não o nome da empresa —
 * exatamente a armadilha em que o seletor genérico `[class*="company"]` cai.
 */
const LEVER_APPLY = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Neon Pagamentos - Analista de Growth (Business Analytics) - Pleno</title><body>
<div class="posting-headline"><h2>Analista de Growth (Business Analytics) - Pleno</h2></div>
<form id="application-form" enctype="multipart/form-data" method="POST">
<div class="application-label">ATTACH RESUME/CV</div><input type="file" name="resume">
<div class="application-label">Full name ✱</div><input type="text" name="name" required>
<div class="application-label">Email ✱</div><input type="email" name="email" required>
<div class="application-label">Phone ✱</div><input type="text" name="phone" required>
<div class="application-label">Current location</div><input type="text" name="location">
<div class="application-question">Current company</div><input type="text" name="org">
<div class="application-label">LinkedIn URL ✱</div><input type="text" name="urls[LinkedIn]" required>
<div class="application-label">GitHub URL</div><input type="text" name="urls[GitHub]">
<input id="hcaptchaResponseInput" type="hidden" name="h-captcha-response" value="">
<button id="hcaptchaSubmitBtn" type="submit" class="hidden"></button>
</form>
<button id="btn-submit" type="button" data-qa="btn-submit">Submit application</button>
</body></html>`;

/**
 * Greenhouse: a pagina da vaga, recortada do HTML real de 06/10/2026.
 *
 * Reproduz o que importa: HA `<h1>` com o titulo (ao contrario do Lever), NAO ha JSON-LD nem classe com
 * "company", e o `<title>` e `"Job Application for <vaga> at <Empresa>"` -- com um " at " DENTRO do
 * titulo da vaga, que e o caso que obriga a cortar no ultimo e nao no primeiro.
 */
const GREENHOUSE_VAGA = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Job Application for Engineer at Scale | Security Engineer at Grupo QuintoAndar</title><body>
<div class="job__title"><h1>Engineer at Scale | Security Engineer</h1><div class="job__location">Brasil</div></div>
<div class="job__description">Requisitos: Java, Spring Boot e SQL.</div>
<h2>Apply for this job</h2>
<form id="application-form"><input type="text" name="first_name"><input type="file" name="resume"></form>
<button type="submit">Enviar inscricao</button>
</body></html>`;
const paginas: Record<string, string> = {
  '/candidatura': CANDIDATURA,
  '/vaga': VAGA_PUBLICA,
  '/conta': VAGA_COM_CONTA,
  '/login': TELA_LOGIN,
  '/logado': VAGA_LOGADO,
  '/indeed': CABECALHO_INDEED,
  '/pt-fora': PT_FORA,
  '/pt-dentro': PT_DENTRO,
  '/um-clique-form': UM_CLIQUE_FORM,
  '/um-clique-js': UM_CLIQUE_JS,
  '/um-clique-submit-js': UM_CLIQUE_SUBMIT_JS,
  '/lever-apply': LEVER_APPLY,
  '/greenhouse-vaga': GREENHOUSE_VAGA,
};
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

  /**
   * ProgramaThor: o handler dedicado e, junto, o reconhecimento do botão de candidatura.
   *
   * O genérico "funcionava" aqui e dizia a coisa mais inútil possível — "você já está logado, então não dá
   * para saber se a candidatura exige conta". Dá para saber: é o destino do CTA que responde.
   */
  const ptHandler = async (caminho: string) => {
    await page.goto(`${base}${caminho}`, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: CONTEUDO });
    return page.evaluate(() => {
      const api = (globalThis as unknown as { ACVExtensao: Record<string, (h?: unknown) => Record<string, unknown>> }).ACVExtensao;
      const h = api.handlerDe('programathor.com.br') as unknown as { precisaLogin: () => Record<string, unknown>; reconhecerEnvio: () => Record<string, unknown> | null; abrir: () => unknown };
      const login = h.precisaLogin();
      const envio = h.reconhecerEnvio();
      // `el` é um nó do DOM e não atravessa a ponte do Playwright: sai daqui
      const limpo = envio ? (Object.fromEntries(Object.entries(envio).filter(([k]) => k !== 'el')) as Record<string, unknown>) : null;
      return { login, envio: limpo, dedicado: (api.PROGRAMATHOR as unknown as { dominios: string[] }).dominios[0] };
    });
  };

  const fora = await ptHandler('/pt-fora');
  assert.equal(fora.dedicado, 'programathor.com.br', 'o ProgramaThor tem handler dedicado no registro');
  assert.equal(fora.login.precisa, true, 'o ProgramaThor sempre exige conta para candidatar');
  assert.equal(fora.login.logado, false, 'o CTA apontando para /users/sign_up é prova de sessão ausente');
  assert.equal(fora.envio?.clicarEnvia, 'nao', 'deslogado o CTA é link: clicar navega para o cadastro, não envia nada');
  // O CTA tem de ser o botão grande, não o "ENTRAR COMO CANDIDATO" que vem antes dele na página real
  assert.equal(fora.envio?.rotulo, 'Quero me candidatar', 'o handler acha o CTA certo, não o primeiro texto com "candidat"');
  assert.match(String(fora.envio?.href), /sign_up/);

  const dentro = await ptHandler('/pt-dentro');
  assert.equal(dentro.login.logado, true, 'CTA que não leva mais ao cadastro e sem ENTRAR no topo = sessão valendo');
  assert.equal(dentro.envio?.clicarEnvia, 'nao', 'logado, o CTA leva à página de candidatura: clicar navega');
  assert.equal(dentro.envio?.rotulo, 'Quero me candidatar');
  console.log('✓ Extensão: handler do ProgramaThor diz se a SUA sessão está valendo pelo destino do botão de candidatura');

  /**
   * Lever: o handler dedicado existe por causa da trava de duplicidade.
   *
   * Título e empresa não são enfeite de painel: são a chave de `jaEnviei({url, titulo, empresa})`, que é o que
   * impede um segundo currículo na mesma vaga (invariante 4). Na tela do `/apply` do Lever o genérico devolvia
   * os dois errados — título vazio (não há `h1` e não há JSON-LD aqui) e empresa igual a "Current company",
   * que é o RÓTULO de uma pergunta do formulário.
   */
  await page.goto(`${base}/lever-apply`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: CONTEUDO });
  const lever = await page.evaluate(() => {
    const api = (globalThis as unknown as { ACVExtensao: Record<string, (h?: unknown) => Record<string, unknown>> & { GENERICO: Record<string, unknown> } }).ACVExtensao;
    const h = api.handlerDe('jobs.lever.co') as unknown as {
      tituloDaVaga: () => string;
      empresaDaVaga: () => string;
      precisaLogin: () => { precisa: boolean | null; logado: boolean };
      descobrirCamposFormulario: () => { pergunta: string }[];
      botaoFinal: RegExp;
    };
    const g = api.GENERICO as unknown as { tituloDaVaga: () => string; empresaDaVaga: () => string };
    return {
      titulo: h.tituloDaVaga(),
      empresa: h.empresaDaVaga(),
      login: h.precisaLogin(),
      campos: h.descobrirCamposFormulario().map(c => c.pergunta),
      finalCasa: h.botaoFinal.test('Submit application'),
      // o que o genérico faria nesta mesma página, para o teste provar que o dedicado é necessário
      tituloGenerico: g.tituloDaVaga.call(g),
      empresaGenerica: g.empresaDaVaga.call(g),
    };
  });
  assert.equal(lever.titulo, 'Analista de Growth (Business Analytics) - Pleno', 'o título sai do h2 da posting-headline');
  assert.equal(lever.empresa, 'Neon Pagamentos', 'a empresa sai do primeiro pedaço do <title>, antes do primeiro " - "');
  // Os DOIS vêm vazios no genérico: não há `h1` nesta página, não há JSON-LD (só na página da vaga) e nenhuma
  // classe com "company". Vazio é o pior caso silencioso: a trava de duplicidade cai para "mesma URL" sem
  // reclamar de nada, e a mesma vaga republicada com outro id passaria.
  assert.equal(lever.tituloGenerico, '', 'sem o dedicado o título vem vazio');
  assert.equal(lever.empresaGenerica, '', 'e a empresa também — é por isto que o dedicado existe');
  assert.equal(lever.login.precisa, false, 'o Lever não pede conta: o painel aparece ali por causa do captcha, não de login');
  assert.ok(lever.finalCasa, '"Submit application" é o botão de envio e o genérico já o reconhece');
  // Os cinco obrigatórios do Lever têm de ser reconhecidos como campo do perfil, não como pergunta da empresa
  for (const rotulo of ['Full name', 'Email', 'Phone', 'LinkedIn URL', 'RESUME/CV']) {
    assert.ok(
      lever.campos.some(c => c.toUpperCase().includes(rotulo.toUpperCase())),
      `"${rotulo}" tem de ser achado no formulário do Lever; vieram: ${lever.campos.join(' | ')}`,
    );
  }
  console.log('✓ Extensão: no Lever o título e a empresa saem certos — é deles que depende a trava de currículo repetido');

  /**
   * Greenhouse: o título o genérico já acerta (há `h1`, ao contrário do Lever) — a empresa, não.
   *
   * Não há JSON-LD nesta página nem classe com "company", então a empresa sairia vazia e a trava de currículo
   * repetido ficaria só com a URL. O `<title>` é `"Job Application for <vaga> at <Empresa>"`, e o nome está
   * depois do ÚLTIMO " at ": o título da vaga pode ter " at " dentro, e é o caso do fixture.
   */
  await page.goto(`${base}/greenhouse-vaga`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: CONTEUDO });
  const gh = await page.evaluate(() => {
    const api = (globalThis as unknown as { ACVExtensao: Record<string, (h?: unknown) => Record<string, unknown>> & { GENERICO: Record<string, unknown> } }).ACVExtensao;
    const h = api.handlerDe('job-boards.greenhouse.io') as unknown as { tituloDaVaga: () => string; empresaDaVaga: () => string; precisaLogin: () => { precisa: boolean | null }; botaoFinal: RegExp };
    const g = api.GENERICO as unknown as { empresaDaVaga: () => string };
    return { titulo: h.tituloDaVaga(), empresa: h.empresaDaVaga(), login: h.precisaLogin(), final: h.botaoFinal.test('Enviar inscrição'), empresaGenerica: g.empresaDaVaga.call(g) };
  });
  assert.equal(gh.titulo, 'Engineer at Scale | Security Engineer', 'o título vem do h1');
  assert.equal(gh.empresa, 'Grupo QuintoAndar', 'a empresa vem depois do ÚLTIMO " at " — o título da vaga tem um " at " dentro');
  assert.equal(gh.empresaGenerica, '', 'sem o dedicado a empresa viria vazia, e a trava de duplicidade ficaria só com a URL');
  assert.equal(gh.login.precisa, false, 'o Greenhouse não pede conta: o painel aparece ali por causa do captcha');
  assert.ok(gh.final, '"Enviar inscrição" é o texto real do botão de envio em pt-BR');
  console.log('✓ Extensão: no Greenhouse a empresa sai do <title>, depois do último " at " (o título da vaga pode ter um)');

  /**
   * O conserto que vale para qualquer site, achado no ProgramaThor: em quadro de vagas com candidatura de um
   * clique, o botão "Quero me candidatar" É o envio. `abrir()` clicava nele achando que abria formulário — a
   * candidatura saía ali, o motor não achava formulário depois e devolvia `erro`. Reportar falha de um envio
   * consumado é a invariante 1 quebrada, e convidava a pessoa a clicar de novo.
   */
  await page.goto(`${base}/um-clique-form`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: CONTEUDO });
  const enviosAntesDoRecon = envios;
  const umClique = await page.evaluate(() => {
    const { GENERICO, reconhecerEnvio } = (globalThis as unknown as { ACVExtensao: { GENERICO: { abrir: () => unknown }; reconhecerEnvio: () => Record<string, unknown> | null } }).ACVExtensao;
    const r = reconhecerEnvio();
    return { clicarEnvia: r?.clicarEnvia, form: r?.form, abrir: GENERICO.abrir() };
  });
  assert.equal(umClique.clicarEnvia, 'sim', 'botão de submit de um <form method="post"> envia ao ser clicado');
  assert.deepEqual((umClique.form as { action: string }).action, '/apply', 'e o reconhecimento conta para onde vai, sem clicar');
  assert.equal(umClique.abrir, 'envia_direto', 'então `abrir` avisa o motor em vez de clicar');
  assert.equal(envios, enviosAntesDoRecon, 'e NADA foi enviado só por reconhecer a página');
  console.log('✓ Extensão: botão que já envia não é clicado como se fosse abrir formulário (nenhuma candidatura às cegas)');

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

  /**
   * `jaCandidatou`: a prevenção da invariante 4 no caminho da extensão, do lado do núcleo.
   *
   * Pega três casos que o cadeado local da extensão (por URL, em `chrome.storage.local`) não pega: a
   * candidatura feita pelo ROBÔ, a mesma vaga republicada em outra URL ou plataforma, e a extensão
   * reinstalada (cadeado vazio, histórico cheio). A chave é a mesma de `jaCandidatado`: empresa + título.
   */
  candidaturas.inserir({
    vagaId: 'inhire:acme:1',
    titulo: 'Pessoa Desenvolvedora Back-end',
    empresa: 'Acme Tecnologia Ltda',
    plataforma: 'inhire',
    url: 'https://acme.inhire.app/vagas/1',
    enviadaEm: new Date().toISOString(),
    nome: '',
    email: '',
    celular: '',
    curriculo: '',
    versao: 'original',
    regime: '',
    resultado: 'enviada',
  });
  assert.equal(jaCandidatou({ url: 'https://acme.inhire.app/vagas/1' }).ja, true, 'a mesma URL é pega');
  assert.equal(jaCandidatou({ url: 'https://www.acme.inhire.app/vagas/1/?utm_source=x' }).ja, true, 'www, barra final e rastreio não mudam a vaga');
  const irma = jaCandidatou({ url: 'https://acme.gupy.io/job/999', titulo: 'Pessoa Desenvolvedora Back-end', empresa: 'Acme Tecnologia S.A.' });
  assert.equal(irma.ja, true, 'outra URL, outra plataforma, mesma empresa e cargo: é a mesma vaga republicada');
  assert.match(irma.motivo, /outra publica[çc][ãa]o/, 'e o motivo diz isso, para a pessoa entender por que não foi');
  assert.equal(jaCandidatou({ url: 'https://outra.inhire.app/vagas/7', titulo: 'Pessoa de Produto', empresa: 'Outra' }).ja, false, 'vaga de verdade diferente passa');
  assert.equal(jaCandidatou({}).ja, false, 'sem url nem par empresa+título não há como afirmar nada');

  // Duplicata que JÁ aconteceu: o núcleo REGISTRA e avisa, nunca descarta — descartar cegaria `jaCandidatado`
  // e o robô poderia mandar um terceiro currículo para a mesma empresa.
  log.listar(0);
  const antesDoRelato = candidaturas.listar().length;
  receberCandidaturas([{ dominio: 'gupy.io', url: 'https://acme.gupy.io/job/999', titulo: 'Pessoa Desenvolvedora Back-end', empresa: 'Acme Tecnologia Ltda', enviadaEm: new Date().toISOString() }]);
  assert.equal(candidaturas.listar().length, antesDoRelato + 1, 'o fato entra no histórico: o envio já aconteceu, e esconder isso cegaria o núcleo');
  assert.ok(
    log.listar(20).some(l => /j[áa] havia uma enviada para a mesma empresa e cargo/.test(l.msg)),
    'e o alerta avisa que o currículo foi duas vezes',
  );
  console.log('✓ Núcleo: ja-candidatou pega a vaga republicada em outra URL, e duplicata recebida é registrada com alerta');

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
  /**
   * O Vagas PJ é CONHECIDO pela ponte (`plataformaDaUrl` o acha) e NÃO é servido à extensão.
   *
   * São perguntas diferentes, e a mudança de 05/10/2026 as separou: `DOMINIOS` continua sendo a lista única
   * de "que plataforma atende esta URL" (o núcleo precisa disso para importar e para recusar com motivo), mas
   * `plataformasConhecidas` — a lista que vira painel no navegador — passou a servir só quem exige conta. Num
   * site sem login o robô já faz tudo e melhor (adapta currículo, respeita o ensaio, prova o envio), então
   * painel ali é ruído sobre uma página onde não há nada a decidir.
   */
  assert.equal(plataformaDaUrl('https://www.vagaspj.com.br/vaga/1')?.id, 'vagaspj', 'a ponte continua conhecendo quem não exige login');
  assert.ok(!plataformasConhecidas().some(p => p.id === 'vagaspj'), 'mas a extensão não recebe plataforma sem login: lá o robô dá conta sozinho');
  assert.ok(
    plataformasConhecidas().every(p => p.exigeLogin || p.motor === 'extensao'),
    'à extensão só chega plataforma com conta para entrar ou cujo envio é dela (Lever: captcha no formulário)',
  );

  /**
   * As três listas da extensão têm de concordar com a servida pelo núcleo.
   *
   * Eram cinco listas paralelas em 03/10, e `DOMINIOS` virou a fonte única — mas duas delas continuam
   * estáticas por natureza (o manifesto não lê HTTP) e por isso precisam de teste, não de confiança. O
   * ProgramaThor entrou em 04/10 e ficou fora dos limites diários: o limite dele não aparecia na página de
   * opções para ser ajustado, caía no padrão e ninguém veria.
   */
  const dominiosServidos = plataformasConhecidas().flatMap(p => p.dominios);
  const manifesto = JSON.parse(readFileSync(new URL('../extensao/manifest.json', import.meta.url), 'utf8')) as {
    content_scripts: { js: string[]; matches: string[] }[];
  };
  const matchesDaRede = manifesto.content_scripts.find(c => c.js.includes('rede.js'))!.matches.join(' ');
  for (const d of dominiosServidos) assert.ok(matchesDaRede.includes(d), `${d} é servida à extensão e precisa estar nos matches do rede.js: sem o monitor não há prova de envio nem corte do ensaio`);

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
      proibeAutomacao: (h: string) => { dominio: string; motivo: string } | null;
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
  /**
   * A cópia de `normalizarEmpresa` em `comum.js` tem de concordar com a de `src/dados.ts`.
   *
   * São duas de propósito: `comum.js` é um IIFE autossuficiente que roda com o ACV fechado e não importa
   * módulo nenhum. Mas as duas decidem a mesma coisa em lugares diferentes — a de lá bloqueia empresa, a de
   * cá pega a mesma vaga republicada com o nome escrito de outro jeito. Divergir significaria a extensão
   * achando que não é duplicata e o núcleo achando que é, ou o contrário. Duplicação travada por teste.
   */
  const { normalizarEmpresa: canonica } = await import('../src/dados.ts');
  const normalizarLa = (comum as { normalizarEmpresa?: (n: string) => string }).normalizarEmpresa;
  for (const nome of ['Acme Tecnologia Ltda', 'ACME TECNOLOGIA S.A.', 'acme', 'Grupo Boticário', 'Soñar Assessoria Empresarial', 'Nubank', 'Radix Engenharia', 'XP Inc.', '']) {
    if (normalizarLa) assert.equal(normalizarLa(nome), canonica(nome), `as duas normalizações de empresa divergem em "${nome}"`);
  }
  // E o que importa na prática: as três grafias da mesma empresa colapsam numa chave só
  assert.equal(canonica('Acme Tecnologia Ltda'), canonica('ACME TECNOLOGIA S.A.'), 'sufixo jurídico não pode separar a mesma empresa');
  assert.equal(canonica('Acme'), canonica('Acme Tecnologia'), 'nem a palavra genérica');
  assert.notEqual(canonica('Radix'), canonica('Nubank'), 'mas empresas diferentes continuam diferentes');
  console.log('✓ Extensão: empresas bloqueadas batem com S.A., Ltda, acento e nome composto — e a normalização é a mesma do núcleo');

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
  // A terceira lista: um limite diário por plataforma servida. Chave ausente cai em LIMITE_PADRAO e o limite
  // fica invisível na página de opções — foi o que aconteceu com o ProgramaThor entre 04 e 05/10.
  const servidosAgora = plataformasConhecidas().flatMap(p => p.dominios);
  const limitesPadrao = (comum.PADRAO as { limiteDiarioPorPlataforma: Record<string, number> }).limiteDiarioPorPlataforma;
  for (const d of servidosAgora) assert.ok(d in limitesPadrao, `${d} é servido à extensão e precisa de limite diário próprio, senão ele não aparece nas opções`);
  for (const d of Object.keys(limitesPadrao)) assert.ok(servidosAgora.includes(d), `${d} tem limite diário e não é servido à extensão: lista parada no tempo`);
  console.log('✓ Extensão: limite por dia, aquecimento de plataforma nova e espera sorteada entre candidaturas');

  // ─── D2) Classificação dos sites e decisão do botão (lógica pura, mesmo sandbox) ───────────────
  const puro = <T>(arquivo: string): T => {
    const caixa: Record<string, unknown> = { module: { exports: {} }, console };
    const ctx = createContext(caixa);
    caixa.globalThis = caixa;
    runInContext(readFileSync(new URL(`../extensao/ui/${arquivo}`, import.meta.url), 'utf8'), ctx);
    return (caixa.module as { exports: unknown }).exports as T;
  };

  type Sitio = { nivel: string; nome: string; importa?: boolean; conectada?: boolean; dois?: boolean; semSessaoDoNucleo?: boolean; nota: string } | null;
  const plat = puro<{
    classificar: (h: string, o: { plataformas?: unknown[]; pareceVaga?: boolean; proibido?: { motivo: string } | null }) => Sitio;
    catalogo: (o: { plataformas?: unknown[] }) => { nome: string; nivel: string; avisos: { texto: string }[] }[];
  }>('plataformas.js');

  // A lista que o núcleo serve de verdade: desde 05/10/2026, só plataforma que exige conta. O LinkedIn
  // aparece mesmo sem adapter — é o conserto de 03/10, a extensão precisa saber dos sites que ELA atende.
  const servidas = plataformasConhecidas();
  assert.ok(
    servidas.some(p => p.id === 'linkedin' && p.motor === 'extensao'),
    'o site sem adapter é servido com o motor da extensão',
  );
  assert.ok(!servidas.some(p => p.id === 'vagaspj'), 'e plataforma sem login não é servida: ali o robô dá conta sozinho');

  assert.equal(plat.classificar('www.linkedin.com', { plataformas: servidas })?.nivel, 'extensao', 'LinkedIn não tem adapter: é o motor da extensão');
  assert.equal(plat.classificar('www.vagaspj.com.br', { plataformas: servidas }), null, 'num site sem login o painel não aparece — nem como núcleo');
  assert.equal(plat.classificar('exemplo.com', { plataformas: servidas }), null, 'site desconhecido que não é vaga: o painel não aparece');
  assert.equal(plat.classificar('exemplo.com', { plataformas: servidas, pareceVaga: true })?.nivel, 'generico', 'site desconhecido COM vaga: oferece o genérico');
  // E a página de vaga de um site sem login também cai no genérico, porque ele não está mais na lista —
  // consequência direta da regra, e é o comportamento certo: ou o robô candidata sozinho pelo ACV, ou você
  // usa o genérico como em qualquer outro site que o ACV não conhece.
  assert.equal(plat.classificar('www.vagaspj.com.br', { plataformas: servidas, pareceVaga: true })?.nivel, 'generico');

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

  /**
   * Sessão do núcleo ausente num site com login: o motor da extensão deixa de ser alternativa e vira o
   * principal. Sem isto o painel oferecia "Candidatar pelo ACV" no ProgramaThor e o envio morria em sessão
   * ausente — com a pessoa logada na própria tela, na frente dele.
   */
  const comLogin = [
    { id: 'programathor', nome: 'ProgramaThor', dominios: ['programathor.com.br'], motor: 'ambos', importa: true, conectada: true, exigeLogin: true, sessaoValida: false },
    { id: 'programathor2', nome: 'ProgramaThor ligado', dominios: ['pt2.com.br'], motor: 'ambos', importa: true, conectada: true, exigeLogin: true, sessaoValida: true },
    { id: 'soNucleo', nome: 'Só Núcleo', dominios: ['sonucleo.com'], motor: 'nucleo', importa: false, conectada: true, exigeLogin: true, sessaoValida: false },
  ];
  const semSessao = plat.classificar('programathor.com.br', { plataformas: comLogin });
  assert.equal(semSessao?.nivel, 'extensao', 'sem a sessão do robô, quem candidata é o motor da extensão, no navegador da pessoa');
  assert.ok(semSessao?.semSessaoDoNucleo, 'e o painel sabe por quê');
  assert.match(String(semSessao?.nota), /sess[ãa]o do navegador do rob[ôo]/, 'a nota explica o motivo em vez de só mudar o botão');

  assert.equal(plat.classificar('pt2.com.br', { plataformas: comLogin })?.nivel, 'nucleo', 'com a sessão valendo, o adapter do núcleo volta a ser o caminho melhor');

  const orfa = plat.classificar('sonucleo.com', { plataformas: comLogin });
  assert.equal(orfa?.nivel, 'nucleo', 'site sem motor da extensão não tem a quem recorrer: continua no núcleo');
  assert.match(String(orfa?.nota), /Entrar e conectar/, 'e a nota manda conectar a conta, em vez de prometer um envio que falha');

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
  /**
   * Site cujos termos proíbem automação: recusa antes de tudo, inclusive antes do modo genérico.
   *
   * O genérico é o ramo de "site que o ACV não conhece", então tirar uma plataforma do cadastro NÃO a
   * protege — ela cai no genérico e é tratada como qualquer outra. Era o que acontecia com o Jobbol depois de
   * eu removê-lo em 05/10/2026: o genérico preencheria nome, sobrenome, celular, e-mail e anexaria o
   * currículo num site cuja cláusula 5.3 proíbe exatamente isso.
   */
  const proibido = comum.proibeAutomacao('www.jobbol.com.br');
  assert.ok(proibido, 'o Jobbol está na lista de sites que proíbem automação');
  assert.match(proibido.motivo, /5\.3|termos de uso/, 'e o motivo cita a cláusula, para a tela poder explicar');
  assert.ok(comum.proibeAutomacao('jobbol.com.br'), 'sem www também');
  assert.equal(comum.proibeAutomacao('jobbol.com.br.exemplo.net'), null, 'domínio que só CONTÉM o nome não conta');
  assert.equal(comum.proibeAutomacao('linkedin.com'), null, 'site que não proíbe não é afetado');

  const classificadoProibido = plat.classificar('www.jobbol.com.br', { plataformas: servidas, pareceVaga: true, proibido });
  assert.equal(classificadoProibido?.nivel, 'proibido', 'o nível próprio vem ANTES do genérico, mesmo a página parecendo uma vaga');
  assert.match(String(classificadoProibido?.nota), /5\.3|termos de uso/);
  console.log('✓ Extensão: site que proíbe automação nos termos é recusado antes do genérico, com o motivo na tela');

  console.log('✓ Extensão: classifica o site aberto, e cai no motor do navegador quando o núcleo não tem a sessão');

  type Acao = { principal: { id: string; desabilitado: boolean; rotulo: string }; alternativa: { id: string } | null; motivo: string };
  const acao = puro<{ decidir: (s: Record<string, unknown>) => Acao }>('acao.js');
  const cabe = { cabem: 3, feitasHoje: 2, limite: 5, aquecendo: false };
  const nucleo: Sitio = { nivel: 'nucleo', nome: 'InHire', nota: '' };
  const situacaoBase = { temVaga: true, sincronizado: true, cota: cabe, sitio: nucleo };

  // Site que proíbe automação: sem botão e sem alternativa, com o motivo no lugar — e isto vem ANTES de
  // qualquer outro caso na ordem de prioridade de `decidir`, porque ali não há escolha a oferecer.
  const semBotao = acao.decidir({ sincronizado: true, temVaga: true, cota: { cabem: 5, limite: 5, feitasHoje: 0 }, sitio: classificadoProibido });
  assert.equal(semBotao.principal.desabilitado, true, 'não existe botão de candidatar num site que proíbe');
  assert.equal(semBotao.alternativa, null, 'nem alternativa: não há escolha a oferecer');
  assert.match(semBotao.motivo, /termos de uso/, 'e a pessoa lê o motivo em vez de procurar um botão');

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
  const prepararCandidatura = async (stub: Record<string, unknown>, caminho?: string) => {
    await page.goto(`${base}${caminho ?? '/candidatura'}`, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: REDE });
    await page.evaluate(s => {
      (globalThis as Record<string, unknown>).__stub = s;
      (globalThis as Record<string, unknown>).chrome = {
        runtime: {
          // sem `id`: conteudo.js expõe a api e não tenta falar com o navegador
          sendMessage: (msg: { tipo: string; candidatura?: unknown; titulo?: string; empresa?: string }, cb: (r: unknown) => void) => {
            const st = (globalThis as unknown as { __stub: Record<string, unknown> }).__stub;
            const resposta =
              (
                {
                  CONFIG: { cfg: st.cfg },
                  DADOS: { dados: st.dados },
                  CABEM: st.cabem,
                  PERGUNTA: st.pergunta ?? { resposta: null, motivo: 'a IA está desligada nas configurações da extensão' },
                  CANDIDATURA: { sincronizado: true },
                  // A trava de "uma vaga, uma candidatura" do worker, imitada aqui. `enviadas` são as URLs que
                  // o `chrome.storage.local` guardaria entre cliques; `irmas` são empresa+título que o NÚCLEO
                  // conhece — a mesma vaga republicada em outra URL, que a chave de URL deixa passar.
                  JA_ENVIEI:
                    (st.enviadas as string[]).includes(location.href) || ((st.irmas as string[]) ?? []).includes(`${msg.empresa}|${msg.titulo}`)
                      ? { ja: true, quando: '2026-10-05T12:00:00.000Z', motivo: 'você já se candidatou a esta vaga' }
                      : { ja: false },
                } as Record<string, Record<string, unknown>>
              )[msg.tipo] ?? {};
            if (msg.tipo === 'CANDIDATURA') (st.enviadas as string[]).push(location.href);
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
  const registradas = (await page.evaluate(() => (globalThis as unknown as { __stub: { enviadas: string[] } }).__stub.enviadas)) as string[];
  assert.equal(registradas.length, 1, 'a candidatura tem de ser registrada para contar no limite e subir ao ACV');
  assert.ok((r.espera as number) >= 5000, 'o motor devolve quanto esperar antes da próxima');

  /**
   * Clicar de novo na MESMA vaga não manda outra (invariante 4).
   *
   * Até 05/10/2026 este teste passava pelo motivo errado: a página falsa desabilita o botão depois do envio,
   * então nada saía por causa do HTML, não por causa de uma trava. O motor conferia empresa bloqueada e
   * limite do dia, e nada sobre "já mandei para esta vaga" — a auditoria do codex achou isso, e era o defeito
   * mais grave do lote: dois currículos para o mesmo recrutador, funcionando até com o ACV fechado (onde não
   * há núcleo nenhum para salvar). Agora o desfecho é `repetida`, declarado, e o teste exige o motivo.
   */
  const antes = envios;
  r = await candidatar();
  assert.equal(r.status, 'repetida', `o segundo clique tem de ser recusado com motivo, não só não enviar (veio ${r.status}: ${r.motivo})`);
  assert.match(String(r.motivo), /j[áa] se candidatou/, 'e a pessoa precisa saber POR QUE não foi');
  assert.equal(envios, antes, 'nenhum segundo envio');
  console.log('✓ Motor: preenche as etapas, envia uma vez só e recusa o segundo clique na mesma vaga');

  /**
   * A MESMA vaga em outra URL (o InHire republica com outro id, e a vaga aparece em duas plataformas).
   *
   * O cadeado local da extensão é por URL e deixaria passar; quem pega é o núcleo, pela chave empresa+título
   * — a mesma de `jaCandidatado`. É por isso que o motor manda `titulo` e `empresa` na pergunta, e não só a
   * URL. Sem isto, dois currículos chegariam ao mesmo recrutador por caminhos diferentes.
   */
  await prepararCandidatura({ cfg: CFG_FALSA, dados: DADOS_FALSOS, cabem: CABEM_LIVRE, enviadas: [], irmas: ['Acme Tecnologia Ltda|Pessoa Desenvolvedora Back-end'] });
  const antesDaIrma = envios;
  r = await candidatar();
  assert.equal(r.status, 'repetida', `a mesma vaga em outra URL tem de ser recusada pelo par empresa+título (veio ${r.status}: ${r.motivo})`);
  assert.equal(envios, antesDaIrma, 'e nada pode sair');
  console.log('✓ Motor: a mesma vaga republicada em outra URL é pega pela chave empresa+título do núcleo');

  /**
   * A outra metade do conserto do clique único, e a mais perigosa: quando o botão manda por JavaScript, daqui
   * não há como saber antes — `reconhecerEnvio` devolve `talvez` e clicar é a única forma de descobrir. Então o
   * clique de `abrir` ENVIA, e o motor chega na etapa 1 sem formulário e sem botão para seguir.
   *
   * O que ele fazia: `erro — não achei o botão para seguir na etapa 1`. A candidatura já estava na mesa do
   * recrutador, e a mensagem convidava a clicar de novo. Agora, antes de acusar erro, ele pergunta à rede:
   * sucesso é a resposta HTTP, não o que está escrito na tela (invariante 1).
   */
  await prepararCandidatura({ cfg: CFG_FALSA, dados: DADOS_FALSOS, cabem: CABEM_LIVRE, enviadas: [] }, '/um-clique-js');
  const antesDoUmClique = envios;
  r = await candidatar();
  assert.equal(r.status, 'enviada', `candidatura de um clique por JavaScript é um envio, não um erro (veio ${r.status}: ${r.motivo})`);
  assert.equal(envios, antesDoUmClique + 1, 'e exatamente um envio saiu');
  const umaSo = (await page.evaluate(() => (globalThis as unknown as { __stub: { enviadas: unknown[] } }).__stub.enviadas)) as unknown[];
  assert.equal(umaSo.length, 1, 'registrada uma vez, para contar no limite do dia e travar a repetição');
  console.log('✓ Motor: clique que já enviou é reconhecido pela prova de rede, nunca reportado como falha');

  /**
   * Invariante 5 valendo fora do núcleo: ensaio não envia.
   *
   * O ensaio é configuração do núcleo e o motor da extensão não o conhecia — a tela do ACV dizia "nada será
   * enviado" e um clique no painel mandava currículo de verdade.
   *
   * O corte é na REDE, por método, como o do núcleo: o motor clica em tudo (senão formulário que abre por
   * botão de JavaScript nunca revelaria os campos, e o ensaio não mostraria nada), e `rede.js` recusa toda
   * escrita. Os dois caminhos entram aqui porque escrevem de formas diferentes: o formulário de etapas manda
   * por `fetch`, e a candidatura de um clique manda pelo `submit` de um `<form method="post">`, que não passa
   * por `fetch` nem por XHR.
   */
  await prepararCandidatura(
    { cfg: CFG_FALSA, dados: { ...DADOS_FALSOS, ensaio: true, perguntas: [{ pergunta: 'Quantos anos de experiência com React?', resposta: 'Mais de 3 anos' }] }, cabem: CABEM_LIVRE, enviadas: [] },
    '/candidatura',
  );
  const antesDoEnsaio = envios;
  r = await candidatar();
  assert.equal(r.status, 'ensaio', `com ensaio ligado o desfecho é ensaio, não enviada (veio ${r.status}: ${r.motivo})`);
  assert.equal(envios, antesDoEnsaio, 'e NADA pode ter saído');
  assert.equal(await page.inputValue('#nome'), 'Marina Pitanga', 'mas o formulário foi preenchido de verdade — é o que o ensaio existe para mostrar');
  const nadaRegistrado = (await page.evaluate(() => (globalThis as unknown as { __stub: { enviadas: unknown[] } }).__stub.enviadas)) as unknown[];
  assert.equal(nadaRegistrado.length, 0, 'ensaio não conta no limite do dia nem sobe como candidatura');

  await prepararCandidatura({ cfg: CFG_FALSA, dados: { ...DADOS_FALSOS, ensaio: true }, cabem: CABEM_LIVRE, enviadas: [] }, '/um-clique-js');
  const antesDoEnsaioDireto = envios;
  r = await candidatar();
  assert.equal(r.status, 'ensaio', `na candidatura de um clique o ensaio também é ensaio (veio ${r.status}: ${r.motivo})`);
  assert.equal(envios, antesDoEnsaioDireto, 'e a escrita foi recusada antes de chegar ao servidor');

  // Envio por <form method="post">, que não passa por fetch nem por XHR: sem o `submit` barrado, o caso mais
  // direto de todos escaparia justamente do ensaio
  await prepararCandidatura({ cfg: CFG_FALSA, dados: { ...DADOS_FALSOS, ensaio: true }, cabem: CABEM_LIVRE, enviadas: [] }, '/um-clique-form');
  const antesDoForm = envios;
  r = await candidatar();
  assert.equal(envios, antesDoForm, 'o submit de um <form method="post"> também é barrado no ensaio');

  /**
   * `form.submit()` por JavaScript, que é a brecha que o evento `submit` não cobre.
   *
   * E, de passagem, a marca de prontidão: `rede.js` roda no mundo da PÁGINA e `motor.js` no mundo isolado do
   * content script, então `window.__acvRede` nunca cruzava — o ensaio recusava em todo site, dizendo "falta o
   * monitor de rede". Este teste não reproduz a separação de mundos (o `addScriptTag` põe os dois no mesmo),
   * então o que ele fixa é o contrato: a marca mora no DOM, que é compartilhado de verdade.
   */
  await prepararCandidatura({ cfg: CFG_FALSA, dados: { ...DADOS_FALSOS, ensaio: true }, cabem: CABEM_LIVRE, enviadas: [] }, '/um-clique-submit-js');
  assert.equal(await page.getAttribute('html', 'data-acv-rede'), '1', 'a prontidão do monitor é marcada no DOM, não numa variável de window que não cruza mundos');
  const antesDoSubmitJs = envios;
  r = await candidatar();
  assert.equal(envios, antesDoSubmitJs, 'form.submit() por JavaScript também é barrado no ensaio');
  assert.equal(r.status, 'ensaio', `e o desfecho é ensaio (veio ${r.status}: ${r.motivo})`);

  // E o corte não pode sobrar na aba: armado e esquecido, ele quebraria a navegação normal da pessoa
  await prepararCandidatura({ cfg: CFG_FALSA, dados: { ...DADOS_FALSOS, ensaio: false }, cabem: CABEM_LIVRE, enviadas: [] }, '/um-clique-js');
  const antesDeVoltar = envios;
  r = await candidatar();
  assert.equal(r.status, 'enviada', `com o ensaio desligado o envio volta a acontecer (veio ${r.status}: ${r.motivo})`);
  assert.equal(envios, antesDeVoltar + 1, 'o corte de escrita do ensaio foi desarmado ao fim da tentativa');
  console.log('✓ Motor: ensaio preenche, clica e NENHUMA escrita sai da página — e o corte não sobra na aba');

  /**
   * O `✕` do painel tem de ESCONDER o painel — e por semanas não escondeu.
   *
   * `painel.css` blinda o host com `display: block !important` e `visibility: visible !important`, de
   * propósito: `#painel { display: none !important }` é ataque real de plataforma de recrutamento contra
   * extensão, e declaração de árvore shadow só ganha da página quando é `!important`. Só que a mesma armadura
   * vencia o nosso próprio `hospedeiro.hidden = true` — `hidden` é `display: none` SEM importância, no estilo
   * do navegador. O escudo barrava o dono junto com o invasor, e o painel ficava sobreposto na tela sem jeito
   * de tirar. O `[hidden]` que já existia na folha não alcança o host: ele vale para dentro da árvore shadow.
   *
   * O teste mede o que o usuário vê (a altura renderizada), e não qual regra ganhou — e confere os dois lados:
   * esconder funciona, e a página hospedeira continua sem conseguir apagar o painel.
   */
  await page.goto(`${base}/vaga`, { waitUntil: 'domcontentloaded' });
  const painelCss = readFileSync(new URL('../extensao/ui/painel.css', import.meta.url), 'utf8');
  const visibilidade = await page.evaluate(
    ([css]) => {
      const host = document.createElement('div');
      const raiz = host.attachShadow({ mode: 'open' });
      const folha = new CSSStyleSheet();
      folha.replaceSync(css);
      raiz.adoptedStyleSheets = [folha];
      raiz.innerHTML = '<div class="caixa" style="height:120px">painel</div>';
      document.documentElement.appendChild(host);
      const alto = () => host.getBoundingClientRect().height;
      const aberto = alto();
      host.hidden = true;
      const escondido = alto();
      host.hidden = false;
      // E a página tentando apagar o painel, que é contra quem a armadura existe
      const ataque = document.createElement('style');
      ataque.textContent = 'div[role], div { display: none !important; visibility: hidden !important; }';
      document.head.appendChild(ataque);
      const sobAtaque = alto();
      return { aberto, escondido, sobAtaque };
    },
    [painelCss],
  );
  assert.ok(visibilidade.aberto > 0, 'o painel aberto ocupa espaço na tela');
  assert.equal(visibilidade.escondido, 0, 'o ✕ marca `hidden` no host: o painel TEM de sumir, apesar do display !important da armadura');
  assert.ok(visibilidade.sobAtaque > 0, 'e a página hospedeira continua sem conseguir apagar o painel — a armadura não foi enfraquecida');
  console.log('✓ Extensão: o ✕ esconde o painel de verdade, e a página hospedeira continua sem poder apagá-lo');
} finally {
  await page.close().catch(() => {});
  servidor.close();
  await fecharNavegador();
}

console.log('\nExtensão: tudo certo.');
