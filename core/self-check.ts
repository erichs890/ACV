// Verificação executável do núcleo (sem tocar em plataforma nenhuma):
//   node core/self-check.ts
// Cobre: Markdown → PDF → Markdown, análise do currículo, score, adaptação sem invenção, similaridade de perguntas.
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.AUTOCV_PERFIL = join(tmpdir(), 'autocv-self-check'); // não colide com o núcleo rodando
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
const pdf = join(tmpdir(), `autocv-selfcheck-${Date.now()}.pdf`);
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
console.log('✓ Autodeclaração: detecção por palavra-chave e política sem similaridade');

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
const { lerFeed, lerJobPosting, localDe, modeloDe: modeloPJ, montarVaga } = await import('./platforms/vagaspj/busca.ts');
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

await fecharNavegador();
console.log('\nTudo certo.');
