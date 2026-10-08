import { mkdir, writeFile, access, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const repository = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(repository, "../.suite-runtime/j-approval");
await mkdir(root, { recursive: true, mode: 0o700 });
let existing = false;
try {
  await access(path.join(root, "integration.env"));
  existing = true;
} catch {}
if (existing)
  throw new Error(
    "Existing runtime is preserved. Do not regenerate credentials.",
  );
await mkdir(path.join(root, "tls"), { recursive: true, mode: 0o700 });
await mkdir(path.join(root, "postgres"), { recursive: true, mode: 0o777 });
await chmod(path.join(root, "postgres"), 0o777);
const cert = path.join(root, "tls/approval.crt"),
  key = path.join(root, "tls/approval.key");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:3072",
    "-sha256",
    "-nodes",
    "-days",
    "30",
    "-subj",
    "/CN=approval.jgw.test",
    "-addext",
    "subjectAltName=DNS:approval.jgw.test,IP:127.0.0.1",
    "-keyout",
    key,
    "-out",
    cert,
  ],
  { stdio: "ignore" },
);
const password = randomBytes(32).toString("base64url"),
  adminPassword = randomBytes(32).toString("base64url");
const env = {
  JAP_TEST_RUNTIME: "isolated-cloud",
  JAP_DB_PASSWORD: password,
  JAP_DB_HOST: "127.0.0.1",
  JAP_DB_PORT: "54236",
  JAP_DB_NAME: "jgw_approval",
  JAP_DB_USER: "jgw_approval",
  JAP_TLS_CERTIFICATE: cert,
  JAP_TLS_KEY: key,
  JAP_PORT: "54242",
};
await writeFile(
  path.join(root, "integration.env"),
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}\n`)
    .join(""),
  { mode: 0o600, flag: "wx" },
);
await writeFile(
  path.join(root, "compose.env"),
  `POSTGRES_PASSWORD=${adminPassword}\nJAP_DB_PASSWORD=${password}\n`,
  { mode: 0o600, flag: "wx" },
);
await writeFile(
  path.join(root, "compose.yaml"),
  `services:\n  postgres:\n    image: postgres:18.6-bookworm\n    restart: "no"\n    ports: ["127.0.0.1:54236:5432"]\n    environment:\n      POSTGRES_USER: postgres\n      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?required}\n      JAP_DB_PASSWORD: \${JAP_DB_PASSWORD:?required}\n    volumes:\n      - ${root}/postgres:/var/lib/postgresql\n      - ${repository}/deploy/postgres-init.sh:/docker-entrypoint-initdb.d/010-approval.sh:ro\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]\n      interval: 2s\n      timeout: 2s\n      retries: 30\n`,
  { mode: 0o600, flag: "wx" },
);
process.stdout.write(
  "Isolated approval runtime prepared outside checkout. Existing runtimes unchanged.\n",
);
