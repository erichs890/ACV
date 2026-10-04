// Migrações de dados que rodam uma vez, na subida do núcleo.
import { existsSync } from 'node:fs';
import { DIR } from './config.ts';
import { kv, log, vagas } from './storage/db.ts';
import type { Arquivo } from '../src/types.ts';

/**
 * Conserta os caminhos de arquivo que ficaram apontando para a pasta antiga.
 *
 * Quando o produto virou ACV (03/10/2026), `core/config.ts` renomeou `%LOCALAPPDATA%\AutoCV` para
 * `...\ACV` — e isso foi conferido: o banco, os PDFs e o perfil do navegador foram todos juntos.
 *
 * O que escapou foi o que está DENTRO do banco: currículo, captura de tela e PDF adaptado guardam o caminho
 * **absoluto**, e esses continuaram com o nome velho. O sintoma não foi sutil: toda candidatura morria em
 * "perfil ou currículo principal ausente" antes mesmo de abrir o navegador, porque o PDF do currículo não
 * existia mais no lugar indicado. 157 caminhos ficaram para trás num caso real.
 *
 * A troca é do prefixo da pasta de dados e nada mais, e só acontece se o arquivo **existir** no destino
 * novo — caminho que não aponta para lugar nenhum nos dois lugares fica como está, para não trocar um erro
 * por outro mais difícil de ler.
 */
export function migrarCaminhosDaPastaAntiga(): number {
  const antiga = DIR.replace(/([\\/])ACV$/i, '$1AutoCV');
  if (antiga === DIR) return 0; // pasta personalizada (ACV_DIR): não há prefixo antigo que case

  const trocar = (caminho: string | undefined): string | undefined => {
    if (!caminho?.toLowerCase().startsWith(antiga.toLowerCase())) return undefined;
    const novo = DIR + caminho.slice(antiga.length);
    return existsSync(novo) ? novo : undefined;
  };

  let trocados = 0;

  const curriculos = kv.get<Arquivo[]>('curriculos', []);
  const corrigidos = curriculos.map(c => {
    const novo = trocar(c.caminho);
    if (!novo) return c;
    trocados++;
    return { ...c, caminho: novo };
  });
  if (trocados) kv.set('curriculos', corrigidos);

  for (const v of vagas.listar()) {
    const captura = trocar(v.captura);
    const pdf = trocar(v.adaptado?.pdf);
    if (!captura && !pdf) continue;
    trocados += (captura ? 1 : 0) + (pdf ? 1 : 0);
    vagas.atualizar(v.id, {
      ...(captura ? { captura } : {}),
      ...(pdf && v.adaptado ? { adaptado: { ...v.adaptado, pdf } } : {}),
    });
  }

  if (trocados) log.registrar('info', `${trocados} caminho(s) de arquivo atualizados da pasta antiga para ${DIR}.`);
  return trocados;
}
