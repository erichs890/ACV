// Convenções do Divulga Vagas (divulgavagas.com.br), levantadas em 23/09/2026 no HTML e nos scripts do site.
//
// O QUE FOI CONFIRMADO
//  - Sem login, sem captcha. `curl` simples recebe 200 em tudo.
//  - Listagem: 5 sitemaps `job_listing-sitemap{1..5}.xml`, ~41 mil URLs, com `lastmod`. Não há API REST
//    (`/wp-json/...` dá 404), não há feed de vagas e os parâmetros de busca na URL não filtram nada.
//    O que salva: o slug carrega o título (`/vaga-de-emprego/desenvolvedor-python-senior-...-34541421`),
//    então dá para peneirar por texto ANTES de baixar qualquer página — de 11 mil URLs sobraram 102 de dev.
//  - Página da vaga: `application/ld+json` com JobPosting completo — title, datePosted, validThrough,
//    `jobLocationType: "TELECOMMUTE"` nas remotas, jobLocation.address, `skills[]` e `directApply: true`.
//  - O EMPREGADOR NÃO É NOMEADO: `hiringOrganization` é sempre "Divulga Vagas". Ver `EMPRESA_OCULTA`.
//  - Candidatura: da vaga sai um link para `/aviso/<slug>` (só uma tela com "Continuar!") e de lá para
//    `/envioCurriculo/<id>`. O `<id>` é o número do fim do slug, então o robô vai direto ao formulário.
//  - O formulário é `#cvForm`, POST multipart para `/envioCV`, e tem SETE campos e nada mais:
//    `id_vaga` (já vem preenchido), `nome`, `email` e `retorno` (escondidos), `curriculo` (file, obrigatório),
//    `politica` e `pcd` (checkbox).
//  - **A candidatura é só o PDF.** O próprio site preenche os escondidos com texto de enfeite:
//    `$('#cv_name').val('Candidatura para: ' + jobTitle)` e `$('#cv_email').val('contato@candidato.com')`.
//    Nome, e-mail e telefone do perfil não vão para lugar nenhum — o empregador recebe o currículo e mais nada.
//
// O QUE NÃO FOI CONFIRMADO AO VIVO
//  - A resposta de `/envioCV` a um envio de verdade e a tela de sucesso: só criando candidatura real.
//    A prova de envio segue o mesmo desenho do Vagas PJ (ver index.ts).

export const DIVULGA = {
  base: 'https://divulgavagas.com.br',
  sitemaps: [1, 2, 3, 4, 5].map(n => `https://divulgavagas.com.br/job_listing-sitemap${n}.xml`),

  // /vaga-de-emprego/<slug-com-o-titulo>-<id>
  urlVaga: /^https:\/\/divulgavagas\.com\.br\/vaga-de-emprego\/([a-z0-9-]*?)-(\d+)\/?$/,
  formulario: (id: string) => `https://divulgavagas.com.br/envioCurriculo/${id}`,

  form: '#cvForm',
  arquivo: '#arquivo_1',
  termos: '#politica',
  /**
   * "Estou ciente de que esta é uma vaga para PCD e me enquadro nos requisitos." Nasce escondido e só aparece
   * nas vagas exclusivas para PcD. Marcar isso sozinho seria declarar deficiência em nome do usuário para um
   * empregador real — e tomar uma vaga reservada. Invariante 3: some daqui, vai para a pessoa decidir.
   */
  pcd: '#pcd',
  /** O bloco que o site mostra só em vaga PcD. É por ELE que se sabe, não pelo input: o input fica sempre
   *  escondido atrás do visual customizado. A validação do próprio site faz `$('#pcd-container').is(':visible')`. */
  pcdContainer: '#pcd-container',
  enviar: /^enviar curr[ií]culo$/i,

  sucesso: /curr[ií]culo enviado|candidatura (enviada|realizada|recebida|conclu)|recebemos (seu|o seu) curr[ií]culo|enviado com sucesso|obrigad[oa] por se candidatar/i,
  encerrada: /vaga (encerrada|expirada|indispon[íi]vel|preenchida|removida)|n[ãa]o est[áa] mais dispon/i,
};

/** O site nunca diz de quem é a vaga; sem isto, toda vaga viraria "empresa Divulga Vagas". */
export const EMPRESA_OCULTA = 'Empresa não informada (Divulga Vagas)';

/** Rota que cria a candidatura: 2xx/3xx aqui é a prova de envio. */
export const ROTA_ENVIO = /\/envioCV\b/i;
export const ROTA_ENVIO_GLOB = '**/envioCV';

export const PAUSA_ENTRE_PAGINAS_MS = 400;
/** Quantas vagas novas abrir por varredura: o acervo é grande e quase todo fora da área de tecnologia. */
export const MAX_VAGAS_POR_VARREDURA = 40;
export const ESPERA_ENVIO_MS = 90_000;
