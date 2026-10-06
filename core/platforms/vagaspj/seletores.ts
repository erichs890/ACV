// Convenções do Vagas PJ (vagaspj.com.br), levantadas em 21/09/2026 lendo o HTML e os scripts do próprio site.
//
// O QUE FOI CONFIRMADO
//  - Site Laravel, renderizado no servidor, sem login e sem bloqueio de robô: `curl` simples recebe 200.
//  - A busca (/buscar-vagas) é filtrada no cliente — os parâmetros de URL não mudam o resultado. A listagem que
//    presta é o feed RSS `/feed-vagas.xml`: 50 vagas com título, link, guid e pubDate. A descrição dele vem
//    truncada e só 2 dos 50 títulos dizem o modelo de trabalho, por isso a busca abre a página de cada vaga nova.
//  - Cada página de vaga traz um `application/ld+json` com `@graph` → `JobPosting`: title, description completa,
//    hiringOrganization.name, jobLocation.address (locality/region/country), employmentType CONTRACTOR,
//    occupationalCategory, datePosted, validThrough e, nas remotas, jobLocationType "TELECOMMUTE".
//    Híbrido não aparece no JSON-LD: vem escrito no título ("| Híbrido em Fortaleza/CE") ou no texto.
//  - `data-externa="1"` marca vaga cuja candidatura é em outro site (Gupy etc.). Essas o robô não envia.
//  - Formulário: `#formCandidatura`, POST multipart para https://www.vagaspj.com.br/candidaturas — página inteira,
//    não AJAX (o `$.ajax` da página é do formulário de avisos, `#formNotificar`). Campos obrigatórios com `name=`
//    limpo: name, telefone, email, linkedin (type=url, `pattern` exige linkedin.com/in), tipocnpj (MEI/ME/Não tenho)
//    e pdf (file). Os rótulos visíveis não existem — o motor casa pelo `name=` (CAMPO_FIXO).
//  - Botões: "Candidatar agora" só revela o formulário; dentro do formulário ficam "Voltar", "Continuar"
//    (etapas, quando data-total-steps > 1) e o submit "Candidatar" — texto exato, sem "-se".
//  - cv-upload.js valida o PDF no navegador: não-PDF ou acima de 5 MB viram `alert()` e o arquivo é APAGADO do
//    campo (input.value = ''), deixando um campo obrigatório vazio. O "Lendo currículo..." é só um timer de 700 ms,
//    não trava o envio. O adapter confere o tamanho antes de abrir o navegador, para a falha ser clara.
//  - vagas-whatsapp-sale.js intercepta o submit na fase de captura: o primeiro clique em "Candidatar" roda
//    `reportValidity()` e, passando, ABRE UM ANÚNCIO em vez de enviar. O POST só acontece no clique em
//    "Continuar candidatura" (#wppSaleSkip). Se a validação do navegador falha, o clique não faz nada — nem
//    anúncio, nem envio. Por isso o adapter confere a validade antes e trata o anúncio depois (aposBotaoFinal).
//
// O QUE NÃO FOI CONFIRMADO AO VIVO
//  - A resposta de /candidaturas a um envio de verdade (status e destino do redirect) e a tela de sucesso: só
//    dava para saber criando uma candidatura real. Daí a regra de prova em `envioAceito` (index.ts), escrita sobre
//    o padrão POST/redirect/GET do Laravel: voltar para a própria vaga = recusa; qualquer outro destino = aceite.

export const VAGASPJ = {
  base: 'https://www.vagaspj.com.br',
  feed: 'https://www.vagaspj.com.br/feed-vagas.xml',
  /**
   * O sitemap, achado em 06/10/2026: **1.259 vagas** contra as 50 do feed RSS.
   *
   * O `robots.txt` o publica (`Sitemap: /sitemap.xml` → `/sitemap-vagas.xml`) e libera `/vagas/`. A URL traz
   * o título no slug (`/vagas/<empresa>/<id>/<slug>`), o que permite a mesma peneira barata do Divulga Vagas:
   * das 1.259, **449 casam com o perfil dele** — e as outras 810 são descartadas sem baixar nada.
   *
   * O feed continua sendo lido primeiro: ele é a lista do que acabou de sair, e vem com `pubDate`. O sitemap
   * é a cobertura do acervo. Fontes com papéis diferentes, como no Jobbol.
   */
  sitemap: 'https://www.vagaspj.com.br/sitemap-vagas.xml',

  // /vagas/<empresa>/<id>/<slug>
  urlVaga: /^https:\/\/www\.vagaspj\.com\.br\/vagas\/([^/]+)\/(\d+)\//,

  formulario: '#formCandidatura',
  expandir: '#btnExpandirForm', // "Candidatar agora": só revela o formulário (no desktop ele já abre sozinho)
  anuncio: '#wppSaleModal', // anúncio do WhatsApp que se intromete no envio
  dispensarAnuncio: '#wppSaleSkip', // "Continuar candidatura": é este clique que dispara o POST
  externa: '[data-externa="1"]', // candidatura no site da empresa: fora do alcance do robô

  // "Híbrido" não está no JSON-LD; está escrito no título ou no texto da vaga
  hibrido: /h[íi]brid[oa]/i,
  remoto: /\bremot[oa]\b|home office|teletrabalho|anywhere/i,
  encerrada: /vaga (encerrada|expirada|indispon[íi]vel|preenchida)|esta vaga n[ãa]o est[áa] mais/i,

  convencoes: {
    proximo: /^(continuar|avan[çc]ar|pr[óo]xim[oa])$/i, // "Continuar" das etapas; "Voltar" não casa de propósito
    final: /^candidatar$/i, // exato: "Candidatar agora" é o botão que só abre o formulário
    sucesso: /candidatura (enviada|realizada|recebida|conclu|registrada)|recebemos (sua|a sua) candidatura|obrigad[oa] por se candidatar|sua candidatura foi/i,
    nome: 'o Vagas PJ',
  },
};

/** Rota que cria a candidatura. 2xx/3xx aqui é a prova de envio; index.ts explica o caso do redirect. */
export const ROTA_ENVIO = /\/candidaturas\b/i;
export const ROTA_ENVIO_GLOB = '**/candidaturas';

// O envio é um POST de página inteira com o PDF anexado: em 23/09/2026 um envio real passou dos 12 s do
// padrão do Playwright e virou "erro" numa candidatura que o site tinha aceitado. O prazo aqui é o do
// upload, não o de um clique.
export const ESPERA_ENVIO_MS = 90_000;

export const MAX_PDF_BYTES = 5 * 1024 * 1024; // limite que cv-upload.js aplica no navegador

export const PAUSA_ENTRE_PAGINAS_MS = 400; // cortesia com o site ao abrir as vagas novas do feed
/**
 * Teto por rodada. Era 50 porque o feed tinha 50 — agora o limite é de ritmo, não de fonte.
 *
 * 120 × 400 ms ≈ 48 s de rodada, e a varredura agendada roda a cada 6 h: o acervo inteiro que interessa
 * (449 vagas) é coberto em ~4 rodadas, e dali em diante só o que é novo.
 */
export const MAX_VAGAS_POR_VARREDURA = 120;
/** `lastmod` mais velho que isto não é baixado: vaga de 2024 no sitemap já venceu. */
export const DIAS_DE_VALIDADE = 120;
