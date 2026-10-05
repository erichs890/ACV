# ACV

App local que acha vagas (InHire, Indeed, Vagas PJ, Divulga Vagas) e candidata sozinho. Front Vite/React (`src/`) + núcleo Node/Playwright/SQLite (`core/`). PT-BR em tudo: código, comentários, UI, commits.

## Rodar

`npm run core` (núcleo, :4780) + `npm run dev` (UI, :5173) — ou `start.bat`. Dados em `%LOCALAPPDATA%\ACV`.
Antes de commitar: `npm run check` (106 verificações) e `npm run build` (biome + tsc + vite).
`npm run relato` (ou `-- 2` para dois dias) condensa `diario/eventos-*.jsonl` num resumo para ler/colar: falhas
agrupadas por motivo, envio com e sem prova de rede, varredura por plataforma, o que a extensão viu em cada site.

## Fluxo

varredura → score → fila → `executarCandidatura` → adapter → **preencher, anexar, enviar, só então confirmar**.

- `core/queue.ts` — trabalhador serial: encadeia vagas até um portão fechar (robô, modo, janela, intervalo, limite/dia). `rodando` ≠ `ocupado`. Pendência pausa **só aquela vaga**.
- `core/candidatura.ts` — uma candidatura ponta a ponta. `jaCandidatado()` trava duplicata por **empresa + título** (o InHire republica a mesma vaga com outro id).
- `core/platforms/inhire/formulario.ts` — motor adaptativo usado por **todas** as plataformas: descobre campos do DOM a cada etapa, classifica fixo × pergunta extra, preenche, avança. Nunca supõe layout. Cada plataforma passa as suas `Convencoes` (textos dos botões e da confirmação); campo fixo se reconhece pelo `name=`, nunca pelo rótulo.
- `core/localizacao.ts` — cidade/UF/país e a regra de compatibilidade de lugar. **Uma só, para todas as plataformas**: presencial/híbrida fora do estado ou do país zera; outra cidade do estado perde 40%; remota restrita a país não escolhido zera.
- `core/platforms/vagaspj/` — vagas PJ: lista pelo feed RSS + JSON-LD de cada página (só HTTP), candidatura num formulário de uma etapa. Um anúncio se intromete entre o botão final e o POST (`aposBotaoFinal`).
- `core/diario.ts` + `core/relato.ts` — duas formas do mesmo histórico. `diario/acv-DIA.log` é prosa, para ler;
  `diario/eventos-DIA.jsonl` é um objeto por linha (`candidatura.desfecho`, `fila.recusa`, `varredura.plataforma`,
  `extensao.pagina`, `erro.processo`), para **contar**. A prosa não diz plataforma, id da vaga nem se houve prova
  de rede, e reconstruir dado a partir de frase já me fez errar uma resposta. Evento novo: nome em `assunto.fato`,
  e **nada de dado pessoal** — o diário é o arquivo que se cola num chat pedindo ajuda.
- `core/falhas.ts` — falha transitória volta à fila (2/10/30 min, 3x); captcha/vaga encerrada/recusa do servidor, não.
- `extensao/` + `core/extensao.ts` — extensão MV3 **autossuficiente**: guarda a própria configuração em `chrome.storage.local` (`comum.js`) e funciona com o ACV fechado, sincronizando quando ele abre (`fundo.js`; o que foi feito offline fica em `pendentes` e sobe depois). `conteudo.js` tem o registro `PlatformHandler` (dedicado por domínio, `GENERICO` para o resto, LinkedIn incluído), `motor.js` preenche e envia **uma vaga por clique seu**, `painel.js` é a UI sobre a página e `rede.js` (mundo MAIN) dá a prova de envio por HTTP. Regras que não se negociam lá: só preenche o que já é seu (resposta salva ganha do campo fixo; nada sai de parecença), pergunta nova **para** a candidatura, a IA só responde pelo núcleo (onde ficam as travas de autodeclaração e dado pessoal), e nenhum disfarce de automação — ritmo sorteado, limite por dia, aquecimento de plataforma nova e parada no primeiro sinal de restrição. Fronteira de confiança: `/extensao/*` exige token; como agora ela PREENCHE, recebe valores de verdade do perfil (antes só booleanos).
- `core/importar.ts` — ponte "candidata nesta vaga que está aberta no meu navegador". A extensão manda a URL, isto acha a vaga na lista (comparando sem www, barra final nem rastreio) ou **importa** (InHire: tenant + jobId da URL → API → `montarVaga`), e `POST /extensao/candidatar` roda o adapter do núcleo e **espera o desfecho**. Em plataforma com adapter o motor do núcleo é o caminho bom; o da extensão é para quem não tem. `DOMINIOS` é a lista que a extensão recebe para saber onde oferecer o botão.
- `core/sessao.ts` — login manual assistido para plataforma com conta (Indeed; Gupy depois): janela visível do robô na página de login, a pessoa entra, o robô só observa a URL sair das telas de login e então a **prova de login** do adapter (`adapter.sessao`). Sessão fica no perfil persistente do navegador (cifrado pelo SO), nada no banco além de `conexoes[id].sessao {validadaEm, valida}`. Sessão caída segura a fila só daquela plataforma. Nunca ler o formulário de login; nunca contornar anti-robô.

## Invariantes

1. **Sucesso é a resposta HTTP**, não texto na tela: 2xx em `ROTAS_ENVIO` = enviada. Texto muda, API não. Nunca reportar erro depois de um envio comprovado; nunca clicar no botão final duas vezes.
2. **Nunca inventar nada no currículo.** `validarAdaptacao` compara palavra a palavra; qualquer termo novo descarta a adaptação e manda o original.
3. **Autodeclaração** (gênero, raça, PcD, religião, saúde) nunca sai de similaridade, de currículo nem de IA — só da escolha explícita do usuário (`src/sensiveis.ts`). **Dado pessoal** (`DADO_PESSOAL`: documento, endereço, contato, dinheiro, data) também não passa pela IA: errar isso vai num formulário real.
4. **Uma vaga, uma candidatura.** Em qualquer caminho: fila, clique manual, retomada de pendência.
5. **Ensaio não envia.** As rotas de envio ficam abortadas no navegador. Desligar o ensaio devolve as vagas ensaiadas à fila (`podeEntrarNaFila`) — senão elas ficam órfãs: a tela mostra, o robô nunca pega.

## Uma fonte por campo

| Dado | Dono |
|---|---|
| nome, e-mail, celular, LinkedIn, CPF, cidade, pretensão, **cargo desejado** | `perfil` (Configurações › Meus Dados) |
| senioridade, área, rigor de função | `automacao` — editável **só** em Configurações; Automação espelha |
| cidade (presencial/híbrida) e países aceitos (remota) | `perfil.cidade` + `perfil.paisesRemoto` → `ler.localizacao()` |
| ritmo, limite, janela, modo, ensaio, adaptação, modo de perguntas (`manual` · `duvida` · `sem_piedade`) | `automacao` (Automação) |
| plataforma ligada **e se está no foco da automação** (`enviar`) | `conexoes` — editável **só** em Automação; Plataformas espelha |
| respostas de autodeclaração | `sensiveis` |
| perguntas das empresas | `perguntas` |
| modelos de IA (id, preço, nota, padrão) | `MODELOS_IA` em `src/dados.ts` — `core/ia.ts` deriva dela |

Nunca criar um segundo lugar que edite o mesmo campo. Campo que a UI mostra e o núcleo não lê é mentira: ou implementa, ou remove.

## Score (`core/resume/score.ts`)

Competências (60) + título (40), multiplicado por função, área, senioridade e local. Decisões que já custaram caro:

- Função é comparada por **família** (`FAMILIAS_CARGO`), não por semelhança de texto — "Analista de Processos" tinha 0,42 de similaridade com "Desenvolvedor Full Stack". Famílias afins (dev, IA, QA, dados, segurança) contam como a mesma.
- Competência conta dos **dois lados**: vaga genérica que cita "sql, rest, testes" não pode dar 100%.
- Senioridade do currículo é o nível **mais alto** (`inferirSenioridadeDoCurriculo`) — `inferirSenioridade` é para vaga e pega o mais baixo.
- Localização não se duplica: use `vagaCompativelComLocalizacao` de `core/localizacao.ts`.
- Mexeu no score? Suba `SCORE_VERSAO` em `core/server.ts`.

## Ao mexer

Teste primeiro em `core/self-check.ts` (puro), `core/fila-check.ts` (fila com adapter falso) ou `core/envio-check.ts` (InHire falso local). Bug achado = cenário novo.
Nada de dependência nova sem necessidade real. Histórico e decisões em `agentlog.md` — registre lá o que mudou e **por quê**.
