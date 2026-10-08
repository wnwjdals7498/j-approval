import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolConfig } from "pg";
import { assertCustomerTenantId } from "@j-auth/contracts";
import { notificationEndpoint } from "./notification-sender.js";
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const required = (env: NodeJS.ProcessEnv, key: string) => {
  const value = env[key];
  if (!value || value.startsWith("__PLACEHOLDER_"))
    throw new Error("Set external service configuration.");
  return value;
};
const port = (raw: string) => {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > 65535 || value === 3001)
    throw new Error("Invalid or reserved port.");
  return value;
};
const external = (value: string) => {
  const relative = path.relative(repository, value);
  if (
    !path.isAbsolute(value) ||
    (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
  )
    throw new Error("TLS files must be outside checkout.");
  return value;
};
export function loadDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  if (
    (env.JAP_DB_NAME && env.JAP_DB_NAME !== "jgw_approval") ||
    (env.JAP_DB_USER && env.JAP_DB_USER !== "jgw_approval")
  )
    throw new Error("Require dedicated jgw_approval role/database.");
  return {
    host: env.JAP_DB_HOST ?? "127.0.0.1",
    port: port(env.JAP_DB_PORT ?? "54236"),
    database: "jgw_approval",
    user: "jgw_approval",
    password: required(env, "JAP_DB_PASSWORD"),
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
    application_name: "j-approval",
  };
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const tenant = required(env, "JAP_TENANT");
  assertCustomerTenantId(tenant);
  const issuer = new URL(required(env, "KC_PUBLIC_URL"));
  if (
    issuer.protocol !== "https:" ||
    !issuer.hostname.endsWith(".jgw.test") ||
    issuer.port === "3001" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    issuer.pathname !== "/"
  )
    throw new Error("Require registered HTTPS Keycloak origin.");
  return {
    tenant,
    keycloakOrigin: issuer.origin,
    port: port(env.JAP_PORT ?? "54242"),
    tlsCertificate: external(required(env, "JAP_TLS_CERTIFICATE")),
    tlsKey: external(required(env, "JAP_TLS_KEY")),
    database: loadDatabaseConfig(env),
    ...(env.JAP_NOTIFICATION_URL || env.JAP_NOTIFICATION_KEY
      ? {
          notification: {
            url: (() => {
              const value = required(env, "JAP_NOTIFICATION_URL");
              notificationEndpoint(value);
              return value;
            })(),
            key: required(env, "JAP_NOTIFICATION_KEY"),
          },
        }
      : {}),
  };
}
