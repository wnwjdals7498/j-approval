CREATE TABLE approval_documents (
  tenant_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  author_id text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  current_stage integer DEFAULT 1,
  revision integer NOT NULL DEFAULT 0 CHECK (revision>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  CHECK ((status='pending' AND current_stage IS NOT NULL AND current_stage BETWEEN 1 AND 32) OR (status<>'pending' AND current_stage IS NULL))
);
CREATE TABLE approval_stages (
  tenant_id text NOT NULL,
  document_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 32),
  assignee_id text NOT NULL CHECK (length(assignee_id) BETWEEN 1 AND 128),
  PRIMARY KEY(tenant_id,document_id,position),
  UNIQUE(tenant_id,document_id,assignee_id),
  FOREIGN KEY(tenant_id,document_id) REFERENCES approval_documents(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE approval_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  document_id uuid NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('submitted','viewed','approved','rejected')),
  stage integer,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(tenant_id,document_id) REFERENCES approval_documents(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,document_id,stage) REFERENCES approval_stages(tenant_id,document_id,position),
  CHECK ((action='rejected' AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 2000) OR (action<>'rejected' AND reason IS NULL))
);
CREATE TABLE notification_outbox (
  tenant_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  stage integer NOT NULL,
  type text NOT NULL CHECK (type IN ('approval.turn','approval.done')),
  dedup_key text NOT NULL,
  recipient_id text NOT NULL,
  link text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,dedup_key),
  FOREIGN KEY(tenant_id,document_id,stage) REFERENCES approval_stages(tenant_id,document_id,position)
);
CREATE INDEX approval_document_order ON approval_documents(tenant_id,created_at DESC,id DESC);
CREATE INDEX approval_author_order ON approval_documents(tenant_id,author_id,created_at DESC,id DESC);
CREATE INDEX approval_assignees ON approval_stages(tenant_id,assignee_id,document_id,position);
CREATE INDEX approval_history_order ON approval_history(tenant_id,document_id,created_at DESC,id DESC);
CREATE INDEX approval_processed ON approval_history(tenant_id,actor_id,document_id) WHERE action IN ('approved','rejected');
ALTER TABLE approval_documents ADD FOREIGN KEY(tenant_id,id,current_stage) REFERENCES approval_stages(tenant_id,document_id,position) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION jap_protect_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.tenant_id,OLD.id,OLD.author_id,OLD.title,OLD.body) IS DISTINCT FROM ROW(NEW.tenant_id,NEW.id,NEW.author_id,NEW.title,NEW.body) THEN
    RAISE EXCEPTION 'Approval snapshot is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER jap_snapshot_immutable BEFORE UPDATE ON approval_documents FOR EACH ROW EXECUTE FUNCTION jap_protect_snapshot();
CREATE FUNCTION jap_protect_immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Approval stages and history are immutable' USING ERRCODE='42501';
END;
$$;
CREATE TRIGGER jap_stages_immutable BEFORE UPDATE OR DELETE ON approval_stages FOR EACH ROW EXECUTE FUNCTION jap_protect_immutable_row();
CREATE TRIGGER jap_history_immutable BEFORE UPDATE OR DELETE ON approval_history FOR EACH ROW EXECUTE FUNCTION jap_protect_immutable_row();
REVOKE ALL ON FUNCTION jap_protect_snapshot(),jap_protect_immutable_row() FROM PUBLIC;
REVOKE ALL ON approval_documents,approval_stages,approval_history,notification_outbox FROM PUBLIC;
