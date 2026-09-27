-- Webhook grant dedupe. Billing event names (billing:{source}:{eventId}) must
-- be unique so the app layer's INSERT ... ON CONFLICT DO NOTHING is an atomic
-- claim on the event id: a concurrent duplicate delivery loses the race and
-- never writes a second credit grant. Ordinary analytics event names are not
-- constrained.
CREATE UNIQUE INDEX IF NOT EXISTS "events_billing_dedupe_uq"
  ON "events" ("name")
  WHERE "name" LIKE 'billing:%';
