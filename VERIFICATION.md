# OrderFlow Verification Checklist

Use this checklist to verify that the OrderFlow system is working correctly after setup.

## Prerequisites

- [ ] Node.js 18+ installed
- [ ] Docker and Docker Compose installed
- [ ] All dependencies installed (`npm install`)

## Infrastructure

- [ ] Docker Compose services started (`npm run docker:up`)
- [ ] PostgreSQL is running on port 5432
- [ ] Kafka is running on port 9092
- [ ] Zookeeper is running on port 2181
- [ ] Kafka UI is accessible at http://localhost:8080 (optional)

## Database Migrations

- [ ] Order Service migrations completed
- [ ] Payment Service migrations completed
- [ ] Inventory Service migrations completed
- [ ] Inventory data seeded

**Verification Commands:**
```bash
cd services/order-service && npm run migrate
cd services/payment-service && npm run migrate
cd services/inventory-service && npm run migrate && npm run seed
```

## Services Running

- [ ] Order Service running on port 3001
- [ ] Payment Service running on port 3002
- [ ] Inventory Service running on port 3003

**Verification Commands:**
```bash
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
```

**Expected Response (for each):**
```json
{
  "status": "healthy",
  "service": "order-service",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Kafka Topics

- [ ] Topic `order.events` exists
- [ ] Topic `payment.events` exists
- [ ] Topic `inventory.events` exists
- [ ] Topic `order.dlq` exists

**Verification Command:**
```bash
docker exec orderflow-kafka kafka-topics --list --bootstrap-server localhost:9092
```

**Expected Output:**
```
order.events
payment.events
inventory.events
order.dlq
```

## Order Flow (Happy Path)

### 1. Create Order

- [ ] Create order via API
- [ ] Order ID returned
- [ ] Order in DRAFT state
- [ ] Total calculated correctly

**Command:**
```bash
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "test-customer",
    "items": [
      { "sku": "WIDGET-001", "quantity": 2, "price": 29.99 },
      { "sku": "GADGET-001", "quantity": 1, "price": 49.99 }
    ]
  }'
```

**Expected:** Order ID and state DRAFT returned

### 2. Approve Order

- [ ] Approve order via API
- [ ] ORDER_APPROVED event published to Kafka
- [ ] Payment Service consumes event
- [ ] Inventory Service consumes event

**Command:**
```bash
curl -X POST http://localhost:3001/orders/{ORDER_ID}/approve
```

**Verification:**
```bash
# Check Kafka messages
# Visit Kafka UI: http://localhost:8080
# Or consume from command line:
docker exec orderflow-kafka kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic order.events \
  --from-beginning \
  --max-messages 1
```

### 3. Payment Authorization

- [ ] Payment Service processes ORDER_APPROVED event
- [ ] Payment created in database
- [ ] PAYMENT_AUTHORIZED event published
- [ ] Order Service consumes PAYMENT_AUTHORIZED

**Verification:**
```bash
docker exec -it orderflow-postgres psql -U orderflow -d paymentdb \
  -c "SELECT * FROM payments WHERE order_id = '{ORDER_ID}'"
```

### 4. Inventory Reservation

- [ ] Inventory Service processes ORDER_APPROVED event
- [ ] Inventory reserved in database
- [ ] INVENTORY_RESERVED event published
- [ ] Order Service consumes INVENTORY_RESERVED

**Verification:**
```bash
docker exec -it orderflow-postgres psql -U orderflow -d inventorydb \
  -c "SELECT * FROM inventory_reservations WHERE order_id = '{ORDER_ID}'"

# Check inventory levels
curl http://localhost:3003/inventory/WIDGET-001
```

### 5. Order Transitions to FULFILLING

- [ ] Order state changes from APPROVED to FULFILLING
- [ ] State tracking shows payment_authorized = true
- [ ] State tracking shows inventory_reserved = true

**Verification:**
```bash
curl http://localhost:3001/orders/{ORDER_ID}

# Check state tracking
docker exec -it orderflow-postgres psql -U orderflow -d orderdb \
  -c "SELECT * FROM order_state_tracking WHERE order_id = '{ORDER_ID}'"
```

### 6. Ship Order

- [ ] Order transitions from FULFILLING to SHIPPED
- [ ] ORDER_STATE_CHANGED event published

**Command:**
```bash
curl -X POST http://localhost:3001/orders/{ORDER_ID}/ship
```

### 7. Complete Order

- [ ] Order transitions from SHIPPED to COMPLETED
- [ ] ORDER_STATE_CHANGED event published

**Command:**
```bash
curl -X POST http://localhost:3001/orders/{ORDER_ID}/complete
curl http://localhost:3001/orders/{ORDER_ID}
```

**Expected:** Order state = COMPLETED

## Production Patterns

### Transactional Outbox

- [ ] Outbox table exists in each service database
- [ ] Events written to outbox in same transaction as business logic
- [ ] Outbox publisher running (polls every 1 second)
- [ ] Events marked as DELIVERED after publishing

**Verification:**
```bash
# Check outbox (should be mostly empty, messages are delivered quickly)
docker exec -it orderflow-postgres psql -U orderflow -d orderdb \
  -c "SELECT id, topic, status, created_at FROM outbox ORDER BY created_at DESC LIMIT 10"
```

### Idempotent Consumers

- [ ] processed_messages table exists
- [ ] Message IDs stored after processing
- [ ] Duplicate messages ignored

**Verification:**
```bash
docker exec -it orderflow-postgres psql -U orderflow -d orderdb \
  -c "SELECT message_id, processed_at FROM processed_messages ORDER BY processed_at DESC LIMIT 10"
```

### Payment Idempotency

- [ ] Payment can be called with same idempotency key twice
- [ ] Second call returns same payment (no duplicate charge)

**Command:**
```bash
# First call
curl -X POST http://localhost:3002/payments/authorize \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-key-123" \
  -d '{"orderId": "test-order-id", "amount": 100.00}'

# Second call (should return same payment ID)
curl -X POST http://localhost:3002/payments/authorize \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-key-123" \
  -d '{"orderId": "test-order-id", "amount": 100.00}'
```

**Expected:** Same payment ID returned both times

### Out-of-Order Events

- [ ] Order handles PAYMENT_AUTHORIZED arriving first
- [ ] Order handles INVENTORY_RESERVED arriving first
- [ ] Order only transitions when BOTH events received

**Note:** This happens automatically, no specific test needed

### Dead Letter Queue (DLQ)

- [ ] DLQ topic exists
- [ ] Failed messages sent to DLQ after max retries

**Verification:**
```bash
docker exec orderflow-kafka kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic order.dlq \
  --from-beginning \
  --max-messages 10
```

**Expected:** Empty (or only old test messages)

### Event Sourcing / Audit Log

- [ ] order_events table stores all events
- [ ] Events are append-only
- [ ] Full history available for each order

**Verification:**
```bash
docker exec -it orderflow-postgres psql -U orderflow -d orderdb \
  -c "SELECT order_id, event_type, created_at FROM order_events WHERE order_id = '{ORDER_ID}' ORDER BY created_at"
```

**Expected:** Full event history showing state transitions

## Error Scenarios

### Payment Failure

- [ ] Payment Service can simulate failures (10% failure rate)
- [ ] PAYMENT_FAILED event published
- [ ] Order transitions to CANCELLED

**Test:** Run demo script multiple times until payment failure occurs

### Inventory Failure

- [ ] Inventory reservation fails when out of stock
- [ ] INVENTORY_FAILED event published
- [ ] Order transitions to CANCELLED

**Test:**
```bash
# Create order with large quantity
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "test-customer",
    "items": [{ "sku": "WIDGET-001", "quantity": 10000, "price": 29.99 }]
  }'

# Approve order
curl -X POST http://localhost:3001/orders/{ORDER_ID}/approve

# Check order state (should be CANCELLED)
curl http://localhost:3001/orders/{ORDER_ID}
```

## Demo Script

- [ ] Demo script runs successfully end-to-end
- [ ] All states transition correctly
- [ ] No errors in console

**Command:**
```bash
npm run demo
```

**Expected Output:**
```
 OrderFlow Demo Script
==================================================

 Step 1: Creating order...
 Order created: 550e8400-...
   State: DRAFT
   Total: $109.97

 Step 2: Approving order...
...

 Step 5: Completing order...
 Order completed: 550e8400-...
   State: COMPLETED

 Demo completed successfully!
```

## Observability

### Logs

- [ ] Structured JSON logs output
- [ ] Correlation IDs present in logs
- [ ] Log levels appropriate (INFO, WARN, ERROR)

**Check logs in service terminals**

### Kafka UI

- [ ] Kafka UI accessible at http://localhost:8080
- [ ] Topics visible
- [ ] Messages visible in topics
- [ ] Consumer groups visible

### Database Inspection

- [ ] Can connect to PostgreSQL
- [ ] All tables created
- [ ] Data visible in tables

**Commands:**
```bash
docker exec -it orderflow-postgres psql -U orderflow -d orderdb
\dt  # List tables
SELECT * FROM orders LIMIT 5;
SELECT * FROM order_events LIMIT 10;
```

## Performance

- [ ] Order creation takes < 1 second
- [ ] Order approval to FULFILLING takes < 3 seconds
- [ ] Kafka consumer lag < 10 messages under load
- [ ] Outbox queue depth < 10 messages

## Clean Up

- [ ] Can stop services cleanly (Ctrl+C)
- [ ] Can stop Docker containers (`npm run docker:down`)
- [ ] Can remove volumes (`docker-compose down -v`)
- [ ] Can reinstall and restart successfully

## Final Checklist

- [ ] All services start successfully
- [ ] Demo script passes
- [ ] Happy path works end-to-end
- [ ] Error scenarios work correctly
- [ ] Production patterns verified (outbox, idempotency, etc.)
- [ ] No errors in service logs
- [ ] No consumer lag in Kafka
- [ ] Database tables populated correctly

## Interview Preparation

If using this project for interviews, ensure you can explain:

- [ ] Why event-driven architecture?
- [ ] How transactional outbox works
- [ ] How idempotency is achieved
- [ ] How out-of-order events are handled
- [ ] What happens when services fail?
- [ ] How to scale the system?
- [ ] Trade-offs made (eventual consistency, complexity, etc.)

## Known Limitations

Document any issues encountered:

- Payment service has 10% simulated failure rate (by design)
- Inventory uses pessimistic locking (limits throughput for same SKU)
- No authentication implemented (JWT mentioned but not enforced)
- No rate limiting
- No distributed tracing (OpenTelemetry recommended for production)

---

## Sign-off

Once all items are checked, the system is verified and ready for:
- [ ] Development
- [ ] Demonstration
- [ ] Interview presentation
- [ ] Production deployment (with additional hardening)

**Verified by:** _________________
**Date:** _________________
**Notes:** _________________
