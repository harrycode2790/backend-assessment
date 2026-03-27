const fs = require("fs/promises");
const path = require("path");
const pool = require("../src/db/postgres");

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConnRefused(error) {
  // `pg` usually sets `code` to `ECONNREFUSED` when the server isn't listening yet.
  return error && error.code === "ECONNREFUSED";
}

async function run() {
  const filePath = path.join(__dirname, "../src/db/schema.sql");
  const sql = await fs.readFile(filePath, "utf8");

  // Retry so local Docker / Postgres readiness doesn't race the migration.
  const maxAttempts = 15;
  const delayMs = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query("SELECT 1");
      await pool.query(sql);
      console.log("Migration completed");
      return;
    } catch (error) {
      if (isConnRefused(error) && attempt < maxAttempts) {
        console.log(
          `DB not ready yet (attempt ${attempt}/${maxAttempts})...`
        );
        await wait(delayMs);
        continue;
      }
      throw error;
    }
  }
}

run()
  .catch((error) => {
    console.error("Migration failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
