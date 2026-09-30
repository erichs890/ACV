// Seletores, URLs e convenções do Quickin (jobs.quickin.io)
// Plataforma ATS brasileira com 628 empresas em sitemap público.
// Os campos do formulário não usam `name=`, apenas `id=`.

export const QUICKIN = {
  sitemapIndex: 'https://jobs.quickin.io/sitemap.xml',
  sitemaps: (empresa: string) => `https://jobs.quickin.io/sitemaps/${empresa}-jobs.xml`,
  formulario: (empresa: string, jobId: string) => `https://jobs.quickin.io/${empresa}/apply?job_id=${jobId}`,

  // Campos identificados por ID
  campos: {
    nome: 'input#name',
    email: 'input#email',
    celular: 'input[placeholder*="00000-0000"], input[type="tel"]',
    pretensao: 'input#salary',
    cidade: 'input#city',
    regiao: 'input#region',
    endereco: 'input#address',
    cep: 'input#zipcode',
    bairro: 'input#neighborhood',
    resumo: 'textarea#summary',
    curriculo: 'input#validatedCustomFile, input[type="file"]',
    termos: 'input#consent, input[type="checkbox"][id*="consent" i]',
    submit: 'button[type="submit"]:has-text("Finalizar"), button:has-text("Finalizar"), button[type="submit"]',
  },

  // Rota HTTP de envio da candidatura
  rotaEnvio: /\/public\/[^/]+\/apply/i,
  rotaEnvioGlob: '**/public/*/apply*',

  // Sucesso na tela após envio
  sucesso: /candidatura enviada|inscri[çc][ãa]o realizada|curr[ií]culo enviado|obrigad[oa]|sucesso|recebemos/i,

  // Vaga encerrada
  encerrada: /vaga encerrada|oportunidade encerrada|n[ãa]o est[áa] mais dispon[íi]vel|p[áa]gina n[ãa]o encontrada|404/i,
};

export const ESPERA_ENVIO_MS = 25_000;
export const MAX_VAGAS_POR_VARREDURA = 30;
export const PAUSA_ENTRE_PAGINAS_MS = 1_000;
