-- Remove placeholder rows that have no vehicle data.
-- These were created during initial Supabase setup before real fleet data was loaded.
delete from vehicles
where vehicle_id in ('vehicle_1', 'vehicle_2', 'vehicle_3', 'vehicle_4');

-- Upsert the four fleet vehicles with their correct display and financial data.
-- ON CONFLICT DO UPDATE ensures rows are refreshed even if 0001 already ran
-- (0001 used DO NOTHING so real data may never have been written).
-- The WHERE clause prevents overwriting data that was subsequently customised
-- via the admin panel (only empty/null data gets replaced).
insert into vehicles (vehicle_id, data) values
  ('vehicle',  '{"vehicle_id":"vehicle",  "vehicle_name":"Vehicle R",     "type":"vehicle","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/car2.jpg"}'::jsonb),
  ('vehicle2', '{"vehicle_id":"vehicle2", "vehicle_name":"Vehicle R (2)", "type":"vehicle","vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/IMG_1749.jpeg"}'::jsonb),
  ('camry',      '{"vehicle_id":"camry",      "vehicle_name":"Camry 2012",      "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/IMG_0046.png"}'::jsonb),
  ('camry2013',  '{"vehicle_id":"camry2013",  "vehicle_name":"Camry 2013 SE",   "type":"economy",  "vehicle_year":null,"purchase_date":"","purchase_price":0,"status":"active","cover_image":"/images/IMG_5144.png"}'::jsonb)
on conflict (vehicle_id) do update
  set data = excluded.data
  where vehicles.data = '{}'::jsonb or vehicles.data is null;
