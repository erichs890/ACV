// ProgramaThor — mural brasileiro de vagas de tecnologia.
//
// O QUE FOI CONFIRMADO AO VIVO (03/10/2026, sem conta):
//  - `robots.txt` libera `/jobs` (bloqueia só /admin/, /user/, /users/, /company/).
//  - Cada página de vaga tem **JSON-LD JobPosting completo**: title, description, hiringOrganization,
//    jobLocation, datePosted, validThrough, employmentType. É o mesmo formato do Vagas PJ.
//  - A listagem é renderizada no servidor, 15 vagas por página, e o card já traz título, empresa, modelo,
//    porte, senioridade, contrato e as tags de skill.
//  - Filtros por querystring, combináveis: `?expertise=Júnior|Pleno|Sênior`, `?remoto=true`,
//    `?contract_type=CLT|PJ|Estágio`. `?expertise=Pleno&remoto=true` devolve 345 páginas (~5.100 vagas).
//  - URL da vaga: `/jobs/<id>-<slug>`. O sitemap lista 23.509 delas.
//  - **Candidatar exige conta**: deslogado, TODO caminho de candidatura aponta para `/users/sign_up`,
//    inclusive o botão "Quero me candidatar". É daí que sai a prova de sessão (ver `sessao` no index.ts).
//  - Os termos de uso (programathor.com.br/terms, lidos em 03/10/2026) NÃO proíbem automação — diferente do
//    LinkedIn. O que eles dizem é que "o desenvolvedor é responsável por todas as atividades que ocorram na
//    sua conta", o que vale lembrar: aqui o robô age logado como você.
//
// O QUE NÃO FOI CONFIRMADO AO VIVO:
//  - O formulário de candidatura logado. Só existe atrás de conta, e não dá para criar uma para espiar.
//    `convencoes` e `ROTA_ENVIO` abaixo são a melhor leitura possível e devem ser tratadas como hipótese
//    até a primeira candidatura em modo ensaio. É por isso que o modo ensaio existe.

export const PROGRAMATHOR = {
  base: 'https://programathor.com.br',

  /** `/jobs/<id>-<slug>` — o id é o que vira `programathor:<id>` na lista do ACV. */
  urlVaga: /programathor\.com\.br\/jobs\/(\d+)-([a-z0-9-]+)/i,

  /** Monta a listagem filtrada. Os filtros do site batem com os do ACV, o que torna a varredura barata. */
  listagem(filtros: { expertise?: string; remoto?: boolean; contrato?: string }, pagina = 1): string {
    const q = new URLSearchParams();
    if (filtros.expertise) q.set('expertise', filtros.expertise);
    if (filtros.remoto) q.set('remoto', 'true');
    if (filtros.contrato) q.set('contract_type', filtros.contrato);
    if (pagina > 1) q.set('page', String(pagina));
    const s = q.toString();
    return `${this.base}/jobs${s ? `?${s}` : ''}`;
  },

  /** Deslogado, o CTA de candidatura aponta para o cadastro. É este o sinal de "não está logado". */
  ctaDeslogado: /href="\/users\/sign_(up|in)"[^>]*>[^<]*candidat/i,

  encerrada: /vaga (encerrada|expirada|preenchida)|esta vaga n[ãa]o est[áa] mais/i,

  convencoes: {
    proximo: /^(continuar|avan[çc]ar|pr[óo]xim[oa]|seguinte)$/i,
    final: /^(candidatar|quero me candidatar|enviar candidatura|me candidatar)$/i,
    sucesso: /candidatura (enviada|realizada|registrada)|voc[êe] se candidatou|inscri[çc][ãa]o realizada/i,
    nome: 'o ProgramaThor',
  },
};

/** Rota do POST de candidatura. HIPÓTESE: o fluxo logado não foi observado. */
export const ROTA_ENVIO = /\/(job_applications|applications|candidaturas)\b/i;
export const ROTA_ENVIO_GLOB = '**/{job_applications,applications,candidaturas}*';

export const ESPERA_ENVIO_MS = 45_000;
export const PAUSA_ENTRE_PAGINAS_MS = 500; // cortesia com o site ao abrir as vagas novas
export const MAX_VAGAS_POR_VARREDURA = 60;
export const MAX_PAGINAS_POR_VARREDURA = 6; // 6 x 15 = 90 cards lidos por rodada, antes do filtro
