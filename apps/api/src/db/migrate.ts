import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export async function migrate() {
  // serialize concurrent migrations (API + workers starting together)
  const c = await pool.connect();
  try { await c.query("SELECT pg_advisory_lock(727001)"); await c.query(fs.readFileSync(path.join(here, "schema.sql"), "utf8")); }
  finally { await c.query("SELECT pg_advisory_unlock(727001)").catch(() => {}); c.release(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) { await migrate(); console.log("schema applied"); await pool.end(); }
