-- ACV — dados iniciais (catálogo de plataformas). Rode depois do schema.sql.
insert into public.plataformas (id, nome, sigla, cor, disponivel, ordem) values
  ('linkedin',  'LinkedIn',        'in', 'bg-blue-deep',   true,  1),
  ('catho',     'Catho',           'ca', 'bg-orange-deep', true,  2),
  ('gupy',      'Gupy',            'gu', 'bg-purple',      true,  3),
  ('infojobs',  'InfoJobs',        'ij', 'bg-blue-dark',   true,  4),
  ('vagas',     'Vagas.com',       'vg', 'bg-green-deep',  true,  5),
  ('indeed',    'Indeed',          'id', 'bg-side-top',    true,  6),
  ('glassdoor', 'Glassdoor',       'gd', 'bg-green-deep',  true,  7),
  ('trampos',   'Trampos.co',      'tr', 'bg-orange-deep', true,  8),
  ('empregos',  'Empregos.com.br', 'em', 'bg-ink-soft',    false, 9),
  ('solides',   'Solides',         'so', 'bg-ink-soft',    false, 10),
  ('kenoby',    'Kenoby',          'ke', 'bg-ink-soft',    false, 11),
  ('workana',   'Workana',         'wo', 'bg-ink-soft',    false, 12)
on conflict (id) do update
  set nome = excluded.nome, sigla = excluded.sigla, cor = excluded.cor,
      disponivel = excluded.disponivel, ordem = excluded.ordem;
