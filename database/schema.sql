-- ACV — schema Supabase (Postgres 15+)
-- Rode no SQL Editor do Supabase (ou como migration) e depois o seed.sql.
-- Tudo que é do usuário fica protegido por RLS: cada um só enxerga as próprias linhas.
-- Tabelas escritas só pelo robô (envios, log, faturas, conexões) não têm policy de escrita:
-- o backend usa a service_role, que ignora RLS.

-- ─────────────────────────────────────────────────────────────
-- Tipos
-- ─────────────────────────────────────────────────────────────
create type public.status_envio   as enum ('enviado', 'visualizado', 'pendente', 'erro');
create type public.estado_robo    as enum ('ativo', 'pausado', 'erro');
create type public.estado_conexao as enum ('conectada', 'erro');
create type public.tipo_log       as enum ('sucesso', 'info', 'aguardo', 'erro', 'alerta');

-- ─────────────────────────────────────────────────────────────
-- Catálogo global de plataformas (LinkedIn, Catho, ...)
-- ─────────────────────────────────────────────────────────────
create table public.plataformas (
  id         text primary key,             -- 'linkedin', 'catho', ...
  nome       text not null,
  sigla      text not null,                -- 'in', 'ca', ...
  cor        text not null,                -- classe/token de cor usada no front
  disponivel boolean not null default true, -- false = "Plataformas em breve"
  ordem      int not null default 0
);

-- ─────────────────────────────────────────────────────────────
-- Perfil (1:1 com auth.users) — tela Configurações > Meus Dados,
-- Notificações e Conta e Assinatura
-- ─────────────────────────────────────────────────────────────
create table public.perfis (
  id                   uuid primary key references auth.users on delete cascade,
  nome                 text not null default '',
  email                text,
  telefone             text,
  cidade               text,
  cargo                text,
  linkedin             text,
  github               text,
  portfolio            text,
  endereco             text,
  cpf                  text,
  nascimento           date,
  disponibilidade      text,
  pcd                  boolean not null default false,
  escolaridade         text,
  idiomas              text,
  pretensao_salarial   numeric(10, 2),
  avatar_path          text,               -- caminho no bucket 'avatares'

  -- Notificações
  notif_cada_envio     boolean not null default true,
  notif_resposta       boolean not null default true,
  notif_resumo_semanal boolean not null default true,
  notif_erro_conexao   boolean not null default false,
  notif_novidades      boolean not null default false,

  -- Plano (só o backend altera — ver grants no fim)
  plano                text not null default 'Plano Pro',
  envios_limite        int not null default 100,
  renova_em            date,

  criado_em            timestamptz not null default now(),
  atualizado_em        timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Currículos e versões — tela Currículo
-- ─────────────────────────────────────────────────────────────
create table public.curriculos (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  nome_arquivo  text not null,
  arquivo_path  text not null,             -- bucket 'curriculos': {user_id}/{arquivo}
  tamanho_bytes int check (tamanho_bytes <= 5 * 1024 * 1024),
  cargo_alvo    text,
  area          text,
  nivel         text check (nivel in ('Estágio', 'Júnior', 'Pleno', 'Sênior')),
  foco          text,
  skills        text[] not null default '{}',
  principal     boolean not null default false,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index curriculos_user on public.curriculos (user_id);
create unique index curriculos_um_principal on public.curriculos (user_id) where principal;

create table public.curriculo_versoes (
  id           uuid primary key default gen_random_uuid(),
  curriculo_id uuid not null references public.curriculos on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  versao       int not null,
  nota         text,
  arquivo_path text not null,
  atual        boolean not null default false,
  criado_em    timestamptz not null default now(),
  unique (curriculo_id, versao)
);
create unique index curriculo_versoes_uma_atual on public.curriculo_versoes (curriculo_id) where atual;

-- ─────────────────────────────────────────────────────────────
-- Configuração do robô (1 por usuário) — tela Automação
-- ─────────────────────────────────────────────────────────────
create table public.automacao_config (
  user_id          uuid primary key default auth.uid() references auth.users on delete cascade,
  estado           public.estado_robo not null default 'pausado',
  configurado      boolean not null default false, -- false = estado vazio do Painel
  plataformas      text[] not null default '{}',   -- ids de public.plataformas
  curriculo_id     uuid references public.curriculos on delete set null,
  area             text,
  cargo            text,
  localizacao      text,
  salario_min      int,
  salario_max      int,
  regimes          text[] not null default '{}',
  intervalo_min    int not null default 15 check (intervalo_min between 5 and 60),
  limite_diario    int not null default 40 check (limite_diario between 1 and 100),
  janela_inicio    time not null default '08:00',
  janela_fim       time not null default '20:00',
  proximo_envio_em timestamptz,                    -- preenchido pelo robô
  atualizado_em    timestamptz not null default now(),
  constraint salario_faixa check (salario_min <= salario_max),
  constraint regimes_validos check (regimes <@ array['remoto', 'hibrido', 'presencial'])
);

-- ─────────────────────────────────────────────────────────────
-- Conexões do usuário com as plataformas — tela Plataformas
-- Senhas e tokens OAuth NUNCA ficam aqui: guarde no Supabase Vault
-- a partir de uma Edge Function (service_role).
-- ─────────────────────────────────────────────────────────────
create table public.conexoes (
  user_id         uuid not null references auth.users on delete cascade,
  plataforma_id   text not null references public.plataformas,
  estado          public.estado_conexao not null default 'conectada',
  vagas_semana    int not null default 0,
  sincronizado_em timestamptz,
  criado_em       timestamptz not null default now(),
  primary key (user_id, plataforma_id)
);

-- ─────────────────────────────────────────────────────────────
-- Fila, envios e log — Painel e Automação
-- ─────────────────────────────────────────────────────────────
create table public.fila_envio (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  vaga          text not null,
  empresa       text not null,
  plataforma_id text not null references public.plataformas,
  posicao       int not null,
  previsto_para timestamptz,
  criado_em     timestamptz not null default now()
);
create index fila_envio_user_posicao on public.fila_envio (user_id, posicao);

create table public.envios (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users on delete cascade,
  vaga          text not null,
  empresa       text not null,
  plataforma_id text not null references public.plataformas,
  status        public.status_envio not null default 'pendente',
  url_vaga      text,
  enviado_em    timestamptz not null default now()
);
create index envios_user_data on public.envios (user_id, enviado_em desc);

create table public.log_atividade (
  id        bigint generated always as identity primary key,
  user_id   uuid not null references auth.users on delete cascade,
  tipo      public.tipo_log not null default 'info',
  mensagem  text not null,
  criado_em timestamptz not null default now()
);
create index log_atividade_user_data on public.log_atividade (user_id, criado_em desc);

-- ─────────────────────────────────────────────────────────────
-- Perguntas automáticas — Configurações > Perguntas Automáticas
-- ─────────────────────────────────────────────────────────────
create table public.perguntas_automaticas (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  pergunta      text not null,
  resposta      text not null default '',
  icone         text,                      -- chave de ícone usada no front ('salario', 'cnh', ...)
  personalizada boolean not null default false,
  ordem         int not null default 0
);
create index perguntas_user_ordem on public.perguntas_automaticas (user_id, ordem);

-- ─────────────────────────────────────────────────────────────
-- Faturas — Conta e Assinatura (escrita só pelo backend de pagamento)
-- ─────────────────────────────────────────────────────────────
create table public.faturas (
  id        bigint generated always as identity primary key,
  user_id   uuid not null references auth.users on delete cascade,
  data      date not null,
  valor     numeric(10, 2) not null,
  status    text not null default 'paga' check (status in ('paga', 'pendente', 'falhou')),
  criado_em timestamptz not null default now()
);
create index faturas_user_data on public.faturas (user_id, data desc);

-- ─────────────────────────────────────────────────────────────
-- Triggers
-- ─────────────────────────────────────────────────────────────
create function public.set_atualizado_em()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;

create trigger perfis_atualizado_em before update on public.perfis
  for each row execute function public.set_atualizado_em();
create trigger curriculos_atualizado_em before update on public.curriculos
  for each row execute function public.set_atualizado_em();
create trigger automacao_config_atualizado_em before update on public.automacao_config
  for each row execute function public.set_atualizado_em();

-- Novo cadastro: cria perfil, config do robô e as perguntas padrão
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.perfis (id, nome, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'nome', ''), new.email);

  insert into public.automacao_config (user_id) values (new.id);

  insert into public.perguntas_automaticas (user_id, pergunta, icone, ordem) values
    (new.id, 'Pretensão salarial',          'salario',     1),
    (new.id, 'Anos de experiência',         'experiencia', 2),
    (new.id, 'Disponibilidade para viagem', 'viagem',      3),
    (new.id, 'Pretende trabalhar remoto?',  'remoto',      4),
    (new.id, 'Possui CNH?',                 'cnh',         5),
    (new.id, 'Disponibilidade de início',   'inicio',      6),
    (new.id, 'Nível de inglês',             'ingles',      7),
    (new.id, 'Possui deficiência (PcD)?',   'pcd',         8);

  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────────────────────
-- Views do Painel (security_invoker: respeitam o RLS de envios)
-- ponytail: dias/mês calculados em UTC; troque por timezone do usuário se precisar
-- ─────────────────────────────────────────────────────────────
create view public.painel_resumo with (security_invoker = true) as
select
  user_id,
  count(*)                                                        as total,
  count(*) filter (where enviado_em >= date_trunc('month', now())) as mes,
  count(*) filter (where enviado_em >= current_date)               as hoje,
  count(*) filter (where status = 'erro' and enviado_em >= current_date) as erros_hoje,
  count(*) filter (where enviado_em >= now() - interval '7 days')  as semana,
  count(*) filter (where enviado_em >= now() - interval '14 days'
                     and enviado_em <  now() - interval '7 days')  as semana_anterior
from public.envios
group by user_id;

create view public.envios_por_dia with (security_invoker = true) as
select user_id, enviado_em::date as dia, count(*) as total
from public.envios
group by user_id, enviado_em::date;

-- ─────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────
alter table public.plataformas           enable row level security;
alter table public.perfis                enable row level security;
alter table public.curriculos            enable row level security;
alter table public.curriculo_versoes     enable row level security;
alter table public.automacao_config      enable row level security;
alter table public.conexoes              enable row level security;
alter table public.fila_envio            enable row level security;
alter table public.envios                enable row level security;
alter table public.log_atividade         enable row level security;
alter table public.perguntas_automaticas enable row level security;
alter table public.faturas               enable row level security;

-- Catálogo: leitura para qualquer usuário logado
create policy "plataformas: leitura" on public.plataformas
  for select to authenticated using (true);

-- Perfil e config: ler e editar a própria linha (criadas pelo trigger)
create policy "perfis: ler o próprio" on public.perfis
  for select to authenticated using (id = (select auth.uid()));
create policy "perfis: editar o próprio" on public.perfis
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "automacao_config: ler a própria" on public.automacao_config
  for select to authenticated using (user_id = (select auth.uid()));
create policy "automacao_config: editar a própria" on public.automacao_config
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- CRUD completo do dono
create policy "curriculos: dono" on public.curriculos
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "curriculo_versoes: dono" on public.curriculo_versoes
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "perguntas: dono" on public.perguntas_automaticas
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Conexões: o usuário vê e desconecta; conectar passa pela Edge Function (OAuth/Vault)
create policy "conexoes: ler as próprias" on public.conexoes
  for select to authenticated using (user_id = (select auth.uid()));
create policy "conexoes: desconectar" on public.conexoes
  for delete to authenticated using (user_id = (select auth.uid()));

-- Fila: o robô insere; o usuário vê, reordena e remove
create policy "fila: ler a própria" on public.fila_envio
  for select to authenticated using (user_id = (select auth.uid()));
create policy "fila: reordenar" on public.fila_envio
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "fila: remover" on public.fila_envio
  for delete to authenticated using (user_id = (select auth.uid()));

-- Somente leitura para o usuário
create policy "envios: ler os próprios" on public.envios
  for select to authenticated using (user_id = (select auth.uid()));
create policy "log: ler o próprio" on public.log_atividade
  for select to authenticated using (user_id = (select auth.uid()));
create policy "faturas: ler as próprias" on public.faturas
  for select to authenticated using (user_id = (select auth.uid()));

-- Colunas que o usuário não pode alterar mesmo na própria linha
revoke update on public.perfis from authenticated, anon;
grant update (
  nome, email, telefone, cidade, cargo, linkedin, github, portfolio, endereco, cpf, nascimento,
  disponibilidade, pcd, escolaridade, idiomas, pretensao_salarial, avatar_path,
  notif_cada_envio, notif_resposta, notif_resumo_semanal, notif_erro_conexao, notif_novidades
) on public.perfis to authenticated;

revoke update on public.automacao_config from authenticated, anon;
grant update (
  estado, configurado, plataformas, curriculo_id, area, cargo, localizacao, salario_min, salario_max,
  regimes, intervalo_min, limite_diario, janela_inicio, janela_fim
) on public.automacao_config to authenticated;

revoke update on public.fila_envio from authenticated, anon;
grant update (posicao) on public.fila_envio to authenticated;

-- ─────────────────────────────────────────────────────────────
-- Storage: arquivos privados em pastas {user_id}/...
-- ─────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('curriculos', 'curriculos', false, 5242880,
    array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  ('avatares', 'avatares', false, 2097152,
    array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy "storage: dono da pasta" on storage.objects
  for all to authenticated
  using (bucket_id in ('curriculos', 'avatares') and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id in ('curriculos', 'avatares') and (storage.foldername(name))[1] = (select auth.uid())::text);
