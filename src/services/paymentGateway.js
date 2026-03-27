const env = require("../config/env");

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function charge({ orderId, amount }) {
  const delay = randomBetween(env.paymentDelayMinMs, env.paymentDelayMaxMs);
  await wait(delay);

  const failed = Math.random() < env.paymentFailureRate;
  if (failed) {
    const error = new Error("Provider timeout while charging card");
    error.code = "PROVIDER_TIMEOUT";
    throw error;
  }

  return {
    providerTxnId: `txn_${orderId}_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    chargedAmount: amount,
    settledAt: new Date().toISOString(),
  };
}

module.exports = {
  charge,
};
