-- 0009_cms_tables.sql
--
-- What this migration does:
--   Adds the three CMS-related tables that were introduced in COMPLETE_SETUP.sql
--   but were never included in a numbered migration file.  Any Supabase project
--   that was set up by running only migrations 0001–0008 will be missing these
--   tables, which causes "Database schema error" toasts in the admin panel
--   (System Settings save, Site Settings, Content Blocks pages).
--
--   Tables added:
--     site_settings     — flat key/value store for business name, hero text, etc.
--     content_blocks    — FAQs, announcements, and testimonials
--     content_revisions — revision/audit history for CMS changes
--
-- Safe to re-run: all statements use IF NOT EXISTS / ON CONFLICT DO NOTHING.

-- Ensure the shared updated_at helper function exists (created in 0003/0007 but
-- re-declared here for safety so 0009 can be applied independently).
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
-- ── 1. site_settings ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.site_settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_settings_key ON public.site_settings (key);

-- Seed default site settings (idempotent)
INSERT INTO public.site_settings (key, value) VALUES
  ('business_name',        'SLY Transportation Services'),
  ('phone',                ''),
  ('whatsapp',             ''),
  ('email',                ''),
  ('instagram_url',        ''),
  ('facebook_url',         ''),
  ('tiktok_url',           ''),
  ('twitter_url',          ''),
  ('promo_banner_enabled', 'false'),
  ('promo_banner_text',    ''),
  ('hero_title',           'Explore LA in Style'),
  ('hero_subtitle',        'Affordable car rentals in Los Angeles'),
  ('about_text',           ''),
  ('policies_cancellation',''),
  ('policies_damage',      ''),
  ('policies_fuel',        ''),
  ('policies_age',         ''),
  ('service_area_notes',   ''),
  ('pickup_instructions',  '')
ON CONFLICT (key) DO NOTHING;

-- Auto-update trigger
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'site_settings_updated_at') THEN
    CREATE TRIGGER site_settings_updated_at
      BEFORE UPDATE ON public.site_settings
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;


-- ── 2. content_blocks ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.content_blocks (
  block_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT        NOT NULL CHECK (type IN ('faq', 'announcement', 'testimonial')),
  title           TEXT,
  body            TEXT,
  author_name     TEXT,
  author_location TEXT,
  sort_order      INTEGER     NOT NULL DEFAULT 0,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_blocks_type   ON public.content_blocks (type);
CREATE INDEX IF NOT EXISTS idx_content_blocks_active ON public.content_blocks (active);
CREATE INDEX IF NOT EXISTS idx_content_blocks_sort   ON public.content_blocks (sort_order, created_at);

-- Seed starter FAQ content blocks (only if table is empty).
-- Note: the Vehicle deposit amount ($150) mentioned here matches the current
-- pricing in car.js / api/_pricing.js — update this text if pricing changes.
INSERT INTO public.content_blocks (type, title, body, sort_order, active)
SELECT type, title, body, sort_order, active FROM (VALUES
  ('faq', 'What is the minimum rental age?',     'The minimum age to rent is 21 years old. A valid driver''s license is required.',                              1, true),
  ('faq', 'Do you offer airport pickup?',         'Yes, we offer pickup and drop-off at major LA area airports. Please contact us to arrange.',                  2, true),
  ('faq', 'What forms of payment do you accept?', 'We accept all major credit cards via Stripe. Payments are processed securely online.',                        3, true),
  ('faq', 'Is there a security deposit?',         'The Vehicle requires a $150 refundable security deposit collected at pickup. The Camry has no deposit.',    4, true)
) AS v(type, title, body, sort_order, active)
WHERE NOT EXISTS (SELECT 1 FROM public.content_blocks);

-- Auto-update trigger
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'content_blocks_updated_at') THEN
    CREATE TRIGGER content_blocks_updated_at
      BEFORE UPDATE ON public.content_blocks
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;


-- ── 3. content_revisions ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.content_revisions (
  id            BIGSERIAL   PRIMARY KEY,
  resource_type TEXT        NOT NULL,
  resource_id   TEXT        NOT NULL,
  before        JSONB,
  after         JSONB,
  changed_keys  TEXT[],
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_revisions_resource
  ON public.content_revisions (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_content_revisions_created
  ON public.content_revisions (created_at DESC);
