# Backend Assessment - Senior (Node.js/Express)

This repository is a pre-interview backend assessment starter.

The API is partially working, but contains hidden logical bugs.
There are no syntax traps. Focus is on correctness under concurrency and failure.

## Scenario

- Orders are created
- Payments are processed
- A payment webhook updates order status
- Some cases can lead to:
  - double-charging
  - missing consistency across order/payment records
  - race conditions

## Tech

- Node.js + Express
- PostgreSQL required
- Redis included and used for idempotency cache

Candidates may replace parts with their preferred approach if justified.

## Run

1. Install dependencies:

```bash
npm install
```

2. Copy env:

```bash
cp .env.example .env
```

3. Start infra:

```bash
docker compose up -d
```

4. Run DB migration and seed:

```bash
npm run db:migrate
npm run db:seed
```

5. Start API:

```bash
npm run dev
```

Health endpoint:

```bash
GET /health
```

## Endpoints

- `POST /orders`
  - body: `{ "customerId": "customer_001", "amount": 120.5 }`
- `GET /orders/:id`
- `POST /payments/charge`
  - body: `{ "orderId": 1 }`
  - optional header: `Idempotency-Key: abc-123`
- `POST /payments/webhook`
  - body example:
    `{ "providerEventId": "evt-1", "orderId": 1, "eventType": "payment_succeeded", "payload": {} }`

## Candidate Task (8h max)

1. Identify as many critical logical/data-integrity issues as possible.
2. Fix the issues with production-appropriate changes.
3. Add tests proving fixes, especially for concurrency/idempotency paths.
4. Write a short explanation:
   - what issues were found
   - why they happen
   - why your fix is safe
   - what trade-offs remain

## Evaluation Focus

- Correctness and data integrity
- Concurrency safety
- Retry/idempotency behavior
- Quality of tests and reasoning
- Practical production judgment
