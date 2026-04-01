const test = require("node:test");
const assert = require("node:assert/strict");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createFakeRedis(initialEntries = {}) {
  const store = new Map(Object.entries(initialEntries));

  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value, ...args) {
      const useNx = args.includes("NX");
      if (useNx && store.has(key)) {
        return null;
      }

      store.set(key, value);
      return "OK";
    },
    async del(key) {
      store.delete(key);
      return 1;
    },
  };
}

function createFakePool() {
  const client = {
    queries: [],
    async query(sql) {
      this.queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release() {
      this.released = true;
    },
  };

  return {
    client,
    async connect() {
      return client;
    },
  };
}

function loadOrdersService({
  ordersRepository,
  paymentsRepository,
  paymentGateway,
  redis,
  pool,
}) {
  const servicePath = require.resolve("../src/services/ordersService");
  const dependencyPaths = {
    ordersRepository: require.resolve("../src/repositories/ordersRepository"),
    paymentsRepository: require.resolve("../src/repositories/paymentsRepository"),
    paymentGateway: require.resolve("../src/services/paymentGateway"),
    redis: require.resolve("../src/db/redis"),
    pool: require.resolve("../src/db/postgres"),
  };

  const previousEntries = new Map();
  for (const dependencyPath of Object.values(dependencyPaths)) {
    previousEntries.set(dependencyPath, require.cache[dependencyPath]);
  }
  previousEntries.set(servicePath, require.cache[servicePath]);

  require.cache[dependencyPaths.ordersRepository] = {
    id: dependencyPaths.ordersRepository,
    filename: dependencyPaths.ordersRepository,
    loaded: true,
    exports: ordersRepository,
  };
  require.cache[dependencyPaths.paymentsRepository] = {
    id: dependencyPaths.paymentsRepository,
    filename: dependencyPaths.paymentsRepository,
    loaded: true,
    exports: paymentsRepository,
  };
  require.cache[dependencyPaths.paymentGateway] = {
    id: dependencyPaths.paymentGateway,
    filename: dependencyPaths.paymentGateway,
    loaded: true,
    exports: paymentGateway,
  };
  require.cache[dependencyPaths.redis] = {
    id: dependencyPaths.redis,
    filename: dependencyPaths.redis,
    loaded: true,
    exports: redis,
  };
  require.cache[dependencyPaths.pool] = {
    id: dependencyPaths.pool,
    filename: dependencyPaths.pool,
    loaded: true,
    exports: pool,
  };

  delete require.cache[servicePath];
  const service = require("../src/services/ordersService");

  function restore() {
    delete require.cache[servicePath];
    for (const [modulePath, previousEntry] of previousEntries.entries()) {
      if (previousEntry) {
        require.cache[modulePath] = previousEntry;
      } else {
        delete require.cache[modulePath];
      }
    }
  }

  return { service, restore };
}

test("chargeOrder serializes concurrent requests that share an idempotency key", async () => {
  const gatewayDeferred = createDeferred();
  const redis = createFakeRedis();
  const pool = createFakePool();
  const order = {
    id: 1,
    customerId: "customer_001",
    amount: 120.5,
    status: "PENDING",
  };
  const updatedOrder = {
    ...order,
    status: "PAID",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
  const payment = {
    id: 99,
    orderId: 1,
    amount: 120.5,
    providerTxnId: "txn_1",
    status: "SUCCESS",
  };

  let gatewayCalls = 0;
  let createPaymentCalls = 0;
  let markPaidCalls = 0;

  const { service, restore } = loadOrdersService({
    ordersRepository: {
      async createOrder() {
        throw new Error("not used");
      },
      async getOrderByIdForUpdate(orderId) {
        assert.equal(orderId, 1);
        return order;
      },
      async markOrderAsPaid(orderId) {
        assert.equal(orderId, 1);
        markPaidCalls += 1;
        return updatedOrder;
      },
      async getOrderWithPayments() {
        throw new Error("not used");
      },
    },
    paymentsRepository: {
      async getSuccessfulPaymentByOrderId(orderId) {
        assert.equal(orderId, 1);
        return null;
      },
      async createPayment(input) {
        createPaymentCalls += 1;
        assert.equal(input.orderId, 1);
        return payment;
      },
      async createWebhookEvent() {
        throw new Error("not used");
      },
    },
    paymentGateway: {
      async charge(input) {
        gatewayCalls += 1;
        assert.equal(input.orderId, 1);
        return gatewayDeferred.promise;
      },
    },
    redis,
    pool,
  });

  try {
    const first = service.chargeOrder({ orderId: 1, idempotencyKey: "idem-1" });
    const second = service.chargeOrder({ orderId: 1, idempotencyKey: "idem-1" });

    gatewayDeferred.resolve({
      providerTxnId: "txn_1",
      chargedAmount: 120.5,
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.deepEqual(firstResult, {
      order: updatedOrder,
      payment,
    });
    assert.deepEqual(secondResult, firstResult);
    assert.equal(gatewayCalls, 1);
    assert.equal(createPaymentCalls, 1);
    assert.equal(markPaidCalls, 1);
  } finally {
    restore();
  }
});

test("chargeOrder rejects reuse of an idempotency key for a different order", async () => {
  const redis = createFakeRedis({
    "idem:result:idem-1": JSON.stringify({
      orderId: 1,
      result: { order: { id: 1 }, payment: { id: 9 } },
    }),
  });

  const { service, restore } = loadOrdersService({
    ordersRepository: {},
    paymentsRepository: {},
    paymentGateway: {},
    redis,
    pool: createFakePool(),
  });

  try {
    await assert.rejects(
      () => service.chargeOrder({ orderId: 2, idempotencyKey: "idem-1" }),
      (error) => {
        assert.equal(error.message, "Idempotency key already used for a different order");
        assert.equal(error.status, 409);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test("processPaymentWebhook creates a payment row and marks the order paid", async () => {
  const pool = createFakePool();
  const order = {
    id: 7,
    customerId: "customer_007",
    amount: 89.99,
    status: "PENDING",
  };

  let paymentLookupCalls = 0;
  let createdPayments = 0;
  let markedPaid = 0;

  const { service, restore } = loadOrdersService({
    ordersRepository: {
      async getOrderByIdForUpdate(orderId) {
        assert.equal(orderId, 7);
        return order;
      },
      async markOrderAsPaid(orderId) {
        assert.equal(orderId, 7);
        markedPaid += 1;
        return { ...order, status: "PAID" };
      },
      async markOrderAsFailed() {
        throw new Error("not used");
      },
    },
    paymentsRepository: {
      async createWebhookEvent(input) {
        assert.equal(input.providerEventId, "evt-7");
        return { id: 1, providerEventId: "evt-7" };
      },
      async getSuccessfulPaymentByOrderId(orderId) {
        assert.equal(orderId, 7);
        paymentLookupCalls += 1;
        return null;
      },
      async createPayment(input) {
        createdPayments += 1;
        assert.equal(input.orderId, 7);
        assert.equal(input.status, "SUCCESS");
        return { id: 2, ...input };
      },
    },
    paymentGateway: {},
    redis: createFakeRedis(),
    pool,
  });

  try {
    const result = await service.processPaymentWebhook({
      providerEventId: "evt-7",
      orderId: 7,
      eventType: "payment_succeeded",
      payload: {},
    });

    assert.deepEqual(result, { accepted: true });
    assert.equal(paymentLookupCalls, 1);
    assert.equal(createdPayments, 1);
    assert.equal(markedPaid, 1);
  } finally {
    restore();
  }
});

test("duplicate webhooks are accepted without reprocessing state changes", async () => {
  const pool = createFakePool();
  let createdPayments = 0;
  let markedPaid = 0;

  const { service, restore } = loadOrdersService({
    ordersRepository: {
      async getOrderByIdForUpdate() {
        return {
          id: 8,
          customerId: "customer_008",
          amount: 100,
          status: "PENDING",
        };
      },
      async markOrderAsPaid() {
        markedPaid += 1;
        return { id: 8, status: "PAID" };
      },
      async markOrderAsFailed() {
        throw new Error("not used");
      },
    },
    paymentsRepository: {
      async createWebhookEvent() {
        return null;
      },
      async getSuccessfulPaymentByOrderId() {
        throw new Error("not used");
      },
      async createPayment() {
        createdPayments += 1;
        return { id: 1 };
      },
    },
    paymentGateway: {},
    redis: createFakeRedis(),
    pool,
  });

  try {
    const result = await service.processPaymentWebhook({
      providerEventId: "evt-duplicate",
      orderId: 8,
      eventType: "payment_succeeded",
      payload: {},
    });

    assert.deepEqual(result, { accepted: true, duplicate: true });
    assert.equal(createdPayments, 0);
    assert.equal(markedPaid, 0);
  } finally {
    restore();
  }
});

test("payment_failed webhooks create a failed payment record and mark the order failed", async () => {
  const pool = createFakePool();
  let createdPayments = 0;
  let markedFailed = 0;

  const { service, restore } = loadOrdersService({
    ordersRepository: {
      async getOrderByIdForUpdate() {
        return {
          id: 9,
          customerId: "customer_009",
          amount: 42,
          status: "PENDING",
        };
      },
      async markOrderAsPaid() {
        throw new Error("not used");
      },
      async markOrderAsFailed(orderId) {
        assert.equal(orderId, 9);
        markedFailed += 1;
        return { id: 9, status: "FAILED" };
      },
    },
    paymentsRepository: {
      async createWebhookEvent() {
        return { id: 3 };
      },
      async getSuccessfulPaymentByOrderId() {
        throw new Error("not used");
      },
      async createPayment(input) {
        createdPayments += 1;
        assert.equal(input.status, "FAILED");
        return { id: 4, ...input };
      },
    },
    paymentGateway: {},
    redis: createFakeRedis(),
    pool,
  });

  try {
    const result = await service.processPaymentWebhook({
      providerEventId: "evt-failed",
      orderId: 9,
      eventType: "payment_failed",
      payload: {},
    });

    assert.deepEqual(result, { accepted: true });
    assert.equal(createdPayments, 1);
    assert.equal(markedFailed, 1);
  } finally {
    restore();
  }
});
