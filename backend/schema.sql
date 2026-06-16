CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS tracked_emails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_id     UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  subject         TEXT NOT NULL,
  recipient_hashes TEXT[] NOT NULL DEFAULT '{}',
  sender_ip_prefix    TEXT,
  sender_fingerprint  TEXT,
  sent_at             TIMESTAMPTZ DEFAULT now()
);

-- Migration for existing installs
ALTER TABLE tracked_emails ADD COLUMN IF NOT EXISTS sender_ip_prefix TEXT;
ALTER TABLE tracked_emails ADD COLUMN IF NOT EXISTS sender_fingerprint TEXT;

CREATE TABLE IF NOT EXISTS tracked_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id         UUID UNIQUE NOT NULL,
  email_id        UUID NOT NULL REFERENCES tracked_emails(id) ON DELETE CASCADE,
  original_url    TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_tracking_id   UUID,
  link_id             UUID,
  event_type          TEXT NOT NULL CHECK (event_type IN ('open', 'click', 'download')),
  ip_prefix           TEXT,
  session_fingerprint TEXT,
  is_forward          BOOLEAN DEFAULT false,
  original_event_id   UUID REFERENCES events(id),
  user_agent          TEXT,
  occurred_at         TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS opt_outs (
  email_hash  TEXT PRIMARY KEY,
  opted_out_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_email_tracking_id ON events(email_tracking_id);
CREATE INDEX IF NOT EXISTS idx_events_link_id ON events(link_id);
CREATE INDEX IF NOT EXISTS idx_tracked_links_email ON tracked_links(email_id);
CREATE INDEX IF NOT EXISTS idx_tracked_links_link_id ON tracked_links(link_id);
