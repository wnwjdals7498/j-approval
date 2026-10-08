import Fastify, { LogController } from "fastify";
import type {
  FastifyRequest,
  FastifyServerOptions,
  FastifyError,
} from "fastify";
import type { ServerOptions as HttpsOptions } from "node:https";
import type { Pool } from "pg";
import {
  createTokenVerifier,
  TokenVerificationError,
} from "@j-auth/token-verifier";
import type { TokenVerifier } from "@j-auth/token-verifier";
import { APPROVAL_PATHS, APPROVAL_LIMITS } from "@j-approval/contracts";
import type {
  SubmitDocument,
  DecideDocument,
  ApprovalListView,
} from "@j-approval/contracts";
import { DocumentStore } from "./db/documents.js";
import { ApiError, unavailable, forbidden } from "./errors.js";

const id = {
  type: "string",
  pattern: "^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$",
};
const memberId = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "(?=.*\\S)^[^\\x00-\\x1f\\x7f-\\x9f]+$",
};
const params = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id },
};
const revision = { type: "integer", minimum: 0, maximum: 2147483647 };
const cursor = {
  type: "string",
  minLength: 1,
  maxLength: 2048,
  pattern: "^[A-Za-z0-9_-]+$",
};
const ROUTES = new Set([
  "GET /health/live",
  "GET /health/ready",
  "POST /approval/documents",
  "GET /approval/documents",
  "GET /approval/documents/:id",
  "GET /approval/documents/:id/history",
  "POST /approval/documents/:id/decisions",
]);
export function createApp(options: {
  pool: Pool;
  tenant: string;
  keycloakOrigin: string;
  verifier?: TokenVerifier;
  fetch?: typeof globalThis.fetch;
  https?: HttpsOptions;
  logger?: FastifyServerOptions["logger"];
}) {
  const app = Fastify({
    exposeHeadRoutes: false,
    trustProxy: false,
    bodyLimit: 65536,
    ajv: { customOptions: { removeAdditional: false } },
    ...(options.https ? { https: options.https } : {}),
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const verifier =
    options.verifier ??
    createTokenVerifier({
      publicUrl: options.keycloakOrigin,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  const store = new DocumentStore(options.pool, options.tenant),
    identities = new WeakMap<FastifyRequest, string>();
  app.addHook("onRoute", (route) => {
    if (!ROUTES.has(`${route.method} ${route.url}`))
      throw new Error("Route must declare approval access.");
    if (route.url.startsWith("/health/")) return;
    route.onRequest = async (request) => {
      const auth = request.headers.authorization;
      if (
        !auth ||
        !/^Bearer [^\s]+$/.test(auth) ||
        auth.length > 16400 ||
        request.headers.cookie !== undefined
      )
        throw new ApiError(401, "unauthenticated", "Valid bearer required.");
      try {
        const identity = await verifier.verify(auth.slice(7), {
          tenantId: options.tenant,
          audience: "j-approval",
        });
        const audience = identity.claims.aud;
        if (
          !(
            audience === "j-approval" ||
            (Array.isArray(audience) &&
              audience.length === 1 &&
              audience[0] === "j-approval")
          ) ||
          typeof identity.claims.sid !== "string" ||
          typeof identity.claims.preferred_username !== "string" ||
          identity.claims.preferred_username.startsWith("service-account-") ||
          identity.subject.length > 128
        )
          throw new ApiError(
            401,
            "unauthenticated",
            "Invalid bearer identity.",
          );
        if (!identity.roles.includes("approval:use")) throw forbidden();
        identities.set(request, identity.subject);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof TokenVerificationError && error.kind === "invalid")
          throw new ApiError(
            401,
            "unauthenticated",
            "Invalid bearer identity.",
          );
        throw unavailable();
      }
    };
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const safe =
      error instanceof ApiError
        ? error
        : "validation" in error ||
            [400, 413, 415].includes(Number(error.statusCode))
          ? new ApiError(
              Number(error.statusCode ?? 400),
              "invalid_input",
              "Invalid request.",
            )
          : unavailable();
    if (safe.status === 503)
      request.log.warn(
        { code: safe.code, requestId: request.id },
        "Approval request unavailable",
      );
    reply
      .code(safe.status)
      .send({ code: safe.code, message: safe.message, requestId: request.id });
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await options.pool.query("SELECT 1");
    return { status: "ok" };
  });
  app.post<{ Body: SubmitDocument }>(
    APPROVAL_PATHS.documents,
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["title", "body", "memberIds"],
          properties: {
            title: {
              type: "string",
              minLength: 1,
              maxLength: APPROVAL_LIMITS.title,
              pattern: "\\S",
            },
            body: {
              type: "string",
              minLength: 1,
              maxLength: APPROVAL_LIMITS.body,
              pattern: "\\S",
            },
            memberIds: {
              type: "array",
              minItems: 1,
              maxItems: APPROVAL_LIMITS.stages,
              uniqueItems: true,
              items: memberId,
            },
          },
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await store.submit(identities.get(request)!, request.body)),
  );
  app.get<{ Querystring: { view: ApprovalListView; cursor?: string } }>(
    APPROVAL_PATHS.documents,
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["view"],
          properties: {
            view: {
              type: "string",
              enum: ["authored", "pending", "processed"],
            },
            cursor,
          },
        },
      },
    },
    (request) =>
      store.list(
        identities.get(request)!,
        request.query.view,
        request.query.cursor,
      ),
  );
  app.get<{ Params: { id: string } }>(
    "/approval/documents/:id",
    {
      schema: {
        params,
        querystring: { type: "object", additionalProperties: false },
      },
    },
    (request) => store.read(identities.get(request)!, request.params.id),
  );
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    "/approval/documents/:id/history",
    {
      schema: {
        params,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { cursor },
        },
      },
    },
    (request) =>
      store.history(
        identities.get(request)!,
        request.params.id,
        request.query.cursor,
      ),
  );
  app.post<{ Params: { id: string }; Body: DecideDocument }>(
    "/approval/documents/:id/decisions",
    {
      schema: {
        params,
        body: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["revision", "action"],
              properties: { revision, action: { const: "approve" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["revision", "action", "reason"],
              properties: {
                revision,
                action: { const: "reject" },
                reason: {
                  type: "string",
                  minLength: 1,
                  maxLength: APPROVAL_LIMITS.reason,
                  pattern: "\\S",
                },
              },
            },
          ],
        },
      },
    },
    (request) =>
      store.decide(identities.get(request)!, request.params.id, request.body),
  );
  return app;
}
