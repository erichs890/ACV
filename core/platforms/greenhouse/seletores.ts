// Convenções do Greenhouse (job-boards.greenhouse.io), levantadas em 06/10/2026 contra a API e o HTML do site.
//
// O QUE FOI CONFIRMADO
//  - `job-boards.greenhouse.io/robots.txt` não bloqueia nada: o arquivo é só o comentário de exemplo, com as
//    linhas `Disallow` COMENTADAS. (`boards.greenhouse.io` bloqueia apenas `/embed/`, que não é usado aqui.)
//  - **API pública por empresa:** `GET https://boards-api.greenhouse.io/v1/boards/<board>/jobs?content=true`
//    devolve `{ jobs: [...], meta: { total } }`, 200 para board que existe e 404 (`{"error":"Job not found"}`)
//    para o que não existe. É a API que o próprio Greenhouse documenta para as empresas embutirem as vagas.
//  - **E ela traz o anúncio INTEIRO**, o que a do Lever não faz: `content` veio com 10.184 caracteres numa vaga
//    do QuintoAndar. Nenhuma página precisa ser aberta — é a varredura mais barata do projeto.
//  - `content` vem com HTML **duas vezes escapado** (`&lt;p&gt;`): é preciso desescapar antes de tirar as tags,
//    senão o texto sai cheio de `&lt;p&gt;` e as competências saem erradas.
//  - Campos: `id`, `title`, `company_name` (o nome pronto, sem precisar ler `<title>`), `location.name`,
//    `offices[{name, location}]`, `departments[]`, `metadata[{name, value}]`, `absolute_url`, `updated_at`,
//    `first_published`, `requisition_id`, `language`, `application_deadline`.
//  - **`location.name` é texto livre, pode trazer VÁRIOS lugares separados por `;`** e é onde o modelo de
//    trabalho costuma estar escrito. Medido em 667 vagas de 6 boards: "Brasil", "São Paulo, São Paulo, Brazil",
//    "Brazil (Remote)", "Brazil (São Paulo - Hybrid)", "Remoto",
//    "Brasil; São Paulo, São Paulo, Brazil", "Boston, Massachusetts, USA; New York, New York, USA".
//    Não existe campo de modelo de trabalho: `modeloDe` lê o texto do local e, em último caso, o anúncio.
//  - `offices[].name` costuma trazer a cidade de verdade quando `location.name` diz só "Brasil" — por isso ele
//    entra na lista de lugares possíveis que `melhorLugar` avalia.
//  - Não há campo de tipo de contrato: o regime fica `indefinido` em todas (ver `montarVaga`).
//
// O QUE NÃO FOI CONFIRMADO AO VIVO
//  - A resposta HTTP de um envio aceito: nenhuma candidatura real foi feita. `ROTA_ENVIO` está escrita sobre o
//    endereço do formulário e é o que a extensão usa como prova de envio; se um envio real mostrar outra rota,
//    é aqui que se corrige.
//  - Os termos para CANDIDATO. `greenhouse.com/legal` responde 200 com o título "Terms of service", mas o
//    corpo servido é a navegação do site; as páginas `/legal/terms-of-use` dão 404. Não foi possível ler uma
//    cláusula que proíba — e também não foi possível ler uma que permita. Como a descoberta usa só a API
//    pública que eles publicam para embutir vagas, e o envio NÃO é automatizado (ver abaixo), isto não está no
//    caminho de nada. Se um dia o envio for considerado, a leitura dos termos tem de ser refeita primeiro.
//
// POR QUE O NÚCLEO NÃO CANDIDATA AQUI (e a extensão sim)
//  Mesma história do Lever, com outro captcha: a página do formulário carrega **reCAPTCHA Enterprise
//  invisível** (`GOOGLE_RECAPTCHA_INVISIBLE_KEY` e `recaptcha.net/recaptcha/enterprise.js` no estado inicial
//  da aplicação). Captcha é anti-robô, e este projeto não contorna anti-robô nem disfarça automação. Então o
//  adapter é `somenteDescoberta`, e o envio fica no único caminho honesto — o SEU navegador, com o SEU
//  clique, uma vaga por vez, você respondendo o desafio se ele aparecer.
//
//  Detalhe que importa para a extensão: o formulário é montado por JavaScript (a aplicação é React/Remix, o
//  HTML servido vem sem `<input name=...>` nenhum). Não é problema no navegador — o motor lê o DOM vivo —,
//  mas é o motivo de não existir aqui uma lista de campos fixos como a do Vagas PJ.

export const GREENHOUSE = {
  base: 'https://job-boards.greenhouse.io',
  /** A API pública de vagas de um board, já com o anúncio inteiro. 404 = board não existe. */
  api: (board: string) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`,
  /** A mesma API sem o conteúdo: serve para confirmar que um candidato a board existe, sem baixar tudo. */
  apiLeve: (board: string) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs`,
  /** Página pública de vagas da empresa, que é o que a pessoa abre. */
  urlBoard: (board: string) => `https://job-boards.greenhouse.io/${board}`,

  // https://job-boards.greenhouse.io/<board>/jobs/<id>
  urlVaga: /^https?:\/\/job-boards\.greenhouse\.io\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/jobs\/(\d+)/i,

  formulario: '#application-form',
  captcha: '.g-recaptcha, [data-sitekey]',

  encerrada: /this job is no longer|job not found|vaga n[ãa]o (est[áa] mais|encontrada)/i,

  convencoes: {
    proximo: /^(continue|next|avan[çc]ar|continuar)$/i,
    final: /^(enviar inscri[çc][ãa]o|submit application|enviar candidatura)$/i,
    sucesso: /thank you for applying|application (received|submitted)|inscri[çc][ãa]o (enviada|recebida)|obrigad[oa] (por se candidatar|pela inscri)/i,
    nome: 'o Greenhouse',
  },
};

/** Onde a candidatura é criada. Prova de envio para o `rede.js` da extensão; o núcleo não envia aqui. */
export const ROTA_ENVIO = /job-boards\.greenhouse\.io\/[^/]+\/(jobs\/\d+|applications)\b/i;

/** Não há `Crawl-delay` publicado; 1 s é o mesmo ritmo que o Lever pede, e ritmo não se economiza. */
export const PAUSA_ENTRE_BOARDS_MS = 1000;

/**
 * Boards por rodada. Cada um é UMA requisição que já traz as vagas e os anúncios inteiros — sem página por
 * vaga, ao contrário do Lever. Por isso cabe mais empresa por rodada: 60 × 1 s ≈ 60 s.
 */
export const BOARDS_POR_VARREDURA = 60;

/** Teto por rodada. Só trabalho de CPU aqui (a rede já trouxe tudo), então ele é mais generoso que o do Lever. */
export const MAX_VAGAS_POR_VARREDURA = 200;

/**
 * Teto por empresa, pelo mesmo motivo que o do Lever existe: sem ele a maior engole a rodada.
 * Aqui há boards de 723 vagas (Stripe) e 434 (Datadog) — um só consumiria tudo.
 */
export const MAX_VAGAS_POR_BOARD = 60;

/** Board que falha este tanto de vezes seguidas sai do ar. */
export const FALHAS_PARA_DESATIVAR = 3;

/** `updated_at` mais velho que isto não entra: vaga parada há meio ano no board já foi preenchida. */
export const DIAS_DE_VALIDADE = 180;
