const pool = require("../src/db/postgres");

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConnRefused(error) {
  return error && error.code === "ECONNREFUSED";
}

async function run() {
  const maxAttempts = 15;
  const delayMs = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query("SELECT 1");
      await pool.query("DELETE FROM payments");
      await pool.query("DELETE FROM payment_events");
      await pool.query("DELETE FROM orders");

      const query = `
        INSERT INTO orders (customer_id, amount, status)
        VALUES
          ('customer_001', 120.50, 'PENDING'),
          ('customer_002', 89.99, 'PENDING'),
          ('customer_003', 240.00, 'PENDING')
      `;
      await pool.query(query);

      console.log("Seed completed");
      return;
    } catch (error) {
      if (isConnRefused(error) && attempt < maxAttempts) {
        console.log(`DB not ready yet (attempt ${attempt}/${maxAttempts})...`);
        await wait(delayMs);
        continue;
      }
      throw error;
    }
  }
}

run()
  .catch((error) => {
    console.error("Seed failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
