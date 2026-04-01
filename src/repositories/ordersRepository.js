const pool = require("../db/postgres");

async function createOrder({ customerId, amount }, db = pool) {
  const query = `
    INSERT INTO orders (customer_id, amount, status)
    VALUES ($1, $2, 'PENDING')
    RETURNING id, customer_id AS "customerId", amount, status, created_at AS "createdAt"
  `;
  const { rows } = await db.query(query, [customerId, amount]);
  return rows[0];
}

async function getOrderById(orderId, db = pool) {
  const query = `
    SELECT id, customer_id AS "customerId", amount, status, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM orders
    WHERE id = $1
  `;
  const { rows } = await db.query(query, [orderId]);
  return rows[0] || null;
}

async function getOrderByIdForUpdate(orderId, db = pool) {
  const query = `
    SELECT id, customer_id AS "customerId", amount, status, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM orders
    WHERE id = $1
    FOR UPDATE
  `;
  const { rows } = await db.query(query, [orderId]);
  return rows[0] || null;
}

async function markOrderAsPaid(orderId, db = pool) {
  const query = `
    UPDATE orders
    SET status = 'PAID', updated_at = NOW()
    WHERE id = $1 AND status = 'PENDING'
    RETURNING id, customer_id AS "customerId", amount, status, created_at AS "createdAt", updated_at AS "updatedAt"
  `;
  const { rows } = await db.query(query, [orderId]);
  return rows[0] || null;
}

async function markOrderAsFailed(orderId, db = pool) {
  const query = `
    UPDATE orders
    SET status = 'FAILED', updated_at = NOW()
    WHERE id = $1 AND status = 'PENDING'
    RETURNING id, customer_id AS "customerId", amount, status, created_at AS "createdAt", updated_at AS "updatedAt"
  `;
  const { rows } = await db.query(query, [orderId]);
  return rows[0] || null;
}

async function getOrderWithPayments(orderId) {
  const orderQuery = `
    SELECT id, customer_id AS "customerId", amount, status, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM orders
    WHERE id = $1
  `;
  const paymentsQuery = `
    SELECT id, order_id AS "orderId", amount, provider_txn_id AS "providerTxnId", status, created_at AS "createdAt"
    FROM payments
    WHERE order_id = $1
    ORDER BY created_at ASC
  `;

  const [orderResult, paymentResult] = await Promise.all([
    pool.query(orderQuery, [orderId]),
    pool.query(paymentsQuery, [orderId]),
  ]);

  if (orderResult.rowCount === 0) {
    return null;
  }

  return {
    ...orderResult.rows[0],
    payments: paymentResult.rows,
  };
}

module.exports = {
  createOrder,
  getOrderById,
  getOrderByIdForUpdate,
  markOrderAsPaid,
  markOrderAsFailed,
  getOrderWithPayments,
};
