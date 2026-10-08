import { beforeAll, describe, it, expect } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import type { Pool } from "pg";
import { createTokenVerifier } from "@j-auth/token-verifier";
import { createApp } from "../../apps/server/src/app.js";
import { loadConfig } from "../../apps/server/src/config.js";
import { submission, decision } from "../../apps/server/src/validation.js";
describe("approval contract and cryptographic authorization boundaries", () => {
  let key: Awaited<ReturnType<typeof generateKeyPair>>;
  beforeAll(async () => {
    key = await generateKeyPair("RS256");
  });
  const claims = (): JWTPayload => ({
    iss: "https://auth.jgw.test/realms/tenant-sample-a",
    aud: "j-approval",
    azp: "j-groupware",
    tenant: "sample-a",
    sub: "writer",
    sid: "sid-a",
    typ: "Bearer",
    preferred_username: "writer",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    resource_access: { "j-approval": { roles: ["approval:use"] } },
  });
  const app = () =>
    createApp({
      tenant: "sample-a",
      keycloakOrigin: "https://auth.jgw.test",
      pool: { query: async () => ({ rows: [] }) } as unknown as Pool,
      verifier: createTokenVerifier({
        publicUrl: "https://auth.jgw.test",
        keyResolver: async () => key.publicKey,
      }),
    });
  it("accepts only a configured-tenant single-audience human bearer", async () => {
    const a = app();
    try {
      const token = await new SignJWT(claims())
        .setProtectedHeader({ alg: "RS256" })
        .sign(key.privateKey);
      expect(
        (
          await a.inject({
            url: "/approval/documents?view=authored",
            headers: { Authorization: "Bearer " + token },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await a.close();
    }
  });
  it.each([
    {},
    { cookie: "__Host-jgw-session=opaque" },
    { authorization: "Bearer malformed" },
  ])(
    "requires bearer and rejects cookie authentication: %j",
    async (headers) => {
      const a = app();
      try {
        expect(
          (
            await a.inject({
              url: "/approval/documents?view=authored",
              headers,
            })
          ).statusCode,
        ).toBe(401);
      } finally {
        await a.close();
      }
    },
  );
  it.each([
    { aud: "j-groupware" },
    { aud: ["j-approval", "j-mail"] },
    { tenant: "sample-b" },
    { iss: "https://evil.jgw.test/realms/tenant-sample-a" },
    { azp: "j-messenger" },
    { exp: 1 },
    { sid: undefined },
    { preferred_username: "service-account-client" },
  ])("rejects invalid claims %j", async (changes) => {
    const a = app();
    try {
      const token = await new SignJWT({ ...claims(), ...changes })
        .setProtectedHeader({ alg: "RS256" })
        .sign(key.privateKey);
      expect(
        (
          await a.inject({
            url: "/approval/documents?view=authored",
            headers: { Authorization: "Bearer " + token },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await a.close();
    }
  });
  it("rejects absent approval role independently of identity roles", async () => {
    const a = app();
    try {
      const token = await new SignJWT({
        ...claims(),
        resource_access: {},
        realm_access: { roles: ["tenant:admin"] },
      })
        .setProtectedHeader({ alg: "RS256" })
        .sign(key.privateKey);
      expect(
        (
          await a.inject({
            url: "/approval/documents?view=authored",
            headers: { Authorization: "Bearer " + token },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await a.close();
    }
  });
  it("maps JWKS outage to safe 503", async () => {
    const a = createApp({
      tenant: "sample-a",
      keycloakOrigin: "https://auth.jgw.test",
      pool: {} as Pool,
      fetch: async () => {
        throw new Error("private upstream failure");
      },
    });
    try {
      const token = await new SignJWT(claims())
        .setProtectedHeader({ alg: "RS256", kid: "missing" })
        .sign(key.privateKey);
      const result = await a.inject({
        url: "/approval/documents?view=authored",
        headers: { Authorization: "Bearer " + token },
      });
      expect(result.statusCode).toBe(503);
      expect(result.body).not.toContain("private upstream");
    } finally {
      await a.close();
    }
  });
  it("denies undeclared routes at registration", () => {
    expect(() => app().get("/undeclared", async () => ({}))).toThrow(
      "declare approval access",
    );
  });
  it("validates the existing sequential-line rules and UTF-16 text limits", () => {
    const valid = {
      title: "제목",
      body: "본문",
      memberIds: ["first", "second"],
    };
    expect(submission("writer", valid)).toEqual(valid);
    for (const memberIds of [
      [],
      ["writer"],
      ["first", "first"],
      Array.from({ length: 33 }, (_, n) => "id-" + n),
      ["control\u0000id"],
    ])
      expect(() => submission("writer", { ...valid, memberIds })).toThrow();
    expect(() =>
      submission("writer", { ...valid, title: "😀".repeat(101) }),
    ).toThrow();
    expect(() =>
      submission("writer", { ...valid, body: "😀".repeat(10001) }),
    ).toThrow();
    expect(
      decision({ action: "reject", revision: 0, reason: " 사유 " }),
    ).toEqual({ action: "reject", revision: 0, reason: "사유" });
    expect(() =>
      decision({ action: "reject", revision: 0, reason: " " }),
    ).toThrow();
    expect(() => decision({ action: "approve", revision: -1 })).toThrow();
  });
  it("requires external TLS, dedicated DB, configured customer tenant and non-reserved ports", () => {
    const env = {
      JAP_TENANT: "sample-a",
      KC_PUBLIC_URL: "https://auth.jgw.test",
      JAP_DB_PASSWORD: "unit-only",
      JAP_TLS_CERTIFICATE: "/tmp/cert.pem",
      JAP_TLS_KEY: "/tmp/key.pem",
    };
    expect(loadConfig(env).database.database).toBe("jgw_approval");
    for (const changes of [
      { JAP_TENANT: "operator" },
      { JAP_PORT: "3001" },
      { JAP_DB_NAME: "postgres" },
      { JAP_DB_USER: "postgres" },
      { JAP_TLS_KEY: "/workspace/j-approval/key.pem" },
      { KC_PUBLIC_URL: "http://auth.jgw.test" },
    ])
      expect(() => loadConfig({ ...env, ...changes })).toThrow();
  });
});
