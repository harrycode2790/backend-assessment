const dotenv = require("dotenv");

dotenv.config();

module.exports = {
  port: Number(process.env.PORT || 3000),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5433/assessment_db", // Updated port to 5433 to avoid conflict with local postgres that is running on 5432
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  paymentFailureRate: Number(process.env.PAYMENT_FAILURE_RATE || 0.1),
  paymentDelayMinMs: Number(process.env.PAYMENT_DELAY_MIN_MS || 50),
  paymentDelayMaxMs: Number(process.env.PAYMENT_DELAY_MAX_MS || 600),
};
