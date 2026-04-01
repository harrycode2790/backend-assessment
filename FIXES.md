# Backend Assessment Notes

## What I looked at

I went through the main parts of the app to understand how orders and payments move through the system:

- the routes
- the service layer
- the database queries
- the database schema
- the migration and seed scripts
- the environment setup

The biggest problems were in the payment flow, especially around duplicate charges, retries, and webhook handling.

## Main issues I found

### 1. The same order could be charged more than once

The original charge flow checked whether an order was still `PENDING`, then called the payment provider, then saved the payment, then updated the order.

The problem was that this was not done inside one protected database transaction. So if two requests came in at almost the same time, both of them could see the order as `PENDING` and both could try to charge it.

That creates a real double-charge risk.

### 2. The idempotency logic was too weak

The app used Redis to cache charge results, but the logic was not strong enough for real retries.

Two requests with the same `Idempotency-Key` could both miss the cache and both continue running. That means idempotency was not actually protecting against duplicate work under concurrency.

There was also another issue: the same key could be reused for a different order and return the wrong cached result.

### 3. A webhook could make an order look paid even when no payment existed

The original webhook code could mark an order as `PAID` after a `payment_succeeded` event, but it did not create a row in the `payments` table.

So the API could return an order like this:

- status is `PAID`
- payments list is empty

That is inconsistent data.

### 4. Duplicate webhooks could be processed more than once

Payment providers often retry webhook delivery. The original code did not properly prevent the same webhook event from being handled multiple times.

That could lead to repeated writes and repeated state changes.

### 5. The database was not enforcing important rules

The original database schema did not protect against:

- duplicate webhook event IDs
- duplicate provider transaction IDs
- more than one successful payment for the same order

That means even if the app code was mostly correct, bad data could still slip into the database.

### 6. Order status updates were too loose

The code that marked an order as paid did not strictly check that the order was still in the right state first.

That makes it easier for invalid state changes to happen.

### 7. Webhook validation was incomplete

The original webhook flow only really handled `payment_succeeded` properly.

It did not fully validate inputs, and it did not handle `payment_failed` in a useful way even though the database already supported a `FAILED` status.


## What I fixed

### Safer charging

I updated the charge flow so it now:

- validates the incoming `orderId`
- uses a Redis lock for the `Idempotency-Key`
- checks for an existing saved result before doing work
- opens a database transaction
- locks the order row before making decisions
- only charges if the order is still in the correct state
- creates the payment and updates the order together

I made charging much safer so two requests cannot easily charge the same order at the same time.

### Stronger idempotency

I improved the idempotency behavior so that:

- retries with the same key return the same result
- two concurrent requests with the same key do not both run the charge flow
- the same idempotency key cannot silently be reused for a different order

This makes retry behavior much more reliable.

### Better webhook handling

I updated webhook processing so it now:

- validates required fields
- accepts only supported event types
- runs inside a transaction
- ignores duplicate webhook events safely
- creates a payment record for `payment_succeeded`
- creates a failed payment record for `payment_failed`
- updates the order status to match what happened

This keeps the order state and payment records in sync.

### Safer repository updates

I tightened the repository layer so that:

- order rows can be locked during a transaction
- an order is only marked `PAID` if it was `PENDING`
- an order is only marked `FAILED` if it was `PENDING`

That helps prevent invalid status changes.

### Stronger database protection

I added database indexes so the database itself now helps enforce correctness:

- webhook event IDs must be unique
- provider transaction IDs must be unique
- only one successful payment can exist per order

This is important because payment safety should not depend only on application code.

### Fixed local database setup

I aligned the default database connection settings with the Docker setup so the app now points to the right Postgres port by default.

## Why these fixes are safe

The main reason these changes are safer is that the most important payment steps now happen in a controlled way.

- charging uses transactions and row locking
- retries use stronger idempotency protection
- webhook processing is deduplicated
- successful paid orders now have matching payment records
- the database also enforces important rules

So even if requests arrive at the same time, or a webhook is retried, the app is much less likely to end up with bad data.

## Tests I added

I added automated tests for the most important risky paths:

- two charge requests with the same idempotency key
- reusing the same idempotency key for a different order
- successful webhook processing
- duplicate webhook delivery
- failed webhook processing

These tests are useful because they prove the logic works in the exact areas this assessment cares about: correctness, concurrency safety, and retry behavior.

## Trade-offs and what still remains

### 1. The charge flow is safer, but it is a bit conservative

Right now the code holds the order lock while waiting for the payment provider call to finish.

That is good for safety, but in a larger production system it could reduce performance if the provider is slow.

For this assessment, I chose correctness first.

### 2. Webhook-created payments use a generated transaction ID

The webhook payload does not provide a real provider transaction ID, so the code creates one from the webhook event ID.

That works for this project, but a real system would ideally store the actual provider transaction ID.

### 3. The payment state model is still simple

The app only uses:

- `PENDING`
- `PAID`
- `FAILED`

That is enough for this assessment, but a production payment system might need more states like `PROCESSING`, `REFUNDED`, or `CANCELLED`.

### 4. The tests are focused, not fully end-to-end

The tests I added are service-level tests. They are very useful for proving the business logic, but they do not fully replace integration tests with a real Postgres and Redis setup.

So the code is much safer now, but full end-to-end testing would still be a good next step.
