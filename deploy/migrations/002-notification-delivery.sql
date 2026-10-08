ALTER TABLE notification_outbox
 ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 ADD COLUMN available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ADD COLUMN locked_until timestamptz,
 ADD COLUMN lease_token uuid,
 ADD COLUMN delivered_at timestamptz,
 ADD COLUMN last_error text CHECK(last_error IS NULL OR last_error='delivery_failed');
CREATE INDEX approval_outbox_delivery ON notification_outbox(tenant_id,available_at,created_at,id) WHERE delivered_at IS NULL;
