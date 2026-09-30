// Seletores, URLs e convenções do Arbeitnow (arbeitnow.com).
// Portal de empregos europeu com foco em vagas de tecnologia e suporte a trabalho remoto.

export const ARBEITNOW = {
  api: 'https://www.arbeitnow.com/api/job-board-api',
  botaoAplicar: 'a[href*="/apply"], button[data-apply-button], a:has-text("Apply Now"), a:has-text("Apply for")',

  // Convenções para o motor de formulário adaptativo (executarFormulario)
  convencoes: {
    proximo: /^(next|continue|weiter|avançar|pr[óo]xim[oa]|step)$/i,
    final: /^(submit( application)?|apply( now)?|send application|bewerbung absenden|candidatar[-\s]?(se|me)?|enviar candidatura|concluir)$/i,
    sucesso: /thank you|application (submitted|received|sent)|erfolgreich|vielen dank|candidatura (enviada|recebida)|sucesso/i,
    nome: 'o Arbeitnow',
  },
};

export const ESPERA_ENVIO_MS = 25_000;
export const MAX_VAGAS_POR_VARREDURA = 30;
