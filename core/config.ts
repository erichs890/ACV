import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ACV_PORTA / ACV_DIR: só para rodar uma segunda instância (testes) sem tocar nos dados de uso real
export const PORTA = Number(process.env.ACV_PORTA) || 4780;

const BASE = process.env.LOCALAPPDATA ?? homedir();

/**
 * O produto se chamou AutoCV até 03/10/2026. A pasta de dados mudou de nome junto, e aqui está a mudança.
 *
 * Isto não é cosmético: dentro dela moram o banco (candidaturas enviadas, vagas, configuração), os PDFs e o
 * perfil do navegador com as sessões das plataformas. Trocar o caminho sem mover a pasta não apagaria nada,
 * mas deixaria tudo órfão — o app subiria vazio, como se fosse a primeira execução, e a pessoa pensaria que
 * perdeu o histórico.
 *
 * A mudança acontece uma vez, só se a pasta nova ainda não existe, e é um `rename` (atômico, no mesmo disco).
 * Se falhar — arquivo em uso porque o núcleo já está rodando, permissão — **continua usando a pasta antiga**.
 * Perder o acesso aos dados é muito pior do que conviver com um nome velho no disco.
 */
function pastaDeDados(): string {
  if (process.env.ACV_DIR) return process.env.ACV_DIR;
  const nova = join(BASE, 'ACV');
  const antiga = join(BASE, 'AutoCV');
  if (!existsSync(nova) && existsSync(antiga)) {
    try {
      renameSync(antiga, nova);
      console.log(`Pasta de dados renomeada: ${antiga} -> ${nova}`);
    } catch (e) {
      console.log(`Mantendo a pasta antiga (${antiga}): não consegui renomear (${(e as Error).message}).`);
      return antiga;
    }
  }
  return nova;
}

export const DIR = pastaDeDados();
export const DIRS = {
  curriculos: join(DIR, 'curriculos'), // PDFs originais enviados
  gerados: join(DIR, 'gerados'), // PDFs adaptados e capturas de tela
  navegador: join(DIR, 'navegador'), // perfil persistente do Edge/Chrome (cookies)
};
for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });

/**
 * O banco também mudou de nome. Mesma regra da pasta: só renomeia se o novo não existe, e na falha segue
 * usando o antigo — um banco de 19 MB com o seu histórico não se arrisca por causa de um nome.
 */
function arquivoDoBanco(): string {
  const novo = join(DIR, 'acv.sqlite');
  const antigo = join(DIR, 'autocv.sqlite');
  if (!existsSync(novo) && existsSync(antigo)) {
    try {
      // Os três arquivos: o banco e os companheiros do modo WAL, quando existirem
      for (const sufixo of ['', '-wal', '-shm']) if (existsSync(antigo + sufixo)) renameSync(antigo + sufixo, novo + sufixo);
      console.log(`Banco renomeado: autocv.sqlite -> acv.sqlite`);
    } catch (e) {
      console.log(`Mantendo autocv.sqlite: não consegui renomear (${(e as Error).message}).`);
      return antigo;
    }
  }
  return novo;
}

export const DB_PATH = arquivoDoBanco();
