const express = require("express");
const ordersRoutes = require("./routes/ordersRoutes");
const paymentsRoutes = require("./routes/paymentsRoutes");

const app = express();

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/orders", ordersRoutes);
app.use("/payments", paymentsRoutes);

app.use((error, req, res, next) => {
  console.error("Request failed", error.message);
  const status = error.status || 500;
  res.status(status).json({
    error: error.message || "Internal server error",
  });
});

module.exports = app;
