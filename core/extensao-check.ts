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
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DIR = mkdtempSync(join(tmpdir(), 'autocv-extensao-'));
process.env.AUTOCV_DIR = DIR;
process.env.AUTOCV_PERFIL = join(DIR, 'navegador');

const { autorizado, lerDeteccoes, perfilParaExtensao, registrarCamposFaltando, registrarPlataformaDetectada, tokenDaExtensao } = await import('./extensao.ts');
const { fecharNavegador, navegador } = await import('./browser.ts');
const { kv } = await import('./storage/db.ts');

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

const paginas: Record<string, string> = { '/vaga': VAGA_PUBLICA, '/conta': VAGA_COM_CONTA, '/login': TELA_LOGIN, '/logado': VAGA_LOGADO, '/indeed': CABECALHO_INDEED };
const servidor = createServer((req, res) => {
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
  await page.addScriptTag({ content: CONTEUDO }); // fora da extensão, o script se expõe em globalThis.AutoCVExtensao
  return page.evaluate(() => (globalThis as unknown as { AutoCVExtensao: { diagnosticar: () => Diagnostico } }).AutoCVExtensao.diagnosticar());
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
    (globalThis as unknown as { AutoCVExtensao: { INDEED: { precisaLogin: () => { precisa: boolean | null; logado: boolean } } } }).AutoCVExtensao.INDEED.precisaLogin(),
  );
  assert.deepEqual(indeed.precisa, true, 'Indeed sempre exige conta para candidatar');
  assert.equal(indeed.logado, false, '"Acessar" à vista = deslogado');
  const desafiado = await page.evaluate(() => {
    document.body.insertAdjacentHTML('afterbegin', '<p>Verificação adicional necessária</p>');
    return (globalThis as unknown as { AutoCVExtensao: { INDEED: { precisaLogin: () => { precisa: boolean | null } } } }).AutoCVExtensao.INDEED.precisaLogin().precisa;
  });
  assert.equal(desafiado, null, 'com a verificação anti-robô na tela, não dá para diagnosticar nada');
  console.log('✓ Extensão: handler dedicado do Indeed (registro por domínio) e recuo diante da verificação anti-robô');

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
  const perfilFalso = { tem: { nome: true, email: true, celular: true, curriculo: true, regime: true, linkedin: false, cidade: false, cpf: false, pretensao: false }, perguntas: ['Tipo de CNPJ'] };
  const faltando = await page.evaluate(
    ([campos, perfil]) => {
      const api = (globalThis as unknown as { AutoCVExtensao: { temDado: (c: unknown, p: unknown) => boolean } }).AutoCVExtensao;
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
} finally {
  await page.close().catch(() => {});
  servidor.close();
  await fecharNavegador();
}

console.log('\nExtensão: tudo certo.');
