# ACV

App local que acha vagas (InHire, Indeed, Vagas PJ, Divulga Vagas, Quickin, Lever, Greenhouse) e candidata sozinho. Front Vite/React (`src/`) + núcleo Node/Playwright/SQLite (`core/`). PT-BR em tudo: código, comentários, UI, commits.

## Rodar

`npm run core` (núcleo, :4780) + `npm run dev` (UI, :5173) — ou `start.bat`. Dados em `%LOCALAPPDATA%\ACV`.
Antes de commitar: `npm run check` (125 verificações) e `npm run build` (biome + tsc + vite).
`npm run relato` (ou `-- 2` para dois dias) condensa `diario/eventos-*.jsonl` num resumo para ler/colar: falhas
agrupadas por motivo, envio com e sem prova de rede, varredura por plataforma, o que a extensão viu em cada site.

## Fluxo

varredura → score → fila → `executarCandidatura` → adapter → **preencher, anexar, enviar, só então confirmar**.

- `core/queue.ts` — trabalhador serial: encadeia vagas até um portão fechar (robô, modo, janela, intervalo, limite/dia). `rodando` ≠ `ocupado`. Pendência pausa **só aquela vaga**.
  **Dois botões no painel da fila:** *Mapear agora* é a varredura de sempre (`POST /buscar`) — varre as
  plataformas conectadas, pontua e enfileira, com um caminho só e não dois. *Esvaziar a fila*
  (`POST /fila/esvaziar`) tira todas da fila **sem** marcar `recusadaPorVoce` (elas voltam a concorrer) e
  pausa a reposição em `kv['fila:pausada']` — senão o laço de 20 s reencheria e o botão pareceria quebrado.
  Mapear ou dar start liberam. **Não confundir com `POST /limpar`** (zona de perigo das Configurações), que
  apaga o banco inteiro, candidaturas inclusive, e cegaria a trava de currículo repetido.

  **Formar a fila e enviar são coisas diferentes:** `enfileirarCompativeis` roda com o robô PAUSADO (é a fase de
  mapeamento — você vê o plano antes do start) e enche até `automacao.filaAlvo`; quem autoriza envio é
  `motivoDeEspera`, conferido em `girarFila` a cada rodada. Quantas entram agora é `min(filaAlvo − na fila,
  limiteDiario − enviadas hoje − na fila)`: o menor vence, e é sempre o que protege você. Tirar uma da fila
  marca `vaga.recusadaPorVoce` e repõe outra na hora — a marca é campo e não status porque `repontuar()`
  reescreve o status de toda vaga `encontrada`/`ignorada` e apagaria a sua decisão.
- `core/candidatura.ts` — uma candidatura ponta a ponta. `jaCandidatado()` trava duplicata por **empresa + título** (o InHire republica a mesma vaga com outro id).
- `core/platforms/inhire/formulario.ts` — motor adaptativo usado por **todas** as plataformas: descobre campos do DOM a cada etapa, classifica fixo × pergunta extra, preenche, avança. Nunca supõe layout. Cada plataforma passa as suas `Convencoes` (textos dos botões e da confirmação); campo fixo se reconhece pelo `name=`, nunca pelo rótulo.
- `core/idioma.ts` — `idiomaDaVaga(vaga)`: em que idioma o ANÚNCIO está escrito, por contagem de palavras
  funcionais (artigo, preposição, pronome) do título + começo da descrição. Nome de tecnologia não conta: é
  igual nos dois idiomas. Decide pela DESCRIÇÃO, não pelo título — "Software Development Coordinator - INGLÊS
  FLUENTE" pode ser vaga em inglês (e é) ou vaga em português pedindo inglês, e só o corpo diz qual. Erra para
  o **português** de propósito: dizer "inglês" por engano manda currículo traduzido para recrutador brasileiro.
  `executarCandidatura` escolhe o PDF por ele, e vaga em inglês **sem** `inglesPdf` PARA em vez de mandar o
  português — desfecho silencioso (o recrutador descarta e você nunca sabe) é pior que erro na tela. A versão
  em inglês nasce no upload do currículo e é preenchida na subida do núcleo para quem enviou antes disso;
  a tradução usa Google GTX quando não há IA, então não custa chave nem cota. Adaptação por vaga só no
  português: `validarAdaptacao` compara com o markdown original.
- `core/localizacao.ts` — cidade/UF/país e a regra de compatibilidade de lugar. **Uma só, para todas as plataformas**: presencial/híbrida fora do estado ou do país zera; outra cidade do estado perde 40%; remota restrita a país não escolhido zera. Modelo não informado passa — **mas só quando há dúvida de verdade**: com o país conhecido e estrangeiro os dois caminhos recusariam (remota fora da sua lista, presencial em outro país), e aí não há dúvida a favor de quem. `melhorLugar` decide entre VÁRIOS lugares possíveis (o Lever manda `allLocations`, o Greenhouse manda tudo separado por `;`), com lugar vago nunca ganhando de lugar específico. E `paisDoLocal` reconhece os 280 países do ICU, não só os de `src/paises.ts`: aquela lista é a dos países que você ESCOLHE para remoto, e usá-la para responder "que país é este" fazia "Vilnius, Lithuania" virar vazio — ou seja, "a vaga não diz onde é", que passa em tudo.
- `core/platforms/vagaspj/` — vagas PJ: **duas fontes** — o feed RSS (50 itens, o que acabou de sair) e o `sitemap-vagas.xml` (**1.259 vagas**, o acervo), com a peneira de `core/peneira.ts` cortando pelo slug antes de baixar; JSON-LD de cada página (só HTTP), candidatura num formulário de uma etapa. Um anúncio se intromete entre o botão final e o POST (`aposBotaoFinal`).
- `core/platforms/lever/` — **o molde do ATS por mural de empresa**, e o primeiro `somenteDescoberta` em uso. Uma requisição por empresa (`api.lever.co/v0/postings/<board>`) traz o anúncio inteiro de todas as vagas dela: nada de abrir página para descobrir o que a vaga é, e por isso nenhuma peneira. **Mas o corpo do anúncio nem sempre vem na API** — `lists: []` quer dizer que requisitos e responsabilidades estão só no HTML (CI&T, Swile, Zippi), e sem abrir a página o score mediria o "Sobre nós". **E o Lever não envia pelo núcleo: o `/apply` tem hCaptcha** (mesmo `sitekey` nos três boards brasileiros, então é do Lever e não configuração da empresa). Nada nos termos dele nem da Employ proíbe candidato de ler ou candidatar — o impedimento é só o captcha, e captcha não se contorna. O envio é pela extensão, no seu navegador, com o seu clique. Descoberta de empresas: não existe índice público (sem sitemap, e o Common Crawl devolveu 504 em todas as coleções), então é semente curada + confirmação na API — e **confirmar na API não basta**: o board `aircall` devolve 77 vagas cujas páginas são 404, dado velho servido por uma API que não checa se o mural está publicado.
- `core/platforms/boards.ts` — a lista de empresas monitoradas de um ATS por mural, uma por plataforma em `kv['boards:<id>']`. Genérica desde o primeiro uso porque Lever, Greenhouse, Ashby e Teamtailor têm a mesma forma, e a alternativa seria copiar o arquivo trocando o nome. `aVisitar(n)` gira a lista **do mais esquecido para o mais recente**, e o desempate é a ordem da semente, não `listar()` (que ordena por nome, para a tela): na primeira varredura todos empatam em `null`, e ordem alfabética fez a rodada inteira ir para boards americanos enquanto Neon, Swile e Zippi esperavam.
- `core/platforms/greenhouse/` — a varredura mais barata do projeto: `?content=true` traz as vagas **e o anúncio inteiro de cada uma** numa requisição por empresa, então nenhuma página é aberta nunca. Três coisas que só o dado real mostra: o `content` vem com HTML **duas vezes escapado** (`&lt;p&gt;`) e sem desfazer isso o score pontuaria marcação; **não existe campo de modelo de trabalho** — ele está escrito no texto do local ("Brazil (Remote)", "Brazil (São Paulo - Hybrid)"); e não existe campo de contrato, então o regime fica `indefinido` em todas. Envio pela extensão, como no Lever: aqui o captcha é reCAPTCHA Enterprise invisível. Board confirmado na API ainda pode estar fora do ar — `coinbase` e `sofi` respondem 200 na API e **403 na página**, o mesmo bloqueio por impressão digital que reprovou o Jobbol, e ficam de fora.
- `core/diario.ts` + `core/relato.ts` — duas formas do mesmo histórico. `diario/acv-DIA.log` é prosa, para ler;
  `diario/eventos-DIA.jsonl` é um objeto por linha (`candidatura.desfecho`, `fila.recusa`, `varredura.plataforma`,
  `extensao.pagina`, `erro.processo`), para **contar**. A prosa não diz plataforma, id da vaga nem se houve prova
  de rede, e reconstruir dado a partir de frase já me fez errar uma resposta. Evento novo: nome em `assunto.fato`,
  e **nada de dado pessoal** — o diário é o arquivo que se cola num chat pedindo ajuda.
- `core/falhas.ts` — falha transitória volta à fila (2/10/30 min, 3x); captcha/vaga encerrada/recusa do servidor, não.
- **Site cujos termos proíbem automação** entra em `SEM_AUTOMACAO` (`extensao/comum.js`) e a extensão recusa
  candidatar lá por **todos** os caminhos, inclusive o modo genérico — que é o ramo de "site desconhecido" e
  por isso NÃO protege nada quando se remove uma plataforma do cadastro. A lista mora na extensão, e não no
  núcleo, porque recusa que depende de servidor no ar não é recusa. O catálogo (`src/dados.ts`) repete o
  motivo para a pessoa ler, com teste cruzando os dois. Primeiro caso: Jobbol (cláusula 5.3).
- `extensao/` + `core/extensao.ts` — extensão MV3 **autossuficiente**: guarda a própria configuração em `chrome.storage.local` (`comum.js`) e funciona com o ACV fechado, sincronizando quando ele abre (`fundo.js`; o que foi feito offline fica em `pendentes` e sobe depois). `conteudo.js` tem o registro `PlatformHandler` (dedicado por domínio, `GENERICO` para o resto, LinkedIn incluído), `motor.js` preenche e envia **uma vaga por clique seu**, `painel.js` é a UI sobre a página e `rede.js` (mundo MAIN) dá a prova de envio por HTTP. **`rede.js` e o resto da extensão não compartilham `window`** (mundo da página × mundo isolado): o que cruza é o DOM — eventos (`acv-rede`, `acv-ensaio`) e `documentElement.dataset`. Variável de `window` entre os dois nunca funciona, e o teste não pega porque injeta tudo no mesmo mundo. Regras que não se negociam lá: só preenche o que já é seu (resposta salva ganha do campo fixo; nada sai de parecença), pergunta nova **para** a candidatura, a IA só responde pelo núcleo (onde ficam as travas de autodeclaração e dado pessoal), e nenhum disfarce de automação — ritmo sorteado, limite por dia, aquecimento de plataforma nova e parada no primeiro sinal de restrição. Fronteira de confiança: `/extensao/*` exige token; como agora ela PREENCHE, recebe valores de verdade do perfil (antes só booleanos).
- `core/importar.ts` — ponte "candidata nesta vaga que está aberta no meu navegador". A extensão manda a URL, isto acha a vaga na lista (comparando sem www, barra final nem rastreio) ou **importa** (InHire: tenant + jobId da URL → API → `montarVaga`), e `POST /extensao/candidatar` roda o adapter do núcleo e **espera o desfecho**. Em plataforma com adapter o motor do núcleo é o caminho bom; o da extensão é para quem não tem. `DOMINIOS` é a lista única de "que plataforma atende esta URL" (a ponte precisa dela para importar e para recusar com motivo), e `motor` ali é o que decide onde a extensão APARECE: **as plataformas em que o ACV sozinho não termina o trabalho** (`plataformasConhecidas` = `login || motor === 'extensao'`). Onde o robô dá conta ele é melhor que a extensão — adapta currículo, respeita o ensaio, prova o envio e tem a trava de duplicidade —, então painel ali é ruído sobre uma página onde não há nada a decidir. São DOIS os motivos para ele não dar conta, e por meses só um tinha nome: **entrar na sua conta** (`login: true`) e **passar por captcha**, que apareceu com o Lever — site sem login nenhum que o filtro antigo deixava de fora como se o robô resolvesse. Site desconhecido continua ganhando o modo genérico, que não depende desta lista. **Três listas estáticas têm de concordar com ela, e o teste cobra:** os `matches` do `rede.js` no manifesto, os `limiteDiarioPorPlataforma` do `comum.js`, e `PLATAFORMAS` em `src/dados.ts`.
- `core/sessao.ts` — login manual assistido para plataforma com conta (Indeed; Gupy depois): janela visível do robô na página de login, a pessoa entra, o robô só observa a URL sair das telas de login e então a **prova de login** do adapter (`adapter.sessao`). Sessão fica no perfil persistente do navegador (cifrado pelo SO), nada no banco além de `conexoes[id].sessao {validadaEm, valida}`. Sessão caída segura a fila só daquela plataforma. Nunca ler o formulário de login; nunca contornar anti-robô.

## Invariantes

1. **Sucesso é a resposta HTTP**, não texto na tela: 2xx em `ROTAS_ENVIO` = enviada. Texto muda, API não. Nunca reportar erro depois de um envio comprovado; nunca clicar no botão final duas vezes.
2. **Nunca inventar nada no currículo.** `validarAdaptacao` compara palavra a palavra; qualquer termo novo descarta a adaptação e manda o original.
3. **Autodeclaração** (gênero, raça, PcD, religião, saúde) nunca sai de similaridade, de currículo nem de IA — só da escolha explícita do usuário (`src/sensiveis.ts`). No **Sem Piedade** a única coisa que o robô pode responder sozinho é a **recusa a declarar**, e só quando a vaga oferece a opção (`decidirSensivel`, regra 4): é a resposta que não afirma nada sobre a pessoa. Vaga que exige a declaração e não oferece recusa **para e espera por ela** — esse é o limite honesto de "delega tudo para a IA". **Dado pessoal** (`DADO_PESSOAL`: documento, endereço, contato, dinheiro, data) também não passa pela IA: errar isso vai num formulário real.
4. **Uma vaga, uma candidatura.** Só existem DOIS lugares que inserem candidatura, e cada caminho até eles tem cadeado:

   | caminho | cadeado |
   |---|---|
   | fila do robô | `enfileirarCompativeis` filtra `!jaCandidatado` **e** `executarCandidatura` reconfere no ponto de uso |
   | "Quero me candidatar" no ACV | `candidatarAgora` lança em `jaEnviada`/`jaCandidatado`, e o ponto de uso reconfere |
   | ponte da extensão (`POST /extensao/candidatar`) | cai em `candidatarAgora` — mesmos dois |
   | motor da extensão, no navegador | pergunta ao núcleo (`POST /extensao/ja-candidatou` → `jaCandidatou`: URL sem rastreio + empresa&nbsp;+&nbsp;título + nome de empresa normalizado) e, com o ACV fechado, cai no cadeado local de `chrome.storage.local`, gravado **antes** de sincronizar |
   | relato chegando ao histórico (`receberCandidaturas`) | **não é envio, é fato passado**: registra sempre e ALERTA se repete empresa+título. Descartar cegaria `jaCandidatado` e o robô mandaria um terceiro currículo |

   `jaCandidatou` é mais forte que `chaveDaVaga` de propósito: o caminho da extensão cruza plataformas, e lá a
   mesma empresa vem escrita de outro jeito ("Acme Tecnologia Ltda" × "ACME S.A."). `normalizarEmpresa`
   (`src/dados.ts`, com cópia travada por teste em `comum.js`) erra para o lado de JUNTAR — juntar errado custa
   uma candidatura perdida, separar errado custa dois currículos na mesa do mesmo recrutador.

   **Risco residual, nomeado:** com o ACV **fechado**, o cadeado da extensão é por URL — a mesma vaga
   republicada em outra URL passaria. Com o ACV aberto, o núcleo pega.
5. **Ensaio não envia.** No núcleo, as rotas de envio ficam abortadas no navegador do robô; **na extensão**, `rede.js` recusa toda escrita enquanto o ensaio está armado — `fetch`, XHR, o evento `submit` **e `HTMLFormElement.prototype.submit`**, que chamado por JavaScript não dispara evento nenhum — por MÉTODO, não por caminho, e desarmado no fim da tentativa. Nos dois casos o motor preenche e clica normalmente: o que segura é a rede, porque formulário que abre por botão de JavaScript só revela os campos depois do clique. Desligar o ensaio devolve as vagas ensaiadas à fila (`podeEntrarNaFila`) — senão elas ficam órfãs: a tela mostra, o robô nunca pega.

## Uma fonte por campo

| Dado | Dono |
|---|---|
| nome, e-mail, celular, LinkedIn, CPF, cidade, pretensão, **cargo desejado** | `perfil` (Configurações › Meus Dados) |
| senioridade, área, rigor de função | `automacao` — editável **só** em Configurações; Automação espelha |
| cidade (presencial/híbrida) e países aceitos (remota) | `perfil.cidade` + `perfil.paisesRemoto` → `ler.localizacao()` |
| ritmo, limite, janela, modo, ensaio, adaptação, tamanho da fila, regime preferido (`CLT` · `PJ` · `qualquer` · `perguntar`), modo de perguntas (`manual` · `duvida` · `sem_piedade`) | `automacao` (Automação, que **grava sozinha** 600 ms depois de cada mudança) |
| plataforma ligada **e se está no foco da automação** (`enviar`) | `conexoes` — editável **só** em Automação; Plataformas espelha |
| respostas de autodeclaração | `sensiveis` |
| perguntas das empresas | `perguntas` |
| modelos de IA (id, preço, nota, padrão) | `MODELOS_IA` em `src/dados.ts` — `core/ia.ts` deriva dela |

Nunca criar um segundo lugar que edite o mesmo campo. Campo que a UI mostra e o núcleo não lê é mentira: ou implementa, ou remove.

`core/peneira.ts` é a peneira que vem ANTES de qualquer download: `slugInteressa(slug, termosDoPerfil(...))`.
É o que torna varredura funda viável (41 mil vagas no Divulga Vagas, 1.259 no Vagas PJ) e é grosseira de
propósito — só precisa não jogar fora vaga boa; quem decide é o score, depois de ler a página.

## Score (`core/resume/score.ts`)

Competências (60) + título (40), multiplicado por função, área, senioridade e local. Decisões que já custaram caro:

- Função é comparada por **família** (`FAMILIAS_CARGO`), não por semelhança de texto — "Analista de Processos" tinha 0,42 de similaridade com "Desenvolvedor Full Stack". Famílias afins (dev, IA, QA, dados, segurança) contam como a mesma.
- Competência conta dos **dois lados**: vaga genérica que cita "sql, rest, testes" não pode dar 100%.
- Senioridade do currículo é o nível **mais alto** (`inferirSenioridadeDoCurriculo`) — `inferirSenioridade` é para vaga e pega o mais baixo.
- Localização não se duplica: use `vagaCompativelComLocalizacao` de `core/localizacao.ts`.
- Mexeu no score? Suba `SCORE_VERSAO` em `core/server.ts`.

## Plataforma nova: pare no primeiro sinal de restrição

Antes de escrever adapter, leia **os termos de uso** e teste **um GET simples**. O Jobbol (05/10/2026) reprovou
nos dois: a cláusula 5.3 proíbe "candidaturas automáticas ou em massa por sistemas automatizados", e o
Cloudflare devolve **403 para o cliente HTTP do Node enquanto o curl recebe 200 no mesmo segundo, do mesmo IP,
com os mesmos headers** (3/3 rodadas) — bloqueio por impressão digital do cliente, não por ritmo nem por
user-agent. Trocar para Playwright ali seria usar um navegador real só para furar um controle que existe para
barrar quem não é navegador: é o disfarce que a regra da extensão proíbe. Investigação registrada no
`agentlog.md`; não vale refazer.

`PlatformAdapter.somenteDescoberta` existe desde então (achar e ranquear sem candidatar), com as três travas
nos pontos de uso e teste próprio. Ninguém deve candidatar pelo NÚCLEO numa plataforma marcada assim.
**O primeiro usuário dele é o Lever (06/10/2026), e por um motivo diferente do que a marca foi criada para
atender:** lá os termos não proíbem nada — o formulário tem captcha. Por isso o motivo é um campo
(`motivoSomenteDescoberta`, espelhado em `src/dados.ts` e cobrado por teste) e não uma frase fixa na tela: a
frase era "não permite candidatura automatizada", que é verdade no Jobbol e mentira no Lever, onde existe
caminho pela extensão. Motivo errado faz desistir de vaga que dá para mandar.

## Ao mexer

Teste primeiro em `core/self-check.ts` (puro), `core/fila-check.ts` (fila com adapter falso) ou `core/envio-check.ts` (InHire falso local). Bug achado = cenário novo.
Nada de dependência nova sem necessidade real. Histórico e decisões em `agentlog.md` — registre lá o que mudou e **por quê**.
