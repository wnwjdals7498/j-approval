import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { decodeJwt } from "jose";
import { Pool } from "pg";
import type { ApprovalDocument } from "@j-approval/contracts";
import { createApp } from "../../apps/server/src/app.js";
import { loadDatabaseConfig } from "../../apps/server/src/config.js";
import { migrate } from "../../apps/server/src/db/migrate.js";

export const required = (name: string) => {
  const value = process.env[name];
  if (!value)
    throw new Error(`Isolated integration requires ${name}. No skip.`);
  return value;
};
export async function integrationRuntime() {
  if (
    required("JAP_TEST_RUNTIME") !== "isolated-cloud" ||
    required("JAUTH_TEST_RUNTIME") !== "isolated-cloud" ||
    new URL(required("KC_PUBLIC_URL")).hostname !== "auth.jgw.test"
  )
    throw new Error("Isolated cloud only.");
  const cert = await readFile(required("JAP_TLS_CERTIFICATE")),
    key = await readFile(required("JAP_TLS_KEY"));
  const agent = new Agent({
    connect: {
      ca: [cert, await readFile(required("JAUTH_TLS_CERTIFICATE"))],
      lookup: (host, options, callback) => {
        if (
          ["auth.jgw.test", "jauth.jgw.test", "approval.jgw.test"].includes(
            host,
          )
        ) {
          if (options.all)
            callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        } else lookup(host, options, callback);
      },
    },
  });
  const fetch: typeof globalThis.fetch = async (input, init) =>
    (await undiciFetch(String(input), {
      ...init,
      dispatcher: agent,
      redirect: "error",
      signal: init?.signal ?? AbortSignal.timeout(10000),
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  const pool = new Pool(loadDatabaseConfig());
  const apps: ReturnType<typeof createApp>[] = [],
    children: ReturnType<typeof spawn>[] = [],
    logs: string[] = [],
    secrets = new Set<string>();
  const members = new Set<string>(),
    owned = new Set<string>();
  let admin = "";
  const auth = async (path: string, method = "GET", body?: unknown) =>
    fetch("https://jauth.jgw.test:54231" + path, {
      method,
      headers: {
        Authorization: `Bearer ${admin}`,
        "X-JGW-Service-Key": required("JGW_SAMPLE_A_SERVICE_KEY"),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const stop = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    timer.unref();
    try {
      await done;
    } finally {
      clearTimeout(timer);
    }
  };
  const start = async (
    cwd: string,
    args: string[],
    url: string,
    env: NodeJS.ProcessEnv = process.env,
  ) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout?.on("data", (b: Buffer) => logs.push(b.toString()));
    child.stderr?.on("data", (b: Buffer) => logs.push(b.toString()));
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null)
        throw new Error("Compiled service stopped before readiness.");
      try {
        if ((await fetch(url, { signal: AbortSignal.timeout(300) })).ok)
          return child;
      } catch {
        /* bounded readiness */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Compiled service did not become ready.");
  };
  const token = async (
    tenant: "sample-a" | "sample-b",
    username: string,
    password: string,
    exchange = true,
  ) => {
    const endpoint =
      required("KC_PUBLIC_URL") +
      "/realms/tenant-" +
      tenant +
      "/protocol/openid-connect/token";
    const credentials = {
      client_id: "j-groupware",
      client_secret: required(
        `JGW_${tenant.toUpperCase().replaceAll("-", "_")}_J_GROUPWARE_CLIENT_SECRET`,
      ),
    };
    const response = await fetch(endpoint, {
      method: "POST",
      body: new URLSearchParams({
        ...credentials,
        grant_type: "password",
        username,
        password,
        scope: "openid",
      }),
    });
    if (!response.ok)
      throw new Error(`Actual fixture login failed (${response.status}).`);
    const original = ((await response.json()) as { access_token: string })
      .access_token;
    secrets.add(original);
    if (!exchange) return original;
    const reduced = await fetch(endpoint, {
      method: "POST",
      body: new URLSearchParams({
        ...credentials,
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: original,
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        audience: "j-approval",
      }),
    });
    if (!reduced.ok)
      throw new Error(
        `Actual approval token exchange failed (${reduced.status}).`,
      );
    const result = ((await reduced.json()) as { access_token: string })
      .access_token;
    secrets.add(result);
    return result;
  };
  const close = async () => {
    for (const app of apps.reverse()) await app.close();
    for (const id of members) {
      const response = await auth(`/auth/members/${id}`, "DELETE");
      if (response.status !== 204 && response.status !== 404)
        throw new Error("Owned member cleanup failed.");
    }
    // Append-only triggers prohibit DELETE. TRUNCATE is permitted only after
    // verifying every row belongs to this invocation in the dedicated test DB.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "LOCK TABLE approval_documents,approval_stages,approval_history,notification_outbox IN ACCESS EXCLUSIVE MODE",
      );
      const rows = await client.query<{ id: string }>(
        "SELECT id FROM approval_documents",
      );
      if (rows.rows.some((row) => !owned.has(row.id)))
        throw new Error("Unknown documents preserved; refusing cleanup.");
      await client.query(
        "TRUNCATE approval_documents,approval_stages,approval_history,notification_outbox",
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    for (const child of children.reverse()) await stop(child);
    await pool.end();
    await agent.close();
  };
  const request = async (
    path: string,
    bearer: string,
    method = "GET",
    body?: unknown,
    port = 54242,
  ) =>
    fetch(`https://approval.jgw.test:${port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const submit = async (
    bearer: string,
    ids: readonly string[],
    title = "isolated approval",
  ) => {
    const response = await request("/approval/documents", bearer, "POST", {
      title,
      body: "document body",
      memberIds: ids,
    });
    if (response.status !== 201)
      throw new Error(`Actual submission failed (${response.status}).`);
    const doc = (await response.json()) as ApprovalDocument;
    owned.add(doc.id);
    return doc;
  };
  const newApp = async (
    tenant: string,
    port: number,
    overrides: Partial<Parameters<typeof createApp>[0]> = {},
  ) => {
    const app = createApp({
      pool,
      tenant,
      keycloakOrigin: required("KC_PUBLIC_URL"),
      fetch,
      https: { cert, key },
      ...overrides,
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port });
    return app;
  };
  try {
    await migrate(pool);
    if ((await pool.query("SELECT 1 FROM approval_documents LIMIT 1")).rowCount)
      throw new Error(
        "Existing approval data preserved. Empty isolated DB required.",
      );
    const authRoot = fileURLToPath(
      new URL("../../../j-auth/", import.meta.url),
    );
    await start(
      authRoot,
      [
        `--env-file=${required("JAUTH_TEST_ENV")}`,
        "--import",
        authRoot + "tests/integration/resolve-test-hosts.mjs",
        "apps/server/dist/main.js",
      ],
      "https://jauth.jgw.test:54231/health/ready",
    );
    admin = await token(
      "sample-a",
      "a-admin",
      required("JGW_SAMPLE_A_A_ADMIN_PASSWORD"),
      false,
    );
    const actors: { id: string; token: string; original: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const username = `approval-${randomUUID()}`,
        password = randomBytes(24).toString("base64url");
      secrets.add(password);
      const created = await auth("/auth/members", "POST", {
        username,
        password,
        roles: ["approval:use"],
      });
      if (created.status !== 201)
        throw new Error(
          `Actual j-auth member creation failed (${created.status}).`,
        );
      const id = ((await created.json()) as { id: string }).id;
      members.add(id);
      actors.push({
        id,
        token: await token("sample-a", username, password),
        original: await token("sample-a", username, password, false),
      });
    }
    const noRole = await token(
      "sample-a",
      "a-member",
      required("JGW_SAMPLE_A_A_MEMBER_PASSWORD"),
    );
    const foreign = await token(
      "sample-b",
      "b-admin",
      required("JGW_SAMPLE_B_B_ADMIN_PASSWORD"),
    );
    await newApp("sample-a", 54242);
    await newApp("sample-b", 54243);
    const startCompiled = async () => {
      const env = fileURLToPath(
        new URL(
          "../../../.suite-runtime/j-approval/compiled.env",
          import.meta.url,
        ),
      );
      const contents = await readFile(required("JAP_TEST_ENV"), "utf8");
      await writeFile(
        env,
        contents +
          `\nJAP_PORT=54244\nJAP_TENANT=sample-a\nKC_PUBLIC_URL=${required("KC_PUBLIC_URL")}\n`,
        { mode: 0o600 },
      );
      return start(
        fileURLToPath(new URL("../../", import.meta.url)),
        [
          `--env-file=${required("JAUTH_TEST_ENV")}`,
          `--env-file=${env}`,
          "--import",
          fileURLToPath(new URL("./resolve-test-hosts.mjs", import.meta.url)),
          "apps/server/dist/main.js",
        ],
        "https://approval.jgw.test:54244/health/ready",
        { ...process.env, JAP_PORT: "54244", JAP_TENANT: "sample-a" },
      );
    };
    return {
      pool,
      fetch,
      actors,
      noRole,
      foreign,
      foreignId: decodeJwt(foreign).sub!,
      request,
      submit,
      owned,
      auth,
      newApp,
      startCompiled,
      stop,
      logs,
      secrets,
      close,
    };
  } catch (error) {
    // Startup failures do not turn into skipped tests or delete unknown data.
    for (const app of apps) await app.close().catch(() => undefined);
    for (const id of members)
      await auth(`/auth/members/${id}`, "DELETE").catch(() => undefined);
    for (const child of children) await stop(child);
    await pool.end();
    await agent.close();
    throw error;
  }
}
export type Runtime = Awaited<ReturnType<typeof integrationRuntime>>;
