const pool = require("../db/postgres");

async function createPayment({ orderId, amount, providerTxnId, status = "SUCCESS" }) {
  const query = `
    INSERT INTO payments (order_id, amount, provider_txn_id, status)
    VALUES ($1, $2, $3, $4)
    RETURNING id, order_id AS "orderId", amount, provider_txn_id AS "providerTxnId", status, created_at AS "createdAt"
  `;
  const { rows } = await pool.query(query, [orderId, amount, providerTxnId, status]);
  return rows[0];
}

async function createWebhookEvent({ providerEventId, orderId, eventType, payload }) {
  const query = `
    INSERT INTO payment_events (provider_event_id, order_id, event_type, payload)
    VALUES ($1, $2, $3, $4)
    RETURNING id, provider_event_id AS "providerEventId", order_id AS "orderId", event_type AS "eventType", created_at AS "createdAt"
  `;
  const { rows } = await pool.query(query, [
    providerEventId,
    orderId,
    eventType,
    JSON.stringify(payload || {}),
  ]);
  return rows[0];
}

module.exports = {
  createPayment,
  createWebhookEvent,
};
