# OrderFlow Operations Runbook

## Overview

This runbook provides operational procedures for monitoring, debugging, and maintaining the OrderFlow system in production.

## Table of Contents

1. [Health Checks](#health-checks)
2. [Monitoring](#monitoring)
3. [Common Issues](#common-issues)
4. [Debugging Procedures](#debugging-procedures)
5. [Recovery Procedures](#recovery-procedures)
6. [Incident Response](#incident-response)

---

## Health Checks

### Service Health Endpoints

All services expose a `/health` endpoint:

```bash
# Order Service
curl http://localhost:3001/health

# Payment Service
curl http://localhost:3002/health

# Inventory Service
curl http://localhost:3003/health
```

**Expected Response:**
```json
{
  "status": "healthy",
  "service": "order-service",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Database Health

```bash
# Check PostgreSQL
docker exec orderflow-postgres pg_isready -U orderflow

# Connect and verify
docker exec -it orderflow-postgres psql -U orderflow -d orderdb -c "SELECT NOW()"
```

### Kafka Health

```bash
# Check Kafka broker
docker exec orderflow-kafka kafka-broker-api-versions \
  --bootstrap-server localhost:9092

# List topics
docker exec orderflow-kafka kafka-topics \
  --list --bootstrap-server localhost:9092
```

---

## Monitoring

### Key Metrics to Track

#### Order Service

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| Order creation rate | Orders/second | < 10% of normal |
| Order approval latency | Time to approve | > 5 seconds |
| State transition failures | Failed transitions | > 5% |
| Orders stuck in APPROVED | Orders not progressing | > 10 orders for > 5 minutes |
| Outbox queue depth | Pending events | > 1000 |
| Consumer lag | Kafka consumer lag | > 100 messages |

#### Payment Service

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| Payment authorization rate | Payments/second | < 10% of normal |
| Payment failure rate | % of failed payments | > 20% |
| Idempotency cache hits | Duplicate requests | Track for patterns |
| Consumer lag | Kafka consumer lag | > 100 messages |

#### Inventory Service

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| Reservation failure rate | % failed reservations | > 10% |
| Low stock items | Items with < 10 units | Alert per SKU |
| Lock contention | Database lock waits | > 100ms avg |
| Consumer lag | Kafka consumer lag | > 100 messages |

### Checking Kafka Consumer Lag

```bash
# Order Service consumers
docker exec orderflow-kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe \
  --group order-service-group-payment

docker exec orderflow-kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe \
  --group order-service-group-inventory

# Payment Service consumer
docker exec orderflow-kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe \
  --group payment-service-group

# Inventory Service consumer
docker exec orderflow-kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe \
  --group inventory-service-group
```

**Interpreting Output:**
```
GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
payment-group   order.events    0          1500            1500            0    <- Healthy
payment-group   order.events    1          1200            1350            150  <- Lagging!
```

- **LAG = 0**: Consumer is caught up
- **LAG < 100**: Acceptable
- **LAG > 100**: Investigate (slow consumer or high load)
- **LAG increasing**: Consumer is falling behind

### Outbox Queue Monitoring

```bash
# Check pending outbox messages
docker exec -it orderflow-postgres psql -U orderflow -d orderdb -c \
  "SELECT topic, COUNT(*), MIN(created_at), MAX(created_at) 
   FROM outbox 
   WHERE status = 'PENDING' 
   GROUP BY topic"
```

**Healthy State:**
- Pending count: 0-10 messages
- Age: < 5 seconds

**Unhealthy State:**
- Pending count: > 100 messages
- Age: > 60 seconds
- **Action:** Investigate outbox publisher or Kafka connectivity

---

## Common Issues

### Issue 1: Orders Stuck in APPROVED State

**Symptoms:**
- Orders remain in APPROVED state for > 5 minutes
- No transition to FULFILLING or CANCELLED

**Root Causes:**
1. Payment service down or not consuming events
2. Inventory service down or not consuming events
3. Payment/inventory events not being published
4. State tracking issue

**Diagnosis:**

```bash
# 1. Check if services are running
curl http://localhost:3002/health  # Payment
curl http://localhost:3003/health  # Inventory

# 2. Check state tracking
ORDER_ID="<stuck-order-id>"
docker exec -it orderflow-postgres psql -U orderflow -d orderdb -c \
  "SELECT * FROM order_state_tracking WHERE order_id = '$ORDER_ID'"

# Expected output shows payment_authorized and inventory_reserved status
# If one is FALSE, that service hasn't processed the event yet

# 3. Check Kafka consumer lag
docker exec orderflow-kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe --group payment-service-group

docker exec orderflow-kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe --group inventory-service-group

# 4. Check service logs for errors
docker logs <payment-service-container-id>
docker logs <inventory-service-container-id>
```

**Resolution:**
```bash
# Restart lagging service
docker restart <service-container-id>

# Or if consumer is stuck, restart the consumer process
# The consumer will catch up from last committed offset
```

### Issue 2: High Kafka Consumer Lag

**Symptoms:**
- Consumer lag > 100 messages and increasing
- Events taking > 10 seconds to process

**Root Causes:**
1. Slow message processing (database locks, external API calls)
2. Insufficient consumer resources (CPU, memory)
3. Too few partitions for load

**Diagnosis:**

```bash
# 1. Check consumer lag trend
# Run this command multiple times, 10 seconds apart
docker exec orderflow-kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe --group order-service-group-payment

# Is LAG increasing? → Consumer is too slow
# Is LAG decreasing? → Consumer is catching up

# 2. Check consumer logs for slow processing
docker logs <service-container-id> | grep "Processing.*event" | tail -20

# 3. Check database performance
docker exec -it orderflow-postgres psql -U orderflow -d orderdb -c \
  "SELECT pid, now() - query_start AS duration, query
   FROM pg_stat_activity
   WHERE state = 'active' AND query NOT LIKE '%pg_stat_activity%'
   ORDER BY duration DESC"
```

**Resolution:**

**Short-term:**
```bash
# Scale consumer horizontally
# Deploy additional instances of the slow service
docker-compose up --scale payment-service=3
```

**Long-term:**
- Increase Kafka topic partitions (allows parallel processing)
- Optimize slow database queries (add indexes)
- Reduce processing time per message

### Issue 3: Outbox Publisher Not Publishing

**Symptoms:**
- Outbox table has many PENDING messages
- Messages are old (> 1 minute)
- Events not appearing in Kafka

**Root Causes:**
1. Outbox publisher process crashed
2. Kafka connection issues
3. Kafka broker down

**Diagnosis:**

```bash
# 1. Check outbox queue
docker exec -it orderflow-postgres psql -U orderflow -d orderdb -c \
  "SELECT COUNT(*), MIN(created_at) 
   FROM outbox 
   WHERE status = 'PENDING'"

# 2. Check service logs for Kafka errors
docker logs <service-container-id> | grep -i kafka | tail -20

# 3. Test Kafka connectivity
docker exec orderflow-kafka kafka-topics \
  --list --bootstrap-server localhost:9092
```

**Resolution:**

```bash
# 1. Restart service (outbox publisher will resume)
docker restart <service-container-id>

# 2. Verify messages are being published
# Wait 10 seconds, then check outbox again
docker exec -it orderflow-postgres psql -U orderflow -d orderdb -c \
  "SELECT COUNT(*) FROM outbox WHERE status = 'PENDING'"
# Count should be decreasing
```

### Issue 4: Payment Failures Spike

**Symptoms:**
- Payment failure rate > 20%
- Many orders transitioning to CANCELLED

**Root Causes:**
1. Payment gateway issues (if using real gateway)
2. Payment service bugs
3. Invalid payment data

**Diagnosis:**

```bash
# 1. Check payment failure reasons
docker exec -it orderflow-postgres psql -U orderflow -d paymentdb -c \
  "SELECT status, COUNT(*) 
   FROM payments 
   WHERE created_at > NOW() - INTERVAL '1 hour'
   GROUP BY status"

# 2. Check recent failed payments
docker exec -it orderflow-postgres psql -U orderflow -d paymentdb -c \
  "SELECT * FROM payments 
   WHERE status = 'FAILED' 
   ORDER BY created_at DESC 
   LIMIT 10"

# 3. Check service logs
docker logs <payment-service-container-id> | grep -i "failed" | tail -20
```

**Resolution:**
- If gateway issue: Wait for gateway recovery or switch to backup
- If data issue: Fix upstream validation in order service
- If service bug: Deploy hotfix

### Issue 5: Inventory Out of Stock

**Symptoms:**
- Orders failing with INVENTORY_FAILED events
- High reservation failure rate

**Diagnosis:**

```bash
# 1. Check inventory levels
docker exec -it orderflow-postgres psql -U orderflow -d inventorydb -c \
  "SELECT sku, quantity, reserved_quantity, 
          quantity - reserved_quantity AS available
   FROM inventory_items
   WHERE quantity - reserved_quantity < 10
   ORDER BY available ASC"

# 2. Check recent reservation failures
docker exec -it orderflow-postgres psql -U orderflow -d inventorydb -c \
  "SELECT * FROM inventory_reservations
   WHERE status = 'FAILED'
   ORDER BY created_at DESC
   LIMIT 10"
```

**Resolution:**
```bash
# Option 1: Replenish inventory (manual)
docker exec -it orderflow-postgres psql -U orderflow -d inventorydb -c \
  "UPDATE inventory_items 
   SET quantity = quantity + 100 
   WHERE sku = 'WIDGET-001'"

# Option 2: Seed inventory via API
curl -X POST http://localhost:3003/inventory/seed \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      { "sku": "WIDGET-001", "quantity": 500 }
    ]
  }'
```

### Issue 6: Dead Letter Queue (DLQ) Messages

**Symptoms:**
- Messages appearing in `order.dlq` topic
- Consumer logs show repeated failures

**Diagnosis:**

```bash
# 1. Consume DLQ messages
docker exec orderflow-kafka kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic order.dlq \
  --from-beginning \
  --max-messages 10

# 2. Check error headers
# Messages will have headers: originalTopic, error, failedAt
```

**Resolution:**

**Analyze failure:**
- Is it a transient issue? (network, timeout) → Replay message
- Is it a poison message? (malformed data) → Fix and replay
- Is it a bug? → Fix bug, deploy, replay

**Replay DLQ message:**
```bash
# Manual replay (for small numbers)
# 1. Fix underlying issue
# 2. Manually repost to original topic
# 3. Monitor for success

# Automated replay (for large numbers)
# Use Kafka Connect or custom replay tool
```

---

## Debugging Procedures

### Tracing an Order Through the System

```bash
ORDER_ID="<your-order-id>"

# 1. Get order current state
curl http://localhost:3001/orders/$ORDER_ID

# 2. View order event history (audit log)
docker exec -it orderflow-postgres psql -U orderflow -d orderdb -c \
  "SELECT event_type, created_at, payload 
   FROM order_events 
   WHERE order_id = '$ORDER_ID' 
   ORDER BY created_at ASC"

# 3. Check state tracking
docker exec -it orderflow-postgres psql -U orderflow -d orderdb -c \
  "SELECT * FROM order_state_tracking WHERE order_id = '$ORDER_ID'"

# 4. Check payment record
docker exec -it orderflow-postgres psql -U orderflow -d paymentdb -c \
  "SELECT * FROM payments WHERE order_id = '$ORDER_ID'"

# 5. Check inventory reservations
docker exec -it orderflow-postgres psql -U orderflow -d inventorydb -c \
  "SELECT * FROM inventory_reservations WHERE order_id = '$ORDER_ID'"
```

### Finding Correlation ID for Distributed Tracing

```bash
# Search logs across all services
docker logs <order-service-id> | grep "<correlation-id>"
docker logs <payment-service-id> | grep "<correlation-id>"
docker logs <inventory-service-id> | grep "<correlation-id>"
```

### Checking for Duplicate Processing (Idempotency)

```bash
# Check processed messages
docker exec -it orderflow-postgres psql -U orderflow -d orderdb -c \
  "SELECT message_id, processed_at 
   FROM processed_messages 
   WHERE message_id LIKE '%order.events%' 
   ORDER BY processed_at DESC 
   LIMIT 20"
```

---

## Recovery Procedures

### Scenario: Service Crashes and Doesn't Restart

**Steps:**

1. **Check logs for crash reason:**
   ```bash
   docker logs <service-container-id> --tail 100
   ```

2. **Check resource usage:**
   ```bash
   docker stats <service-container-id>
   ```

3. **Restart service:**
   ```bash
   docker restart <service-container-id>
   ```

4. **Verify recovery:**
   ```bash
   curl http://localhost:3001/health
   
   # Check consumer lag is catching up
   docker exec orderflow-kafka kafka-consumer-groups \
     --bootstrap-server localhost:9092 \
     --describe --group order-service-group-payment
   ```

### Scenario: Kafka Broker Down

**Impact:**
- Services can't publish/consume events
- Events buffered in outbox tables
- System degraded but not completely down

**Recovery:**

1. **Restart Kafka:**
   ```bash
   docker restart orderflow-kafka
   docker restart orderflow-zookeeper
   ```

2. **Wait for Kafka to be ready:**
   ```bash
   # Check Kafka is responding
   docker exec orderflow-kafka kafka-broker-api-versions \
     --bootstrap-server localhost:9092
   ```

3. **Verify services reconnect:**
   ```bash
   docker logs <order-service-id> | grep -i "kafka.*connected"
   ```

4. **Monitor outbox queue draining:**
   ```bash
   docker exec -it orderflow-postgres psql -U orderflow -d orderdb -c \
     "SELECT COUNT(*) FROM outbox WHERE status = 'PENDING'"
   ```

### Scenario: Database Corruption

**Prevention:**
- Regular backups
- Point-in-time recovery enabled

**Recovery:**

1. **Stop services:**
   ```bash
   docker stop <order-service-id> <payment-service-id> <inventory-service-id>
   ```

2. **Restore from backup:**
   ```bash
   # Example: restore specific database
   docker exec -i orderflow-postgres pg_restore \
     -U orderflow -d orderdb < backup.dump
   ```

3. **Replay events (if using event sourcing):**
   ```bash
   # Replay from order_events table
   # Application-specific procedure
   ```

4. **Restart services:**
   ```bash
   docker start <order-service-id> <payment-service-id> <inventory-service-id>
   ```

### Scenario: Data Inconsistency

**Example:** Order is FULFILLING but payment was never authorized

**Investigation:**
```bash
ORDER_ID="<order-id>"

# Check order state
curl http://localhost:3001/orders/$ORDER_ID

# Check state tracking
docker exec -it orderflow-postgres psql -U orderflow -d orderdb -c \
  "SELECT * FROM order_state_tracking WHERE order_id = '$ORDER_ID'"

# Check payment exists
docker exec -it orderflow-postgres psql -U orderflow -d paymentdb -c \
  "SELECT * FROM payments WHERE order_id = '$ORDER_ID'"
```

**Resolution:**

**Option 1: Manual fix (dangerous)**
```bash
# Update order state
docker exec -it orderflow-postgres psql -U orderflow -d orderdb -c \
  "UPDATE orders SET state = 'CANCELLED' WHERE id = '$ORDER_ID'"
```

**Option 2: Compensating transaction**
```bash
# Cancel the order via API
curl -X POST http://localhost:3001/orders/$ORDER_ID/cancel \
  -H "Content-Type: application/json" \
  -d '{ "reason": "Manual cancellation due to inconsistency" }'
```

---

## Incident Response

### Severity Levels

| Level | Description | Response Time | Example |
|-------|-------------|---------------|---------|
| **P0** | System down, no orders processing | < 15 minutes | All services down |
| **P1** | Partial outage, significant impact | < 1 hour | Order service down |
| **P2** | Performance degraded | < 4 hours | High consumer lag |
| **P3** | Minor issue, low impact | < 24 hours | Single order stuck |

### Incident Checklist

1. **Assess severity** (P0-P3)
2. **Notify team** (via PagerDuty, Slack, etc.)
3. **Create incident channel** (#incident-YYYY-MM-DD-description)
4. **Investigate** (use debugging procedures above)
5. **Implement fix** (restart, deploy hotfix, etc.)
6. **Verify recovery** (check metrics, test manually)
7. **Post-incident review** (document root cause, preventive actions)

### Emergency Contacts

```
# Update with your team's contacts
Order Service: @order-team
Payment Service: @payment-team
Inventory Service: @inventory-team
Infrastructure: @platform-team
On-call: PagerDuty rotation
```

### Rollback Procedure

```bash
# 1. Identify last known good version
git log --oneline -10

# 2. Checkout previous version
git checkout <commit-hash>

# 3. Rebuild and deploy
npm run build
docker-compose down
docker-compose up -d

# 4. Verify services are healthy
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3003/health
```

---

## Interview Talking Points

When discussing this system in interviews, highlight:

### What to Say

1. **Transactional Outbox:**
   - "We use the outbox pattern to guarantee at-least-once event delivery"
   - "Events are written to the database in the same transaction as business logic"
   - "A separate publisher polls the outbox and publishes to Kafka"

2. **Idempotency:**
   - "All consumers track processed message IDs to handle duplicates"
   - "Payment service uses idempotency keys for API-level idempotency"
   - "This ensures exactly-once semantics from the consumer's perspective"

3. **Out-of-order Events:**
   - "We track partial state (payment + inventory separately)"
   - "Order only transitions when both conditions are met"
   - "Works regardless of which event arrives first"

4. **Failure Handling:**
   - "Consumers retry failed messages up to 3 times"
   - "After max retries, messages go to DLQ for manual investigation"
   - "Services buffer events locally if Kafka is down (via outbox)"

5. **Scaling:**
   - "Services are stateless and scale horizontally"
   - "Kafka partitioning allows parallel consumer processing"
   - "Database is the bottleneck for inventory (due to locking)"

### Tradeoffs Discussed

- **Eventual consistency** vs strong consistency
- **Outbox polling** vs CDC (Change Data Capture)
- **Pessimistic locking** vs optimistic locking (inventory)
- **Event-driven** vs synchronous HTTP calls

### Failure Modes

- Service crashes → Kafka redelivers from last offset
- Kafka down → Events buffered in outbox
- Database down → Service unavailable (no workaround)
- Network partition → Services buffer locally, catch up when healed

---

## Additional Resources

- [Kafka Consumer Groups](https://kafka.apache.org/documentation/#consumergroups)
- [PostgreSQL Performance Tuning](https://wiki.postgresql.org/wiki/Performance_Optimization)
- [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html)
