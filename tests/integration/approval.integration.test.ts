import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import type {
  ApprovalDocument,
  DocumentPage,
  HistoryPage,
} from "@j-approval/contracts";
import { integrationRuntime, type Runtime } from "./runtime.js";
import { loadDatabaseConfig } from "../../apps/server/src/config.js";
import { migrate } from "../../apps/server/src/db/migrate.js";

describe("actual j-auth / Keycloak / PostgreSQL approval workflow", () => {
  let rt: Runtime;
  beforeAll(async () => {
    rt = await integrationRuntime();
  });
  afterAll(async () => {
    if (rt) await rt.close();
  });
  const actor = (i = 0) => rt.actors[i]!;
  const make = (line = [actor(1).id, actor(2).id]) =>
    rt.submit(actor().token, line);
  const decide = (
    doc: ApprovalDocument,
    i: number,
    body: unknown = { revision: doc.revision, action: "approve" },
  ) =>
    rt.request(
      `/approval/documents/${doc.id}/decisions`,
      actor(i).token,
      "POST",
      body,
    );
  const detail = (doc: ApprovalDocument, i = 0) =>
    rt.request(`/approval/documents/${doc.id}`, actor(i).token);
  const events = async (id: string) =>
    (
      await rt.pool.query(
        "SELECT action,actor_id,stage,reason FROM approval_history WHERE document_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
  const notifications = async (id: string) =>
    (
      await rt.pool.query(
        "SELECT stage,type,recipient_id,dedup_key,link FROM notification_outbox WHERE document_id=$1 ORDER BY stage,type",
        [id],
      )
    ).rows;
  const counts = async () =>
    (
      await rt.pool.query(
        "SELECT (SELECT count(*)::int FROM approval_documents) AS docs,(SELECT count(*)::int FROM approval_stages) AS stages,(SELECT count(*)::int FROM approval_history) AS history,(SELECT count(*)::int FROM notification_outbox) AS outbox",
      )
    ).rows[0];

  it("uses a non-superuser dedicated database and repeatable immutable migrations", async () => {
    await migrate(rt.pool);
    const result = (
      await rt.pool.query(
        "SELECT current_user,current_database() AS db,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    expect(result).toEqual({
      current_user: "jgw_approval",
      db: "jgw_approval",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    for (const database of ["postgres", "jgw_other"]) {
      const forbidden = new Pool({ ...loadDatabaseConfig(), database });
      try {
        await expect(forbidden.query("SELECT 1")).rejects.toMatchObject({
          code: "42501",
        });
      } finally {
        await forbidden.end();
      }
    }
    expect(
      (await rt.pool.query("SELECT count(*)::int AS n FROM schema_migrations"))
        .rows[0].n,
    ).toBe(1);
  });

  it("accepts actual single-audience member tokens and commits the N-step snapshot with first turn", async () => {
    expect(decodeJwt(actor().token).aud).toBe("j-approval");
    const doc = await make();
    expect(doc).toMatchObject({
      authorId: actor().id,
      status: "pending",
      currentStage: 1,
      revision: 0,
      memberIds: [actor(1).id, actor(2).id],
      body: "document body",
    });
    expect(await events(doc.id)).toEqual([
      { action: "submitted", actor_id: actor().id, stage: 1, reason: null },
    ]);
    expect(await notifications(doc.id)).toEqual([
      {
        stage: 1,
        type: "approval.turn",
        recipient_id: actor(1).id,
        dedup_key: `${doc.id}:1:approval.turn`,
        link: `/approval/documents/${doc.id}`,
      },
    ]);
  });

  it("denies author, later stage, and outsiders without granting processing through roles", async () => {
    const doc = await make();
    for (const i of [0, 2, 3]) expect((await decide(doc, i)).status).toBe(403);
    expect((await events(doc.id)).length).toBe(1);
    expect((await notifications(doc.id)).length).toBe(1);
  });

  it("advances sequentially and completes the last stage with one author notification", async () => {
    const doc = await make();
    const first = await decide(doc, 1);
    expect(first.status).toBe(200);
    const next = (await first.json()) as ApprovalDocument;
    expect(next).toMatchObject({
      status: "pending",
      currentStage: 2,
      revision: 1,
      memberIds: doc.memberIds,
    });
    expect((await decide(doc, 1)).status).toBe(409);
    expect((await decide(next, 1)).status).toBe(403);
    const last = await decide(next, 2);
    expect(last.status).toBe(200);
    const done = (await last.json()) as ApprovalDocument;
    expect(done).toMatchObject({
      status: "approved",
      currentStage: null,
      revision: 2,
    });
    expect((await decide(done, 2)).status).toBe(409);
    expect(await events(doc.id)).toEqual([
      { action: "submitted", actor_id: actor().id, stage: 1, reason: null },
      { action: "approved", actor_id: actor(1).id, stage: 1, reason: null },
      { action: "approved", actor_id: actor(2).id, stage: 2, reason: null },
    ]);
    expect(
      (await notifications(doc.id)).map((x) => [
        x.type,
        x.stage,
        x.recipient_id,
      ]),
    ).toEqual([
      ["approval.turn", 1, actor(1).id],
      ["approval.done", 2, actor().id],
      ["approval.turn", 2, actor(2).id],
    ]);
  });

  it("requires a rejection reason and terminates at that stage", async () => {
    const doc = await make();
    for (const body of [
      { revision: 0, action: "reject" },
      { revision: 0, action: "reject", reason: " \t " },
    ])
      expect((await decide(doc, 1, body)).status).toBe(400);
    const response = await decide(doc, 1, {
      revision: 0,
      action: "reject",
      reason: "  missing information  ",
    });
    expect(response.status).toBe(200);
    const done = (await response.json()) as ApprovalDocument;
    expect(done).toMatchObject({
      status: "rejected",
      currentStage: null,
      revision: 1,
    });
    expect((await decide(done, 2)).status).toBe(409);
    expect((await events(doc.id)).at(-1)).toEqual({
      action: "rejected",
      actor_id: actor(1).id,
      stage: 1,
      reason: "missing information",
    });
    expect(
      (await notifications(doc.id)).find((x) => x.type === "approval.done")
        ?.recipient_id,
    ).toBe(actor().id);
  });

  it("supports one-stage final approval", async () => {
    const doc = await make([actor(1).id]);
    const response = await decide(doc, 1);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "approved",
      currentStage: null,
      revision: 1,
    });
    expect((await notifications(doc.id)).length).toBe(2);
  });

  it("accepts the documented maximum text and 32-stage snapshot without external member lookup", async () => {
    const ids = Array.from({ length: 32 }, () => randomUUID());
    const response = await rt.request(
      "/approval/documents",
      actor().token,
      "POST",
      { title: "x".repeat(200), body: "x".repeat(20000), memberIds: ids },
    );
    expect(response.status).toBe(201);
    const doc = (await response.json()) as ApprovalDocument;
    rt.owned.add(doc.id);
    expect(doc.memberIds).toEqual(ids);
    expect(doc.body.length).toBe(20000);
    expect(
      (
        await rt.pool.query(
          "SELECT count(*)::int AS n FROM approval_stages WHERE document_id=$1",
          [doc.id],
        )
      ).rows[0].n,
    ).toBe(32);
  });

  it("persists a second tenant document while both tenant servers filter reads and inboxes", async () => {
    const response = await rt.request(
      "/approval/documents",
      rt.foreign,
      "POST",
      { title: "second tenant", body: "isolated", memberIds: [randomUUID()] },
      54243,
    );
    expect(response.status).toBe(201);
    const doc = (await response.json()) as ApprovalDocument;
    rt.owned.add(doc.id);
    expect(doc.authorId).toBe(rt.foreignId);
    expect(
      (await rt.request(`/approval/documents/${doc.id}`, actor().token)).status,
    ).toBe(404);
    const list = (await (
      await rt.request(
        "/approval/documents?view=authored",
        rt.foreign,
        "GET",
        undefined,
        54243,
      )
    ).json()) as DocumentPage;
    expect(list.items.map((x) => x.id)).toEqual([doc.id]);
    expect(
      (
        await rt.pool.query(
          "SELECT tenant_id FROM approval_documents WHERE id=$1",
          [doc.id],
        )
      ).rows[0].tenant_id,
    ).toBe("sample-b");
  });

  it("rejects invalid lines, oversized text, identity overrides, and decision fields before writing", async () => {
    const before = await counts();
    for (const body of [
      { title: "x", body: "x", memberIds: [] },
      { title: "x", body: "x", memberIds: [actor().id] },
      { title: "x", body: "x", memberIds: [actor(1).id, actor(1).id] },
      { title: "x", body: "x", memberIds: ["  "] },
      { title: "x", body: "x", memberIds: ["bad\u0000id"] },
      {
        title: "x",
        body: "x",
        memberIds: Array.from({ length: 33 }, (_, i) => `member-${i}`),
      },
      { title: "x".repeat(201), body: "x", memberIds: [actor(1).id] },
      { title: "x", body: "x".repeat(20001), memberIds: [actor(1).id] },
      { title: "x", body: "x", memberIds: [actor(1).id], tenant: "sample-b" },
      {
        title: "x",
        body: "x",
        memberIds: [actor(1).id],
        authorId: actor(1).id,
      },
    ])
      expect(
        (await rt.request("/approval/documents", actor().token, "POST", body))
          .status,
      ).toBe(400);
    expect(await counts()).toEqual(before);
    const doc = await make();
    for (const body of [
      { revision: -1, action: "approve" },
      { revision: 0, action: "approve", actorId: actor(1).id },
      { revision: 0, action: "approve", reason: "x" },
      { revision: 0, action: "reject", reason: "x".repeat(2001) },
    ])
      expect((await decide(doc, 1, body)).status).toBe(400);
    expect((await events(doc.id)).length).toBe(1);
  });

  it("denies missing/malformed cookies, the original audience, and real members without approval:use", async () => {
    const url =
      "https://approval.jgw.test:54242/approval/documents?view=authored";
    for (const headers of [
      {},
      { Cookie: "session=x" },
      { Authorization: "Bearer malformed" },
      { Authorization: `Bearer ${actor().token}`, Cookie: "session=x" },
    ])
      expect((await rt.fetch(url, { headers })).status).toBe(401);
    expect(
      (await rt.request("/approval/documents?view=authored", actor().original))
        .status,
    ).toBe(401);
    expect(
      (await rt.request("/approval/documents?view=authored", rt.noRole)).status,
    ).toBe(403);
  });

  it("isolates actual realm tokens and documents, leaving no denied-read history", async () => {
    const doc = await make(),
      before = await counts();
    expect(
      (await rt.request(`/approval/documents/${doc.id}`, rt.foreign)).status,
    ).toBe(401);
    expect(
      (
        await rt.request(
          `/approval/documents/${doc.id}`,
          rt.foreign,
          "GET",
          undefined,
          54243,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await rt.request(
          `/approval/documents/${doc.id}/decisions`,
          rt.foreign,
          "POST",
          { revision: 0, action: "approve" },
          54243,
        )
      ).status,
    ).toBe(404);
    expect((await detail(doc, 3)).status).toBe(403);
    expect(
      (
        await rt.request(
          `/approval/documents/${doc.id}/history`,
          actor(3).token,
        )
      ).status,
    ).toBe(403);
    expect(await counts()).toEqual(before);
  });

  it("stores invalid unknown or foreign assignees without allowing another realm to process them", async () => {
    const doc = await make([rt.foreignId, randomUUID()]);
    expect(doc.memberIds[0]).toBe(rt.foreignId);
    expect(
      (
        await rt.request(
          `/approval/documents/${doc.id}/decisions`,
          rt.foreign,
          "POST",
          { revision: 0, action: "approve" },
        )
      ).status,
    ).toBe(401);
    expect((await decide(doc, 1)).status).toBe(403);
    expect(
      (
        await rt.pool.query(
          "SELECT status,revision FROM approval_documents WHERE id=$1",
          [doc.id],
        )
      ).rows[0],
    ).toEqual({ status: "pending", revision: 0 });
  });

  it("protects snapshots and append-only history in PostgreSQL, including terminal views", async () => {
    const doc = await make([actor(1).id]);
    for (const statement of [
      "UPDATE approval_documents SET title='changed' WHERE id=$1",
      "UPDATE approval_stages SET assignee_id='changed' WHERE document_id=$1",
      "DELETE FROM approval_history WHERE document_id=$1",
      "UPDATE approval_history SET actor_id='changed' WHERE document_id=$1",
    ])
      await expect(rt.pool.query(statement, [doc.id])).rejects.toMatchObject({
        code: "42501",
      });
    const done = (await (await decide(doc, 1)).json()) as ApprovalDocument;
    const viewed = await detail(done);
    expect(viewed.status).toBe(200);
    expect(await viewed.json()).toEqual(done);
    expect((await events(doc.id)).at(-1)).toMatchObject({
      action: "viewed",
      stage: null,
      actor_id: actor().id,
    });
    expect((await detail(done, 1)).status).toBe(200);
  });

  it("returns only the actor's authored, current pending, or processed documents", async () => {
    const doc = await make();
    const list = async (i: number, view: string) =>
      (await (
        await rt.request(`/approval/documents?view=${view}`, actor(i).token)
      ).json()) as DocumentPage;
    expect((await list(0, "authored")).items.some((x) => x.id === doc.id)).toBe(
      true,
    );
    expect((await list(1, "pending")).items.some((x) => x.id === doc.id)).toBe(
      true,
    );
    expect((await list(2, "pending")).items.some((x) => x.id === doc.id)).toBe(
      false,
    );
    expect((await list(3, "authored")).items).toEqual([]);
    expect((await list(3, "pending")).items).toEqual([]);
    const next = (await (await decide(doc, 1)).json()) as ApprovalDocument;
    expect(
      (await list(1, "processed")).items.some((x) => x.id === doc.id),
    ).toBe(true);
    expect((await list(1, "pending")).items.some((x) => x.id === doc.id)).toBe(
      false,
    );
    expect((await list(2, "pending")).items.some((x) => x.id === next.id)).toBe(
      true,
    );
    expect((await list(1, "processed")).items[0]).not.toHaveProperty("body");
  });

  it("paginates real submissions without duplicates and binds cursors to actor, tenant, and view", async () => {
    for (let i = 0; i < 51; i++)
      await rt.submit(actor(3).token, [actor(1).id], `page ${i}`);
    const first = (await (
      await rt.request("/approval/documents?view=authored", actor(3).token)
    ).json()) as DocumentPage;
    expect(first.items.length).toBe(50);
    expect(first.nextCursor).toBeTruthy();
    const second = (await (
      await rt.request(
        `/approval/documents?view=authored&cursor=${first.nextCursor}`,
        actor(3).token,
      )
    ).json()) as DocumentPage;
    expect(second.items.length).toBe(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((x) => x.id)).size,
    ).toBe(51);
    for (const [bearer, view, port] of [
      [actor().token, "authored", 54242],
      [actor(3).token, "pending", 54242],
      [rt.foreign, "authored", 54243],
    ] as const)
      expect(
        (
          await rt.request(
            `/approval/documents?view=${view}&cursor=${first.nextCursor}`,
            bearer,
            "GET",
            undefined,
            port,
          )
        ).status,
      ).toBe(400);
    expect(
      (
        await rt.request(
          "/approval/documents?view=authored&cursor=bad",
          actor().token,
        )
      ).status,
    ).toBe(400);
  });

  it("paginates append-only actual views with microsecond cursor precision and no duplicate events", async () => {
    const doc = await make();
    for (let i = 0; i < 51; i++) expect((await detail(doc)).status).toBe(200);
    const path = `/approval/documents/${doc.id}/history`;
    const first = (await (
      await rt.request(path, actor().token)
    ).json()) as HistoryPage;
    expect(first.items.length).toBe(50);
    expect(first.nextCursor).toBeTruthy();
    const second = (await (
      await rt.request(`${path}?cursor=${first.nextCursor}`, actor().token)
    ).json()) as HistoryPage;
    expect(second.items.length).toBe(3);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((x) => x.id)).size,
    ).toBe(53);
    const before = await counts();
    expect(
      (await rt.request(`${path}?cursor=${first.nextCursor}`, actor(1).token))
        .status,
    ).toBe(400);
    expect(await counts()).toEqual(before);
  });

  it("serializes concurrent approval/rejection of the same revision into one decision", async () => {
    const doc = await make([actor(1).id]);
    const responses = await Promise.all([
      decide(doc, 1),
      decide(doc, 1, {
        revision: 0,
        action: "reject",
        reason: "concurrent rejection",
      }),
    ]);
    expect(responses.map((x) => x.status).sort()).toEqual([200, 409]);
    const winner = (await responses
      .find((x) => x.status === 200)!
      .json()) as ApprovalDocument;
    expect(winner.revision).toBe(1);
    expect(["approved", "rejected"]).toContain(winner.status);
    const actions = (await events(doc.id)).filter(
      (x) => x.action !== "submitted",
    );
    expect(actions.length).toBe(1);
    expect(actions[0].action).toBe(winner.status);
    expect(
      (await notifications(doc.id)).filter((x) => x.type === "approval.done")
        .length,
    ).toBe(1);
  });

  const failOutbox = async (run: () => Promise<void>) => {
    await rt.pool.query(
      "CREATE FUNCTION test_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated outbox failure'; END $$; CREATE TRIGGER test_outbox_failure BEFORE INSERT ON notification_outbox FOR EACH ROW EXECUTE FUNCTION test_fail_outbox()",
    );
    try {
      await run();
    } finally {
      await rt.pool.query(
        "DROP TRIGGER test_outbox_failure ON notification_outbox; DROP FUNCTION test_fail_outbox()",
      );
    }
  };
  it("rolls back submission, all stages, history and outbox on actual database failure", async () => {
    const before = await counts();
    await failOutbox(async () => {
      const response = await rt.request(
        "/approval/documents",
        actor().token,
        "POST",
        { title: "failure", body: "x", memberIds: [actor(1).id, actor(2).id] },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "unavailable" });
      expect(await counts()).toEqual(before);
    });
    expect((await make()).status).toBe("pending");
  });

  it("rolls back approval on actual outbox failure and accepts a retry of the unchanged revision", async () => {
    const doc = await make(),
      before = await counts();
    await failOutbox(async () => {
      expect((await decide(doc, 1)).status).toBe(503);
      expect(await counts()).toEqual(before);
      expect(
        (
          await rt.pool.query(
            "SELECT status,current_stage,revision FROM approval_documents WHERE id=$1",
            [doc.id],
          )
        ).rows[0],
      ).toEqual({ status: "pending", current_stage: 1, revision: 0 });
    });
    expect((await decide(doc, 1)).status).toBe(200);
    expect(
      (await events(doc.id)).filter((x) => x.action === "approved").length,
    ).toBe(1);
    expect((await notifications(doc.id)).length).toBe(2);
  });

  it("returns 503 for actual PostgreSQL connection and JWKS network failures before mutation", async () => {
    const badPool = new Pool({
      ...loadDatabaseConfig(),
      port: 54299,
      connectionTimeoutMillis: 500,
    });
    const badDb = await rt.newApp("sample-a", 54245, { pool: badPool });
    try {
      expect(
        (
          await rt.request(
            "/approval/documents?view=authored",
            actor().token,
            "GET",
            undefined,
            54245,
          )
        ).status,
      ).toBe(503);
    } finally {
      await badDb.close();
      await badPool.end();
    }
    const failedFetch: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      url.port = "54299";
      return rt.fetch(url, { ...init, signal: AbortSignal.timeout(500) });
    };
    const badJwks = await rt.newApp("sample-a", 54246, { fetch: failedFetch });
    const before = await counts();
    try {
      const response = await rt.request(
        "/approval/documents",
        actor().token,
        "POST",
        { title: "x", body: "x", memberIds: [actor(1).id] },
        54246,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "unavailable" });
      expect(await counts()).toEqual(before);
    } finally {
      await badJwks.close();
    }
  });

  it("runs compiled HTTPS startup, shutdown, and restart with persisted documents and safe logs", async () => {
    const doc = await make();
    const first = await rt.startCompiled();
    expect(
      (
        await rt.request(
          `/approval/documents/${doc.id}`,
          actor().token,
          "GET",
          undefined,
          54244,
        )
      ).status,
    ).toBe(200);
    await rt.stop(first);
    expect(first.exitCode).toBe(0);
    const second = await rt.startCompiled();
    const response = await rt.request(
      `/approval/documents/${doc.id}`,
      actor().token,
      "GET",
      undefined,
      54244,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(doc);
    await rt.stop(second);
    expect(second.exitCode).toBe(0);
    const text = rt.logs.join("");
    for (const secret of rt.secrets) expect(text.includes(secret)).toBe(false);
    expect(text.includes("document body")).toBe(false);
  });
});
