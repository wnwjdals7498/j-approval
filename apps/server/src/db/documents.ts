import type { Pool, PoolClient } from "pg";
import type {
  SubmitDocument,
  DecideDocument,
  ApprovalDocument,
  DocumentSummary,
  DocumentPage,
  ApprovalListView,
  ApprovalHistory,
  HistoryPage,
  ApprovalStatus,
} from "@j-approval/contracts";
import { ApiError, missing, forbidden, conflict } from "../errors.js";
import { submission, decision } from "../validation.js";

interface Row {
  id: string;
  author_id: string;
  title: string;
  body: string;
  status: ApprovalStatus;
  current_stage: number | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
  cursor_time: string;
}
interface HistoryRow {
  id: string;
  action: ApprovalHistory["action"];
  actor_id: string;
  stage: number | null;
  reason: string | null;
  created_at: Date;
  cursor_time: string;
}
const summary = (row: Row): DocumentSummary => ({
  id: row.id,
  authorId: row.author_id,
  title: row.title,
  status: row.status,
  currentStage: row.current_stage,
  revision: row.revision,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
const history = (row: HistoryRow): ApprovalHistory => ({
  id: row.id,
  action: row.action,
  actorId: row.actor_id,
  stage: row.stage,
  reason: row.reason,
  createdAt: row.created_at.toISOString(),
});
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function cursor(
  input: string | undefined,
  scope: string,
  kind: "document" | "history",
): [string | null, string | null] {
  if (!input) return [null, null];
  try {
    const value: unknown = JSON.parse(
      Buffer.from(input, "base64url").toString(),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      value[0] !== scope ||
      typeof value[1] !== "string" ||
      !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?\+00$/.test(value[1]) ||
      value[1].startsWith("0000-") ||
      typeof value[2] !== "string" ||
      (kind === "document"
        ? !uuid.test(value[2])
        : !/^[1-9][0-9]{0,18}$/.test(value[2]))
    )
      throw new Error();
    const parsed = new Date(value[1].replace(" ", "T") + ":00");
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 19) !==
        value[1].slice(0, 19).replace(" ", "T") ||
      (kind === "history" && BigInt(value[2]) > 9223372036854775807n)
    )
      throw new Error();
    return [value[1], value[2]];
  } catch {
    throw new ApiError(400, "invalid_input", "Invalid approval cursor.");
  }
}
const encode = (scope: string, row: { cursor_time: string; id: string }) =>
  Buffer.from(JSON.stringify([scope, row.cursor_time, row.id])).toString(
    "base64url",
  );
export class DocumentStore {
  constructor(
    private readonly pool: Pool,
    private readonly tenant: string,
  ) {}
  private async transaction<T>(
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  private async load(
    client: PoolClient,
    id: string,
    lock = false,
  ): Promise<Row> {
    const result = await client.query<Row>(
      `SELECT *,created_at::text AS cursor_time FROM approval_documents WHERE tenant_id=$1 AND id=$2 ${lock ? "FOR UPDATE" : ""}`,
      [this.tenant, id],
    );
    if (!result.rows[0]) throw missing();
    return result.rows[0];
  }
  private async line(client: PoolClient, id: string): Promise<string[]> {
    return (
      await client.query<{ assignee_id: string }>(
        "SELECT assignee_id FROM approval_stages WHERE tenant_id=$1 AND document_id=$2 ORDER BY position",
        [this.tenant, id],
      )
    ).rows.map((row) => row.assignee_id);
  }
  private participant(author: string, row: Row, line: readonly string[]): void {
    if (row.author_id !== author && !line.includes(author)) throw forbidden();
  }
  private async event(
    client: PoolClient,
    id: string,
    actor: string,
    action: ApprovalHistory["action"],
    stage: number | null,
    reason: string | null = null,
  ): Promise<void> {
    await client.query(
      "INSERT INTO approval_history(tenant_id,document_id,actor_id,action,stage,reason) VALUES($1,$2,$3,$4,$5,$6)",
      [this.tenant, id, actor, action, stage, reason],
    );
  }
  private async notify(
    client: PoolClient,
    id: string,
    stage: number,
    type: "approval.turn" | "approval.done",
    recipient: string,
  ): Promise<void> {
    await client.query(
      "INSERT INTO notification_outbox(tenant_id,document_id,stage,type,dedup_key,recipient_id,link) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        this.tenant,
        id,
        stage,
        type,
        `${id}:${stage}:${type}`,
        recipient,
        `/approval/documents/${id}`,
      ],
    );
  }
  submit(author: string, raw: SubmitDocument): Promise<ApprovalDocument> {
    const input = submission(author, raw);
    return this.transaction(async (client) => {
      const row = (
        await client.query<Row>(
          "INSERT INTO approval_documents(tenant_id,author_id,title,body) VALUES($1,$2,$3,$4) RETURNING *,created_at::text AS cursor_time",
          [this.tenant, author, input.title, input.body],
        )
      ).rows[0]!;
      await client.query(
        "INSERT INTO approval_stages(tenant_id,document_id,position,assignee_id) SELECT $1,$2,ordinality,value FROM unnest($3::text[]) WITH ORDINALITY AS stage(value,ordinality)",
        [this.tenant, row.id, input.memberIds],
      );
      await this.event(client, row.id, author, "submitted", 1);
      await this.notify(
        client,
        row.id,
        1,
        "approval.turn",
        input.memberIds[0]!,
      );
      return { ...summary(row), body: row.body, memberIds: input.memberIds };
    });
  }
  read(actor: string, id: string): Promise<ApprovalDocument> {
    return this.transaction(async (client) => {
      const row = await this.load(client, id, true),
        line = await this.line(client, id);
      this.participant(actor, row, line);
      await this.event(client, id, actor, "viewed", row.current_stage);
      return { ...summary(row), body: row.body, memberIds: line };
    });
  }
  decide(
    actor: string,
    id: string,
    raw: DecideDocument,
  ): Promise<ApprovalDocument> {
    const input = decision(raw);
    return this.transaction(async (client) => {
      const row = await this.load(client, id, true),
        line = await this.line(client, id);
      this.participant(actor, row, line);
      if (row.status !== "pending" || row.revision !== input.revision)
        throw conflict();
      const stage = row.current_stage!;
      if (line[stage - 1] !== actor) throw forbidden();
      const status: ApprovalStatus =
        input.action === "reject"
          ? "rejected"
          : stage === line.length
            ? "approved"
            : "pending";
      const next = status === "pending" ? stage + 1 : null;
      const updated = (
        await client.query<Row>(
          "UPDATE approval_documents SET status=$3,current_stage=$4,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *,created_at::text AS cursor_time",
          [this.tenant, id, status, next],
        )
      ).rows[0]!;
      await this.event(
        client,
        id,
        actor,
        input.action === "approve" ? "approved" : "rejected",
        stage,
        input.action === "reject" ? input.reason : null,
      );
      await this.notify(
        client,
        id,
        status === "pending" ? next! : stage,
        status === "pending" ? "approval.turn" : "approval.done",
        status === "pending" ? line[next! - 1]! : row.author_id,
      );
      return { ...summary(updated), body: updated.body, memberIds: line };
    });
  }
  async list(
    actor: string,
    view: ApprovalListView,
    input?: string,
  ): Promise<DocumentPage> {
    const scope = JSON.stringify([this.tenant, actor, view]),
      [time, id] = cursor(input, scope, "document");
    const result = await this.pool.query<Row>(
      `SELECT d.*,d.created_at::text AS cursor_time FROM approval_documents d WHERE d.tenant_id=$1 AND (($3='authored' AND d.author_id=$2) OR ($3='pending' AND d.status='pending' AND EXISTS(SELECT 1 FROM approval_stages s WHERE s.tenant_id=d.tenant_id AND s.document_id=d.id AND s.position=d.current_stage AND s.assignee_id=$2)) OR ($3='processed' AND EXISTS(SELECT 1 FROM approval_history h WHERE h.tenant_id=d.tenant_id AND h.document_id=d.id AND h.actor_id=$2 AND h.action IN ('approved','rejected')))) AND ($4::timestamptz IS NULL OR (d.created_at,d.id)<($4::timestamptz,$5::uuid)) ORDER BY d.created_at DESC,d.id DESC LIMIT 51`,
      [this.tenant, actor, view, time, id],
    );
    const items = result.rows.slice(0, 50),
      last = items.at(-1);
    return {
      items: items.map(summary),
      nextCursor: result.rows.length > 50 && last ? encode(scope, last) : null,
    };
  }
  history(actor: string, id: string, input?: string): Promise<HistoryPage> {
    const scope = JSON.stringify([this.tenant, actor, id]),
      [time, eventId] = cursor(input, scope, "history");
    return this.transaction(async (client) => {
      const row = await this.load(client, id, true),
        line = await this.line(client, id);
      this.participant(actor, row, line);
      await this.event(client, id, actor, "viewed", row.current_stage);
      const result = await client.query<HistoryRow>(
        "SELECT *,created_at::text AS cursor_time FROM approval_history WHERE tenant_id=$1 AND document_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::bigint)) ORDER BY created_at DESC,id DESC LIMIT 51",
        [this.tenant, id, time, eventId],
      );
      const items = result.rows.slice(0, 50),
        last = items.at(-1);
      return {
        items: items.map(history),
        nextCursor:
          result.rows.length > 50 && last ? encode(scope, last) : null,
      };
    });
  }
}
