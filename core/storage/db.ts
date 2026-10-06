import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from '../config.ts';
import { emitir } from '../events.ts';
import { anotar } from '../diario.ts';
import type { Candidatura, EmpresaInHire, LinhaLog, Vaga } from '../../src/types.ts';

export const db = new DatabaseSync(DB_PATH);
db.exec(`
  create table if not exists kv (chave text primary key, valor text not null);
  create table if not exists vagas (
    id text primary key, dados text not null, status text not null,
    score integer not null default 0, posicao integer, atualizada_em text not null
  );
  create table if not exists candidaturas (id integer primary key autoincrement, enviada_em text not null, dados text not null);
  create table if not exists log (id integer primary key autoincrement, hora text not null, tipo text not null, msg text not null);
  create table if not exists empresas_inhire (
    subdominio text primary key, nome text not null default '', ativo integer not null default 1,
    origem text not null default 'manual', ultima_verificacao text, total_vagas integer not null default 0,
    falhas integer not null default 0, criada_em text not null
  );
  create table if not exists formularios (vaga_id text primary key, estrutura text not null, atualizada_em text not null);
`);

// Estrutura de formulário descoberta por vaga (cache/diagnóstico; a descoberta em tempo real continua mandando)
export const formularios = {
  salvar(vagaId: string, estrutura: unknown) {
    db.prepare(
      'insert into formularios (vaga_id, estrutura, atualizada_em) values (?, ?, ?) on conflict(vaga_id) do update set estrutura = excluded.estrutura, atualizada_em = excluded.atualizada_em',
    ).run(vagaId, JSON.stringify(estrutura), new Date().toISOString());
  },
  get<T>(vagaId: string): T | undefined {
    const l = db.prepare('select estrutura from formularios where vaga_id = ?').get(vagaId) as { estrutura: string } | undefined;
    return l ? (JSON.parse(l.estrutura) as T) : undefined;
  },
};

// Blobs JSON por chave: perfil, curriculos, conexoes, automacao, robo, perguntas, notificacoes...
export const kv = {
  get<T>(chave: string, padrao: T): T {
    const linha = db.prepare('select valor from kv where chave = ?').get(chave) as { valor: string } | undefined;
    return linha ? (JSON.parse(linha.valor) as T) : padrao;
  },
  set(chave: string, valor: unknown) {
    db.prepare('insert into kv (chave, valor) values (?, ?) on conflict(chave) do update set valor = excluded.valor').run(chave, JSON.stringify(valor));
  },
};

export const vagas = {
  salvar(v: Vaga) {
    db.prepare(
      `insert into vagas (id, dados, status, score, posicao, atualizada_em) values (?, ?, ?, ?, ?, ?)
       on conflict(id) do update set dados = excluded.dados, status = excluded.status, score = excluded.score, posicao = excluded.posicao, atualizada_em = excluded.atualizada_em`,
    ).run(v.id, JSON.stringify(v), v.status, v.score, v.posicao ?? null, v.atualizadaEm);
  },
  get(id: string): Vaga | undefined {
    const l = db.prepare('select dados from vagas where id = ?').get(id) as { dados: string } | undefined;
    return l ? (JSON.parse(l.dados) as Vaga) : undefined;
  },
  listar(): Vaga[] {
    return (db.prepare('select dados from vagas order by score desc, atualizada_em desc').all() as { dados: string }[]).map(l => JSON.parse(l.dados) as Vaga);
  },
  atualizar(id: string, patch: Partial<Vaga>): Vaga | undefined {
    const atual = vagas.get(id);
    if (!atual) return undefined;
    const nova = { ...atual, ...patch, atualizadaEm: new Date().toISOString() };
    vagas.salvar(nova);
    return nova;
  },
  /** Próxima da fila, ignorando as que estão em espera de nova tentativa (falha transitória com backoff). */
  /**
   * A próxima vaga que o robô pode pegar AGORA, em ordem de fila.
   *
   * `podePegar` é a regra de quem está liberado, e vem de fora porque esta camada não conhece sessão nem
   * configuração — quem conhece é `core/queue.ts`. Sem ela, uma vaga travada no começo da fila parava a fila
   * inteira: o CLAUDE.md promete que "sessão caída segura a fila só daquela plataforma" e isso não estava
   * implementado em lugar nenhum. Medido em 06/10/2026: as três primeiras vagas da fila eram de uma
   * plataforma com login nunca feito, e nada atrás delas sairia.
   *
   * Pular não é descartar: a vaga fica na fila, na posição dela, esperando o login.
   */
  proximaNaFila(podePegar: (v: Vaga) => boolean = () => true): Vaga | undefined {
    const linhas = db.prepare("select dados from vagas where status = 'na_fila' order by posicao asc, score desc").all() as { dados: string }[];
    const agora = Date.now();
    for (const l of linhas) {
      const v = JSON.parse(l.dados) as Vaga;
      if (v.proximaTentativaEm && new Date(v.proximaTentativaEm).getTime() > agora) continue;
      if (!podePegar(v)) continue;
      return v;
    }
    return undefined;
  },
  proximaPosicao(): number {
    const l = db.prepare('select coalesce(max(posicao), 0) + 1 as p from vagas').get() as { p: number };
    return l.p;
  },
  limpar() {
    db.exec('delete from vagas');
  },
};

export const candidaturas = {
  inserir(c: Omit<Candidatura, 'id'>): Candidatura {
    const r = db.prepare('insert into candidaturas (enviada_em, dados) values (?, ?)').run(c.enviadaEm, JSON.stringify(c));
    return { ...c, id: Number(r.lastInsertRowid) };
  },
  listar(): Candidatura[] {
    return (db.prepare('select id, dados from candidaturas order by enviada_em desc').all() as { id: number; dados: string }[]).map(l => ({
      ...(JSON.parse(l.dados) as Candidatura),
      id: l.id,
    }));
  },
};

export const log = {
  registrar(tipo: LinhaLog['tipo'], msg: string): LinhaLog {
    const linha = { hora: new Date().toLocaleTimeString('pt-BR', { hour12: false }), tipo, msg };
    db.prepare('insert into log (hora, tipo, msg) values (?, ?, ?)').run(linha.hora, tipo, msg);
    db.exec('delete from log where id not in (select id from log order by id desc limit 300)');
    console.log(`[${linha.hora}] ${tipo}: ${msg}`);
    anotar(linha); // e o diário em arquivo, que não é podado em 300 linhas
    emitir({ tipo: 'log', linha });
    return linha;
  },
  listar(limite = 150): LinhaLog[] {
    return db.prepare('select hora, tipo, msg from log order by id desc limit ?').all(limite) as unknown as LinhaLog[];
  },
};

type LinhaEmpresa = { subdominio: string; nome: string; ativo: number; origem: EmpresaInHire['origem']; ultima_verificacao: string | null; total_vagas: number; falhas: number; criada_em: string };
const paraEmpresa = (l: LinhaEmpresa): EmpresaInHire => ({
  subdominio: l.subdominio,
  nome: l.nome,
  urlVagas: `https://${l.subdominio}.inhire.app/vagas`,
  ativo: l.ativo === 1,
  origem: l.origem,
  ultimaVerificacao: l.ultima_verificacao,
  totalVagas: l.total_vagas,
  falhas: l.falhas,
  criadaEm: l.criada_em,
});

export const empresas = {
  listar(): EmpresaInHire[] {
    return (db.prepare('select * from empresas_inhire order by ativo desc, total_vagas desc, nome').all() as unknown as LinhaEmpresa[]).map(paraEmpresa);
  },
  get(subdominio: string): EmpresaInHire | undefined {
    const l = db.prepare('select * from empresas_inhire where subdominio = ?').get(subdominio) as unknown as LinhaEmpresa | undefined;
    return l ? paraEmpresa(l) : undefined;
  },
  inserir(subdominio: string, nome: string, origem: EmpresaInHire['origem']) {
    db.prepare('insert or ignore into empresas_inhire (subdominio, nome, origem, criada_em) values (?, ?, ?, ?)').run(subdominio, nome, origem, new Date().toISOString());
  },
  atualizar(subdominio: string, p: Partial<Pick<EmpresaInHire, 'nome' | 'ativo' | 'ultimaVerificacao' | 'totalVagas' | 'falhas'>>) {
    const atual = empresas.get(subdominio);
    if (!atual) return;
    const n = { ...atual, ...p };
    db.prepare('update empresas_inhire set nome = ?, ativo = ?, ultima_verificacao = ?, total_vagas = ?, falhas = ? where subdominio = ?').run(
      n.nome,
      n.ativo ? 1 : 0,
      n.ultimaVerificacao,
      n.totalVagas,
      n.falhas,
      subdominio,
    );
  },
  remover(subdominio: string) {
    db.prepare('delete from empresas_inhire where subdominio = ?').run(subdominio);
  },
};

export function apagarTudo() {
  db.exec('delete from kv; delete from vagas; delete from candidaturas; delete from log; delete from empresas_inhire; delete from formularios;');
}
