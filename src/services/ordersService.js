const ordersRepository = require("../repositories/ordersRepository");
const paymentsRepository = require("../repositories/paymentsRepository");
const paymentGateway = require("./paymentGateway");
const redis = require("../db/redis");

async function createOrder({ customerId, amount }) {
  if (!customerId || !amount || Number(amount) <= 0) {
    const error = new Error("customerId and positive amount are required");
    error.status = 400;
    throw error;
  }

  return ordersRepository.createOrder({
    customerId,
    amount: Number(amount),
  });
}

// Intentionally buggy:
// - no transaction
// - stale order check with race window
// - idempotency key read/write is not atomic
async function chargeOrder({ orderId, idempotencyKey }) {
  const order = await ordersRepository.getOrderById(orderId);
  if (!order) {
    const error = new Error("Order not found");
    error.status = 404;
    throw error;
  }

  if (order.status !== "PENDING") {
    const error = new Error("Only pending orders can be charged");
    error.status = 409;
    throw error;
  }

  if (idempotencyKey) {
    const existing = await redis.get(`idem:${idempotencyKey}`);
    if (existing) {
      return JSON.parse(existing);
    }
  }

  const gatewayResponse = await paymentGateway.charge({
    orderId: order.id,
    amount: order.amount,
  });

  const payment = await paymentsRepository.createPayment({
    orderId: order.id,
    amount: gatewayResponse.chargedAmount,
    providerTxnId: gatewayResponse.providerTxnId,
    status: "SUCCESS",
  });

  const updatedOrder = await ordersRepository.markOrderAsPaid(order.id);

  const result = {
    order: updatedOrder,
    payment,
  };

  if (idempotencyKey) {
    await redis.set(`idem:${idempotencyKey}`, JSON.stringify(result), "EX", 3600);
  }

  return result;
}

// Intentionally buggy:
// - webhook dedupe is not enforced
// - status update is not validated by event type
async function processPaymentWebhook({ providerEventId, orderId, eventType, payload }) {
  await paymentsRepository.createWebhookEvent({
    providerEventId,
    orderId,
    eventType,
    payload,
  });

  if (eventType === "payment_succeeded") {
    await ordersRepository.markOrderAsPaid(orderId);
  }

  return { accepted: true };
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
