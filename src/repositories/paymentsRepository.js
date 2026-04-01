const pool = require("../db/postgres");

async function createPayment(
  { orderId, amount, providerTxnId, status = "SUCCESS" },
  db = pool
) {
  const query = `
    INSERT INTO payments (order_id, amount, provider_txn_id, status)
    VALUES ($1, $2, $3, $4)
    RETURNING id, order_id AS "orderId", amount, provider_txn_id AS "providerTxnId", status, created_at AS "createdAt"
  `;
  const { rows } = await db.query(query, [orderId, amount, providerTxnId, status]);
  return rows[0];
}

async function createWebhookEvent(
  { providerEventId, orderId, eventType, payload },
  db = pool
) {
  const query = `
    INSERT INTO payment_events (provider_event_id, order_id, event_type, payload)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (provider_event_id) DO NOTHING
    RETURNING id, provider_event_id AS "providerEventId", order_id AS "orderId", event_type AS "eventType", created_at AS "createdAt"
  `;
  const { rows } = await db.query(query, [
    providerEventId,
    orderId,
    eventType,
    JSON.stringify(payload || {}),
  ]);
  return rows[0] || null;
}

async function getSuccessfulPaymentByOrderId(orderId, db = pool) {
  const query = `
    SELECT id, order_id AS "orderId", amount, provider_txn_id AS "providerTxnId", status, created_at AS "createdAt"
    FROM payments
    WHERE order_id = $1 AND status = 'SUCCESS'
    ORDER BY created_at ASC
    LIMIT 1
  `;
  const { rows } = await db.query(query, [orderId]);
  return rows[0] || null;
}

module.exports = {
  createPayment,
  createWebhookEvent,
  getSuccessfulPaymentByOrderId,
};
