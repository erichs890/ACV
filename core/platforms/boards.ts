// A lista de empresas monitoradas de uma plataforma de ATS — onde cada empresa tem o seu próprio mural.
//
// Existe porque Lever, Greenhouse, Ashby e Teamtailor têm todos a mesma forma: não há um índice de vagas, há
// um endereço por empresa (`jobs.lever.co/<empresa>`) e uma API que responde 200 ou 404. Varrer essas
// plataformas é percorrer uma lista de empresas, e essa lista é um dado que tem de sobreviver ao reinício.
//
// Por que não reusar `empresas_inhire`: aquela tabela é do InHire (a coluna é `subdominio`, a `urlVagas` é
// montada como `<sub>.inhire.app/vagas`, e ela tem rota e tela próprias). Generalizar a tabela pediria
// migração de schema e mexeria no único caminho de descoberta que funciona hoje. Aqui o dado é pequeno
// (dezenas de registros, não milhares) e um blob por plataforma no `kv` resolve sem migrar nada.
//
// Por que genérico desde o primeiro uso, e não "quando chegar o segundo": o Greenhouse entra em seguida, e a
// alternativa seria copiar este arquivo trocando o nome — que é como se criam duas cópias que divergem.
import { kv } from '../storage/db.ts';

export interface Board {
  /** O identificador da empresa na URL da plataforma (`jobs.lever.co/<slug>`). */
  slug: string;
  nome: string;
  ativo: boolean;
  /** `seed` = veio da lista inicial do projeto · `manual` = você adicionou · `busca` = a descoberta achou. */
  origem: 'seed' | 'manual' | 'busca';
  ultimaVerificacao: string | null;
  totalVagas: number;
  falhas: number;
  criadoEm: string;
}

const chave = (plataforma: string) => `boards:${plataforma}`;
const ler = (plataforma: string) => kv.get<Record<string, Board>>(chave(plataforma), {});

export function boards(plataforma: string) {
  return {
    listar(): Board[] {
      return Object.values(ler(plataforma)).sort((a, b) => Number(b.ativo) - Number(a.ativo) || b.totalVagas - a.totalVagas || a.slug.localeCompare(b.slug));
    },

    get(slug: string): Board | undefined {
      return ler(plataforma)[slug];
    },

    /** Insere se ainda não existe. Devolve `true` quando criou — o chamador conta as novas com isto. */
    inserir(slug: string, nome: string, origem: Board['origem']): boolean {
      const atual = ler(plataforma);
      if (atual[slug]) return false;
      atual[slug] = { slug, nome: nome || slug, ativo: true, origem, ultimaVerificacao: null, totalVagas: 0, falhas: 0, criadoEm: new Date().toISOString() };
      kv.set(chave(plataforma), atual);
      return true;
    },

    atualizar(slug: string, p: Partial<Omit<Board, 'slug' | 'origem' | 'criadoEm'>>): void {
      const atual = ler(plataforma);
      if (!atual[slug]) return;
      atual[slug] = { ...atual[slug], ...p };
      kv.set(chave(plataforma), atual);
    },

    remover(slug: string): void {
      const atual = ler(plataforma);
      if (!atual[slug]) return;
      delete atual[slug];
      kv.set(chave(plataforma), atual);
    },

    /**
     * Os `n` próximos boards a visitar: os ativos, **do mais esquecido para o mais recente**.
     *
     * É a rotação do Quickin (que gira 60 de 628 empresas por rodada) escrita de outra forma. Lá o ponteiro é
     * um número guardado, e amostra aleatória ou ponteiro numérico podem deixar uma empresa de fora por muitas
     * rodadas seguidas. Ordenar por `ultimaVerificacao` dá a mesma rotação e garante a volta completa: quem
     * acabou de ser visto vai para o fim da fila sozinho, e board novo (`null`) é visto na primeira rodada.
     *
     * **O desempate é a ordem em que a lista foi montada, e não passa por `listar()` de propósito.**
     * Na primeira varredura TODOS os boards têm `ultimaVerificacao: null`, então o desempate decide a rodada
     * inteira. `listar()` ordena por nome, que é o que a TELA quer — e com isso a primeira varredura de
     * verdade do Lever (06/10/2026) andou em ordem alfabética, bateu o teto em "EnableComp" e deixou Neon,
     * Swile, Zippi e Tractian para a rodada seguinte: justamente as brasileiras, que por acaso estão no fim
     * do alfabeto. Ordem alfabética não tem relação com valor; a ordem da semente tem, porque ela foi escrita
     * com as que importam primeiro. `Object.values` devolve na ordem de inserção e o `sort` do V8 é estável,
     * então o empate preserva essa ordem.
     */
    aVisitar(n: number): Board[] {
      return Object.values(ler(plataforma))
        .filter(b => b.ativo)
        .sort((a, b) => (a.ultimaVerificacao ?? '').localeCompare(b.ultimaVerificacao ?? ''))
        .slice(0, n);
    },
  };
}
