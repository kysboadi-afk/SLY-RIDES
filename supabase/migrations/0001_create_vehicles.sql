create table if not exists vehicles (
  vehicle_id text        primary key,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists vehicles_updated_at_idx on vehicles (updated_at);

-- Seed the four known fleet vehicles (safe to re-run; ignores conflicts)
insert into vehicles (vehicle_id, data) values
  ('vehicle',  '{"vehicle_id":"vehicle",  "vehicle_name":"Vehicle R",     "type":"vehicle","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/car2.jpg"}'::jsonb),
  ('vehicle2', '{"vehicle_id":"vehicle2", "vehicle_name":"Vehicle R (2)", "type":"vehicle","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/IMG_1749.jpeg"}'::jsonb),
  ('camry',      '{"vehicle_id":"camry",      "vehicle_name":"Camry 2012",      "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/IMG_0046.png"}'::jsonb),
  ('camry2013',  '{"vehicle_id":"camry2013",  "vehicle_name":"Camry 2013 SE",   "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/IMG_5144.png"}'::jsonb)
on conflict (vehicle_id) do nothing;
