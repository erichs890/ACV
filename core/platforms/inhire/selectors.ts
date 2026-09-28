// Seletores e classificações do formulário público do InHire, centralizados (levantados em 17–18/09/2026 em
// *.inhire.app/vagas/<id>/<slug>). O motor (formulario.ts) descobre os campos no DOM em tempo real; aqui fica só o
// que é convenção da plataforma: como reconhecer os campos fixos, os botões de navegação e a confirmação.

// name= dos campos fixos → papel que o robô sabe preencher. Qualquer outro campo é "pergunta extra".
// O motor (formulario.ts) é usado por todas as plataformas, então este dicionário também é: além dos name= do
// InHire, ele guarda os nomes óbvios de formulário em português que outros sites usam (telefone, linkedin, pdf).
export type PapelFixo = 'nome' | 'email' | 'celular' | 'cpf' | 'linkedin' | 'pretensao' | 'pais' | 'cidade' | 'cep' | 'modelo' | 'regime' | 'indicacao' | 'curriculo' | 'cnpj' | 'termos' | 'ignorar';
export const CAMPO_FIXO: Record<string, PapelFixo> = {
  name: 'nome',
  // Vagas PJ (e formulários em português em geral)
  telefone: 'celular',
  whatsapp: 'celular',
  linkedin: 'linkedin',
  pdf: 'curriculo',
  tipocnpj: 'cnpj',
  email: 'email',
  cpf: 'cpf',
  document: 'cpf',
  phone: 'celular',
  phoneCountry: 'ignorar', // o +55 já vem preenchido
  linkedinUsername: 'linkedin',
  salaryExpectation: 'pretensao',
  country: 'pais',
  districtBr: 'cidade',
  district: 'cidade',
  locationCity: 'cidade',
  cep: 'cep',
  workModel: 'modelo', // "tem disponibilidade para o modelo X?" — a vaga já passou pelo filtro de regime do usuário
  contractType: 'regime',
  isIndication: 'indicacao',
  resume: 'curriculo',
  privacyPolicy: 'termos',
  'g-recaptcha-response': 'ignorar',
};

// Sem name= (ou com name gerado), o rótulo decide
export const ROTULO_FIXO: [RegExp, PapelFixo][] = [
  [/nome completo/i, 'nome'],
  [/^(seu )?(melhor )?e-?mail/i, 'email'],
  [/celular|telefone|whatsapp|whats app/i, 'celular'],
  // CPF em qualquer ponto do rótulo: além do campo padrão, empresas perguntam em texto livre
  // ("Coloque aqui o seu CPF" — QI Tech, 20/09/2026). Exceções em CPF_DE_TERCEIRO.
  [/\bcpf\b/i, 'cpf'],
  [/linkedin/i, 'linkedin'],
  [/pretens[aã]o|expectativa salarial/i, 'pretensao'],
  [/^pa[ií]s\b/i, 'pais'],
  [/^cidade\b|sua cidade/i, 'cidade'],
  [/^cep\b/i, 'cep'],
  [/anexar curr|curr[ií]culo|resume/i, 'curriculo'],
  [/pol[ií]tica de privacidade|termos de uso|li e concordo/i, 'termos'],
];

/**
 * Tipo de CNPJ (MEI/ME/não tenho): dado da vida da pessoa que o currículo não traz e que muda o enquadramento
 * da contratação — o robô nunca escolhe por ela. Rótulo fixo de propósito: assim a resposta é dada uma vez e
 * vale para todas as vagas PJ seguintes, em vez de virar uma pergunta nova a cada formulário.
 */
export const PERGUNTA_CNPJ = 'Tipo do seu CNPJ (para vagas PJ)';

/**
 * "CPF do responsável", "CPF da empresa", "CPF do cônjuge": o dado é de outra pessoa, não do candidato.
 * Preencher com o CPF do usuário aqui seria erro grave — nesses casos a pergunta volta para ele.
 */
export const CPF_DE_TERCEIRO = /\bcpf\b[^?]*?\b(?:d[oae]s?)\s+(respons[áa]vel|c[ôo]njuge|s[óo]ci[oa]|dependente|empresa|contato|indicad|representante|m[ãa]e|pai|titular)/i;

// Botões de navegação: "próximo" muda de aba sem enviar; "final" cria a candidatura (POST com reCAPTCHA).
// O texto do botão final MUDA de empresa para empresa (levantado em 20/09/2026 nas páginas reais):
// "Continuar inscrição" (QI Tech, BIX) e "Candidatar-se para a vaga" (Ninecon, Insider Store) convivem.
// "candidatar-se"/"candidatar-me" é exigido de propósito: o botão "Candidatar" do topo da página só rola
// a tela até o formulário — clicar nele não envia nada e o robô ficaria preso.
export const BOTAO_PROXIMO = /^(avan[çc]ar|pr[óo]xim[oa]|seguinte|continuar)$/i;
export const BOTAO_FINAL = /continuar inscri|candidatar[-\s]?(se|me)\b|enviar candidatura|enviar inscri|^enviar$|finalizar|concluir|submit/i;

// Sinais de que o InHire aceitou a candidatura (texto da página).
// A prova dura é a resposta HTTP das rotas de envio (ROTAS_ENVIO); este texto é o reforço, não a única evidência —
// quando o InHire troca a redação da tela de agradecimento o robô não pode concluir "falhou" e reenviar.
export const SUCESSO =
  /candidatura (enviada|realizada|recebida|conclu|registrada|cadastrada)|inscri[çc][ãa]o (enviada|realizada|recebida|conclu|registrada|finalizada|confirmada)|recebemos (sua|a sua|seu|o seu) (candidatura|inscri|curr[ií]culo|cadastro)|obrigad[oa] por (se candidatar|se inscrever|participar|sua inscri|seu interesse)|boa sorte|em breve (entraremos|nossa equipe|o time)|voc[êe] (j[áa] )?(est[áa] )?(inscrit[oa]|candidatad[oa])|sua candidatura (foi|est[áa])|deu tudo certo/i;

// Rotas que o InHire chama para CRIAR a candidatura. Uma resposta 2xx aqui é prova de que o envio aconteceu —
// vale mais do que qualquer texto na tela. `talents` cria o talento (fluxo normal); `form/submit` e `responses`
// gravam as respostas do questionário (fluxo condicional, em que o talento nasce só no fim).
export const ROTAS_ENVIO: { re: RegExp; definitiva: boolean }[] = [
  { re: /\/job-talents\/public\/[^/]+\/talents\b/i, definitiva: true },
  { re: /\/forms\/form\/submit\b/i, definitiva: true },
  { re: /\/responses\b/i, definitiva: false }, // Typeform grava resposta a resposta: só confirma o questionário
];

// Botão que abre o seletor de arquivo do currículo
export const BOTAO_ANEXAR = /anexar|upload|escolher arquivo|selecionar arquivo/i;

// Questionário sequencial ("uma pergunta por tela"). Levantado em 18/09/2026:
//  - depois de "Continuar inscrição" o InHire embute um iframe do PRÓPRIO InHire: form-app.inhire.app/form?jobId=…&formId=<typeformId>&type=subscription
//    (com talentId quando o talento já existe; com flow=returnMessageToParent no fluxo condicional, em que o questionário vem ANTES de criar o talento);
//  - em /forms/preview/<id> o mesmo questionário aparece como widget do Typeform (form.typeform.com/to/<id>, blocos com data-qa).
// A definição das perguntas vem da API pública do Typeform (schema.ts). O motor detecta o modo a cada etapa, nunca assume.
export const SEQUENCIAL = {
  frameTypeform: /form\.typeform\.com/,
  frameInHire: /form-app\.inhire\.app/,
  boasVindas: /responda as perguntas|para finalizar sua inscri/i,
  /**
   * A tela de boas-vindas pela ESTRUTURA, não pelo texto.
   *
   * Cada empresa escreve o seu convite: o da Framework Digital não casava com a regex acima, então o motor nem
   * entrava no laço de boas-vindas, caía na tela sem campo nenhum e respondia "estrutura não reconhecida" — três
   * candidaturas perdidas em 28/09/2026. O QuillForms marca essa tela na classe do bloco, e classe de fornecedor
   * é mais estável do que o texto que o recrutador digitou.
   */
  boasVindasBloco: '.blocktype-welcome-screen-block, .qf-welcome-screen-block__wrapper',
  iniciar: /^(iniciar|começar|comecar|start|responder|vamos)/i,
  proximo: /^(ok|próximo|proximo|avançar|avancar|next|seguinte|→|>)\b/i, // "OK" pode vir com a dica "pressione Enter" colada
  final: /^(enviar|finalizar|concluir|submit|enviar respostas|enviar candidatura|finalizar inscri)/i,
  concluido: /respostas? (enviadas?|recebidas?)|obrigad[oa] por responder|questionário (enviado|concluído)|inscri[çc][ãa]o (finalizada|conclu)/i,
};
