// Adapter do Greenhouse (job-boards.greenhouse.io) — **acha e ranqueia; não candidata.**
//
// A melhor descoberta do projeto: uma requisição por empresa traz as vagas E o anúncio inteiro de cada uma
// (`?content=true`), então nenhuma página é aberta em nenhum momento — nem para peneirar, nem para ler. O
// `robots.txt` de `job-boards.greenhouse.io` não bloqueia nada (o arquivo é só o comentário de exemplo, com
// as linhas `Disallow` comentadas), e a API é a que o próprio Greenhouse publica para as empresas embutirem
// as vagas nos sites delas.
//
// **E o envio não é feito por aqui, pelo mesmo motivo do Lever, com outro captcha:** a página do formulário
// carrega reCAPTCHA Enterprise invisível. Captcha existe para barrar quem não é pessoa; passar por ele num
// navegador controlado seria o disfarce de automação que este projeto não faz.
//
// O caminho de envio continua existindo e é o honesto: **o seu navegador**. A extensão preenche a vaga que
// você abriu, você clica, e se o desafio aparecer é você que responde. `rede.js` prova o envio pela resposta
// HTTP (invariante 1) e `jaCandidatou` continua barrando duplicata (invariante 4).
//
// Uma diferença do Lever que a extensão sente: aqui o formulário é montado por JavaScript (aplicação React),
// então o HTML servido não tem `<input name=...>` nenhum. No navegador isso não muda nada — o motor lê o DOM
// vivo, depois de a página montar.
import type { ConfigAutomacao, PerfilBusca, Vaga } from '../../../src/types.ts';
import { registrarAdapter, type Log, type PlatformAdapter } from '../adapter.ts';
import { ler } from '../../estado.ts';
import { buscarNoGreenhouse } from './busca.ts';

const buscarVagas = (perfil: PerfilBusca, cfg: ConfigAutomacao, log: Log): Promise<Vaga[]> => buscarNoGreenhouse(perfil, cfg, ler.localizacao(), log);

export const greenhouse: PlatformAdapter = {
  id: 'greenhouse',
  nome: 'Greenhouse',
  buscarVagas,
  somenteDescoberta: true,
  motivoSomenteDescoberta:
    'o formulário do Greenhouse é protegido por captcha (reCAPTCHA), e o ACV não contorna captcha. Abra a vaga no seu navegador: com a extensão instalada, ela preenche tudo e você dá o clique final.',
};

registrarAdapter(greenhouse);
