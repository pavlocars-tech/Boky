-- TaxiAds: Grundschema
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Kunden und Benutzer
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  address       text,
  vat_id        text,
  phone         text,
  contact_email citext,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext NOT NULL UNIQUE,
  password_hash     text,
  name              text NOT NULL,
  role              text NOT NULL CHECK (role IN ('admin', 'customer')),
  customer_id       uuid REFERENCES customers(id) ON DELETE CASCADE,
  customer_role     text CHECK (customer_role IN ('owner', 'member')),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  email_verified_at timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_customer CHECK (
    (role = 'admin' AND customer_id IS NULL AND customer_role IS NULL) OR
    (role = 'customer' AND customer_id IS NOT NULL AND customer_role IS NOT NULL)
  )
);
CREATE INDEX users_customer_idx ON users (customer_id);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  bytea NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  ip          inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Einmal-Tokens: E-Mail bestätigen, Passwort zurücksetzen, Einladung
CREATE TABLE user_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify_email', 'password_reset', 'invite')),
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Einstellungen
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- Fahrzeuge und Geräte (keine Fahrerdaten!)
-- ---------------------------------------------------------------------------
CREATE TABLE vehicles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label         text NOT NULL UNIQUE,      -- z. B. Taxinummer
  license_plate text,
  notes         text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id               uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  screen_slot              smallint CHECK (screen_slot >= 1),
  public_key               text NOT NULL UNIQUE,
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  name                     text,
  manufacturer             text,
  model                    text,
  android_version          text,
  app_version              text,
  serial                   text,
  paired_at                timestamptz NOT NULL DEFAULT now(),
  last_seen_at             timestamptz,
  last_ip                  inet,
  last_playlist_version    integer,
  last_config_hash         text,
  last_free_storage_bytes  bigint,
  last_total_storage_bytes bigint,
  last_battery_percent     smallint,
  last_brightness_percent  smallint,
  last_clock_skew_ms       integer,
  last_now_playing         jsonb,
  last_pending             jsonb,
  last_position            geography(Point, 4326),
  last_position_at         timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_slot_requires_vehicle CHECK (vehicle_id IS NOT NULL OR screen_slot IS NULL)
);
CREATE UNIQUE INDEX devices_vehicle_slot_uidx ON devices (vehicle_id, screen_slot) WHERE vehicle_id IS NOT NULL;
CREATE INDEX devices_vehicle_idx ON devices (vehicle_id);

-- Historie der Zuordnung Gerät -> Fahrzeug (für nachträglich hochgeladene Logs)
CREATE TABLE device_assignments (
  id            bigserial PRIMARY KEY,
  device_id     uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz
);
CREATE INDEX device_assignments_device_idx ON device_assignments (device_id);

CREATE TABLE device_pairings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL,
  public_key  text NOT NULL,
  device_info jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'expired')),
  device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  claimed_at  timestamptz,
  claimed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX device_pairings_pending_code_uidx ON device_pairings (code) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Medien, Kampagnen, Motive, Zuteilungen, Füllinhalte
-- ---------------------------------------------------------------------------
CREATE TABLE media_assets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose              text NOT NULL CHECK (purpose IN ('creative', 'filler')),
  customer_id          uuid REFERENCES customers(id) ON DELETE CASCADE,
  original_key         text NOT NULL,
  processed_key        text,
  original_filename    text NOT NULL,
  declared_mime_type   text NOT NULL,
  declared_size_bytes  bigint NOT NULL,
  media_type           text CHECK (media_type IN ('image', 'video')),
  width                integer,
  height               integer,
  duration_ms          integer,
  sha256               text,
  size_bytes           bigint,
  status               text NOT NULL DEFAULT 'awaiting_upload'
                         CHECK (status IN ('awaiting_upload', 'processing', 'ready', 'failed')),
  error                text,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_assets_customer_idx ON media_assets (customer_id);

CREATE TABLE campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name             text NOT NULL,
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  vehicle_count    integer NOT NULL CHECK (vehicle_count > 0),
  seconds_per_loop integer NOT NULL CHECK (seconds_per_loop > 0),
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'booked', 'paused', 'ended', 'cancelled')),
  booked_at        timestamptz,
  ended_at         timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_period CHECK (end_date >= start_date)
);
CREATE INDEX campaigns_customer_idx ON campaigns (customer_id);
CREATE INDEX campaigns_status_idx ON campaigns (status);

CREATE TABLE creatives (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  media_asset_id uuid NOT NULL REFERENCES media_assets(id),
  title          text NOT NULL,
  sort_order     integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'processing'
                   CHECK (status IN ('processing', 'pending_review', 'approved', 'rejected', 'failed', 'archived')),
  review_note    text,
  reviewed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creatives_campaign_idx ON creatives (campaign_id);
CREATE INDEX creatives_status_idx ON creatives (status);

-- Verkaufte Zeit: Kampagne läuft auf Fahrzeug im Zeitraum mit X Sekunden pro Schleife
CREATE TABLE allocations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  vehicle_id       uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  seconds_per_loop integer NOT NULL CHECK (seconds_per_loop > 0),
  period           daterange GENERATED ALWAYS AS (daterange(start_date, end_date, '[]')) STORED,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allocations_period CHECK (end_date >= start_date),
  -- eine Kampagne belegt ein Fahrzeug an einem Tag höchstens einmal
  CONSTRAINT allocations_no_overlap EXCLUDE USING gist (campaign_id WITH =, vehicle_id WITH =, period WITH &&)
);
CREATE INDEX allocations_vehicle_period_idx ON allocations USING gist (vehicle_id, period);
CREATE INDEX allocations_campaign_idx ON allocations (campaign_id);

CREATE TABLE fillers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id uuid NOT NULL REFERENCES media_assets(id),
  title          text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  start_date     date,
  end_date       date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Vorbereitet für Version 2 (Gebiete/Uhrzeiten), wird in Version 1 nicht ausgewertet
CREATE TABLE targeting_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('geo', 'time')),
  area         geography(MultiPolygon, 4326),
  time_windows jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Playlists
-- ---------------------------------------------------------------------------
CREATE TABLE playlists (
  id           bigserial PRIMARY KEY,
  vehicle_id   uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  content_hash text NOT NULL,
  valid_from   date NOT NULL,
  valid_to     date NOT NULL,
  body         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, version)
);

-- ---------------------------------------------------------------------------
-- Massendaten (monatlich partitioniert, ohne Fremdschlüssel für schnelle Inserts)
-- ---------------------------------------------------------------------------
CREATE TABLE playback_events (
  id                uuid NOT NULL,
  device_id         uuid NOT NULL,
  vehicle_id        uuid NOT NULL,
  kind              text NOT NULL,
  campaign_id       uuid,
  creative_id       uuid,
  filler_id         uuid,
  media_asset_id    uuid,
  started_at        timestamptz NOT NULL,
  planned_ms        integer NOT NULL,
  played_ms         integer NOT NULL,
  completed         boolean NOT NULL,
  abort_reason      text,
  position          geography(Point, 4326),
  position_accuracy real,
  playlist_version  integer,
  received_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);
CREATE INDEX playback_events_campaign_idx ON playback_events (campaign_id, started_at);
CREATE INDEX playback_events_vehicle_idx ON playback_events (vehicle_id, started_at);

CREATE TABLE gps_points (
  id          uuid NOT NULL,
  device_id   uuid NOT NULL,
  vehicle_id  uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  position    geography(Point, 4326) NOT NULL,
  accuracy    real,
  speed       real,
  heading     real,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);
CREATE INDEX gps_points_vehicle_idx ON gps_points (vehicle_id, recorded_at);

CREATE TABLE device_heartbeats (
  device_id   uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL
) PARTITION BY RANGE (received_at);
CREATE INDEX device_heartbeats_device_idx ON device_heartbeats (device_id, received_at);

-- Legt die Monatspartition für `month_start` an (idempotent, parallel sicher).
CREATE OR REPLACE FUNCTION ensure_month_partition(parent text, month_start date) RETURNS text AS $$
DECLARE
  first_day date := date_trunc('month', month_start)::date;
  part      text := parent || '_' || to_char(first_day, 'YYYYMM');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(part));
  IF to_regclass(part) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      part, parent,
      (first_day::timestamp AT TIME ZONE 'UTC'),
      ((first_day + interval '1 month')::timestamp AT TIME ZONE 'UTC')
    );
  END IF;
  RETURN part;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Hintergrundjobs (einfache Warteschlange in PostgreSQL)
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  dedupe_key   text UNIQUE,
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  locked_until timestamptz,
  requeue      boolean NOT NULL DEFAULT false,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE attempts < max_attempts;

CREATE TABLE scheduled_runs (
  name     text PRIMARY KEY,
  last_run date NOT NULL
);

-- updated_at-Trigger
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'users', 'vehicles', 'devices', 'media_assets', 'campaigns', 'creatives', 'fillers']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
