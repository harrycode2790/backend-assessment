const express = require("express");
const ordersService = require("../services/ordersService");

const router = express.Router();

router.post("/", async (req, res, next) => {
  try {
    const order = await ordersService.createOrder(req.body);
    res.status(201).json(order);
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const order = await ordersService.getOrderById(Number(req.params.id));
    res.json(order);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
