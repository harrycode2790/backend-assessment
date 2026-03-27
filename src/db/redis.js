const Redis = require("ioredis");
const env = require("../config/env");

const redis = new Redis(env.redisUrl);

redis.on("error", (error) => {
  console.error("Redis connection error", error);
});

module.exports = redis;
