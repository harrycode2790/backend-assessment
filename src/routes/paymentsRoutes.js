const express = require("express");
const ordersService = require("../services/ordersService");

const router = express.Router();

router.post("/charge", async (req, res, next) => {
  try {
    const result = await ordersService.chargeOrder({
      orderId: Number(req.body.orderId),
      idempotencyKey: req.headers["idempotency-key"],
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/webhook", async (req, res, next) => {
  try {
    const result = await ordersService.processPaymentWebhook(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
