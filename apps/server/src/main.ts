import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./app.js";
async function main() {
  const config = loadConfig(),
    pool = new Pool(config.database);
  try {
    await migrate(pool);
    const [cert, key] = await Promise.all([
      readFile(config.tlsCertificate),
      readFile(config.tlsKey),
    ]);
    const app = createApp({
      pool,
      tenant: config.tenant,
      keycloakOrigin: config.keycloakOrigin,
      https: { cert, key, minVersion: "TLSv1.2" },
      logger: {
        level: "info",
        serializers: {
          req: () => ({}),
          res: () => ({}),
          err: () => ({ type: "Error", message: "Request failed.", stack: "" }),
        },
      },
    });
    app.addHook("onClose", () => pool.end());
    let closing = false;
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        if (!closing) {
          closing = true;
          void app.close().catch(() => {
            process.exitCode = 1;
          });
        }
      });
    await app.listen({ host: "127.0.0.1", port: config.port });
  } catch {
    await pool.end().catch(() => undefined);
    throw new Error("Approval startup failed.");
  }
}
main().catch(() => {
  process.stderr.write(
    "Approval startup failed. No sensitive configuration was logged.\n",
  );
  process.exitCode = 1;
});
