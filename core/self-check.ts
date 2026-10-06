// Verificação executável do núcleo (sem tocar em plataforma nenhuma):
//   node core/self-check.ts
// Cobre: Markdown → PDF → Markdown, análise do currículo, score, adaptação sem invenção, similaridade de perguntas.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ACV_PERFIL = join(tmpdir(), 'acv-self-check'); // não colide com o núcleo rodando
/**
 * **Nada neste arquivo pode ESCREVER no banco.** Não é disciplina, é limitação: `import` é içado, então
 * qualquer `process.env.ACV_DIR` daqui roda DEPOIS de `core/config.ts` já ter resolvido o caminho, e o banco
 * aberto é o de uso real. Tentei apontar para um temporário aqui e o teste da lista de boards gravou no banco
 * de verdade (06/10/2026). Teste que precisa gravar vai para `fila-check.ts`, que só usa `await import` e por
 * isso consegue trocar o caminho antes de alguém lê-lo. Aqui, só leitura e função pura.
 */
import { markdownParaPdf } from './resume/mdToPdf.ts';
import { pdfParaMarkdown } from './resume/pdfToMd.ts';
import { analisarCurriculo } from './resume/analyzer.ts';
import { calcularScore } from './resume/score.ts';
import { inferirSenioridade } from './resume/analyzer.ts';
import { adaptarCurriculo, validarAdaptacao } from './resume/adapter.ts';
import { extrairSkills, similaridade } from './resume/texto.ts';
import { fecharNavegador } from './browser.ts';

const CV = `# Marina Pitanga
São Paulo, SP · marina@email.com · (11) 98232-4410

## Resumo
Desenvolvedora back-end júnior com 2 anos de experiência em Java e Spring Boot.

## Experiência
**Desenvolvedora Back-end Jr — Nuvemtec (2024–2026)**
- APIs REST em Java com Spring Boot e PostgreSQL
- Testes automatizados com JUnit
**Estagiária de Suporte — Bitmarco (2023–2024)**
- Atendimento a usuários e help desk

## Habilidades
- Excel
- Java
- Spring
- SQL
- Git

## Idiomas
- Inglês intermediário`;

const VAGA = {
  titulo: 'Desenvolvedor Back-end Júnior',
  descricao: 'Requisitos: Java, Spring Boot, SQL, Git, Docker (desejável). Trabalho em equipe.',
  skills: [] as string[],
};
VAGA.skills = extrairSkills(`${VAGA.titulo}\n${VAGA.descricao}`);

// 1) PDF ⇄ Markdown
const pdf = join(tmpdir(), `acv-selfcheck-${Date.now()}.pdf`);
await markdownParaPdf(CV, pdf);
const lido = await pdfParaMarkdown(pdf);
for (const trecho of ['marina pitanga', 'resumo', 'experiência', 'habilidades', 'spring boot', 'postgresql']) assert.ok(lido.toLowerCase().includes(trecho), `PDF→MD perdeu "${trecho}":\n${lido}`);
assert.ok((lido.match(/^## /gm) ?? []).length >= 4, `PDF→MD não reconheceu as seções:\n${lido}`);
assert.ok((lido.match(/^- /gm) ?? []).length >= 5, `PDF→MD perdeu os itens de lista:\n${lido}`);
console.log('✓ Markdown → PDF → Markdown preserva nome, seções e conteúdo');

// 2) Perfil de busca
const perfil = analisarCurriculo(CV);
assert.equal(perfil.area, 'Tecnologia da Informação');
assert.equal(perfil.senioridade, 'Júnior');
assert.ok(perfil.skills.includes('java') && perfil.skills.includes('spring') && perfil.skills.includes('sql'), JSON.stringify(perfil));
assert.ok(
  perfil.cargos.some(c => /desenvolvedora/i.test(c)),
  JSON.stringify(perfil.cargos),
);
console.log('✓ Análise do currículo:', JSON.stringify(perfil));

// 3) Score
const { score, motivo } = calcularScore(VAGA, perfil);
assert.ok(score >= 50 && score <= 100, `score inesperado: ${score}`);
const ruim = calcularScore(
  { titulo: 'Consultor Comercial', descricao: 'Vendas, negociação, CRM e boa comunicação', skills: extrairSkills('Vendas, negociação, CRM, comunicação, proatividade') },
  perfil,
);
assert.ok(ruim.score < 25, `score de vaga incompatível deveria ser baixo: ${ruim.score} (${ruim.motivo})`);
const generica = calcularScore(
  { titulo: 'Supervisor de Atendimento', descricao: 'Comunicação, organização, proatividade, trabalho em equipe', skills: extrairSkills('Comunicação, organização, proatividade, trabalho em equipe') },
  perfil,
);
assert.ok(generica.score < 25, `vaga só com soft skills não pode pontuar alto: ${generica.score}`);
console.log(`✓ Score: compatível ${score} (${motivo}) · incompatível ${ruim.score} · só soft skills ${generica.score}`);

// 3b) Senioridade
assert.equal(inferirSenioridade('Desenvolvedor Java Pleno/Sênior', ''), 'Pleno');
assert.equal(inferirSenioridade('Analista Fiscal Jr', ''), 'Júnior');
assert.equal(inferirSenioridade('Estagiário de TI', ''), 'Estágio');
assert.equal(inferirSenioridade('Coordenador de Engenharia', ''), 'Liderança');
assert.equal(inferirSenioridade('Desenvolvedor Java', 'Requisitos: mínimo 5 anos de experiência com Java'), 'Sênior');
assert.equal(inferirSenioridade('Desenvolvedor Java', 'Vaga para nosso time'), 'Indefinida');
const BASE = 'Desenvolvedor Back-end';
const senior = calcularScore({ ...VAGA, titulo: `${BASE} Sênior` }, perfil);
const pleno = calcularScore({ ...VAGA, titulo: `${BASE} Pleno` }, perfil);
const junior = calcularScore({ ...VAGA, titulo: `${BASE} Júnior` }, perfil);
assert.ok(senior.score < pleno.score && pleno.score < junior.score, `júnior deve pontuar mais que pleno e sênior: ${junior.score} / ${pleno.score} / ${senior.score}`);
assert.ok(senior.score <= junior.score * 0.5, `dois níveis acima deve cortar pelo menos metade: ${senior.score} vs ${junior.score}`);
assert.ok(/acima do seu nível/.test(senior.motivo), senior.motivo);
const configurado = calcularScore({ ...VAGA, titulo: `${BASE} Sênior` }, perfil, { senioridade: 'Sênior' });
assert.ok(configurado.score > pleno.score && /senioridade ok/.test(configurado.motivo), `senioridade configurada deve sobrepor a do currículo: ${configurado.score} (${configurado.motivo})`);
console.log(`✓ Senioridade: júnior ${junior.score} · pleno ${pleno.score} · sênior ${senior.score}`);

// Rigor de senioridade: corte, não desconto — e só para cima
const soPleno2 = { senioridade: 'Pleno', senioridadeRigida: true };
assert.equal(calcularScore({ ...VAGA, titulo: `${BASE} Sênior` }, perfil, soPleno2).score, 0, 'com rigor, vaga acima do nível é zerada');
assert.ok(calcularScore({ ...VAGA, titulo: `${BASE} Pleno` }, perfil, soPleno2).score > 0, 'o nível pedido continua passando');
// Para BAIXO não corta: cortar os dois lados tirava 843 vagas de uma vez (medido no banco real em 28/09/2026)
assert.ok(calcularScore({ ...VAGA, titulo: `${BASE} Júnior` }, perfil, soPleno2).score > 0, 'um nível abaixo continua passando');
assert.ok(calcularScore({ ...VAGA, titulo: BASE }, perfil, soPleno2).score > 0, 'vaga sem nível declarado escapa do corte');
assert.ok(/acima do seu nível/.test(calcularScore({ ...VAGA, titulo: `${BASE} Sênior` }, perfil, soPleno2).motivo), 'o motivo diz de onde veio o corte');
console.log('✓ Rigor de senioridade: corta o que está acima do seu nível, e só isso');

// ─── Vaga reservada a um grupo do qual a pessoa não faz parte ────────────────────────────────────
// Caso real (28/09/2026): saiu candidatura para "Vaga Afirmativa para PCD | Analista de Desenvolvimento Full
// Stack" com PcD declarado "Não", e para "Software Engineer (afirmativa para mulheres)" declarando-se homem.
const euSou = { pcd: 'Não', genero: 'Homem Cisgênero', raca: 'Branca', orientacao: 'Heterossexual' };
const comGrupo = (t: string) => calcularScore({ ...VAGA, titulo: t }, perfil, { autodeclaracoes: euSou });
assert.equal(comGrupo('Vaga Afirmativa para PCD | Analista de Desenvolvimento Full Stack').score, 0);
assert.equal(comGrupo('Engineering l Software Engineer (afirmativa para mulheres)').score, 0);
assert.equal(comGrupo('Desenvolvedor Full Stack | Vaga afirmativa para pessoas negras').score, 0);
assert.equal(comGrupo('Desenvolvedor Full Stack | Vagas Afirmativas | Pessoas Trans').score, 0);
assert.match(comGrupo('Vaga Exclusiva para PCD | Full Stack').motivo, /reservada a pessoas com defici/);

// "afirmativa TAMBÉM para" é aberta a todo mundo: reprovar essas cortaria vaga boa por engano
assert.ok(comGrupo('Desenvolvedor Full Stack - Vaga Afirmativa Também Para O Público PCD').score > 0, '"também para" é aberta a todos');
// Vaga normal não é afetada
assert.ok(comGrupo(`${BASE} Pleno`).score > 0);
// Quem É do grupo continua vendo a vaga
const souPcd = calcularScore({ ...VAGA, titulo: 'Vaga Afirmativa para PCD | Full Stack' }, perfil, { autodeclaracoes: { pcd: 'Sim' } });
assert.ok(souPcd.score > 0, 'quem declarou ser do grupo continua vendo a vaga');
// Sem autodeclaração o robô NÃO adivinha (invariante 3)
assert.ok(calcularScore({ ...VAGA, titulo: 'Vaga Afirmativa para PCD | Full Stack' }, perfil, {}).score > 0, 'sem declaração, não se supõe nada');
console.log('✓ Vaga reservada a um grupo: só a sua autodeclaração decide, e "também para" não é exclusiva');

// 3c) Localização: presencial/híbrida pela cidade, remota pelos países escolhidos
const { lerLocal } = await import('./resume/score.ts');
assert.deepEqual(lerLocal('São Paulo - SP'), { cidade: 'sao paulo', uf: 'SP' });
assert.deepEqual(lerLocal('Belo Horizonte, Minas Gerais'), { cidade: 'belo horizonte', uf: 'MG' });
assert.deepEqual(lerLocal('Campinas/SP'), { cidade: 'campinas', uf: 'SP' });
assert.deepEqual(lerLocal('Brasil'), { cidade: '', uf: '' });
assert.deepEqual(lerLocal('Minas Gerais'), { cidade: '', uf: 'MG' });
assert.deepEqual(lerLocal('São Paulo, SP, BR'), { cidade: 'sao paulo', uf: 'SP' }); // formato real do InHire
assert.deepEqual(lerLocal('Rio de Janeiro, RJ, BR'), { cidade: 'rio de janeiro', uf: 'RJ' });
assert.deepEqual(lerLocal('BR'), { cidade: '', uf: '' });
assert.deepEqual(lerLocal('São Paulo'), { cidade: 'sao paulo', uf: 'SP' });
const { paisDoLocal, vagaCompativelComLocalizacao } = await import('./localizacao.ts');
assert.equal(paisDoLocal('São Paulo, SP, BR'), 'Brasil');
assert.equal(paisDoLocal('Campinas - SP'), 'Brasil');
assert.equal(paisDoLocal('Lisboa, PT'), 'Portugal');
assert.equal(paisDoLocal('Porto, Portugal'), 'Portugal');
assert.equal(paisDoLocal('Belém, PA'), 'Brasil', 'PA é Pará, não Panamá');
assert.equal(paisDoLocal('London, UK'), 'Reino Unido');
assert.equal(paisDoLocal('Remoto'), '');
assert.equal(paisDoLocal('BR'), 'Brasil');
const meu = { localizacao: { localizacaoPresencial: 'Fortaleza - CE', paisesRemoto: ['Brasil', 'Portugal'] } };
const pref = meu.localizacao;
const naCidade = calcularScore({ ...VAGA, modelo: 'presencial', local: 'Fortaleza, CE, BR' }, perfil, meu);
const noEstado = calcularScore({ ...VAGA, modelo: 'presencial', local: 'Sobral - CE' }, perfil, meu);
const foraEstado = calcularScore({ ...VAGA, modelo: 'presencial', local: 'Curitiba - PR' }, perfil, meu);
const hibridaFora = calcularScore({ ...VAGA, modelo: 'hibrido', local: 'São Paulo, SP, BR' }, perfil, meu);
const remotaBR = calcularScore({ ...VAGA, modelo: 'remoto', local: 'Curitiba - PR' }, perfil, meu);
const remotaPT = calcularScore({ ...VAGA, modelo: 'remoto', local: 'Lisboa, PT' }, perfil, meu);
const remotaUS = calcularScore({ ...VAGA, modelo: 'remoto', local: 'Austin, TX, US' }, perfil, meu);
const remotaLivre = calcularScore({ ...VAGA, modelo: 'remoto', local: '' }, perfil, meu);
assert.equal(naCidade.score, score, 'mesma cidade não muda o score');
assert.ok(noEstado.score < naCidade.score && noEstado.score > 0, `outra cidade do estado: desconto, não exclusão (${noEstado.score})`);
assert.equal(foraEstado.score, 0, 'presencial em outro estado é incompatível');
assert.equal(hibridaFora.score, 0, 'híbrida segue a mesma regra da presencial');
assert.equal(remotaBR.score, score, 'remota no Brasil: a cidade não importa');
assert.equal(remotaPT.score, score, 'remota em Portugal, país escolhido');
assert.equal(remotaUS.score, 0, 'remota restrita a país não escolhido');
assert.equal(remotaLivre.score, score, 'remota sem país declarado é compatível');
assert.equal(calcularScore({ ...VAGA, modelo: 'presencial', local: 'Curitiba - PR' }, perfil).score, score, 'sem preferências não penaliza');
assert.equal(
  calcularScore({ ...VAGA, modelo: 'presencial', local: 'Curitiba - PR' }, perfil, { localizacao: { localizacaoPresencial: '', paisesRemoto: ['Brasil'] } }).score,
  score,
  'sem cidade no perfil não penaliza',
);
assert.ok(/fora do seu estado/.test(foraEstado.motivo) && /fora dos países/.test(remotaUS.motivo), `${foraEstado.motivo} | ${remotaUS.motivo}`);
assert.equal(vagaCompativelComLocalizacao({ modelo: 'presencial', local: 'Lisboa', pais: 'Portugal' }, pref).compativel, false, 'presencial em outro país');
assert.equal(vagaCompativelComLocalizacao({ modelo: 'remoto', local: '', pais: 'Portugal' }, pref).compativel, true, 'vaga.pais (domínio do Indeed) vale mesmo sem local');
assert.equal(vagaCompativelComLocalizacao({ modelo: 'indefinido', local: 'Curitiba - PR' }, pref).compativel, true, 'modelo não informado: na dúvida, mostra');
console.log(`✓ Localização: cidade ${naCidade.score} · estado ${noEstado.score} · outro estado ${foraEstado.score} · remota BR/PT ${remotaBR.score}/${remotaPT.score} · remota EUA ${remotaUS.score}`);

// ─── Cidade sem UF: o buraco por onde saíram sete presenciais fora do estado ─────────────────────
// Caso real (28/09/2026): o perfil tinha "Fortaleza" sem o "CE". Sem a UF da pessoa, a regra não conseguia
// dizer "outro estado" e caía no desconto de 40% de "outra cidade" — e presencial em São Paulo, Porto
// Alegre, Blumenau, Manaus e Recife receberam currículo.
const semUf = { localizacao: { localizacaoPresencial: 'Fortaleza', paisesRemoto: ['Brasil'] } };
const spSemUf = calcularScore({ ...VAGA, modelo: 'presencial', local: 'São Paulo, SP, BR' }, perfil, semUf);
assert.equal(spSemUf.score, 0, 'vaga com UF + minha cidade sem UF: não dá para afirmar que é perto, então não vai');
assert.match(spSemUf.motivo, /informe o estado na sua cidade/, 'e o motivo diz o que preencher');
// Com a UF preenchida, a mesma vaga continua zerada — agora pela regra de sempre
const comUf = { localizacao: { localizacaoPresencial: 'Fortaleza - CE', paisesRemoto: ['Brasil'] } };
assert.equal(calcularScore({ ...VAGA, modelo: 'presencial', local: 'São Paulo, SP, BR' }, perfil, comUf).score, 0);
// Na sua cidade continua passando, com ou sem UF no perfil
assert.ok(calcularScore({ ...VAGA, modelo: 'presencial', local: 'Fortaleza, CE, BR' }, perfil, semUf).score > 0, 'a sua própria cidade sempre passa');

// "Só presencial na minha cidade" (Automação) agora existe no núcleo: antes a tela prometia e ninguém lia
const soMinhaCidade = { localizacao: { localizacaoPresencial: 'Fortaleza - CE', paisesRemoto: ['Brasil'], presencialSoNaMinhaCidade: true } };
assert.equal(calcularScore({ ...VAGA, modelo: 'presencial', local: 'Sobral - CE' }, perfil, soMinhaCidade).score, 0, 'ligado, nem outra cidade do seu estado passa');
assert.ok(calcularScore({ ...VAGA, modelo: 'presencial', local: 'Sobral - CE' }, perfil, comUf).score > 0, 'desligado, outra cidade do estado passa com desconto');
assert.ok(calcularScore({ ...VAGA, modelo: 'remoto', local: 'São Paulo, SP, BR' }, perfil, soMinhaCidade).score > 0, 'remota não é afetada por isso');
assert.ok(calcularScore({ ...VAGA, modelo: 'presencial', local: 'Fortaleza, CE, BR' }, perfil, soMinhaCidade).score > 0, 'a sua cidade continua passando');
console.log('✓ Presencial: cidade sem UF não vira desconto, e "só na minha cidade" é lida pelo núcleo');

// 3d) Indeed: plano de buscas por país, modelo de trabalho pelos atributos da vaga, filtro de candidatura simplificada
const { planejarConsultas, modeloDe, montarVagaIndeed, urlDeBusca } = await import('./platforms/indeed/busca.ts');
const plano = planejarConsultas(['Assistente Fiscal', 'Analista Fiscal', 'Terceiro cargo'], pref);
assert.deepEqual(
  plano.map(c => `${c.host}|${c.remoto ? 'remoto' : 'local'}`),
  ['br.indeed.com|local', 'br.indeed.com|remoto', 'pt.indeed.com|remoto', 'br.indeed.com|local', 'br.indeed.com|remoto', 'pt.indeed.com|remoto'],
  'presencial só no país da pessoa; remoto em cada país escolhido; no máximo 2 cargos',
);
assert.ok(plano[0].url.includes('l=Fortaleza') && !plano[0].url.includes('sc='), plano[0].url);
assert.ok(plano[2].url.startsWith('https://pt.indeed.com/jobs?') && decodeURIComponent(plano[2].url).includes('sc=0kf:attr(DSQF7);') && !plano[2].url.includes('l='), plano[2].url);
assert.equal(planejarConsultas(['X'], { localizacaoPresencial: '', paisesRemoto: ['Paraguai'] }).length, 0, 'país sem Indeed mapeado não gera busca');
assert.equal(urlDeBusca('br.indeed.com', 'assistente fiscal', 'Fortaleza, CE', false), 'https://br.indeed.com/jobs?q=assistente+fiscal&l=Fortaleza%2C+CE');
assert.equal(modeloDe({ suidsRemoto: ['DSQF7'], local: 'Fortaleza, CE' }, false), 'remoto');
assert.equal(modeloDe({ suidsRemoto: ['PAXZC', 'DSQF7'], local: 'Fortaleza, CE' }, false), 'hibrido', 'Home Office + Modelo Híbrido = híbrido');
assert.equal(modeloDe({ suidsRemoto: [], local: 'Fortaleza, CE' }, false), 'presencial');
assert.equal(modeloDe({ suidsRemoto: [], local: 'Remoto' }, false), 'remoto');
const cfgTeste = { area: '', senioridade: '', scoreMinimo: 30 } as unknown as Parameters<typeof montarVagaIndeed>[3];
const card = {
  jobkey: 'a7a47a8368d6eed7',
  titulo: 'Desenvolvedor Back-end Júnior',
  empresa: 'ACME',
  local: 'Fortaleza, CE',
  facil: true,
  trecho: '<ul><li>Java, <b>Spring</b> Boot e SQL</li></ul>',
  tipos: ['Efetivo/CLT'],
  suidsRemoto: [] as string[],
};
const vFortaleza = montarVagaIndeed(card, plano[0], perfil, cfgTeste, pref);
assert.equal(vFortaleza.id, 'indeed:a7a47a8368d6eed7');
assert.equal(vFortaleza.plataforma, 'indeed');
assert.equal(vFortaleza.url, 'https://br.indeed.com/viewjob?jk=a7a47a8368d6eed7');
assert.deepEqual([vFortaleza.modelo, vFortaleza.pais, vFortaleza.regime, vFortaleza.status], ['presencial', 'Brasil', 'CLT', 'encontrada'], JSON.stringify(vFortaleza));
assert.ok(vFortaleza.descricao.includes('Spring') && !vFortaleza.descricao.includes('<'), vFortaleza.descricao);
const vPortugal = montarVagaIndeed({ ...card, jobkey: 'pt1', local: 'Teletrabalho', suidsRemoto: ['DSQF7'] }, plano[2], perfil, cfgTeste, pref);
assert.deepEqual([vPortugal.modelo, vPortugal.pais, vPortugal.status], ['remoto', 'Portugal', 'encontrada'], 'remota de Portugal, país escolhido');
const vForaDaLista = montarVagaIndeed({ ...card, jobkey: 'pt2', local: 'Teletrabalho', suidsRemoto: ['DSQF7'] }, plano[2], perfil, cfgTeste, { ...pref, paisesRemoto: ['Brasil'] });
assert.equal(vForaDaLista.status, 'ignorada', 'remota de país não escolhido fica de fora');
const vOutroEstado = montarVagaIndeed({ ...card, jobkey: 'sp1', local: 'São Paulo, SP' }, plano[0], perfil, cfgTeste, pref);
assert.equal(vOutroEstado.status, 'ignorada', 'presencial em outro estado fica de fora');
console.log(`✓ Indeed: ${plano.length} buscas planejadas (BR local+remoto, PT remoto) · Fortaleza ${vFortaleza.score} · remota PT ${vPortugal.score} · fora da lista/estado ignoradas`);

// 4) Adaptação sem invenção
const adaptacao = adaptarCurriculo(CV, VAGA);
assert.deepEqual(validarAdaptacao(CV, adaptacao.markdown), [], 'adaptação introduziu palavras novas');
assert.ok(!adaptacao.markdown.toLowerCase().includes('docker'), 'Docker NÃO pode aparecer: não está no currículo');
assert.ok(adaptacao.markdown.includes('Foco em java'), adaptacao.markdown);
const habilidades = adaptacao.markdown.split('## Habilidades')[1].split('##')[0];
assert.ok(habilidades.indexOf('Java') < habilidades.indexOf('Excel'), 'habilidades pedidas devem vir antes');
assert.ok(adaptacao.markdown.includes('Estagiária de Suporte'), 'experiência real removida');
assert.deepEqual(validarAdaptacao(CV, `${CV}\nCertificação AWS`), ['certificacao', 'aws'], 'validador deve pegar termo inventado');
console.log('✓ Adaptação:', adaptacao.diff.join(' | '));

// 4b) Validação de texto reescrito por IA: sinônimos passam, entidade nova não
const { validarEntidades, adaptarComIA } = await import('./resume/adapter.ts');
const reescrito = CV.replace('APIs REST em Java com Spring Boot e PostgreSQL', 'Construção de APIs REST com Java, Spring Boot e PostgreSQL').replace(
  'Desenvolvedora back-end júnior com 2 anos',
  'Desenvolvedora back-end júnior, com 2 anos',
);
assert.deepEqual(validarEntidades(CV, reescrito), [], 'sinônimos e reordenação devem passar');
const inventado = CV.replace('Testes automatizados com JUnit', 'Testes automatizados com JUnit e Docker na AWS desde 2019');
const p = validarEntidades(CV, inventado);
assert.ok(p.includes('docker') && p.includes('aws') && p.includes('2019'), `deveria pegar docker/aws/2019: ${p}`);
assert.ok(
  validarEntidades(CV, CV.replace('**Estagiária de Suporte — Bitmarco (2023–2024)**\n- Atendimento a usuários e help desk\n', '')).some(x => x.startsWith('item removido')),
  'remoção de experiência deve ser pega',
);
const simulada = await adaptarComIA(CV, VAGA, async () => `\`\`\`markdown\n${inventado}\n\`\`\``);
assert.ok(simulada.problemas.length > 0 && !simulada.markdown.startsWith('```'), 'adaptarComIA deve limpar cerca de código e reportar problemas');
console.log('✓ Validação de entidades (IA):', p.join(', '));

// 5) Pretensão salarial → formato da máscara do InHire (reais inteiros; a máscara põe ",00")
const { pretensaoEmReais } = await import('./platforms/inhire/index.ts');
assert.equal(pretensaoEmReais('R$ 4.500,00'), '4500');
assert.equal(pretensaoEmReais('4500'), '4500');
assert.equal(pretensaoEmReais('R$ 4.500'), '4500');
assert.equal(pretensaoEmReais('3.200,50'), '3200');
console.log('✓ Pretensão salarial em reais');

// 5c) Máscaras do perfil
const { mascaraTelefone, mascaraMoeda } = await import('../src/mascaras.ts');
assert.equal(mascaraTelefone('11912345678'), '(11) 91234-5678');
assert.equal(mascaraTelefone('+55 11 3123-4567'), '(11) 3123-4567');
assert.equal(mascaraTelefone('119'), '(11) 9');
assert.equal(mascaraMoeda('4500'), 'R$ 4.500');
assert.equal(mascaraMoeda('R$ 4.500,00'), 'R$ 4.500'); // valor antigo com centavos não vira 450 mil
assert.equal(pretensaoEmReais(mascaraMoeda('4500')), '4500');
console.log('✓ Máscaras de telefone e pretensão');

// 6) Motor de formulário: schema → perguntas, escolha de opção, classificação de campo (sem navegador)
const { perguntasDoTypeform, perguntasDaDiversidade, perguntasCertas } = await import('./platforms/inhire/schema.ts');
const { melhorOpcao, papelDe, resolverCampo } = await import('./platforms/inhire/formulario.ts');
const tf = perguntasDoTypeform({
  fields: [
    {
      id: 'a',
      ref: 'r1',
      type: 'multiple_choice',
      title: 'Nível de inglês?',
      validations: { required: true },
      properties: { choices: [{ label: 'Básico' }, { label: 'Fluente' }], allow_multiple_selection: false },
    },
    {
      id: 'b',
      ref: 'r2',
      type: 'multiple_choice',
      title: 'Formatos aceitos?',
      validations: { required: true },
      properties: { choices: [{ label: 'Remoto' }, { label: 'Híbrido' }], allow_multiple_selection: true },
    },
    { id: 'c', ref: 'r3', type: 'short_text', title: 'Se sim, quem?', validations: { required: false } },
    { id: 'd', ref: 'r4', type: 'yes_no', title: 'Já foi servidor público?', validations: { required: true } },
    { id: 'e', ref: 'r5', type: 'statement', title: 'Obrigado!' },
    { id: 'f', ref: 'r6', type: 'long_text', title: 'Conte mais', validations: { required: true } },
  ],
  logic: [{ type: 'field', ref: 'r1', actions: [{ details: { to: { value: 'r6' } } }] }],
});
assert.deepEqual(
  tf.map(p => `${p.tipo}${p.obrigatoria ? '*' : ''}${p.condicional ? '?' : ''}`),
  ['opcoes*', 'multipla*', 'texto', 'opcoes*', 'texto*?'],
  JSON.stringify(tf),
);
assert.deepEqual(tf[3].opcoes, ['Sim', 'Não']);
const div = perguntasDaDiversidade({
  diversity: {
    questions: [
      {
        id: 'genderIdentity',
        active: true,
        required: false,
        answerType: 'singleChoice',
        question: 'Qual é a sua identidade de gênero?',
        answerOptions: [{ title: 'Homem Cisgênero' }, { title: 'Prefiro não responder' }],
      },
      {
        id: 'diversityGroup',
        active: true,
        required: true,
        answerType: 'multipleChoice',
        question: 'Você pertence a um dos grupos abaixo?',
        answerOptions: [{ title: 'Mulher' }, { title: 'Prefiro não responder' }],
      },
      { id: 'peopleWithDisabilityAID', active: true, required: true, answerType: 'longText', question: 'Precisa de adaptação?' },
      { id: 'antiga', active: false, required: true, answerType: 'shortText', question: 'Inativa' },
    ],
  },
});
assert.deepEqual(
  div.map(p => p.id),
  ['genderIdentity', 'diversityGroup', 'peopleWithDisabilityAID'],
);
assert.deepEqual(
  perguntasCertas({ campos: [], obrigatorios: [], contratos: [], typeformId: null, perguntas: [...div, ...tf], fluxoCondicional: false }).map(p => p.id),
  ['diversityGroup', 'a', 'b', 'd'],
  'só obrigatórias e não condicionais',
);
const { SEQUENCIAL } = await import('./platforms/inhire/selectors.ts');
assert.ok(SEQUENCIAL.frameInHire.test('https://form-app.inhire.app/form?jobId=x&formId=y&type=subscription&flow=returnMessageToParent'));
assert.ok(SEQUENCIAL.frameTypeform.test('https://form.typeform.com/to/IjnhiKRd?typeform-embed=embed-widget'));
assert.ok(
  SEQUENCIAL.boasVindas.test('Responda as perguntas para finalizar sua inscrição:') &&
    SEQUENCIAL.iniciar.test('Iniciar') &&
    SEQUENCIAL.final.test('Enviar respostas') &&
    !SEQUENCIAL.final.test('Avançar'),
);
assert.equal(melhorOpcao(['Rio de Contas - BA', 'Rio de Janeiro - RJ'], 'Rio de Janeiro - RJ'), 1);
assert.equal(melhorOpcao(['Homem CisgêneroNasceu homem...', 'Prefiro não responder'], 'Prefiro não responder'), 1);
assert.equal(melhorOpcao(['Sim', 'Não'], 'nao'), 1);
assert.equal(melhorOpcao(['CLT', 'PJ'], 'Estágio'), -1);
assert.equal(papelDe({ nome: 'districtBr', rotulo: 'Cidade', tipo: 'dropdown' }), 'cidade');
assert.equal(papelDe({ nome: 'questionsDiversity.genderIdentity', rotulo: 'Qual é a sua identidade de gênero?', tipo: 'dropdown' }), null);
assert.equal(papelDe({ nome: '', rotulo: 'Pretensão salarial como CLT', tipo: 'texto' }), 'pretensao');
assert.equal(papelDe({ nome: '', rotulo: 'CPF', tipo: 'texto' }), 'cpf');
const dadosBase = {
  nome: 'Ana',
  email: 'a@b.c',
  celular: '(21) 99876-5432',
  linkedin: '',
  cidade: '',
  cpf: '',
  pretensao: 'R$ 4.500',
  regime: 'PJ' as const,
  curriculoPdf: '',
  responder: (p: { rotulo: string }) => (/indicad/i.test(p.rotulo) ? null : /inglês/i.test(p.rotulo) ? 'Básico' : null),
  ensaio: true,
  mostrarNavegador: false,
};
const campo = (extra: object) => ({ i: 0, tipo: 'texto' as const, nome: '', rotulo: '', obrigatorio: true, opcoes: [] as string[], preenchido: false, html: '', ...extra });
assert.deepEqual(resolverCampo(campo({ nome: 'phone' }), dadosBase), { acao: 'valor', valor: '21998765432', mascarado: true });
assert.equal(resolverCampo(campo({ nome: 'districtBr', tipo: 'dropdown' }), dadosBase).acao, 'pergunta', 'sem cidade no perfil → pergunta');
assert.deepEqual(resolverCampo(campo({ nome: 'contractType', tipo: 'radio', opcoes: ['CLT', 'PJ'] }), dadosBase), { acao: 'valor', valor: 'PJ' });
assert.deepEqual(resolverCampo(campo({ nome: 'isIndication', tipo: 'radio', opcoes: ['Não', 'Sim'] }), dadosBase), { acao: 'valor', valor: 'Não' });
assert.deepEqual(resolverCampo(campo({ tipo: 'radio', rotulo: 'Nível de inglês?', opcoes: ['Básico', 'Fluente'] }), dadosBase), { acao: 'valor', valor: 'Básico' });
assert.equal(resolverCampo(campo({ tipo: 'grupo', rotulo: 'Grupos?', opcoes: ['Mulher'], obrigatorio: false }), dadosBase).acao, 'pular', 'opcional sem resposta → pula');
assert.equal(resolverCampo(campo({ tipo: 'grupo', rotulo: 'Grupos?', opcoes: ['Mulher'] }), dadosBase).acao, 'pergunta', 'obrigatória sem resposta → pausa');
assert.deepEqual(resolverCampo(campo({ nome: 'privacyPolicy', tipo: 'checkbox' }), dadosBase), { acao: 'marcar' });
const { mascaraCPF } = await import('../src/mascaras.ts');
assert.equal(mascaraCPF('52998224725'), '529.982.247-25');
console.log('✓ Motor de formulário: schema, opções e classificação');

// 7) Autodeclaração / dados sensíveis: detecção por palavra-chave e política (funções puras)
const { categoriaSensivel, decidirSensivel, PREFIRO_NAO } = await import('../src/sensiveis.ts');
assert.equal(categoriaSensivel('Qual é a sua identidade de gênero?')?.id, 'genero');
assert.equal(categoriaSensivel('Qual é a sua orientação sexual?')?.id, 'orientacao');
assert.equal(categoriaSensivel('Qual é a sua cor ou raça?')?.id, 'raca');
assert.equal(categoriaSensivel('Deseja se candidatar para a vaga como pessoa com deficiência?')?.id, 'pcd');
assert.equal(categoriaSensivel('Você pertence a um dos grupos abaixo?')?.id, 'grupos');
assert.equal(categoriaSensivel('Você se declara uma pessoa com deficiência?')?.id, 'pcd');
assert.equal(categoriaSensivel('Qual o seu nível de conversação em inglês?'), null);
assert.equal(categoriaSensivel('Possui CNH categoria B?'), null);
assert.equal(categoriaSensivel('Qual a cor do seu carro?'), null, '"cor" sozinho não é sensível');
assert.ok(PREFIRO_NAO.test('Prefiro não responder') && PREFIRO_NAO.test('Não desejo informar') && !PREFIRO_NAO.test('Não'));
const casarOp = (ops: string[]) => (r: string) => ops.find(o => o.toLowerCase() === r.toLowerCase()) ?? null;
const genero = { rotulo: 'Qual é a sua identidade de gênero?', opcoes: ['Homem Cisgênero', 'Mulher Cisgênero', 'Prefiro não responder'], obrigatoria: false };
const casar = casarOp(genero.opcoes);
// 1) nunca por similaridade: resposta guardada para pergunta parecida (outra vaga) não vale
assert.equal(decidirSensivel(genero, [{ pergunta: 'Qual a sua identidade de gênero? *', resposta: 'Mulher Cisgênero' }], { modo: 'perguntar', padroes: {} }, casar), null);
// 2) pergunta literal (mesmo texto, ignorando acento/caixa) vale
assert.equal(decidirSensivel(genero, [{ pergunta: 'qual e a sua identidade de genero?', resposta: 'Mulher Cisgênero' }], { modo: 'perguntar', padroes: {} }, casar), 'Mulher Cisgênero');
// 3) prefiro_nao só quando opcional e a opção existe
assert.equal(decidirSensivel(genero, [], { modo: 'prefiro_nao', padroes: {} }, casar), 'Prefiro não responder');
assert.equal(decidirSensivel({ ...genero, obrigatoria: true }, [], { modo: 'prefiro_nao', padroes: {} }, casar), null, 'obrigatória → pausa');
assert.equal(decidirSensivel({ ...genero, opcoes: ['Homem', 'Mulher'] }, [], { modo: 'prefiro_nao', padroes: {} }, casar), null, 'sem a opção → pausa');
// 4) padrão por categoria, só se bater com uma opção
assert.equal(decidirSensivel({ ...genero, obrigatoria: true }, [], { modo: 'padrao', padroes: { genero: 'Homem Cisgênero' } }, casar), 'Homem Cisgênero');
assert.equal(decidirSensivel({ ...genero, obrigatoria: true }, [], { modo: 'padrao', padroes: { genero: 'Agênero' } }, casar), null, 'padrão que não existe na vaga → pausa');
assert.equal(decidirSensivel({ rotulo: 'Nível de inglês', opcoes: ['Básico'] }, [], { modo: 'padrao', padroes: {} }, casar), null, 'pergunta comum não passa por aqui');

/**
 * 5) Sem Piedade (`aceitarPreferirNao`): marca "prefiro não declarar" quando a vaga oferece, inclusive em
 * pergunta obrigatória — e NUNCA inventa uma característica dele.
 *
 * O que está sendo fixado aqui é o limite: a única coisa que o Sem Piedade pode responder em autodeclaração é
 * a RECUSA a declarar, que é verdadeira para qualquer pessoa. Sem opção de recusa, pausa.
 */
const semPiedade = { aceitarPreferirNao: true };
assert.equal(decidirSensivel({ ...genero, obrigatoria: true }, [], { modo: 'perguntar', padroes: {} }, casar, semPiedade), 'Prefiro não responder', 'obrigatória COM a opção de recusa: marca e segue');
assert.equal(decidirSensivel(genero, [], { modo: 'perguntar', padroes: {} }, casar, semPiedade), 'Prefiro não responder', 'opcional também');
assert.equal(
  decidirSensivel(
    { ...genero, opcoes: ['Homem Cisgênero', 'Mulher Cisgênero'], obrigatoria: true },
    [],
    { modo: 'perguntar', padroes: {} },
    casarOp(['Homem Cisgênero', 'Mulher Cisgênero']),
    semPiedade,
  ),
  null,
  'sem opção de recusa não há resposta segura: nem o Sem Piedade declara gênero por ele',
);
assert.equal(
  decidirSensivel({ rotulo: 'Qual é a sua cor ou raça?' }, [], { modo: 'perguntar', padroes: {} }, (r: string) => r, semPiedade),
  null,
  'texto livre sensível: escrever a recusa seria o robô redigindo em nome dele num campo de autodeclaração',
);
// A precedência não muda: a resposta DELE ganha da recusa
assert.equal(
  decidirSensivel({ ...genero, obrigatoria: true }, [{ pergunta: 'qual e a sua identidade de genero?', resposta: 'Mulher Cisgênero' }], { modo: 'perguntar', padroes: {} }, casar, semPiedade),
  'Mulher Cisgênero',
  'o que ele já respondeu ganha de tudo, em qualquer modo',
);
// E sem o flag (modos `manual` e `duvida`) nada disso vale
assert.equal(decidirSensivel({ ...genero, obrigatoria: true }, [], { modo: 'perguntar', padroes: {} }, casar), null, 'a regra é só do Sem Piedade');
// Nenhuma combinação pode devolver uma opção que não é a recusa, sem resposta salva nem padrão
for (const obrigatoria of [true, false])
  for (const flag of [{}, semPiedade]) {
    const r = decidirSensivel({ ...genero, obrigatoria }, [], { modo: 'perguntar', padroes: {} }, casar, flag);
    assert.ok(r === null || PREFIRO_NAO.test(r), `sem resposta sua, a única saída possível é a recusa (veio "${r}")`);
  }
console.log('✓ Autodeclaração: detecção por palavra-chave, política sem similaridade, e o Sem Piedade só podendo recusar a declarar');

// 5b) Descoberta: subdomínio a partir de qualquer forma de entrada, URL com página de carreira, seed bem formado
const { extrairSubdominio } = await import('./platforms/inhire/discovery.ts');
const { urlVaga } = await import('./platforms/inhire/api.ts');
assert.equal(extrairSubdominio('db1'), 'db1');
assert.equal(extrairSubdominio('https://DB1.inhire.app/vagas'), 'db1');
assert.equal(extrairSubdominio('https://eurosolucoes.inhire.app/fitcard-tech/vagas/abc/analista'), 'eurosolucoes');
assert.equal(extrairSubdominio('https://www.inhire.com.br/x'), '');
assert.equal(urlVaga('acme', 'id1', 'Dev Júnior | SP', 'default'), 'https://acme.inhire.app/vagas/id1/dev-junior-or-sp');
assert.equal(urlVaga('euro', 'id1', 'Analista', 'fitcard-tech'), 'https://euro.inhire.app/fitcard-tech/vagas/id1/analista');
const seed = JSON.parse((await import('node:fs')).readFileSync(new URL('./platforms/inhire/seed_empresas_inhire.json', import.meta.url), 'utf8')) as {
  empresas: { subdominio: string; nome: string }[];
};
assert.ok(seed.empresas.length >= 10 && seed.empresas.every(e => /^[a-z0-9-]+$/.test(e.subdominio) && e.nome), 'seed inválido');
assert.equal(new Set(seed.empresas.map(e => e.subdominio)).size, seed.empresas.length, 'seed com subdomínio repetido');
console.log(`✓ Descoberta: subdomínios, URLs e seed (${seed.empresas.length} empresas)`);

// 5c) Envio: prova de rede, texto de confirmação e política de nova tentativa
const { SUCESSO, ROTAS_ENVIO } = await import('./platforms/inhire/selectors.ts');
for (const t of [
  'Candidatura enviada com sucesso!',
  'Inscrição realizada com sucesso',
  'Recebemos o seu currículo',
  'Obrigada por se candidatar',
  'Sua candidatura foi registrada',
  'Em breve entraremos em contato',
])
  assert.ok(SUCESSO.test(t), `confirmação não reconhecida: "${t}"`);
for (const t of ['Preencha os campos obrigatórios', 'Continuar inscrição', 'Ocorreu um erro']) assert.ok(!SUCESSO.test(t), `texto comum lido como confirmação: "${t}"`);
const definitiva = (url: string) => ROTAS_ENVIO.some(r => r.definitiva && r.re.test(url));
assert.ok(definitiva('https://api.inhire.app/job-talents/public/abc123/talents'), 'POST do talento é prova de envio');
assert.ok(definitiva('https://api.inhire.app/forms/form/submit'), 'submit do questionário é prova de envio');
assert.ok(!definitiva('https://api.inhire.app/job-posts/public/pages/abc123'), 'leitura da vaga não é envio');
assert.ok(!definitiva('https://api.typeform.com/responses'), 'resposta avulsa do Typeform não confirma a candidatura');

// Texto do botão de envio: varia por empresa (levantado nas páginas reais em 20/09/2026)
const { BOTAO_FINAL, BOTAO_PROXIMO } = await import('./platforms/inhire/selectors.ts');
for (const t of ['Continuar inscrição', 'Candidatar-se para a vaga', 'Candidatar-me', 'Enviar candidatura', 'Finalizar inscrição', 'Enviar'])
  assert.ok(BOTAO_FINAL.test(t), `botão de envio não reconhecido: "${t}"`);
// "Candidatar" sozinho é o botão do topo que só rola a página até o formulário: clicar nele trava o robô
for (const t of ['Candidatar', 'Vagas', 'Sobre a empresa', 'Anexar currículo', 'Voltar', 'Recursos Assistivos']) assert.ok(!BOTAO_FINAL.test(t), `"${t}" não pode ser confundido com o botão de envio`);
assert.ok(BOTAO_PROXIMO.test('Avançar') && BOTAO_PROXIMO.test('Continuar') && !BOTAO_PROXIMO.test('Continuar inscrição'));

// Senioridade DO CANDIDATO: o curriculo cita os cargos antigos, entao vale o nivel mais ALTO
const { inferirSenioridadeDoCurriculo, anosDeCarreira, familiaDoCargo } = await import('./resume/analyzer.ts');
assert.equal(anosDeCarreira('sou desenvolvedor full stack ha mais de 3 anos'), 3, '"ha mais de N anos" tem de contar');
assert.equal(anosDeCarreira('7+ anos de experiencia em backend'), 7);
assert.equal(anosDeCarreira('cursei 4 anos de faculdade'), 0, 'tempo de faculdade nao e carreira');
assert.equal(inferirSenioridadeDoCurriculo('Estagiario lider; desenvolvedor full stack ha mais de 3 anos'), 'Pleno', 'estagio antigo nao pode rebaixar quem tem 3 anos');
assert.equal(inferirSenioridadeDoCurriculo('Estagiario de TI, cursando Sistemas de Informacao'), 'Estágio', 'sem outro sinal, estagio vale');
assert.equal(inferirSenioridadeDoCurriculo('Desenvolvedor Senior, 8 anos de mercado'), 'Sênior');
assert.equal(inferirSenioridadeDoCurriculo('Desenvolvedor Junior com 1 ano de experiencia'), 'Júnior');
console.log('✓ Senioridade do curriculo: vale o nivel mais alto, nao o mais baixo');

// Familia de cargo: separa profissao, coisa que similaridade de texto nao faz
assert.equal(familiaDoCargo('Analista de Processos'), 'Processos e Negócio');
assert.equal(familiaDoCargo('Engenheiro de Software'), 'Desenvolvimento');
assert.equal(familiaDoCargo('Desenvolvedor Full Stack'), 'Desenvolvimento');
assert.equal(familiaDoCargo('Analista de Risco de Liquidez de Fundos de Investimento'), 'Financeiro e Contábil');
assert.equal(familiaDoCargo('Advogado Contencioso Civel'), 'Jurídico');
assert.equal(familiaDoCargo('Analista de Dados'), 'Dados e Analytics');
assert.ok(similaridade('Desenvolvedor Full Stack Ha Mais De 3 Anos', 'Analista de Processos') > 0.35, 'o texto ENGANA: por isso existe a familia');

// Score: vaga de outra funcao nao pode competir com vaga da sua
const meuPerfil = {
  area: 'Tecnologia da Informação',
  senioridade: 'Pleno',
  cargos: ['Desenvolvedor Full Stack'],
  skills: ['javascript', 'typescript', 'react', 'node.js', 'sql', 'docker', 'rest', 'testes', 'git'],
};
const vagaProcessos = { titulo: 'Analista de Processos', skills: ['sql', 'rest', 'testes'], descricao: 'mapeamento e automacao de processos, BPM e RPA', modelo: 'remoto' as const, local: 'BR' };
const vagaMinha = {
  titulo: 'Desenvolvedor Full Stack Pleno',
  skills: ['javascript', 'typescript', 'react', 'node.js', 'sql', 'docker'],
  descricao: 'aplicacoes web',
  modelo: 'remoto' as const,
  local: 'BR',
};
const sProcessos = calcularScore(vagaProcessos, meuPerfil, {});
const sMinha = calcularScore(vagaMinha, meuPerfil, {});
assert.ok(sMinha.score >= 80, `vaga da sua funcao deveria pontuar alto, deu ${sMinha.score}`);
assert.ok(sProcessos.score < 45, `vaga de outra funcao nao pode passar de 45, deu ${sProcessos.score} (${sProcessos.motivo})`);
assert.ok(sMinha.score - sProcessos.score > 35, 'a distancia entre as duas precisa ser clara');
assert.match(sProcessos.motivo, /outra função/);
// Rigido derruba ainda mais
assert.ok(calcularScore(vagaProcessos, meuPerfil, { cargoRigido: true }).score < sProcessos.score, 'filtro rigido tem de cortar mais');
// Vaga vaga (poucas competencias genericas) nao chega a 100% so por isso
assert.ok(calcularScore({ titulo: 'Analista Administrativo', skills: ['sql'], descricao: 'rotinas administrativas', modelo: 'remoto' as const, local: 'BR' }, meuPerfil, {}).score < 40);
console.log('✓ Score: funcao diferente cai, vaga generica nao infla, filtro rigido corta mais');

// Intervalo em segundos: o rotulo tem de ficar legivel nas quatro faixas usadas na tela
const { textoIntervalo } = await import('../src/dados.ts');
assert.equal(textoIntervalo(10), '10 s');
assert.equal(textoIntervalo(30), '30 s');
assert.equal(textoIntervalo(60), '1 min');
assert.equal(textoIntervalo(180), '3 min');
assert.equal(textoIntervalo(90), '1 min 30 s');
assert.equal(textoIntervalo(480), '8 min', 'valor migrado de minutos precisa de rótulo (era o que faltava no select)');
console.log('✓ Intervalo entre candidaturas legivel em segundos e minutos');

// Sem Piedade: a resposta da IA casa com a opcao da vaga por similaridade, nao por igualdade exata
const { casarComOpcao } = await import('./ia.ts');
const escalaVaga = ['Nunca utilizei', 'Básico — já estudei', 'Intermediário — uso com apoio', 'Avançado — uso no dia a dia'];
assert.equal(casarComOpcao(escalaVaga, 'Avançado'), 'Avançado — uso no dia a dia', 'exigir igualdade exata jogava fora resposta boa e parava a vaga à toa');
assert.equal(casarComOpcao(escalaVaga, 'avançado - uso no dia a dia'), 'Avançado — uso no dia a dia');
assert.equal(casarComOpcao(escalaVaga, 'Intermediário'), 'Intermediário — uso com apoio');
assert.equal(casarComOpcao(escalaVaga, 'Nunca utilizei'), 'Nunca utilizei');
assert.equal(casarComOpcao(escalaVaga, 'Especialista'), null, 'resposta que não corresponde a nenhuma opção continua sendo recusada');
assert.equal(casarComOpcao(['Sim', 'Não'], 'Sim'), 'Sim');
console.log('✓ Sem Piedade: resposta da IA casa com a opcao da vaga por similaridade');

// Modo Sem Piedade: o que a IA devolve so passa se for curto, humano e (em lista) uma opcao real
const { CHEIRO_DE_IA, limparResposta } = await import('./ia.ts');
assert.equal(limparResposta('  "Tenho 3 anos de experiencia."  '), 'Tenho 3 anos de experiencia.');
assert.equal(limparResposta('Resposta: Sim'), 'Sim');
assert.equal(limparResposta('**Nao**'), 'Nao');
for (const ruim of [
  'Como profissional da area, posso afirmar que sim',
  'Vale ressaltar que tenho experiencia com React',
  'Trabalho com isso — e gosto muito',
  '- React e Node',
  'Alem disso, atuo com Docker',
  'Em resumo, sim',
  'Sou apaixonado por tecnologia',
  'Nao tenho acesso a essa informacao',
  'Com base no meu curriculo, sim',
  'Nao possuo informacoes suficientes para responder',
  'Nao informado no curriculo',
  'Nao consta',
  'Nao e possivel determinar com os dados disponiveis',
])
  assert.ok(CHEIRO_DE_IA.test(ruim), `deveria ser recusado por cheiro de IA: "${ruim}"`);
for (const bom of [
  'Sim',
  'Nao',
  '3 anos',
  'Tenho 3 anos com React e Node',
  'Disponibilidade imediata',
  'Ingles intermediario',
  'Ja trabalhei com Docker em producao',
  // Stack que o CV nao mostra: o tom pedido e "ainda estou aprendendo", nunca um nao seco nem experiencia inventada
  'Ainda nao usei em projeto, estou estudando.',
  'Ainda estou aprendendo, sem experiencia profissional ainda.',
])
  assert.ok(!CHEIRO_DE_IA.test(bom), `resposta humana e curta nao pode ser recusada: "${bom}"`);
console.log('✓ Sem Piedade: filtro de resposta rejeita texto com cara de IA e aceita resposta curta');

// Opcoes prontas de autodeclaracao: tem de casar com o que as vagas realmente escrevem
const { CATEGORIAS_SENSIVEIS: CATS, PREFIRO_NAO_RESPONDER } = await import('../src/sensiveis.ts');
for (const c of CATS) {
  assert.ok(c.opcoesComuns.length >= 2, `${c.id} precisa de opcoes prontas`);
  assert.ok(c.opcoesComuns.includes(PREFIRO_NAO_RESPONDER), `${c.id} deve oferecer "${PREFIRO_NAO_RESPONDER}"`);
  assert.ok(new Set(c.opcoesComuns).size === c.opcoesComuns.length, `${c.id} tem opcao repetida`);
}
// A escolha guardada precisa achar a opcao da vaga mesmo escrita diferente (o casamento e por similaridade)
const casarPorSimilaridade = (opcoes: string[]) => (r: string) => opcoes.find(o => similaridade(o, r) >= 0.7) ?? null;
const catGenero = CATS.find(c => c.id === 'genero')!;
assert.ok(catGenero.opcoesComuns.includes('Homem Cisgênero') && catGenero.opcoesComuns.includes('Mulher Cisgênero'));
const daVaga = ['Homem cisgênero', 'Mulher cisgênero', 'Homem transgênero', 'Mulher transgênero', 'Prefiro não responder'];
assert.equal(
  decidirSensivel({ rotulo: 'Qual é a sua identidade de gênero?', opcoes: daVaga, obrigatoria: true }, [], { modo: 'padrao', padroes: { genero: 'Homem Cisgênero' } }, casarPorSimilaridade(daVaga)),
  'Homem cisgênero',
  'a opcao pronta tem de casar com a grafia da vaga',
);
// PcD e saude usam Sim/Nao, que as vagas escrevem assim mesmo
assert.equal(
  decidirSensivel({ rotulo: 'Você é uma pessoa com deficiência?', opcoes: ['Sim', 'Não'], obrigatoria: true }, [], { modo: 'padrao', padroes: { pcd: 'Não' } }, casarPorSimilaridade(['Sim', 'Não'])),
  'Não',
);
// Sem padrao definido continua pausando
assert.equal(decidirSensivel({ rotulo: 'Qual é a sua identidade de gênero?', opcoes: daVaga, obrigatoria: true }, [], { modo: 'padrao', padroes: {} }, casarPorSimilaridade(daVaga)), null);
console.log('✓ Autodeclaracao: opcoes prontas casam com a grafia real das vagas');

// Pergunta sobre a propria empresa: nao pode nascer marcada para reaproveitar em outra vaga
const { perguntaSoDestaVaga } = await import('../src/dados.ts');
for (const [r, emp] of [
  ['Quais sao as suas impressoes sobre as nossas producoes?', 'Brasil Paralelo'],
  ['Voce ja conhece a Brasil Paralelo?', 'Brasil Paralelo'],
  ['Por que voce quer trabalhar conosco?', 'Acme'],
  ['O que voce sabe sobre a empresa?', 'Acme'],
  ['Por que se interessou por esta vaga?', 'Acme'],
  ['Como conheceu a QI Tech?', 'QI Tech'],
] as [string, string][])
  assert.ok(perguntaSoDestaVaga(r, emp), `deveria ser so desta vaga: "${r}"`);
for (const [r, emp] of [
  ['Qual o seu nivel de ingles?', 'Acme'],
  ['Anos de experiencia com React', 'Acme'],
  ['Possui CNH categoria B?', 'Acme'],
  ['Qual a sua pretensao salarial?', 'Acme'],
  ['Disponibilidade de inicio', 'Acme'],
  ['Conhece a metodologia Scrum?', 'Acme'],
] as [string, string][])
  assert.ok(!perguntaSoDestaVaga(r, emp), `deveria poder ser reaproveitada: "${r}"`);
console.log('✓ Pergunta sobre a propria empresa nao nasce marcada para reaproveitar');

// Afinidade: quem programa reconhece IA, QA, dados e seguranca como o mesmo mundo
const { familiasAfins } = await import('./resume/analyzer.ts');
assert.equal(familiaDoCargo('Engenheiro de IA'), 'IA e Machine Learning');
assert.equal(familiaDoCargo('QA Automation Engineer'), 'Qualidade e Testes');
for (const outra of ['IA e Machine Learning', 'Qualidade e Testes', 'Dados e Analytics', 'Segurança da Informação'])
  assert.ok(familiasAfins('Desenvolvimento', outra), `${outra} deveria ser afim de Desenvolvimento`);
for (const longe of ['Financeiro e Contábil', 'Jurídico', 'Processos e Negócio', 'Comercial e Vendas']) assert.ok(!familiasAfins('Desenvolvimento', longe), `${longe} NAO e do mundo de quem programa`);

// Com rigor RIGIDO, vaga de IA/QA/senior continua alta; outra profissao e cortada
const fRigido = { cargoRigido: true, localizacao: { localizacaoPresencial: 'Fortaleza - CE', paisesRemoto: ['Brasil'] } };
const vagaRemota = (titulo: string, skills: string[], descricao = '') => ({ titulo, skills, descricao, modelo: 'remoto' as const, local: 'BR' });
const meuCv = {
  area: 'Tecnologia da Informação',
  senioridade: 'Pleno',
  cargos: ['Desenvolvedor Full Stack'],
  skills: ['javascript', 'typescript', 'react', 'node.js', 'sql', 'docker', 'python', 'git', 'rest'],
};
const meuStack = ['javascript', 'typescript', 'react', 'node.js', 'python', 'sql'];
for (const t of ['Engenheiro de IA', 'QA Automation Engineer', 'Desenvolvedor Full Stack Senior', 'Cientista de Dados'])
  assert.ok(
    calcularScore(vagaRemota(t, meuStack), meuCv, fRigido).score >= 60,
    `"${t}" deveria continuar relevante no rigor rigido (deu ${calcularScore(vagaRemota(t, meuStack), meuCv, fRigido).score})`,
  );
assert.ok(calcularScore(vagaRemota('Analista de Processos', ['sql', 'rest']), meuCv, fRigido).score < 30, 'outra profissao cai no rigor rigido');
assert.ok(calcularScore(vagaRemota('Advogado Contencioso', ['excel']), meuCv, fRigido).score < 20);
console.log('✓ Rigor rigido mantem dev/IA/QA/dados/seguranca e corta outras profissoes');

// Fora da cidade: so remotas. Presencial/hibrido em outra cidade nem pontua.
const vagaEm = (modelo: 'presencial' | 'hibrido' | 'remoto', local: string) => ({ titulo: 'Desenvolvedor Full Stack Pleno', skills: meuStack, descricao: '', modelo, local });
assert.equal(calcularScore(vagaEm('presencial', 'São Paulo, SP, BR'), meuCv, fRigido).score, 0, 'presencial em outra cidade tem de ser cortada');
assert.equal(calcularScore(vagaEm('hibrido', 'Belo Horizonte, MG, BR'), meuCv, fRigido).score, 0, 'hibrido em outra cidade tambem');
assert.ok(calcularScore(vagaEm('presencial', 'Fortaleza, CE, BR'), meuCv, fRigido).score >= 60, 'presencial NA sua cidade continua valendo');
assert.ok(calcularScore(vagaEm('hibrido', 'Fortaleza, CE, BR'), meuCv, fRigido).score >= 60, 'hibrido na sua cidade continua valendo');
assert.ok(calcularScore(vagaEm('remoto', 'BR'), meuCv, fRigido).score >= 60, 'remota sempre vale');
assert.ok(calcularScore(vagaEm('hibrido', 'BR'), meuCv, fRigido).score >= 60, 'local ilegivel nao pode sumir com a vaga');
assert.match(calcularScore(vagaEm('presencial', 'São Paulo, SP, BR'), meuCv, fRigido).motivo, /fora do seu estado/);
// Sem preferencia de localizacao, nao penaliza
assert.ok(calcularScore(vagaEm('presencial', 'São Paulo, SP, BR'), meuCv, { cargoRigido: true }).score > 0);
console.log('✓ Fora da sua cidade so passam remotas (presencial/hibrido local continuam valendo)');

// CPF: preenche sozinho em qualquer redacao de campo de digitar, mas nunca de terceiro nem em pergunta sim/nao
const texto = (rotulo: string, tipo = 'texto' as const) => ({ nome: '', rotulo, tipo });
for (const r of ['CPF', 'Coloque aqui o seu CPF', 'Qual o seu CPF?', 'CPF (somente numeros)', 'Informe seu CPF para cadastro'])
  assert.equal(papelDe(texto(r)), 'cpf', `deveria reconhecer CPF em "${r}"`);
for (const r of ['CPF do responsavel legal', 'CPF da empresa', 'CPF do conjuge', 'CPF do socio administrador'])
  assert.equal(papelDe(texto(r)), null, `CPF de terceiro nao pode ser preenchido: "${r}"`);
assert.equal(papelDe({ nome: '', rotulo: 'Voce possui CPF?', tipo: 'radio' }), null, 'pergunta sim/nao nao recebe o numero');
assert.equal(papelDe(texto('Qual o seu CNPJ?')), null, 'CNPJ nao e CPF');
assert.deepEqual(resolverCampo(campo({ rotulo: 'Coloque aqui o seu CPF', tipo: 'texto' }), { ...dadosBase, cpf: '529.982.247-25' }), { acao: 'valor', valor: '52998224725', mascarado: true });
assert.equal(resolverCampo(campo({ rotulo: 'Coloque aqui o seu CPF', tipo: 'texto' }), dadosBase).acao, 'pergunta', 'sem CPF no perfil, pergunta');
console.log('✓ CPF: preenchido sozinho em qualquer redacao; de terceiro ou sim/nao vira pergunta');

// Disponibilidade presencial: nunca afirmar "Sim" por conta propria quando a vaga e em outra cidade
const { disponibilidadeNoModelo } = await import('./platforms/inhire/formulario.ts');
const campoModelo = (rotulo: string) => ({ i: 0, tipo: 'radio' as const, nome: 'workModel', rotulo, obrigatorio: true, opcoes: ['Sim', 'Nao'], preenchido: false, html: '' });
const emFortaleza = { ...dadosBase, cidade: 'Fortaleza - CE' };
const perguntaSP = 'Voce tem disponibilidade para trabalhar no modelo presencial em Sao Paulo, Sao Paulo, Brasil, Pinheiros - SP?';
assert.equal(disponibilidadeNoModelo(campoModelo(perguntaSP), emFortaleza).acao, 'pergunta', 'presencial em outra cidade tem de perguntar');
assert.deepEqual(disponibilidadeNoModelo(campoModelo('Voce tem disponibilidade para o modelo presencial em Fortaleza - CE?'), emFortaleza), { acao: 'valor', valor: 'Sim' });
assert.deepEqual(disponibilidadeNoModelo(campoModelo('Voce aceita trabalhar no modelo remoto?'), emFortaleza), { acao: 'valor', valor: 'Sim' }, 'remoto nao precisa perguntar');
assert.equal(disponibilidadeNoModelo(campoModelo(perguntaSP), { ...dadosBase, cidade: '' }).acao, 'pergunta', 'sem a cidade do usuario, perguntar');
assert.equal(disponibilidadeNoModelo(campoModelo('Tem disponibilidade para o modelo hibrido?'), emFortaleza).acao, 'pergunta', 'hibrido sem cidade legivel: perguntar');
console.log('✓ Disponibilidade presencial: so afirma "Sim" quando a vaga e remota ou na regiao do usuario');

const { falhaRepetivel, esperaDaTentativa, MAX_TENTATIVAS: MAXT } = await import('./falhas.ts');
for (const m of [
  'Timeout 12000ms exceeded',
  'net::ERR_CONNECTION_RESET',
  'o questionário do InHire (form-app) não carregou: ficou em branco por 20 s',
  'sem confirmação do InHire após o envio',
  'Target page, context or browser has been closed',
  'tela do questionário sem nada reconhecível (estrutura não reconhecida)',
])
  assert.ok(falhaRepetivel(m), `deveria tentar de novo: "${m}"`);
for (const m of [
  'o InHire pediu verificação (captcha); envie esta vaga manualmente',
  'formulário de candidatura não apareceu (vaga encerrada ou layout mudou)',
  'perfil ou currículo principal ausente',
  'o InHire recusou o envio (HTTP 400)',
  'parei para não candidatar duas vezes',
  'não sei preencher "X" (tipo desconhecido)',
])
  assert.ok(!falhaRepetivel(m), `não deveria repetir: "${m}"`);
assert.deepEqual([1, 2, 3, 9].map(esperaDaTentativa), [2, 10, 30, 30]);
assert.equal(MAXT, 3);
console.log('✓ Envio: prova de rede, confirmação e política de nova tentativa');

// 6) Perguntas parecidas
assert.ok(similaridade('Possui CNH?', 'Você possui CNH categoria B?') > 0.55);
assert.ok(similaridade('Nível de inglês', 'Qual seu nível de inglês?') > 0.55);
assert.ok(similaridade('Possui CNH?', 'Pretensão salarial') < 0.4);
console.log('✓ Similaridade de perguntas');

// 7) Vagas PJ: feed, JSON-LD da página e as convenções do formulário (levantados em 21/09/2026 no site real)
const { lerFeed, lerSitemapPJ, lerJobPosting, localDe, modeloDe: modeloPJ, montarVaga } = await import('./platforms/vagaspj/busca.ts');
const { motivoDoErro } = await import('./platforms/vagaspj/index.ts');
const { VAGASPJ } = await import('./platforms/vagaspj/seletores.ts');

const FEED = `<?xml version="1.0"?><rss><channel><title>Vagas PJ</title>
<item><title>Desenvolvedor Full Stack Pleno - PJ | Híbrido em Fortaleza/CE – Tecla T</title>
<link>https://www.vagaspj.com.br/vagas/teclat/404042009/desenvolvedor-full-stack-pleno-pj</link>
<pubDate>Mon, 21 Sep 2026 11:28:15 -0300</pubDate><description><![CDATA[Sobre o cliente...]]></description></item>
<item><title>Videomaker / Criador(a) de Conteúdo – Instituto Gozzano</title>
<link>https://www.vagaspj.com.br/vagas/gozzano/404042004/videomaker</link></item>
<item><title>Página que não é vaga</title><link>https://www.vagaspj.com.br/empresas/teclat</link></item>
</channel></rss>`;
const itens = lerFeed(FEED);
assert.equal(itens.length, 2, 'só entram links de /vagas/<empresa>/<id>/');
assert.deepEqual({ id: itens[0].id, empresaSlug: itens[0].empresaSlug }, { id: '404042009', empresaSlug: 'teclat' });
assert.ok(itens[1].titulo.includes('Videomaker / Criador(a)'), `a barra escapada do feed volta ao normal: ${itens[1].titulo}`);

const paginaPJ = (jp: object, extra = '') =>
  `<html><body>${extra}<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'BreadcrumbList' }, { '@type': 'JobPosting', ...jp }] })}</script></body></html>`;
const ENDERECO_FOR = { address: { '@type': 'PostalAddress', addressLocality: 'Fortaleza', addressRegion: 'CE', addressCountry: 'BR' } };
assert.equal(lerJobPosting('<html><body>sem dados</body></html>'), null);
assert.equal(lerJobPosting(paginaPJ({ title: 'X' }))?.title, 'X', 'o JobPosting vem de dentro do @graph');
assert.equal(localDe({ jobLocation: ENDERECO_FOR }), 'Fortaleza - CE');
assert.equal(localDe({}), '');
assert.equal(modeloPJ({ jobLocationType: 'TELECOMMUTE' }, 'Dev', ''), 'remoto');
assert.equal(modeloPJ({ jobLocation: ENDERECO_FOR }, 'Dev Pleno - PJ | Híbrido em Fortaleza/CE', ''), 'hibrido', 'híbrido só aparece escrito, nunca no JSON-LD');
assert.equal(modeloPJ({ jobLocation: ENDERECO_FOR }, 'Dev', ''), 'presencial');
assert.equal(modeloPJ({}, 'Dev', ''), 'indefinido', 'sem endereço e sem marca não invento presencial');

const itemPJ = { id: '404042009', empresaSlug: 'teclat', url: 'https://www.vagaspj.com.br/vagas/teclat/404042009/dev', titulo: 'Dev – Tecla T' };
const cfgPJ = { area: '', senioridade: '', scoreMinimo: 30 } as unknown as Parameters<typeof montarVaga>[3];
const soRemotas = { localizacaoPresencial: 'Fortaleza - CE', paisesRemoto: ['Brasil'] };
const BASE_JP = { title: 'Desenvolvedor Back-end Júnior', description: '<p>Java, <b>Spring</b> Boot e SQL</p>', hiringOrganization: { name: 'Tecla T' } };
assert.equal(montarVaga(itemPJ, paginaPJ({ ...BASE_JP }, '<a data-externa="1">Candidatar no site</a>'), perfil, cfgPJ, soRemotas), null, 'candidatura em outro site não entra');
assert.equal(montarVaga(itemPJ, paginaPJ({ ...BASE_JP, validThrough: '2020-01-01T00:00:00-03:00' }), perfil, cfgPJ, soRemotas), null, 'vaga vencida não entra');
assert.equal(montarVaga(itemPJ, '<html>sem json-ld</html>', perfil, cfgPJ, soRemotas), null);
const remotaPJ = montarVaga(itemPJ, paginaPJ({ ...BASE_JP, jobLocationType: 'TELECOMMUTE' }), perfil, cfgPJ, soRemotas)!;
assert.equal(remotaPJ.id, 'vagaspj:404042009');
assert.equal(remotaPJ.regime, 'PJ', 'o site inteiro é PJ');
assert.equal(remotaPJ.empresa, 'Tecla T');
assert.equal(remotaPJ.modelo, 'remoto');
assert.ok(remotaPJ.skills.includes('java') && !remotaPJ.descricao.includes('<b>'), 'descrição vira texto e as skills saem dela');
assert.notEqual(remotaPJ.status, 'ignorada', 'remota compatível fica na lista');
const presencialSP = montarVaga(itemPJ, paginaPJ({ ...BASE_JP, jobLocation: { address: { addressLocality: 'São Paulo', addressRegion: 'SP', addressCountry: 'BR' } } }), perfil, cfgPJ, soRemotas)!;
assert.equal(presencialSP.status, 'ignorada', 'presencial fora do estado é cortada, como em qualquer plataforma');

// Botões: o texto exato importa — "Candidatar agora" só abre o formulário, "Candidatar" envia
/**
 * O sitemap do Vagas PJ, achado em 06/10/2026: 1.259 vagas contra as 50 do feed RSS, e com o título no slug —
 * o que permite a mesma peneira barata do Divulga Vagas antes de baixar qualquer página.
 */
const SITEMAP_PJ = [
  '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  '<url><loc>https://www.vagaspj.com.br/vagas/innolevels/404040559/desenvolvedor-front-end-vuejs</loc>',
  '  <lastmod>2024-09-19T14:40:11-03:00</lastmod></url>',
  '<url><loc>https://www.vagaspj.com.br/vagas/acme/404042009/pessoa-desenvolvedora-back-end</loc><lastmod>2026-10-01T09:00:00-03:00</lastmod></url>',
  '<url><loc>https://www.vagaspj.com.br/artigos/como-ser-pj</loc></url>',
  '</urlset>',
].join('\n');
const doSitemapPJ = lerSitemapPJ(SITEMAP_PJ);
assert.equal(doSitemapPJ.length, 2, 'artigo no meio do sitemap nao e vaga');
assert.deepEqual({ id: doSitemapPJ[0].id, empresaSlug: doSitemapPJ[0].empresaSlug, lastmod: doSitemapPJ[0].lastmod }, { id: '404040559', empresaSlug: 'innolevels', lastmod: '2024-09-19' });
assert.equal(doSitemapPJ[1].lastmod, '2026-10-01', 'o lastmod de cada item fica com o item certo, nao deslocado');
assert.ok(doSitemapPJ[0].titulo.includes('desenvolvedor'), 'o titulo sai do slug, para a peneira funcionar antes do download');
// E a peneira, que é o que torna 1.259 páginas viável: só o que casa com o perfil é baixado.
// Importada de `core/peneira.ts`, que é onde ela mora desde que dois adapters passaram a usá-la.
const { termosDoPerfil: termosPeneira, slugInteressa: peneiraSlug } = await import('./peneira.ts');
const termosPJ = termosPeneira(perfil, 'Desenvolvedor Full Stack');
assert.ok(peneiraSlug('desenvolvedor-back-end-nodejs', termosPJ));
assert.ok(!peneiraSlug('motorista-de-caminhao-truck', termosPJ), 'vaga fora da área é descartada sem baixar');

assert.ok(VAGASPJ.convencoes.final.test('Candidatar'));
assert.ok(!VAGASPJ.convencoes.final.test('Candidatar agora'), 'o botão que só revela o formulário não pode ser lido como envio');
assert.ok(VAGASPJ.convencoes.proximo.test('Continuar') && !VAGASPJ.convencoes.proximo.test('Voltar'));
assert.ok(!VAGASPJ.convencoes.proximo.test('Candidatar') && !VAGASPJ.convencoes.final.test('Continuar'));

// Texto real da tela de sucesso, tirado da captura de um envio de verdade (23/09/2026). Este envio foi
// gravado como ERRO porque o clique estourou 12 s enquanto o PDF subia; a tela é a testemunha de que deu certo.
assert.ok(VAGASPJ.convencoes.sucesso.test('TUDO CERTO Candidatura enviada A empresa já recebeu seu perfil.'), 'a tela de sucesso real tem de ser reconhecida');
assert.ok(!VAGASPJ.convencoes.sucesso.test('Candidatura rápida Seu Nome Seu e-mail Candidatar'), 'o formulário ainda por enviar não é sucesso');

// POST que saiu sem resposta: não pode voltar sozinho para a fila (seria um segundo envio na mesma vaga)
assert.equal(motivoDoErro('x', false, 'o Vagas PJ recusou o envio (HTTP 422)'), 'o Vagas PJ recusou o envio (HTTP 422)');
assert.equal(motivoDoErro('timeout', false, ''), 'timeout');
assert.ok(!falhaRepetivel(motivoDoErro('timeout', true, '')), 'envio sem resposta espera decisão do usuário');
assert.ok(falhaRepetivel(motivoDoErro('timeout', false, '')), 'sem envio nenhum, pode tentar de novo');
console.log('✓ Vagas PJ: feed, JSON-LD, corte por localização e travas de envio');

// ─── 7b) Lever: a API por empresa, o corpo que falta nela e a vaga aberta em vários lugares ──────
// Tudo aqui é desenhado sobre JSON e HTML capturados ao vivo em 06/10/2026 (CI&T, Neon, Swile, Zippi).
const { montarVaga: montarLever, modeloDe: modeloLever, regimeDe: regimeLever, corpoDaPagina, corpoFaltaNaApi, descricaoDe: descricaoLever, melhorLocal } = await import('./platforms/lever/busca.ts');
const { extrairSlug: slugLever } = await import('./platforms/lever/boards.ts');
const { ROTA_ENVIO: ROTA_LEVER, LEVER } = await import('./platforms/lever/seletores.ts');
const { paisDoIso } = await import('./localizacao.ts');
const { paisDoLocal: paisDoLocalTexto } = await import('./localizacao.ts');

assert.equal(modeloLever('remote'), 'remoto');
assert.equal(modeloLever('hybrid'), 'hibrido');
assert.equal(modeloLever('onsite'), 'presencial', 'o Lever escreve "onsite", sem underscore — não é o "on_site" do Workable');
assert.equal(modeloLever(undefined), 'indefinido');

/**
 * `commitment` é texto livre, e é por isso que o regime quase sempre sai indefinido.
 *
 * Os quatro valores abaixo são reais, do mesmo campo: regime, tipo de contrato, senioridade e modelo de
 * trabalho. Ler "Permanent Full Time Employee" como CLT seria adivinhar contrato, e `regimePreferido` tira
 * vaga da fila com base nisso.
 */
assert.equal(regimeLever('CLT'), 'CLT');
assert.equal(regimeLever('Permanent Full Time Employee'), 'indefinido', 'contrato em inglês não vira CLT por conta própria');
assert.equal(regimeLever('Mid-Senior Level'), 'indefinido', 'aqui a empresa escreveu senioridade no campo de regime');
assert.equal(regimeLever('Homeoffice'), 'indefinido', 'e aqui escreveu o modelo de trabalho (CI&T)');
assert.equal(regimeLever(undefined), 'indefinido');

/**
 * O país vem da sigla DECLARADA, e a colisão é real: "ES" é Espanha e também Espírito Santo.
 *
 * `paisDoLocal` lê sigla de duas letras como UF brasileira de propósito (este app é para quem mora no
 * Brasil), e por isso devolve "Brasil" para "ES". No Lever isso seria errado em 19 vagas medidas: uma remota
 * com `country: "ES"` é restrita à Espanha, e lida como brasileira passaria pelo filtro de países como se
 * fosse daqui. Campo declarado não se adivinha. Sigla fora de `PAISES` devolve vazio, que vale como "não sei
 * o país" — e remota sem país é compatível, o lado seguro de errar.
 */
assert.equal(paisDoIso('BR'), 'Brasil');
assert.equal(paisDoIso('ES'), 'Espanha', 'sigla declarada não passa pela heurística que lê UF brasileira');
assert.equal(paisDoLocalTexto('ES'), 'Brasil', 'e a heurística de texto continua certa no que ela faz: "ES" num local é Espírito Santo');
assert.equal(paisDoIso('zz'), '');

// O corpo do anúncio: `lists` é onde o Lever o guarda, e três dos seis boards medidos não o preenchem
assert.equal(corpoFaltaNaApi({ id: 'x', text: 'x', hostedUrl: 'x', lists: [{ text: 'Requisitos', content: '<li>Java</li>' }] }), false);
assert.equal(corpoFaltaNaApi({ id: 'x', text: 'x', hostedUrl: 'x', lists: [] }), true, 'CI&T, Swile e Zippi mandam lists vazio: o anúncio tem de vir da página');
assert.equal(corpoFaltaNaApi({ id: 'x', text: 'x', hostedUrl: 'x' }), true);

// HTML real da página da vaga, recortado. O marcador é `data-qa`, não a estrutura de div.
const PAGINA_LEVER = `<html><body><div class="posting-header"><h2>[ job - 32054] Mid-Level Fullstack Developer</h2></div>
<div class="section page-centered" data-qa="job-description"><div>Responsabilidades</div>
<ul><li>Desenvolver aplicações em <b>Java</b> 17 com Spring Framework.</li><li>Interfaces em Angular 21 e SASS.</li>
<li>APIs Restful e SQL Server.</li></ul></div>
<div class="section page-centered" data-qa="closing-description"><div>Nossos benefícios: plano de saúde</div></div>
<div data-qa="btn-apply-bottom">apply</div></body></html>`;
const corpoLever = corpoDaPagina(PAGINA_LEVER);
assert.ok(corpoLever.startsWith('Responsabilidades'), `o atributo não pode vazar para dentro do texto: ${corpoLever.slice(0, 40)}`);
assert.ok(corpoLever.includes('Angular') && corpoLever.includes('SQL Server'), 'o corpo inteiro entra');
assert.ok(!corpoLever.includes('<b>') && !corpoLever.includes('benefícios'), 'vira texto, e para no fim da descrição');
assert.equal(corpoDaPagina('<html>página sem o marcador</html>'), '');

// E a descrição não sai com o "Sobre nós" em dobro quando a API e a página dizem a mesma coisa
const aberturaLever = 'Na CI&T, ajudamos grandes empresas.';
const descLever = descricaoLever({ id: 'x', text: 'x', hostedUrl: 'x', openingPlain: aberturaLever, additionalPlain: 'Nossos benefícios' }, aberturaLever);
assert.equal(descLever.split('Na CI&T').length - 1, 1, `trecho repetido entre API e página entra uma vez só: ${descLever}`);

/**
 * A vaga aberta em vários lugares — o achado que mais importa aqui.
 *
 * Dado real da CI&T: `location` diz "Brazil" e `allLocations` diz as cidades. Uma HÍBRIDA em Campinas não pode
 * passar como compatível para quem mora em Fortaleza só porque o rótulo largo não tem cidade nem UF para a
 * regra reprovar — foi assim que sete candidaturas presenciais erradas saíram em 28/09/2026.
 */
const moraEmFortaleza = { localizacaoPresencial: 'Fortaleza - CE', paisesRemoto: ['Brasil'] };
const CIANDT_HIBRIDA = {
  id: '6d9f31cf-2493-4774-bb9c-1b9241a33f63',
  text: '[Job - 31339] Analista de Remuneração Sênior',
  country: 'BR',
  workplaceType: 'hybrid',
  hostedUrl: 'https://jobs.lever.co/ciandt/6d9f31cf-2493-4774-bb9c-1b9241a33f63',
  categories: { commitment: 'Full Time', location: 'Brazil', allLocations: ['Brazil', 'Campinas, SP', 'São Paulo, SP'] },
};
const soRotuloLever = melhorLocal({ ...CIANDT_HIBRIDA, categories: { location: 'Brazil', allLocations: [] } }, 'Brasil', 'hibrido', moraEmFortaleza);
assert.equal(soRotuloLever.lugar.compativel, true, 'o rótulo "Brazil" sozinho não tem o que reprovar — é justamente o risco');
const comCidadesLever = melhorLocal(CIANDT_HIBRIDA, 'Brasil', 'hibrido', moraEmFortaleza);
assert.equal(comCidadesLever.lugar.compativel, false, 'híbrida em Campinas/São Paulo não serve para quem mora em Fortaleza');
assert.ok(/Campinas|São Paulo/.test(comCidadesLever.local), `o lugar gravado é o que decidiu, para a tela dizer por quê: ${comCidadesLever.local}`);
// E o contrário: se UM dos lugares serve, a vaga vale e é esse lugar que fica
const tambemAquiLever = melhorLocal({ ...CIANDT_HIBRIDA, categories: { location: 'Brazil', allLocations: ['Campinas, SP', 'Fortaleza, CE'] } }, 'Brasil', 'hibrido', moraEmFortaleza);
assert.equal(tambemAquiLever.lugar.compativel, true, 'vaga aberta também na cidade dela não pode ser descartada por causa de Campinas');
assert.ok(/Fortaleza/.test(tambemAquiLever.local), `vence o melhor lugar, não o primeiro da lista: ${tambemAquiLever.local}`);

const cfgLever = { area: '', senioridade: '', scoreMinimo: 30, regimes: ['remoto', 'hibrido', 'presencial'] } as unknown as Parameters<typeof montarLever>[4];
const CIANDT_REMOTA = {
  id: '472ffac1-5bc5-4b1c-97bb-b1b85950f878',
  text: '[ job - 32054] Mid-Level Fullstack Developer ( Java + Angular ), Brasil',
  country: 'BR',
  workplaceType: 'remote',
  createdAt: Date.now() - 86400000,
  hostedUrl: 'https://jobs.lever.co/ciandt/472ffac1-5bc5-4b1c-97bb-b1b85950f878',
  categories: { commitment: 'Homeoffice', location: 'Brazil', allLocations: ['Brazil'] },
  openingPlain: 'Na CI&T, ajudamos grandes empresas a transformar o potencial da AI.',
  lists: [],
};
const vagaLever = montarLever('ciandt', 'CI&T', CIANDT_REMOTA, perfil, cfgLever, moraEmFortaleza, corpoLever)!;
assert.equal(vagaLever.id, 'lever:ciandt:472ffac1-5bc5-4b1c-97bb-b1b85950f878');
assert.equal(vagaLever.tenant, 'ciandt', 'o board fica no tenant: é por ele que a varredura encerra o que saiu do ar');
assert.equal(vagaLever.pais, 'Brasil');
assert.equal(vagaLever.modelo, 'remoto');
assert.equal(vagaLever.regime, 'indefinido');
assert.ok(vagaLever.skills.includes('java'), `as competências saem do corpo lido da PÁGINA, não do "Sobre nós": ${vagaLever.skills.join(',')}`);
assert.notEqual(vagaLever.status, 'ignorada', 'remota no Brasil com Java no anúncio tem de ficar na lista');
// Sem o corpo da página, a mesma vaga é pontuada só pela apresentação da empresa — o motivo de abrir a página
const semCorpoLever = montarLever('ciandt', 'CI&T', CIANDT_REMOTA, perfil, cfgLever, moraEmFortaleza)!;
assert.ok(semCorpoLever.score < vagaLever.score, `pontuar só pelo "Sobre nós" dá nota menor (${semCorpoLever.score} < ${vagaLever.score}): é por isso que a página é lida`);
assert.equal(montarLever('ciandt', 'CI&T', { ...CIANDT_REMOTA, createdAt: Date.now() - 400 * 86400000 }, perfil, cfgLever, moraEmFortaleza), null, 'vaga de mais de um ano no board já foi preenchida');
assert.equal(montarLever('ciandt', 'CI&T', { id: '', text: '', hostedUrl: '' }, perfil, cfgLever, moraEmFortaleza), null);

// Slug do board: aceita o nome, a URL do board, a da vaga e a do formulário
assert.equal(slugLever('neon'), 'neon');
assert.equal(slugLever('https://jobs.lever.co/ciandt'), 'ciandt');
assert.equal(slugLever('https://jobs.lever.co/zippi/8a2b211c-4b0a-490d-a155-92384ce0f09d/apply'), 'zippi');
assert.equal(slugLever(''), '');

// A prova de envio da extensão: o POST vai para a própria URL do /apply, porque o <form> não tem action
assert.ok(ROTA_LEVER.test('https://jobs.lever.co/neon/026b745f-bc2a-4661-8d4e-a711987c2f0b/apply'));
assert.ok(!ROTA_LEVER.test('https://jobs.lever.co/neon/026b745f-bc2a-4661-8d4e-a711987c2f0b'), 'abrir a vaga não é enviar candidatura');
assert.ok(LEVER.convencoes.final.test('Submit application'), 'o texto real do botão de envio');
assert.ok(!LEVER.convencoes.final.test('Apply for this job'), 'o botão que só abre o formulário não pode ser lido como envio');

console.log('✓ Lever: API por empresa, corpo lido da página quando falta, e vaga em vários lugares decidida pelo melhor');

// ─── 7c) Greenhouse: anúncio escapado duas vezes, modelo escrito no local, e o buraco do país ────
// Dados reais de 06/10/2026 (QuintoAndar, SumUp, BTG, VTEX), 667 vagas medidas em 6 boards.
const { montarVaga: montarGh, modeloDe: modeloGh, anuncioEmTexto, locaisDe: locaisGh, requisitosDe: requisitosGh } = await import('./platforms/greenhouse/busca.ts');
const { extrairSlug: slugGh } = await import('./platforms/greenhouse/boards.ts');
const { ROTA_ENVIO: ROTA_GH, GREENHOUSE } = await import('./platforms/greenhouse/seletores.ts');

/**
 * O `content` vem com o HTML DUAS vezes escapado.
 *
 * Sem desfazer isso antes, `htmlParaTexto` não enxerga tag nenhuma (para ele o texto não tem `<`), devolve a
 * string com `&lt;p&gt;` dentro, e as competências sairiam de um texto cheio de marcação.
 */
const CONTENT_GH = '&lt;p&gt;&lt;strong&gt;Sobre a vaga&lt;/strong&gt;&lt;/p&gt;&lt;p&gt;Requisitos: Java, Spring Boot &amp;amp; SQL&lt;/p&gt;';
const anuncioGh = anuncioEmTexto(CONTENT_GH);
assert.ok(!anuncioGh.includes('&lt;') && !anuncioGh.includes('<p>'), `o HTML duplamente escapado tem de virar texto limpo: ${anuncioGh}`);
assert.ok(anuncioGh.includes('Java') && anuncioGh.includes('Spring Boot'), 'e o conteúdo tem de sobreviver');
assert.ok(anuncioGh.includes('&') && !anuncioGh.includes('&amp;'), 'o & escapado duas vezes volta a ser um & só');
assert.equal(anuncioEmTexto(), '');

// O modelo de trabalho não é campo no Greenhouse: está escrito no texto do local (valores reais medidos)
assert.equal(modeloGh('Brazil (Remote)'), 'remoto');
assert.equal(modeloGh('Brazil (São Paulo - Hybrid)'), 'hibrido');
assert.equal(modeloGh('Remoto'), 'remoto');
assert.equal(modeloGh('São Paulo, São Paulo, Brazil'), 'indefinido', 'local sem marca não vira presencial por suposição');
assert.equal(modeloGh('Brasil', 'A vaga é 100% remota, de qualquer lugar do país.'), 'remoto', 'o anúncio é a segunda chance');
assert.equal(modeloGh('Brazil (São Paulo - Hybrid)'), 'hibrido', 'híbrido ganha de remoto quando os dois aparecem');

/**
 * Os lugares possíveis: `location.name` pode trazer vários separados por `;`, e quando ele diz só "Brasil" é
 * em `offices[]` que está a cidade de verdade (medido no QuintoAndar).
 */
assert.deepEqual(locaisGh({ id: 1, title: 'x', absolute_url: 'x', location: { name: 'Brasil; São Paulo, São Paulo, Brazil' }, offices: [{ name: 'São Paulo' }] }), [
  'Brasil',
  ' São Paulo, São Paulo, Brazil',
  'São Paulo',
]);

const QUINTOANDAR_SP = {
  id: 4411502009,
  title: 'Grupo QuintoAndar | Security Engineer',
  company_name: 'Grupo QuintoAndar',
  absolute_url: 'https://job-boards.greenhouse.io/quintoandar/jobs/4411502009',
  updated_at: new Date(Date.now() - 86400000).toISOString(),
  location: { name: 'Brasil' },
  offices: [{ name: 'São Paulo' }],
  content: CONTENT_GH,
};
const cfgGh = { area: '', senioridade: '', scoreMinimo: 30, regimes: ['remoto', 'hibrido', 'presencial'] } as unknown as Parameters<typeof montarGh>[4];
const vagaGh = montarGh('quintoandar', 'Grupo QuintoAndar', QUINTOANDAR_SP, perfil, cfgGh, moraEmFortaleza)!;
assert.equal(vagaGh.id, 'greenhouse:quintoandar:4411502009');
assert.equal(vagaGh.empresa, 'Grupo QuintoAndar', 'a empresa vem pronta da API, sem precisar ler o <title>');
assert.equal(vagaGh.pais, 'Brasil');
assert.equal(vagaGh.regime, 'indefinido', 'o Greenhouse não publica tipo de contrato em campo nenhum: não se adivinha');
assert.ok(vagaGh.skills.includes('java'), `as competências saem do anúncio desescapado: ${vagaGh.skills.join(',')}`);
assert.equal(
  montarGh('quintoandar', 'x', { ...QUINTOANDAR_SP, updated_at: new Date(Date.now() - 400 * 86400000).toISOString() }, perfil, cfgGh, moraEmFortaleza),
  null,
  'vaga parada há mais de meio ano no board já foi preenchida',
);
assert.equal(montarGh('quintoandar', 'x', { id: 0, title: '', absolute_url: '' }, perfil, cfgGh, moraEmFortaleza), null);
assert.ok(requisitosGh('Sobre nós\nSomos uma empresa.\nRequisitos\nJava e SQL').startsWith('Requisitos'), 'a seção de requisitos é achada pelo título dela');

assert.equal(slugGh('quintoandar'), 'quintoandar');
assert.equal(slugGh('https://job-boards.greenhouse.io/quintoandar/jobs/4411502009'), 'quintoandar');
assert.equal(slugGh('https://boards.greenhouse.io/sumup'), 'sumup');
assert.ok(ROTA_GH.test('https://job-boards.greenhouse.io/quintoandar/jobs/4411502009'));
assert.ok(GREENHOUSE.convencoes.final.test('Enviar inscrição'), 'o texto real do botão de envio, em pt-BR');
assert.ok(GREENHOUSE.convencoes.final.test('Submit application'));
assert.ok(!GREENHOUSE.convencoes.final.test('Apply for this job'), 'o botão que só abre o formulário não é envio');

/**
 * **O buraco do país, que o Greenhouse abriu e vale para todas as plataformas.**
 *
 * `PAISES` (`src/paises.ts`) é a lista de países que a pessoa ESCOLHE para trabalho remoto — curta de
 * propósito, porque é um seletor de tela. Usá-la também para responder "que país é este lugar?" fazia
 * "Vilnius, Lithuania" virar vazio, e vazio quer dizer "a vaga não diz onde é", que a regra trata como
 * compatível. Medido na primeira varredura do Greenhouse: vagas em Vilnius e Sofia entraram na lista a 78%,
 * e as de Berlim não — só porque a Alemanha por acaso está em `PAISES` e a Lituânia não.
 */
assert.equal(paisDoLocalTexto('Vilnius, Lithuania'), 'Lituânia', 'país fora de PAISES tem de ser reconhecido mesmo assim');
assert.equal(paisDoLocalTexto('Sofia, Bulgaria'), 'Bulgária');
assert.equal(paisDoLocalTexto('Tokyo, Japan'), 'Japão');
assert.equal(paisDoLocalTexto('São Paulo, SP'), 'Brasil', 'e nada disso pode atrapalhar o que já funcionava');
assert.equal(paisDoLocalTexto('Belém, PA'), 'Brasil', 'sigla que é UF continua sendo UF');
assert.equal(paisDoLocalTexto('Remoto'), '', 'remoto sem país continua sem país');
assert.equal(paisDoLocalTexto('Barueri, Alphaville'), '', 'nome que não é país não vira país');

/**
 * E o ramo `indefinido` da regra de localização: compatível porque na dúvida se mostra a vaga — **mas só
 * quando há dúvida.** Com o país conhecido e estrangeiro, os DOIS caminhos recusam (remota restrita a país
 * fora da lista; presencial em outro país), então não sobrou dúvida sobre o que importa.
 */
const soBrPtAr = { localizacaoPresencial: 'Fortaleza - CE', paisesRemoto: ['Brasil', 'Portugal', 'Argentina'] };
const porLugar = (modelo: 'indefinido' | 'remoto' | 'presencial', local: string) => vagaCompativelComLocalizacao({ modelo, local }, soBrPtAr).compativel;
assert.equal(porLugar('indefinido', 'Vilnius, Lithuania'), false, 'nem como remota nem como presencial ela serve');
assert.equal(porLugar('indefinido', 'Sofia, Bulgaria'), false);
assert.equal(porLugar('indefinido', 'Lisboa, Portugal'), true, 'Portugal está na lista de remotas: aqui a dúvida é legítima e a vaga aparece');
assert.equal(porLugar('indefinido', 'São Paulo, SP'), true, 'no seu país, a dúvida continua valendo a favor de mostrar');
assert.equal(porLugar('indefinido', 'Remoto'), true, 'sem lugar declarado nada mudou');
assert.equal(porLugar('indefinido', ''), true);
assert.equal(porLugar('remoto', 'Vilnius, Lithuania'), false, 'e a remota restrita a país fora da lista agora é reconhecida como tal');
console.log('✓ Greenhouse: anúncio desescapado, modelo lido do local, e país estrangeiro deixa de passar por "na dúvida mostra"');

// 8) Campos com nome em português e o LinkedIn em campo type=url
const { urlDoLinkedin } = await import('./platforms/inhire/formulario.ts');
assert.equal(papelDe({ nome: 'telefone', rotulo: 'Seu whatsapp (DDD+número)', tipo: 'texto' }), 'celular');
assert.equal(papelDe({ nome: 'linkedin', rotulo: '', tipo: 'texto' }), 'linkedin');
assert.equal(papelDe({ nome: 'pdf', rotulo: 'Arquivo', tipo: 'arquivo' }), 'curriculo');
assert.equal(papelDe({ nome: 'tipocnpj', rotulo: '1 Dados', tipo: 'select' }), 'cnpj', 'o rótulo do Vagas PJ é lixo: quem decide é o name=');
assert.equal(papelDe({ nome: '', rotulo: 'Seu WhatsApp', tipo: 'texto' }), 'celular');
assert.equal(urlDoLinkedin('https://www.linkedin.com/in/ana'), 'https://www.linkedin.com/in/ana');
assert.equal(urlDoLinkedin('linkedin.com/in/ana'), 'https://linkedin.com/in/ana');
assert.equal(urlDoLinkedin('ana'), 'https://www.linkedin.com/in/ana');
const comLinkedin = { ...dadosBase, linkedin: 'ana' };
assert.deepEqual(resolverCampo(campo({ nome: 'linkedin', subtipo: 'url' }), comLinkedin), { acao: 'valor', valor: 'https://www.linkedin.com/in/ana' });
assert.deepEqual(resolverCampo(campo({ nome: 'linkedinUsername' }), comLinkedin), { acao: 'valor', valor: 'ana' }, 'campo de texto comum leva o valor como está');
const cnpj = resolverCampo(campo({ nome: 'tipocnpj', tipo: 'select', opcoes: ['MEI', 'ME', 'Não tenho'] }), dadosBase);
assert.ok(cnpj.acao === 'pergunta', 'tipo de CNPJ nunca é escolhido pelo robô');
assert.ok(cnpj.acao === 'pergunta' && cnpj.pergunta.rotulo.includes('CNPJ') && cnpj.pergunta.opcoes?.length === 3);
const rotuloCnpj = cnpj.acao === 'pergunta' ? cnpj.pergunta.rotulo : '';
assert.deepEqual(
  resolverCampo(campo({ nome: 'tipocnpj', tipo: 'select', opcoes: ['MEI', 'ME'] }), { ...dadosBase, responder: (q: { rotulo: string }) => (q.rotulo === rotuloCnpj ? 'MEI' : null) }),
  { acao: 'valor', valor: 'MEI' },
  'respondida uma vez, vale para as próximas vagas PJ',
);
console.log('✓ Campos em português, LinkedIn em campo url e tipo de CNPJ');

// 9) Catálogo de modelos de IA: uma lista só, sem modelo aposentado
const { MODELOS_IA, modeloPadrao, faixaDeCusto } = await import('../src/dados.ts');
const { MODELOS } = await import('./ia.ts');

for (const provedor of ['gemini', 'anthropic'] as const) {
  const lista = MODELOS_IA[provedor];
  const ids = lista.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length, `${provedor}: id repetido no catálogo`);
  // O núcleo não pode conhecer uma lista diferente da que a tela oferece: já aconteceu de divergirem
  assert.deepEqual(MODELOS[provedor].opcoes, ids, `${provedor}: core/ia.ts divergiu de src/dados.ts`);
  assert.ok(ids.includes(MODELOS[provedor].padrao), `${provedor}: o padrão tem de estar entre as opções`);
  assert.equal(MODELOS[provedor].padrao, modeloPadrao(provedor));
  assert.equal(lista.filter(m => m.situacao === 'recomendado').length, 1, `${provedor}: deve haver exatamente um recomendado`);
  for (const m of lista) {
    assert.ok(m.entrada > 0 && m.saida > 0, `${m.id}: preço faltando`);
    assert.ok(m.saida >= m.entrada, `${m.id}: saída mais barata que entrada é suspeito`);
    assert.ok(m.nota.length > 20, `${m.id}: sem nota que ajude a escolher`);
  }
}

// Aposentados de verdade: conferido em 23/09/2026 com uma chamada real, que devolve
// 404 "no longer available to new users". Ficam listados em models.list, então só o teste segura.
for (const morto of ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'])
  assert.ok(!MODELOS.gemini.opcoes.includes(morto), `${morto} foi aposentado pelo Google e não pode ser oferecido`);

// A faixa de custo tem de separar o mais barato do mais caro da própria lista
const gem = MODELOS_IA.gemini;
const maisBarato = [...gem].sort((a, b) => a.saida - b.saida)[0];
const maisCaro = [...gem].sort((a, b) => b.saida - a.saida)[0];
assert.equal(faixaDeCusto(maisBarato, gem).rotulo, 'Mais barato');
assert.equal(faixaDeCusto(maisCaro, gem).rotulo, 'Mais caro');
console.log(`✓ Modelos de IA: ${MODELOS.gemini.opcoes.length} Gemini + ${MODELOS.anthropic.opcoes.length} Claude, lista única e sem modelo aposentado`);

// 10) Foco por plataforma: um interruptor só decide a fila E a lista de vagas
const { plataformaNoFoco } = await import('../src/dados.ts');
const conexoesTeste = { inhire: { conectadaEm: 'x' }, vagaspj: { conectadaEm: 'x', enviar: false }, indeed: { conectadaEm: 'x', enviar: true } };
assert.equal(plataformaNoFoco(conexoesTeste, 'inhire'), true, 'conexão sem o campo continua no foco (as criadas antes disto)');
assert.equal(plataformaNoFoco(conexoesTeste, 'vagaspj'), false);
assert.equal(plataformaNoFoco(conexoesTeste, 'indeed'), true);
assert.equal(plataformaNoFoco(conexoesTeste, 'gupy'), true, 'plataforma sem conexão não é o que este filtro resolve');
assert.equal(plataformaNoFoco({}, 'inhire'), true);
console.log('✓ Foco por plataforma: mesma regra para a fila e para a lista');

// 11) Modo "Só na dúvida": o que a IA resolve e o que ela devolve
const { DADO_PESSOAL } = await import('../src/sensiveis.ts');
// Devolve: dado que a IA não tem como saber e erraria num formulário de uma empresa real
for (const r of [
  'Qual o seu CPF?',
  'Informe seu endereço completo',
  'Em qual bairro você mora?',
  'Qual o seu CEP?',
  'Data de nascimento',
  'Qual a sua pretensão salarial?',
  'Nome da mãe',
  'Seu telefone para contato',
  'Qual o seu e-mail?',
])
  assert.ok(DADO_PESSOAL.test(r), `deveria ficar com o usuário: "${r}"`);
// Resolve: pergunta técnica tem resposta certa e não depende de dado pessoal nenhum
for (const r of [
  'Para garantir a resiliência de um serviço em ambiente distribuído, quais padrões você aplicaria?',
  'Quais das seguintes práticas são fundamentais para código limpo?',
  'Qual abordagem garante consistência eventual entre microsserviços?',
  'Qual seu nível de experiência com Java 11+ e Spring Boot?',
  'Você já trabalhou com modelos de Machine Learning em produção?',
])
  assert.ok(!DADO_PESSOAL.test(r), `a IA deveria poder tratar: "${r}"`);
console.log('✓ Dado pessoal nunca chega na IA; pergunta técnica chega');

// "Marque todas que se aplicam": o motor espera "A | B", e casar só uma deixava a resposta pela metade
const OPC = [
  'Circuit Breaker para interromper chamadas a serviços indisponíveis e Fallback para prover uma resposta alternativa.',
  'Implementar um mecanismo de Timeout para limitar o tempo de espera por uma resposta.',
  'Utilizar Retry apenas quando o serviço retornar um erro 500, sem nenhuma outra estratégia.',
  'Ignorar completamente as falhas de comunicação entre serviços.',
];
const varias =
  'Circuit Breaker para interromper chamadas a serviços indisponíveis e Fallback para prover uma resposta alternativa. | Implementar um mecanismo de Timeout para limitar o tempo de espera por uma resposta.';
const casadas = varias
  .split('|')
  .map(t => casarComOpcao(OPC, t))
  .filter(Boolean);
assert.equal(casadas.length, 2, 'as duas opções corretas têm de ser reconhecidas');
assert.deepEqual(casadas, [OPC[0], OPC[1]]);
assert.equal(casarComOpcao(OPC, 'Isso não existe na lista desta vaga'), null, 'opção inventada é recusada');
console.log('✓ Marcar várias: a IA pode escolher mais de uma opção');

// 12) Divulga Vagas: peneira pelo slug, JSON-LD e a trava de vaga PcD
const { lerSitemap, termosDoPerfil, slugInteressa, lerJobPosting: lerJP, modeloDe: modeloDV, montarVaga: montarDV } = await import('./platforms/divulgavagas/busca.ts');
const { DIVULGA, EMPRESA_OCULTA } = await import('./platforms/divulgavagas/seletores.ts');

const SITEMAP = `<?xml version="1.0"?><urlset>
<url><loc>https://divulgavagas.com.br/vaga-de-emprego/desenvolvedor-python-senior-home-office-rs-34541421</loc><lastmod>2026-09-23</lastmod></url>
<url><loc>https://divulgavagas.com.br/vaga-de-emprego/motorista-de-carreta-34296295</loc></url>
<url><loc>https://divulgavagas.com.br/vagas-de-home-office</loc></url></urlset>`;
const doSitemap = lerSitemap(SITEMAP);
assert.equal(doSitemap.length, 2, 'só entram URLs de vaga, não páginas de categoria');
assert.deepEqual({ id: doSitemap[0].id, slug: doSitemap[0].slug }, { id: '34541421', slug: 'desenvolvedor-python-senior-home-office-rs' });

// A peneira é o que torna viável um acervo de 41 mil vagas quase todo fora da área
const termos = termosDoPerfil({ area: 'TI', cargos: ['Desenvolvedor Full Stack'], skills: ['python', 'react'], senioridade: 'Pleno' }, 'Desenvolvedor');
assert.ok(slugInteressa('desenvolvedor-python-senior-home-office-rs', termos));
assert.ok(!slugInteressa('motorista-de-carreta', termos), 'vaga de outra área não pode custar um download');
assert.ok(!slugInteressa('auxiliar-administrativo', termos));
assert.ok(!termos.includes('ia'), 'termo de 2 letras casaria com qualquer slug');

const paginaDV = (jp: object) => `<html><body><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org/', '@type': 'JobPosting', ...jp })}</script></body></html>`;
const JP = { title: 'Desenvolvedor Python Sênior – Home Office - Rs | Vaga #34541421', description: 'Vaga de Python', skills: ['Python', 'SQL'], employmentType: 'FULL_TIME' };
assert.equal(lerJP(paginaDV(JP))?.title, JP.title);
assert.equal(modeloDV({ jobLocationType: 'TELECOMMUTE' }, 'Dev'), 'remoto');
assert.equal(modeloDV({}, 'Dev Pleno | Híbrido em Fortaleza'), 'hibrido');
assert.equal(modeloDV({}, 'Dev'), 'indefinido', 'sem endereço e sem marca não invento presencial');

const itemDV = { id: '34541421', slug: 'desenvolvedor-python-senior', url: 'https://divulgavagas.com.br/vaga-de-emprego/desenvolvedor-python-senior-34541421' };
const cfgDV = { area: '', senioridade: '', scoreMinimo: 30 } as unknown as Parameters<typeof montarDV>[3];
const prefDV = { localizacaoPresencial: 'Fortaleza - CE', paisesRemoto: ['Brasil'] };
const vDV = montarDV(itemDV, paginaDV({ ...JP, jobLocationType: 'TELECOMMUTE' }), perfil, cfgDV, prefDV)!;
assert.equal(vDV.id, 'divulgavagas:34541421');
assert.equal(vDV.titulo, 'Desenvolvedor Python Sênior – Home Office - Rs', 'o sufixo "| Vaga #id" é ruído do site');
assert.equal(vDV.empresa, EMPRESA_OCULTA, 'o site nunca diz de quem é a vaga');
assert.equal(vDV.modelo, 'remoto');
assert.ok(vDV.requisitos.includes('Python'), 'as skills do JSON-LD viram requisitos');
assert.equal(montarDV(itemDV, paginaDV({ ...JP, validThrough: '2020-01-01T00:00:00-03:00' }), perfil, cfgDV, prefDV), null, 'vaga vencida não entra');
assert.equal(montarDV(itemDV, '<html>sem json-ld</html>', perfil, cfgDV, prefDV), null);

// A caixa de PcD é uma declaração sobre a pessoa: o robô a detecta pelo CONTÊINER, não pelo input
assert.notEqual(DIVULGA.pcdContainer, DIVULGA.pcd, 'o input fica sempre escondido; quem revela a vaga PcD é o contêiner');
assert.ok(DIVULGA.sucesso.test('Currículo enviado com sucesso!'));
assert.ok(!DIVULGA.sucesso.test('Enviar Currículo Li e aceito os Termos'), 'o formulário por enviar não é sucesso');
// 13) Workable: modelo de trabalho, regime, montagem de vaga e rotas de envio
const { modeloDe: modeloWK, regimeDe: regimeWK, montarVaga: montarWK } = await import('./platforms/workable/busca.ts');
const { idDaVaga: idWK } = await import('./platforms/workable/index.ts');
const { WORKABLE } = await import('./platforms/workable/seletores.ts');

assert.equal(modeloWK('remote'), 'remoto');
assert.equal(modeloWK('hybrid'), 'hibrido');
assert.equal(modeloWK('on_site'), 'presencial');
assert.equal(modeloWK(''), 'indefinido');
assert.equal(regimeWK('Full-time'), 'CLT');
assert.equal(regimeWK('Contract'), 'PJ');
assert.equal(regimeWK(''), 'indefinido');

assert.equal(idWK({ id: 'workable:abc-123', url: 'https://jobs.workable.com/view/abc-123/slug' }), 'abc-123');
assert.equal(idWK({ id: '', url: 'https://jobs.workable.com/view/def-456/slug-da-vaga' }), 'def-456');

const rawWK = {
  id: 'abc-123',
  title: 'Java Backend Developer',
  description: '<p>Requisitos: Java, Spring Boot e SQL</p>',
  requirementsSection: '<p>2 anos de experiência</p>',
  benefitsSection: '<p>Plano de saúde</p>',
  workplace: 'remote' as const,
  employmentType: 'Full-time',
  url: 'https://jobs.workable.com/view/abc-123/java-backend-developer',
  location: { city: 'São Paulo', subregion: 'SP', countryName: 'Brazil' },
  company: { id: 'acme-corp', title: 'Acme Corp' },
  created: '2026-09-24T00:00:00Z',
};
const vWK = montarWK(rawWK, perfil, { area: '', senioridade: '', scoreMinimo: 30 } as unknown as Parameters<typeof montarWK>[2], {
  localizacaoPresencial: 'São Paulo - SP',
  paisesRemoto: ['Brasil'],
})!;
assert.equal(vWK.id, 'workable:abc-123');
assert.equal(vWK.plataforma, 'workable');
assert.equal(vWK.titulo, 'Java Backend Developer');
assert.equal(vWK.empresa, 'Acme Corp');
assert.equal(vWK.modelo, 'remoto');
assert.equal(vWK.regime, 'CLT');
assert.ok(vWK.score >= 50, `score Workable deveria ser alto: ${vWK.score}`);
assert.ok(WORKABLE.rotaEnvio.test('https://jobs.workable.com/api/v1/jobs/abc-123/apply?lng=en'));
assert.ok(!WORKABLE.rotaEnvio.test('https://jobs.workable.com/api/v1/jobs/abc-123/form'));
assert.ok(WORKABLE.sucesso.test('Thank you for applying!'));
assert.ok(WORKABLE.sucesso.test('Your application has been received'));
console.log(`✓ Workable: modelo/regime, extração de ID, API e prova de envio (${vWK.score}%)`);

// 14) Quickin: sitemaps, extração por ID, JSON-LD e convenções
const { extrairEmpresasDoSitemapIndex, lerSitemapEmpresa, lerJobPosting: lerJPQK, modeloDe: modeloQK, regimeDe: regimeQK, montarVaga: montarQK } = await import('./platforms/quickin/busca.ts');
const { extrairEmpresaEId } = await import('./platforms/quickin/index.ts');
const { QUICKIN } = await import('./platforms/quickin/seletores.ts');

const SITEMAP_INDEX_QK = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://jobs.quickin.io/sitemaps/empresa-alpha-jobs.xml</loc><lastmod>2026-09-24</lastmod></sitemap>
  <sitemap><loc>https://jobs.quickin.io/sitemaps/beta-tech-jobs.xml</loc></sitemap>
</sitemapindex>`;
const empresasQK = extrairEmpresasDoSitemapIndex(SITEMAP_INDEX_QK);
assert.deepEqual(empresasQK, ['empresa-alpha', 'beta-tech']);

const SITEMAP_EMP_QK = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://jobs.quickin.io/empresa-alpha/jobs/6ab06d193299af0013c75f37</loc></url>
</urlset>`;
const itensQK = lerSitemapEmpresa(SITEMAP_EMP_QK, 'empresa-alpha');
assert.equal(itensQK.length, 1);
assert.equal(itensQK[0].id, '6ab06d193299af0013c75f37');
assert.equal(itensQK[0].empresa, 'empresa-alpha');

const infoQK = extrairEmpresaEId({ id: 'quickin:6ab06d193299af0013c75f37', url: 'https://jobs.quickin.io/empresa-alpha/jobs/6ab06d193299af0013c75f37' });
assert.deepEqual(infoQK, { empresa: 'empresa-alpha', jobId: '6ab06d193299af0013c75f37' });

const JP_QK = {
  title: 'Desenvolvedora Back-end Java Jr',
  description: '<p>Requisitos: Java, Spring Boot e SQL</p>',
  employmentType: 'FULL_TIME',
  jobLocationType: 'TELECOMMUTE',
  hiringOrganization: { name: 'Empresa Alpha' },
  jobLocation: { address: { addressLocality: 'São Paulo', addressRegion: 'SP', addressCountry: 'Brasil' } },
};
const htmlQK = `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org/', '@type': 'JobPosting', ...JP_QK })}</script></head><body></body></html>`;
assert.equal(lerJPQK(htmlQK)?.title, JP_QK.title);
assert.equal(modeloQK(JP_QK, JP_QK.title, JP_QK.description), 'remoto');
assert.equal(regimeQK(JP_QK), 'CLT');

const vQK = montarQK(itensQK[0], htmlQK, perfil, { area: '', senioridade: '', scoreMinimo: 30 } as unknown as Parameters<typeof montarQK>[3], {
  localizacaoPresencial: 'São Paulo - SP',
  paisesRemoto: ['Brasil'],
})!;
assert.equal(vQK.id, 'quickin:6ab06d193299af0013c75f37');
assert.equal(vQK.plataforma, 'quickin');
assert.equal(vQK.titulo, 'Desenvolvedora Back-end Java Jr');
assert.equal(vQK.empresa, 'Empresa Alpha');
assert.equal(vQK.modelo, 'remoto');
assert.equal(vQK.regime, 'CLT');
assert.ok(vQK.score >= 50, `score Quickin deveria ser alto: ${vQK.score}`);
assert.ok(QUICKIN.rotaEnvio.test('https://api.quickin.io/public/66c6006c637e170013d1509b/apply'));
assert.ok(QUICKIN.sucesso.test('Candidatura enviada com sucesso!'));
assert.ok(QUICKIN.sucesso.test('Recebemos sua candidatura'));
console.log(`✓ Quickin: sitemaps de 628 empresas, JSON-LD, formulário por ID e envio (${vQK.score}%)`);

// 15) Arbeitnow: modelo de trabalho, regime, montagem de vaga e convenções multilíngues
const { modeloDe: modeloAN, regimeDe: regimeAN, montarVaga: montarAN } = await import('./platforms/arbeitnow/busca.ts');
const { ARBEITNOW } = await import('./platforms/arbeitnow/seletores.ts');

const itemAN = {
  slug: 'backend-java-developer-remote-12345',
  company_name: 'Tech Berlin GmbH',
  title: 'Junior Java Backend Developer',
  description: '<p>Requirements: Java, Spring Boot, SQL, Git</p>',
  remote: true,
  url: 'https://www.arbeitnow.com/jobs/companies/tech-berlin-gmbh/backend-java-developer-remote-12345',
  tags: ['Java', 'Spring', 'Backend'],
  job_types: ['Full-time'],
  location: 'Berlin',
  created_at: Math.floor(Date.now() / 1000),
};

assert.equal(modeloAN(itemAN), 'remoto');
assert.equal(modeloAN({ ...itemAN, remote: false, location: 'Berlin' }), 'presencial');
assert.equal(regimeAN(itemAN), 'CLT');
assert.equal(regimeAN({ ...itemAN, job_types: ['Contract'] }), 'PJ');

const vAN = montarAN(itemAN, perfil, { area: '', senioridade: '', scoreMinimo: 30 } as unknown as Parameters<typeof montarAN>[2], { localizacaoPresencial: '', paisesRemoto: ['Alemanha', 'Brasil'] })!;
assert.equal(vAN.id, 'arbeitnow:backend-java-developer-remote-12345');
assert.equal(vAN.plataforma, 'arbeitnow');
assert.equal(vAN.titulo, 'Junior Java Backend Developer');
assert.equal(vAN.empresa, 'Tech Berlin GmbH');
assert.equal(vAN.modelo, 'remoto');
assert.ok(vAN.score >= 50, `score Arbeitnow deveria ser alto: ${vAN.score}`);

// Convenções multilíngues (Inglês, Alemão e Português) para formulários internacionais
assert.ok(ARBEITNOW.convencoes.proximo.test('Next'));
assert.ok(ARBEITNOW.convencoes.proximo.test('Continue'));
assert.ok(ARBEITNOW.convencoes.proximo.test('Weiter'));
assert.ok(ARBEITNOW.convencoes.final.test('Submit application'));
assert.ok(ARBEITNOW.convencoes.final.test('Bewerbung absenden'));
assert.ok(ARBEITNOW.convencoes.final.test('Apply now'));
assert.ok(ARBEITNOW.convencoes.sucesso.test('Thank you for your application'));
assert.ok(ARBEITNOW.convencoes.sucesso.test('Vielen Dank für Ihre Bewerbung'));
assert.ok(ARBEITNOW.convencoes.sucesso.test('Application received'));
console.log(`✓ Arbeitnow: API, modelo/regime, pontuação e convenções EN/DE/PT (${vAN.score}%)`);

// 16) Tradução de currículo para inglês e geração de PDF A4
const { traduzirCurriculoParaIngles } = await import('./resume/traducao.ts');

const cvExemploPt = `# Marina Pitanga
Desenvolvedora Back-End Júnior | Campinas - SP

## Resumo Profissional
Desenvolvedora Back-End com foco em Java e Spring Boot.

## Experiência Profissional
### Acme Corp — Desenvolvedora Back-End
Janeiro de 2023 – Presente
• Desenvolvimento de microsserviços em Java e Spring Boot.

## Formação Acadêmica
Bacharelado em Ciência da Computação

## Competências Técnicas
Java, Spring Boot, PostgreSQL, Docker, Git.
`;

const cvTraduzidoEn = await traduzirCurriculoParaIngles(cvExemploPt);
assert.ok(cvTraduzidoEn.includes('# Marina Pitanga'));
assert.ok(cvTraduzidoEn.includes('Professional Summary') || cvTraduzidoEn.includes('Summary'));
assert.ok(cvTraduzidoEn.includes('Professional Experience') || cvTraduzidoEn.includes('Experience'));
assert.ok(cvTraduzidoEn.includes('Education'));
assert.ok(cvTraduzidoEn.includes('Technical Skills') || cvTraduzidoEn.includes('Skills'));
assert.ok(cvTraduzidoEn.includes('Java'));
assert.ok(cvTraduzidoEn.includes('Spring Boot'));

// Geração do PDF em inglês a partir do Markdown traduzido
const caminhoPdfEn = join(tmpdir(), `curriculo-en-teste-${Date.now()}.pdf`);
await markdownParaPdf(cvTraduzidoEn, caminhoPdfEn);
assert.ok(existsSync(caminhoPdfEn));
assert.ok(statSync(caminhoPdfEn).size > 1000);
console.log('✓ Currículo em inglês: tradução preserva markdown e gera PDF A4 diagramado');

// 13) Nichos a evitar: vaga da sua função que você mesmo recusa
const { termoExcluido } = await import('./resume/score.ts');

// Caso real (28/09/2026): "Pessoa Desenvolvedora SAP ABAP Pleno" tirou 69 e entrou na fila. É dev, é da área,
// é da senioridade — nada no score reprovava. O que reprova é a vontade de quem procura.
assert.equal(termoExcluido('Pessoa Desenvolvedora SAP ABAP Pleno', ['sap']), 'sap');
assert.equal(termoExcluido('Desenvolvedor SAP ABAP', ['cobol', 'sap']), 'sap', 'acha em qualquer posição da lista');
assert.equal(termoExcluido('ANALISTA SAP MM', ['sap']), 'sap', 'maiúsculas não escapam');
assert.equal(termoExcluido('Desenvolvedor Sap Basis', ['SAP']), 'SAP', 'o termo volta como a pessoa escreveu');
assert.equal(termoExcluido('Consultor SAP/ABAP', ['abap']), 'abap', 'barra separa palavra');

// Borda de palavra: sem isso, "sap" casaria com "sapataria" e a pessoa perderia vagas sem saber
assert.equal(termoExcluido('Desenvolvedor para rede de sapatarias', ['sap']), null);
assert.equal(termoExcluido('Engenheiro de Dados - Sapiens', ['sap']), null);
assert.equal(termoExcluido('Desenvolvedor Full Stack', ['sap']), null);

// Só o TÍTULO decide: vaga full stack que cita SAP numa integração continua valendo
const cfgSemSap = { excluir: ['sap'] };
const fullstack = calcularScore({ titulo: 'Desenvolvedor Full Stack Pleno', skills: ['java', 'sql', 'sap'], descricao: 'Integrações com SAP e outros ERPs.' }, perfil, cfgSemSap);
assert.ok(fullstack.score > 0, 'citar SAP no texto não pode excluir uma vaga full stack');
const sapDeVerdade = calcularScore({ titulo: 'Pessoa Desenvolvedora SAP ABAP Pleno', skills: ['java', 'sql'], descricao: 'ABAP' }, perfil, cfgSemSap);
assert.equal(sapDeVerdade.score, 0, 'vaga de SAP no título é zerada');
assert.ok(/sap/i.test(sapDeVerdade.motivo) && /evitar|Configura/i.test(sapDeVerdade.motivo), `o motivo tem de dizer por quê: "${sapDeVerdade.motivo}"`);

// Lista vazia (o padrão) não muda nada
const semLista = calcularScore({ titulo: 'Pessoa Desenvolvedora SAP ABAP Pleno', skills: ['java', 'sql'], descricao: 'ABAP' }, perfil, {});
assert.ok(semLista.score > 0, 'sem lista de exclusão, nada é cortado');
assert.equal(termoExcluido('Qualquer coisa', []), null);
assert.equal(termoExcluido('Qualquer coisa', ['  ']), null, 'termo em branco não exclui o mundo');
console.log('✓ Nichos a evitar: corta pelo título, com borda de palavra, e não mexe no resto');

// ─── ProgramaThor: leitura do HTML REAL capturado do site em 03/10/2026 ─────────────────────────
// As fixturas são recortes do que o site devolveu de verdade — não HTML inventado para o teste passar.
const { lerListagem, lerJobPosting: lerJobPostingPT, localDe: localDePT, modeloDe: modeloDePT, montarVaga: montarPT, filtrosDoPerfil } = await import('./platforms/programathor/busca.ts');
const { PROGRAMATHOR } = await import('./platforms/programathor/seletores.ts');
// O ProgramaThor tem configuração própria no teste: senioridade e regimes mudam os filtros da URL
const cfgPT = { area: '', senioridade: 'Pleno', scoreMinimo: 0, regimes: ['remoto'], excluir: [] } as unknown as Parameters<typeof montarPT>[3];
const htmlPT = (nome: string) => readFileSync(new URL(`../core/fixtures/programathor-${nome}.html`, import.meta.url), 'utf8');

const listaPT = lerListagem(htmlPT('listagem'));
assert.equal(listaPT.length, 15, 'a listagem do ProgramaThor traz 15 vagas por página');
assert.match(listaPT[0].url, /^https:\/\/programathor\.com\.br\/jobs\/\d+-/);
assert.ok(new Set(listaPT.map(i => i.id)).size === 15, 'e nenhuma repetida: o mesmo id aparece mais de uma vez no HTML');

const jpPT = lerJobPostingPT(htmlPT('vaga'));
assert.ok(jpPT, 'o JSON-LD precisa ser lido mesmo com quebra de linha crua dentro das strings (o site tem)');
assert.equal(jpPT?.hiringOrganization?.name, 'Net2source');
assert.equal(localDePT(jpPT!), 'São Paulo');
assert.equal(modeloDePT(jpPT!, htmlPT('vaga'), jpPT!.title ?? '', jpPT!.description ?? ''), 'hibrido', 'o modelo vem da página, que diz "Modelo: Híbrido"');
// Sem a página, o JSON-LD sozinho não sabe: e 'indefinido' escapa da regra de localização — foi esse o
// buraco por onde sete presenciais fora do Ceará receberam currículo em 28/09.
assert.equal(modeloDePT(jpPT!, '', jpPT!.title ?? '', jpPT!.description ?? ''), 'indefinido', 'o JSON-LD sozinho não diz o modelo');

const vagaPT = montarPT(listaPT[0], htmlPT('vaga'), perfil, cfgPT, { localizacaoPresencial: 'São Paulo - SP', paisesRemoto: ['Brasil'] });
assert.ok(vagaPT, 'a vaga tem de ser montada a partir do HTML real');
assert.match(vagaPT!.id, /^programathor:\d+$/);
assert.equal(vagaPT!.empresa, 'Net2source');
assert.ok(vagaPT!.skills.length > 0, 'as competências saem da descrição do JSON-LD');

// Vaga vencida não entra: o site mantém a página no ar depois do prazo
const vencida = htmlPT('vaga').replace('2026-12-24', '2020-01-01');
assert.equal(montarPT(listaPT[0], vencida, perfil, cfgPT, { localizacaoPresencial: '', paisesRemoto: ['Brasil'] }), null, 'vaga fora do prazo não entra na lista');

// Os filtros da URL saem da configuração: é o que torna a varredura barata (23.509 -> ~5.100)
assert.deepEqual(filtrosDoPerfil(cfgPT, perfil), { expertise: 'Pleno', remoto: true });
assert.equal(filtrosDoPerfil({ ...cfgPT, senioridade: 'Especialista' }, perfil).expertise, undefined, 'nível que o site não tem como filtro não vai para a URL');
assert.equal(filtrosDoPerfil({ ...cfgPT, regimes: ['remoto', 'presencial'] }, perfil).remoto, false, 'quem aceita presencial não filtra só remotas');
assert.match(PROGRAMATHOR.listagem({ expertise: 'Pleno', remoto: true }, 3), /expertise=Pleno.*remoto=true.*page=3/);

// Deslogado, TODO caminho de candidatura leva ao cadastro — é daí que sai a prova de sessão
assert.ok(PROGRAMATHOR.ctaDeslogado.test(htmlPT('vaga')), 'a página deslogada tem de ser reconhecida como deslogada');
// O login assistido fecha a janela quando a URL sai das "telas de login" por 6 s. O site oferece "Login com
// LinkedIn", que passa por /users/auth/linkedin e por linkedin.com — se essas URLs não contarem como "ainda
// entrando", o robô fecha a janela com a pessoa digitando a senha.
const { programathor } = await import('./platforms/programathor/index.ts');
const aindaEntrando = programathor.sessao!.telasDeLogin;
for (const url of [
  'https://programathor.com.br/users/sign_in',
  'https://programathor.com.br/users/auth/linkedin',
  'https://www.linkedin.com/oauth/v2/authorization?client_id=x',
  'https://www.linkedin.com/checkpoint/challenge/',
])
  assert.ok(aindaEntrando.test(url), `${url} faz parte do caminho do login e não pode encerrar a espera`);
assert.ok(!aindaEntrando.test('https://programathor.com.br/jobs'), 'a listagem já é o estado logado: aí sim a espera acaba');
assert.ok(!aindaEntrando.test('https://programathor.com.br/jobs/123-dev'), 'e a página de uma vaga também');
console.log('✓ ProgramaThor: lê a listagem e o JSON-LD reais, monta a vaga e sabe dizer que está deslogado');

// ─── Idioma da vaga: qual currículo mandar ───────────────────────────────────────────────────────
// Mandar currículo em português para vaga escrita em inglês desperdiça a candidatura, e o desfecho é
// silencioso: o recrutador descarta e você nunca sabe por quê. Os casos abaixo são REAIS, tirados do banco
// em 06/10/2026 — inclusive os dois que quase enganam a conta.
const { idiomaDaVaga, nomeDoIdioma } = await import('./idioma.ts');

// Vaga em português pura
assert.equal(
  idiomaDaVaga({
    titulo: 'Pessoa Desenvolvedora Back-end Pleno',
    descricao: 'Buscamos uma pessoa desenvolvedora para a nossa equipe. Requisitos: experiência com Java e Spring, conhecimento de SQL. Benefícios: vale refeição, plano de saúde.',
  }),
  'pt',
);

// Vaga em inglês pura
assert.equal(
  idiomaDaVaga({
    titulo: 'Python AI Engineer (USD-based pay)',
    descricao:
      'We are looking for a strong engineer to join our team. You will work with Python and LLMs. Requirements: 5 years of experience with backend development, strong knowledge of SQL. Benefits include remote work.',
  }),
  'en',
);

/**
 * O caso que mais engana, e que estava na fila dele: título em inglês, vaga em português.
 * Um detector por título diria "inglês" e mandaria o currículo traduzido para um recrutador brasileiro.
 */
assert.equal(
  idiomaDaVaga({
    titulo: 'Software Development Coordinator - INGLÊS FLUENTE - Full Stack',
    descricao:
      'Empresa de tecnologia admite Coordenador de Desenvolvimento em São Paulo. Responsabilidades: liderar a equipe de desenvolvimento, definir a arquitetura dos sistemas. Requisitos: experiência com gestão de times, inglês fluente para reuniões. Benefícios: vale refeição e plano de saúde.',
  }),
  'pt',
  'título em inglês com descrição em português é vaga em PORTUGUÊS',
);

/** O oposto: título que parece português (nome de tecnologia) com a vaga inteira em inglês. */
assert.equal(
  idiomaDaVaga({
    titulo: 'Full-stack & AI Engineer (USD-based pay)',
    descricao:
      'About the role: you will be responsible for building and shipping features. We are a remote-first team and we work with modern tools. What we expect from you: solid experience, ability to work independently, and strong communication skills.',
  }),
  'en',
);

// Erra para o PORTUGUÊS quando não dá para ter certeza: dizer "inglês" por engano manda o currículo errado
// para um recrutador brasileiro, e o comportamento antigo (sempre português) era o que já funcionava.
assert.equal(idiomaDaVaga({ titulo: 'Dev Full Stack', descricao: '' }), 'pt', 'sem texto suficiente, fica no português');
assert.equal(idiomaDaVaga({ titulo: 'Senior Software Engineer', descricao: '' }), 'pt', 'três palavras em inglês não decidem uma vaga');
assert.equal(idiomaDaVaga({}), 'pt', 'vaga sem texto nenhum não vira inglês');
// Nome de tecnologia não conta: ele é igual nos dois idiomas
assert.equal(idiomaDaVaga({ titulo: 'Desenvolvedor React Node TypeScript Docker AWS', descricao: 'Vaga para atuar com React, Node, TypeScript, Docker e AWS na nossa equipe de produto.' }), 'pt');
assert.equal(nomeDoIdioma('en'), 'inglês');
assert.equal(nomeDoIdioma('pt'), 'português');
console.log('✓ Idioma da vaga: separa título em inglês de vaga em inglês, e erra para o português na dúvida');

// ─── Contrato dos adapters: ou candidata, ou declara que só descobre ─────────────────────────────
// Um adapter sem `candidatar` por esquecimento e um adapter que de propósito só descobre são coisas
// diferentes, e do lado de fora pareceriam iguais. Este laço obriga a diferença a estar escrita: quem não
// candidata tem de dizer que não candidata, e dizer por quê — porque esse "por quê" é o que a tela mostra
// para a pessoa não ficar procurando um botão de enviar que não existe.
// Importados aqui pelo efeito colateral, como `core/server.ts` faz: sem isto o laço rodaria sobre os poucos
// adapters que as outras seções deste arquivo importaram, e não provaria nada do contrato.
for (const p of ['inhire', 'indeed', 'vagaspj', 'divulgavagas', 'workable', 'quickin', 'arbeitnow', 'programathor', 'lever', 'greenhouse']) await import(`./platforms/${p}/index.ts`);
const { adapters: todosAdapters, soDescobre: soDescobreAdapter } = await import('./platforms/adapter.ts');
assert.ok(Object.keys(todosAdapters).length >= 8, `esperava todos os adapters registrados, vieram ${Object.keys(todosAdapters).length}`);
for (const a of Object.values(todosAdapters)) {
  if (a.candidatar && !a.somenteDescoberta) {
    assert.equal(soDescobreAdapter(a.id), false, `${a.id} candidata: não pode ser lido como só-descoberta`);
    continue;
  }
  assert.equal(a.somenteDescoberta, true, `${a.id} não tem candidatar: tem de DECLARAR somenteDescoberta, para a ausência não passar por esquecimento`);
  assert.ok((a.motivoSomenteDescoberta ?? '').length > 20, `${a.id}: o motivo é o texto que a tela mostra; escreva um de verdade`);
  assert.equal(soDescobreAdapter(a.id), true);
}
// E o catálogo da tela não pode discordar do adapter: campo que a UI mostra e o núcleo não cumpre é mentira
const { PLATAFORMAS: CATALOGO } = await import('../src/dados.ts');

/**
 * `DOMINIOS` (a lista que a extensão recebe) × `PLATAFORMAS` (o catálogo que a tela lê).
 *
 * As duas dizem "esta plataforma exige conta", e discordaram de verdade: o LinkedIn estava em `DOMINIOS` e
 * faltava no catálogo, então `getPlataforma('linkedin')` caía na PRIMEIRA plataforma da lista — o InHire — e
 * uma vaga do LinkedIn apareceria com o nome e a cor errados. É a família de bugs de lista paralela que este
 * projeto já consertou três vezes; agora o teste não deixa voltar.
 */
const { DOMINIOS: TODOS_DOMINIOS } = await import('./importar.ts');
for (const d of TODOS_DOMINIOS) {
  const naTela = CATALOGO.find(p => p.id === d.id);
  assert.ok(naTela, `${d.id} está em DOMINIOS e não está em PLATAFORMAS: getPlataforma cairia na primeira da lista`);
  assert.equal(!!naTela.login, d.login, `${d.id}: DOMINIOS e PLATAFORMAS discordam sobre exigir conta`);
  if (todosAdapters[d.id]?.sessao) assert.equal(d.login, true, `${d.id} tem prova de login no adapter, então DOMINIOS tem de dizer login: true`);
}
/**
 * A regra: a extensão é servida onde o ACV sozinho NÃO termina o trabalho.
 *
 * Era "onde há conta para entrar" (05/10/2026) e isso estava estreito: o Lever (06/10/2026) não pede login
 * nenhum e também não pode ser enviado pelo robô, porque o formulário tem captcha. O que decide é `motor` —
 * o campo que diz quem envia —, e não o sintoma de um dos dois motivos.
 */
const { plataformasConhecidas: servirParaExtensao } = await import('./importar.ts');
const servidasNaExtensao = servirParaExtensao();
assert.ok(servidasNaExtensao.length > 0);
assert.ok(
  servidasNaExtensao.every(p => p.exigeLogin || p.motor === 'extensao'),
  `a extensão só recebe plataforma com login ou cujo envio é dela; veio ${servidasNaExtensao
    .filter(p => !p.exigeLogin && p.motor !== 'extensao')
    .map(p => p.id)
    .join(', ')}`,
);
for (const id of ['linkedin', 'gupy', 'indeed', 'programathor'])
  assert.ok(
    servidasNaExtensao.some(p => p.id === id),
    `${id} exige conta e tem de ser servida à extensão`,
  );
// O Lever não exige conta e ainda assim entra: quem envia ali é a extensão, porque o robô pararia no captcha.
// Sem esta linha, "arrumar" o filtro de volta para `login` passaria no teste e deixaria o Lever sem envio.
assert.ok(
  servidasNaExtensao.some(p => p.id === 'lever' && !p.exigeLogin && p.motor === 'extensao'),
  'o Lever não pede login, mas o núcleo não envia nele (captcha): a extensão tem de receber a plataforma',
);
assert.ok(
  servidasNaExtensao.some(p => p.id === 'greenhouse' && !p.exigeLogin && p.motor === 'extensao'),
  'o Greenhouse idem, com reCAPTCHA no lugar do hCaptcha',
);
for (const id of ['vagaspj', 'divulgavagas', 'quickin', 'workable', 'arbeitnow', 'inhire'])
  assert.ok(!servidasNaExtensao.some(p => p.id === id), `${id} não exige conta e o robô envia: o painel não deve aparecer ali`);
console.log('✓ Extensão: servida onde o ACV não termina sozinho, e DOMINIOS × PLATAFORMAS não divergem');
for (const a of Object.values(todosAdapters)) {
  const naTela = CATALOGO.find(p => p.id === a.id);
  if (!naTela) continue; // adapter de teste não está no catálogo
  assert.equal(!!naTela.somenteDescoberta, !!a.somenteDescoberta, `${a.id}: o catálogo da tela e o adapter discordam sobre candidatar`);
  // E o MOTIVO tem de ser o mesmo nos dois. A tela mostrava uma frase fixa ("não permite candidatura
  // automatizada") que é verdade no Jobbol e mentira no Lever, onde o impedimento é captcha e existe caminho
  // pela extensão. Motivo errado faz desistir de vaga que dá para mandar.
  if (a.somenteDescoberta) assert.equal(naTela.motivoSomenteDescoberta, a.motivoSomenteDescoberta, `${a.id}: o motivo na tela e no núcleo têm de ser o mesmo texto`);
}
console.log('✓ Contrato dos adapters: quem não candidata declara que só descobre, e a tela concorda com o núcleo');

await fecharNavegador();
console.log('\nTudo certo.');
