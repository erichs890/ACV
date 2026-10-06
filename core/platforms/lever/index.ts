// Adapter do Lever (jobs.lever.co) — **acha e ranqueia; não candidata.**
//
// A descoberta aqui é das melhores do projeto: uma requisição por empresa traz o anúncio inteiro de todas as
// vagas dela, com país e modelo de trabalho em campo próprio. O `robots.txt` libera tudo pedindo
// `Crawl-delay: 1`, e nenhum documento do Lever ou da Employ (a dona) proíbe candidato de ler as vagas —
// procurado em 06/10/2026 nos termos de serviço do Lever, nos da Employ e na política de privacidade: as
// cláusulas de uso são do contrato com a empresa CLIENTE, e nenhuma fala de candidato, scraping, robô ou
// automação. A API pública é a mesma que as empresas usam para embutir as vagas nos sites delas.
//
// **E o envio não é feito por aqui, por um motivo só: o formulário tem hCaptcha.**
// O `/apply` carrega o hCaptcha do próprio Lever (o mesmo `sitekey` nos três boards brasileiros) e o POST só
// sai depois do token. Captcha existe para barrar quem não é pessoa; passar por ele num navegador controlado
// seria exatamente o disfarce de automação que este projeto não faz — é a regra que já valeu para o Jobbol e
// para o LinkedIn, aplicada ao caso dela.
//
// Então o caminho de envio é o único honesto que existe: **o seu navegador**. A extensão preenche a vaga que
// você abriu, você clica, e se o captcha pedir alguma coisa é você que responde. Uma vaga por clique seu, com
// a sua impressão digital, sem fingir nada. O `rede.js` prova o envio pela resposta HTTP (invariante 1) e
// `jaCandidatou` continua barrando a duplicata (invariante 4), porque a extensão pergunta ao núcleo antes de
// preencher.
//
// `somenteDescoberta` é uma DECLARAÇÃO e não um `candidatar` esquecido: `soDescobre` passa a valer nos três
// pontos de uso (`plataformaEnviaCurriculo` na fila, `candidatarAgora` no clique, `executarCandidatura` no
// ponto de uso) e a tela troca "Quero me candidatar" por "Abrir no site".
import type { ConfigAutomacao, PerfilBusca, Vaga } from '../../../src/types.ts';
import { registrarAdapter, type Log, type PlatformAdapter } from '../adapter.ts';
import { ler } from '../../estado.ts';
import { buscarNoLever } from './busca.ts';

const buscarVagas = (perfil: PerfilBusca, cfg: ConfigAutomacao, log: Log, opcoes?: { manual?: boolean }): Promise<Vaga[]> =>
  buscarNoLever(perfil, cfg, ler.localizacao(), log, opcoes?.manual === true);

export const lever: PlatformAdapter = {
  id: 'lever',
  nome: 'Lever',
  buscarVagas,
  somenteDescoberta: true,
  motivoSomenteDescoberta:
    'o formulário do Lever é protegido por captcha (hCaptcha), e o ACV não contorna captcha. Abra a vaga no seu navegador: com a extensão instalada, ela preenche tudo e você dá o clique final.',
};

registrarAdapter(lever);
