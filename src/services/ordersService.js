const ordersRepository = require("../repositories/ordersRepository");
const paymentsRepository = require("../repositories/paymentsRepository");
const paymentGateway = require("./paymentGateway");
const redis = require("../db/redis");
const pool = require("../db/postgres");

const IDEMPOTENCY_TTL_SECONDS = 3600;
const IDEMPOTENCY_WAIT_MS = 100;
const IDEMPOTENCY_MAX_WAITS = 50;
const SUPPORTED_WEBHOOK_EVENTS = new Set([
  "payment_succeeded",
  "payment_failed",
]);

function buildIdempotencyCacheKey(idempotencyKey) {
  return `idem:result:${idempotencyKey}`;
}

function buildIdempotencyLockKey(idempotencyKey) {
  return `idem:lock:${idempotencyKey}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCachedIdempotencyResult(idempotencyKey, orderId) {
  if (!idempotencyKey) {
    return null;
  }

  const existing = await redis.get(buildIdempotencyCacheKey(idempotencyKey));
  if (!existing) {
    return null;
  }

  const parsed = JSON.parse(existing);
  if (parsed.orderId !== orderId) {
    const error = new Error("Idempotency key already used for a different order");
    error.status = 409;
    throw error;
  }

  return parsed.result;
}

async function acquireIdempotencyLock(idempotencyKey) {
  if (!idempotencyKey) {
    return true;
  }

  const acquired = await redis.set(
    buildIdempotencyLockKey(idempotencyKey),
    "locked",
    "EX",
    IDEMPOTENCY_TTL_SECONDS,
    "NX"
  );

  return acquired === "OK";
}

async function releaseIdempotencyLock(idempotencyKey) {
  if (!idempotencyKey) {
    return;
  }

  await redis.del(buildIdempotencyLockKey(idempotencyKey));
}

async function waitForIdempotencyResult(idempotencyKey, orderId) {
  for (let attempt = 0; attempt < IDEMPOTENCY_MAX_WAITS; attempt++) {
    const cached = await readCachedIdempotencyResult(idempotencyKey, orderId);
    if (cached) {
      return cached;
    }

    await wait(IDEMPOTENCY_WAIT_MS);
  }

  const error = new Error("Another request is already processing this idempotency key");
  error.status = 409;
  throw error;
}

function validateWebhookPayload({ providerEventId, orderId, eventType }) {
  if (!providerEventId || !eventType) {
    const error = new Error(
      "providerEventId, orderId and eventType are required"
    );
    error.status = 400;
    throw error;
  }

  validateOrderId(orderId);

  if (!SUPPORTED_WEBHOOK_EVENTS.has(eventType)) {
    const error = new Error("Unsupported eventType");
    error.status = 400;
    throw error;
  }
}

function validateOrderId(orderId) {
  if (!Number.isInteger(orderId) || orderId <= 0) {
    const error = new Error("A valid positive orderId is required");
    error.status = 400;
    throw error;
  }
}

async function createOrder({ customerId, amount }) {
  if (!customerId || !customerId.trim() || !amount || Number(amount) <= 0) {
    const error = new Error("customerId and positive amount are required");
    error.status = 400;
    throw error;
  }

  return ordersRepository.createOrder({
    customerId,
    amount: Number(amount),
  });
}

async function chargeOrder({ orderId, idempotencyKey }) {
  validateOrderId(orderId);

  const cached = await readCachedIdempotencyResult(idempotencyKey, orderId);
  if (cached) {
    return cached;
  }

  const hasLock = await acquireIdempotencyLock(idempotencyKey);
  if (!hasLock) {
    return waitForIdempotencyResult(idempotencyKey, orderId);
  }

  try {
    const existingAfterLock = await readCachedIdempotencyResult(
      idempotencyKey,
      orderId
    );
    if (existingAfterLock) {
      return existingAfterLock;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const order = await ordersRepository.getOrderByIdForUpdate(orderId, client);
      if (!order) {
        const error = new Error("Order not found");
        error.status = 404;
        throw error;
      }

      const existingPayment = await paymentsRepository.getSuccessfulPaymentByOrderId(
        order.id,
        client
      );
      if (existingPayment) {
        if (order.status !== "PAID") {
          const error = new Error(
            "Order/payment state is inconsistent for an existing successful payment"
          );
          error.status = 409;
          throw error;
        }
        await client.query("COMMIT");

        const result = {
          order,
          payment: existingPayment,
        };

        if (idempotencyKey) {
          await redis.set(
            buildIdempotencyCacheKey(idempotencyKey),
            JSON.stringify({ orderId, result }),
            "EX",
            IDEMPOTENCY_TTL_SECONDS
          );
        }

        return result;
      }

      if (order.status !== "PENDING") {
        const error = new Error("Only pending orders can be charged");
        error.status = 409;
        throw error;
      }

      const gatewayResponse = await paymentGateway.charge({
        orderId: order.id,
        amount: order.amount,
      });

      const payment = await paymentsRepository.createPayment(
        {
          orderId: order.id,
          amount: gatewayResponse.chargedAmount,
          providerTxnId: gatewayResponse.providerTxnId,
          status: "SUCCESS",
        },
        client
      );

      const updatedOrder = await ordersRepository.markOrderAsPaid(order.id, client);
      if (!updatedOrder) {
        const error = new Error("Order could not be marked as paid");
        error.status = 409;
        throw error;
      }

      await client.query("COMMIT");

      const result = {
        order: updatedOrder,
        payment,
      };

      if (idempotencyKey) {
        await redis.set(
          buildIdempotencyCacheKey(idempotencyKey),
          JSON.stringify({ orderId, result }),
          "EX",
          IDEMPOTENCY_TTL_SECONDS
        );
      }

      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await releaseIdempotencyLock(idempotencyKey);
  }
}

async function processPaymentWebhook({ providerEventId, orderId, eventType, payload }) {
  validateWebhookPayload({ providerEventId, orderId, eventType });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const order = await ordersRepository.getOrderByIdForUpdate(orderId, client);
    if (!order) {
      const error = new Error("Order not found");
      error.status = 404;
      throw error;
    }

    const event = await paymentsRepository.createWebhookEvent(
      {
        providerEventId,
        orderId,
        eventType,
        payload,
      },
      client
    );

    if (!event) {
      await client.query("COMMIT");
      return { accepted: true, duplicate: true };
    }

    if (eventType === "payment_succeeded") {
      let payment = await paymentsRepository.getSuccessfulPaymentByOrderId(
        orderId,
        client
      );

      if (!payment) {
        payment = await paymentsRepository.createPayment(
          {
            orderId,
            amount: order.amount,
            providerTxnId: `webhook:${providerEventId}`,
            status: "SUCCESS",
          },
          client
        );
      }

      if (order.status === "PENDING") {
        const updatedOrder = await ordersRepository.markOrderAsPaid(orderId, client);
        if (!updatedOrder) {
          const error = new Error("Order could not be marked as paid");
          error.status = 409;
          throw error;
        }
      }
    }

    if (eventType === "payment_failed") {
      await paymentsRepository.createPayment(
        {
          orderId,
          amount: order.amount,
          providerTxnId: `webhook:${providerEventId}`,
          status: "FAILED",
        },
        client
      );

      if (order.status === "PENDING") {
        const updatedOrder = await ordersRepository.markOrderAsFailed(
          orderId,
          client
        );
        if (!updatedOrder) {
          const error = new Error("Order could not be marked as failed");
          error.status = 409;
          throw error;
        }
      }
    }

    await client.query("COMMIT");
    return { accepted: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getOrderById(orderId) {
  const order = await ordersRepository.getOrderWithPayments(orderId);
  if (!order) {
    const error = new Error("Order not found");
    error.status = 404;
    throw error;
  }
  return order;
}

module.exports = {
  createOrder,
  chargeOrder,
  processPaymentWebhook,
  getOrderById,
};
