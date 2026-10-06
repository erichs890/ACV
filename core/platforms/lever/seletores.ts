// Convenções do Lever (jobs.lever.co), levantadas em 06/10/2026 contra a API e o HTML do próprio site.
//
// O QUE FOI CONFIRMADO
//  - `jobs.lever.co/robots.txt` é `User-agent: * / Allow: / / Crawl-delay: 1` — liberado, com ritmo pedido.
//    O `Crawl-delay` é o que manda em `PAUSA_ENTRE_BOARDS_MS`: respeitar o que o site pede é de graça.
//  - **API pública por empresa:** `GET https://api.lever.co/v0/postings/<board>?mode=json` devolve um ARRAY de
//    vagas, 200 para board que existe e 404 para o que não existe. É a mesma API que as empresas usam para
//    embutir as vagas no site delas. Responde ao Node com user-agent próprio, sem chave e sem cabeçalho especial.
//  - Campos de cada vaga: `id` (uuid), `text` (título), `categories { commitment, department, location, team,
//    allLocations }`, `country` (ISO: BR, US, FR...), `workplaceType` (`remote` · `hybrid` · `onsite`),
//    `createdAt` (ms), `opening`/`openingPlain`, `lists[{text, content}]` (as seções: "Requisitos",
//    "Responsabilidades", "What You'll Do"...), `additional`/`additionalPlain`, `descriptionPlain` (só a
//    abertura, não o anúncio inteiro), `hostedUrl` e `applyUrl`.
//  - **`categories.commitment` é texto livre que a empresa digita** e pode ser qualquer coisa: medido em 157
//    vagas de 5 boards, veio "Permanent Full Time Employee" (66), "Permanent" (26), "Mid-Senior Level" (16),
//    "CLT" (11), "Internship" (11), "Director" (5), ausente (5). Ou seja: às vezes é regime, às vezes é
//    senioridade, às vezes é tipo de contrato em inglês. Por isso `regimeDe` só aceita o que é literal
//    ("CLT", "PJ") e devolve `indefinido` no resto — ver o comentário dele em `busca.ts`.
//  - `categories.location` também é texto livre: "Remoto", "São Paulo, Brazil", "Remote, Brasil",
//    "Centro-Oeste do Brasil", "São Paulo". Quem decide se dá para trabalhar ali é `vagaCompativelComLocalizacao`,
//    com `pais` vindo do `country` (campo declarado) e não do texto.
//  - **Formulário de candidatura** (`<hostedUrl>/apply`): HTML estático, `<form id="application-form"
//    enctype="multipart/form-data" method="POST">`, SEM login e sem senha. Campos fixos por `name=`:
//    `resume` (file), `name` (obrigatório), `email` (obrigatório, com `pattern`), `phone` (obrigatório),
//    `location` + `selectedLocation` (hidden, autocomplete), `org`, `urls[LinkedIn]` (obrigatório),
//    `urls[GitHub]`, `urls[Portfolio]`, `urls[Other]`. As perguntas da empresa vêm como
//    `cards[<uuid>][field0..N]` (textarea, text, radio, checkbox) — zero em alguns boards, 27 no da Zippi.
//  - **E o que decidiu o desenho: hCaptcha.** O `apply` carrega `//js.hcaptcha.com/1/secure-api.js` e chama
//    `hcaptcha.render('h-captcha', ...)` + `hcaptcha.execute()`; o botão visível `#btn-submit` é
//    `type="button"` e só depois do token o `#hcaptchaSubmitBtn` (`type="submit"`) dispara o POST. O
//    `sitekey` é **o mesmo** (`e33f87f8-...`) nos quatro boards que o têm, inclusive nos três brasileiros
//    (Zippi, Swile, Neon): é captcha do Lever, não configuração de uma empresa. Um board global (Aircall)
//    não o tinha, o que mostra que dá para desligar — mas as vagas que interessam aqui estão atrás dele.
//
// O QUE NÃO FOI CONFIRMADO AO VIVO
//  - A resposta HTTP de um envio aceito: nenhuma candidatura real foi feita. `ROTA_ENVIO` existe para a prova
//    de envio do motor da extensão (`rede.js`), e está escrita sobre o `action` do formulário, que é a própria
//    URL do `/apply` — se um envio real mostrar outra rota, é aqui que se corrige.
//  - Se o hCaptcha apresenta desafio visual ou passa invisível para um navegador comum. Nos dois casos o
//    caminho é o mesmo: quem clica e, se preciso, resolve, é a pessoa.
//  - Não existe índice público de boards. Não há sitemap em `jobs.lever.co` (404) e o Common Crawl, tentado
//    em 06/10/2026 para `url=jobs.lever.co/*`, devolveu 504 em todas as coleções. A descoberta é por
//    candidato confirmado na API — ver `boards.ts`.
//
// POR QUE O NÚCLEO NÃO CANDIDATA AQUI (e a extensão sim)
//  Captcha é anti-robô, e este projeto não contorna anti-robô nem disfarça automação. Então o adapter é
//  `somenteDescoberta`: acha, pontua e mostra. Enviar continua possível pelo único caminho honesto — o SEU
//  navegador, a sua impressão digital, o seu clique, uma vaga por vez, com você resolvendo o desafio se ele
//  aparecer. É o mesmo arranjo do LinkedIn, por um motivo diferente.

export const LEVER = {
  base: 'https://jobs.lever.co',
  /** A API pública de vagas de um board. Devolve array; 404 = board não existe. */
  api: (board: string) => `https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`,
  /** Página pública de vagas da empresa, que é o que a pessoa abre. */
  urlBoard: (board: string) => `https://jobs.lever.co/${board}`,

  // https://jobs.lever.co/<board>/<uuid> e .../<uuid>/apply
  urlVaga: /^https?:\/\/jobs\.lever\.co\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/([0-9a-f-]{36})/i,

  formulario: '#application-form',
  /** Botão visível. `type="button"`: ele dispara o hCaptcha, e é o captcha que submete. */
  enviar: '#btn-submit',
  captcha: '#h-captcha, #hcaptchaResponseInput',

  encerrada: /this posting is no longer|vaga n[ãa]o (est[áa] mais|encontrada)|posting not found|job not found/i,

  convencoes: {
    proximo: /^(continue|next|avan[çc]ar|continuar)$/i,
    final: /^submit application$|^submit$|^enviar candidatura$/i,
    sucesso: /thank you for applying|application (received|submitted)|obrigad[oa] por se candidatar|candidatura (enviada|recebida)/i,
    nome: 'o Lever',
  },
};

/**
 * Onde a candidatura é criada. O `<form>` não tem `action`, então o POST vai para a própria URL do `/apply`.
 * Serve de prova de envio para o `rede.js` da extensão (invariante 1); o núcleo não envia aqui.
 */
export const ROTA_ENVIO = /jobs\.lever\.co\/[^/]+\/[0-9a-f-]{36}\/apply/i;

/** O `Crawl-delay: 1` do robots.txt, em milissegundos. Não é chute: é o que o site pede. */
export const PAUSA_ENTRE_BOARDS_MS = 1000;

/**
 * Boards por rodada. Cada um é UMA requisição que já traz todas as vagas da empresa — nada de abrir página
 * por vaga, como no Vagas PJ ou no Divulga Vagas. Com 40 boards × 1 s a rodada leva ~40 s, no mesmo porte
 * das outras plataformas, e um ponteiro gira a lista quando ela passar disso.
 */
export const BOARDS_POR_VARREDURA = 40;

/**
 * Pausa entre as páginas de vaga abertas na mesma empresa.
 *
 * Só abre página quem precisa: `lists` vazio na API quer dizer que o corpo do anúncio não veio e tem de ser
 * lido do HTML (CI&T, Swile, Zippi). É o mesmo valor do Vagas PJ, que faz o mesmo tipo de leitura.
 */
export const PAUSA_ENTRE_PAGINAS_MS = 400;

/**
 * Teto de vagas inéditas gravadas por rodada.
 *
 * 120 porque a CI&T sozinha tem 187 vagas publicadas e todas elas precisam da página aberta: 120 × 400 ms ≈ 48 s,
 * o mesmo porte da rodada do Vagas PJ. A primeira varredura cobre o grosso e as seguintes só pegam o que é novo.
 */
export const MAX_VAGAS_POR_VARREDURA = 120;

/**
 * E um teto POR EMPRESA, porque sem ele a maior engole a rodada inteira.
 *
 * Medido na primeira varredura de verdade (06/10/2026): a CI&T é a primeira da lista em ordem alfabética, tem
 * 187 vagas, e sozinha bateu o teto de 120 — a rodada terminou ali e Neon, Swile, Zippi e dLocal, que são 31
 * vagas brasileiras, não foram nem consultadas. Pela rotação elas entrariam na rodada seguinte, mas "a
 * primeira varredura do Lever não trouxe nada da Neon" é o tipo de coisa que parece defeito e não é.
 *
 * 40 cabe folgado em qualquer board e deixa o resto do orçamento para as outras empresas. O que sobra numa
 * empresa grande não se perde: `aVisitar` manda para o fim da fila quem acabou de ser visto, então a CI&T
 * volta depois das outras e vai juntando 40 por rodada.
 */
export const MAX_VAGAS_POR_BOARD = 40;

/** Board que falha este tanto de vezes seguidas sai do ar (a empresa trocou de ATS ou mudou o slug). */
export const FALHAS_PARA_DESATIVAR = 3;

/** `createdAt` mais velho que isto não entra: vaga de um ano atrás no board já foi preenchida. */
export const DIAS_DE_VALIDADE = 180;
