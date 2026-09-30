// Seletores, URLs e padrões de envio do Workable (jobs.workable.com)
// Centralizados para facilitar manutenção quando o layout ou a API do Workable mudarem.

export const WORKABLE_API_BASE = 'https://jobs.workable.com/api/v1';

export const WORKABLE = {
  api: {
    jobs: `${WORKABLE_API_BASE}/jobs`,
    job: (id: string) => `${WORKABLE_API_BASE}/jobs/${encodeURIComponent(id)}`,
    form: (id: string, lng = 'en') => `${WORKABLE_API_BASE}/jobs/${encodeURIComponent(id)}/form?includeAccountMetadata=true&lng=${lng}`,
    apply: (id: string, lng = 'en') => `${WORKABLE_API_BASE}/jobs/${encodeURIComponent(id)}/apply?lng=${lng}`,
  },
  // Cookies / consent
  cookies: 'button:has-text("Accept"), button:has-text("I agree"), button:has-text("Concordo"), button[id*="cookie" i]',
  // Botões de candidatura na página da vaga
  botaoAplicar: 'button:has-text("Apply now"), button[data-ui="overview-apply-now"], a:has-text("Apply now")',
  // Modal de candidatura
  modal: '[data-role="dialog-container"], [data-ui="application-form-title"], div[class*="applicationModal"]',
  // Campos fixos do modal
  campos: {
    firstname: 'input[name="firstname"], input#firstname',
    lastname: 'input[name="lastname"], input#lastname',
    email: 'input[name="email"], input#email',
    phone: 'input[name="phone"], input[type="tel"]',
    address: 'input[name="address"], input#address',
    city: 'input[name="city"], input#city',
    summary: 'textarea[name="summary"], textarea#summary',
    coverLetter: 'textarea[name="cover_letter"], textarea#cover_letter',
    arquivo: 'input[type="file"]',
    submit: 'button[data-ui="application-form-submit"], button:has-text("Submit application")',
    cancel: 'button[data-ui="application-form-cancel"], button:has-text("Cancel")',
  },
  // Sucesso na tela após envio
  sucesso: /thank you|application .*(submitted|received)|application (submitted|received)|candidatura enviada|inscri[çc][ãa]o realizada|recebemos (sua|o seu)|sucesso/i,
  // Rota HTTP do envio
  rotaEnvio: /\/api\/v1\/jobs\/[^/]+\/apply/i,
  rotaEnvioGlob: '**/api/v1/jobs/*/apply*',
};

export const ESPERA_ENVIO_MS = 25_000;
export const MAX_VAGAS_POR_VARREDURA = 30;
export const PAUSA_ENTRE_CONSULTAS_MS = 1_500;
