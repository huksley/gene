/**
 * Undocumented `gene --import-legacy <dump.sql>` support.
 *
 * Reads a SQL dump and replays it against the configured store. The intended use is
 * seeding a shared Postgres database (DATABASE_URL / PG* set) with state exported
 * from an older deployment; it also works against the embedded PGlite store. The
 * dump is executed as a single multi-statement script via the store's `exec`.
 */

import fs from "node:fs";
import { getDb, pgConfigured } from "./db.ts";
import logger from "./logger.ts";

export const importLegacy = async (file: string): Promise<void> => {
  const sql = fs.readFileSync(file, "utf-8");
  if (!sql.trim()) {
    logger.warn(`import-legacy: ${file} is empty, nothing to do`);
    return;
  }

  const target = pgConfigured() ? "shared Postgres" : "embedded PGlite";
  logger.info(`import-legacy: importing ${file} into ${target}`);

  const db = await getDb();
  await db.exec(sql);

  logger.info("import-legacy: done");
};
