# OrderFlow Architecture

## Overview

OrderFlow is an event-driven microservices system designed for distributed order processing. It demonstrates production-grade patterns for building resilient, scalable systems using TypeScript, Kafka, and PostgreSQL.

## System Architecture

```
┌─────────────┐         ┌──────────────┐         ┌───────────────────┐
│   Client    │────────▶│Order Service │────────▶│   Kafka Cluster   │
└─────────────┘         └──────────────┘         └───────────────────┘
                               │                           │
                               │                           │
                               ▼                           ▼
                        ┌──────────────┐         ┌─────────────────┐
                        │  PostgreSQL  │         │  Payment Svc    │
                        │   (orderdb)  │         │  Inventory Svc  │
                        └──────────────┘         └─────────────────┘
                                                           │
                                                           ▼
                                                  ┌─────────────────┐
                                                  │   PostgreSQL    │
                                                  │  (paymentdb +   │
                                                  │  inventorydb)   │
                                                  └─────────────────┘
```

## Core Services

### Order Service (Port 3001)
**Responsibilities:**
- Manages order lifecycle and state machine
- Orchestrates order flow through states
- Produces order events (ORDER_CREATED, ORDER_APPROVED, ORDER_STATE_CHANGED, ORDER_CANCELLED)
- Consumes payment and inventory events
- Implements transactional outbox pattern
- Handles out-of-order event arrival

**Database:** `orderdb`
- `orders` - Order aggregates
- `order_events` - Event sourcing / audit log
- `order_state_tracking` - Tracks payment + inventory status
- `outbox` - Transactional outbox for reliable event publishing
- `processed_messages` - Idempotency tracking

**API Endpoints:**
- `POST /orders` - Create draft order
- `POST /orders/:id/approve` - Approve order (triggers payment + inventory)
- `POST /orders/:id/ship` - Mark order as shipped
- `POST /orders/:id/complete` - Complete order
- `POST /orders/:id/cancel` - Cancel order
- `GET /orders/:id` - Get order details
- `GET /orders?customerId=X` - List customer orders
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics

### Payment Service (Port 3002)
**Responsibilities:**
- Authorizes payments for approved orders
- Implements idempotency using `Idempotency-Key` header
- Consumes ORDER_APPROVED events
- Produces PAYMENT_AUTHORIZED or PAYMENT_FAILED events
- Simulates payment gateway (90% success rate for demo)

**Database:** `paymentdb`
- `payments` - Payment records with unique idempotency keys
- `outbox` - Transactional outbox
- `processed_messages` - Idempotency tracking

**API Endpoints:**
- `POST /payments/authorize` - Authorize payment (requires Idempotency-Key header)
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics

### Inventory Service (Port 3003)
**Responsibilities:**
- Manages inventory quantities and reservations
- Reserves inventory for approved orders
- Uses pessimistic locking (SELECT FOR UPDATE) to prevent overselling
- Consumes ORDER_APPROVED events
- Produces INVENTORY_RESERVED or INVENTORY_FAILED events
- Tracks reserved vs available quantities

**Database:** `inventorydb`
- `inventory_items` - SKU inventory with quantity and reserved_quantity
- `inventory_reservations` - Reservation records per order
- `outbox` - Transactional outbox
- `processed_messages` - Idempotency tracking

**API Endpoints:**
- `POST /inventory/seed` - Seed inventory (dev only)
- `GET /inventory/:sku` - Get inventory details
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics

## Order State Machine

```
        ┌───────┐
        │ DRAFT │
        └───┬───┘
            │ approve()
            ▼
      ┌──────────┐
      │ APPROVED │◀────────┐
      └────┬─────┘         │
           │                │
           │ (wait for both)│
           │ ├─ PAYMENT_AUTHORIZED
           │ └─ INVENTORY_RESERVED
           │                │
           ▼                │
     ┌────────────┐         │
     │ FULFILLING │         │
     └─────┬──────┘         │
           │ ship()         │
           ▼                │
      ┌─────────┐           │
      │ SHIPPED │           │
      └────┬────┘           │
           │ complete()     │
           ▼                │
     ┌───────────┐          │
     │ COMPLETED │          │
     └───────────┘          │
                            │
           ┌────────────────┘
           │ Any failure
           ▼
      ┌───────────┐
      │ CANCELLED │
      └───────────┘
```

### State Transitions

1. **DRAFT → APPROVED**
   - Triggered by: `POST /orders/:id/approve`
   - Emits: `ORDER_APPROVED` event
   - Creates state tracking entry

2. **APPROVED → FULFILLING**
   - Triggered by: Both `PAYMENT_AUTHORIZED` and `INVENTORY_RESERVED` events received
   - Handles out-of-order events (stores partial state until both arrive)
   - Emits: `ORDER_STATE_CHANGED` event

3. **APPROVED → CANCELLED**
   - Triggered by: `PAYMENT_FAILED` or `INVENTORY_FAILED` events
   - Emits: `ORDER_CANCELLED` event with reason code

4. **FULFILLING → SHIPPED**
   - Triggered by: `POST /orders/:id/ship`
   - Emits: `ORDER_STATE_CHANGED` event

5. **SHIPPED → COMPLETED**
   - Triggered by: `POST /orders/:id/complete`
   - Emits: `ORDER_STATE_CHANGED` event

## Event Flow

### Happy Path

```
1. Client → Order Service: POST /orders (create draft)
   └─ Returns: Order ID in DRAFT state

2. Client → Order Service: POST /orders/:id/approve
   ├─ Order Service → Kafka: ORDER_APPROVED event
   ├─ Payment Service ← Kafka: Consumes ORDER_APPROVED
   │  └─ Payment Service → Kafka: PAYMENT_AUTHORIZED event
   └─ Inventory Service ← Kafka: Consumes ORDER_APPROVED
      └─ Inventory Service → Kafka: INVENTORY_RESERVED event

3. Order Service ← Kafka: Consumes PAYMENT_AUTHORIZED + INVENTORY_RESERVED
   └─ Order transitions to FULFILLING

4. Client → Order Service: POST /orders/:id/ship
   └─ Order transitions to SHIPPED

5. Client → Order Service: POST /orders/:id/complete
   └─ Order transitions to COMPLETED
```

### Failure Scenarios

**Payment Failure:**
```
ORDER_APPROVED → Payment Service → PAYMENT_FAILED → Order Service → CANCELLED
```

**Inventory Failure:**
```
ORDER_APPROVED → Inventory Service → INVENTORY_FAILED → Order Service → CANCELLED
```

## Kafka Topics

| Topic | Producers | Consumers | Purpose |
|-------|-----------|-----------|---------|
| `order.events` | Order Service | Payment Service, Inventory Service | Order lifecycle events |
| `payment.events` | Payment Service | Order Service | Payment authorization results |
| `inventory.events` | Inventory Service | Order Service | Inventory reservation results |
| `order.dlq` | All Services | Manual/Monitoring | Dead letter queue for failed messages |

## Production Patterns

### 1. Transactional Outbox Pattern

**Problem:** How to atomically update the database and publish an event?

**Solution:** Write events to an `outbox` table in the same transaction as the business logic, then a separate publisher process polls the outbox and publishes to Kafka.

**Implementation:**
```typescript
await db.transaction(async (client) => {
  // Update business state
  await orderRepo.save(order, client);
  
  // Write event to outbox
  await outboxRepo.save(order.id, Topics.ORDER_EVENTS, order.id, event, client);
});

// Separate process polls outbox every 1s
setInterval(async () => {
  const pending = await outboxRepo.findPending(100);
  for (const msg of pending) {
    await kafkaProducer.send(msg);
    await outboxRepo.markDelivered(msg.id);
  }
}, 1000);
```

**Benefits:**
- Guarantees at-least-once delivery
- No lost events even if Kafka is down
- No dual-write problem

### 2. Idempotent Consumers

**Problem:** Kafka delivers messages at-least-once, so consumers may see duplicates.

**Solution:** Track processed message IDs in a `processed_messages` table.

**Implementation:**
```typescript
const messageId = `${topic}-${partition}-${offset}`;

if (await idempotencyRepo.isProcessed(messageId)) {
  return; // Already processed
}

// Process message...

await idempotencyRepo.markProcessed(messageId);
```

**Benefits:**
- Safe reprocessing after failures
- No duplicate side effects
- Exactly-once semantics from consumer perspective

### 3. Idempotency Keys (Payment Service)

**Problem:** External API calls (e.g., payment gateways) should not be retried blindly.

**Solution:** Use idempotency keys that are unique per business operation.

**Implementation:**
```typescript
// Client includes Idempotency-Key header
POST /payments/authorize
Idempotency-Key: order-{orderId}

// Service checks if payment already exists
const existing = await paymentRepo.findByIdempotencyKey(key);
if (existing) {
  return existing; // Return cached result
}

// Proceed with payment...
```

**Benefits:**
- Safe API retries
- No duplicate charges
- Resilient to network failures

### 4. Out-of-Order Event Handling

**Problem:** Events may arrive in different order than produced.

**Solution:** Store partial state and only transition when all preconditions are met.

**Implementation:**
```typescript
// Order State Tracking table
{
  orderId: uuid,
  paymentAuthorized: boolean,
  inventoryReserved: boolean
}

// On PAYMENT_AUTHORIZED
await stateTracking.updatePaymentStatus(orderId, true);
await tryTransitionToFulfilling(orderId);

// On INVENTORY_RESERVED
await stateTracking.updateInventoryStatus(orderId, true);
await tryTransitionToFulfilling(orderId);

// Try transition only if BOTH are true
if (tracking.paymentAuthorized && tracking.inventoryReserved) {
  order.startFulfilling();
}
```

**Benefits:**
- Resilient to race conditions
- Works regardless of event arrival order
- Idempotent state transitions

### 5. Dead Letter Queue (DLQ)

**Problem:** Some messages fail processing after multiple retries.

**Solution:** Send failed messages to a DLQ topic for manual inspection.

**Implementation:**
```typescript
try {
  await processMessage(message);
} catch (err) {
  const retryCount = message.headers.retryCount || 0;
  
  if (retryCount < MAX_RETRIES) {
    // Kafka will retry
    throw err;
  } else {
    // Send to DLQ
    await kafkaProducer.send({
      topic: Topics.DLQ,
      messages: [{
        key: message.key,
        value: message.value,
        headers: {
          ...message.headers,
          originalTopic: topic,
          error: err.message,
          failedAt: new Date().toISOString()
        }
      }]
    });
  }
}
```

**Benefits:**
- Prevents poison messages from blocking queue
- Preserves failed messages for debugging
- Allows manual reprocessing

### 6. Event Sourcing (Audit Log)

**Problem:** Need full audit trail of order changes.

**Solution:** Store all events in an append-only `order_events` table.

**Implementation:**
```typescript
await eventRepo.save(orderId, EventTypes.ORDER_APPROVED, eventPayload);
```

**Benefits:**
- Complete audit trail
- Can rebuild state from events
- Useful for debugging and compliance

## Database Design

### Per-Service Databases

Each service has its own database to maintain bounded contexts:
- **orderdb** - Order Service
- **paymentdb** - Payment Service  
- **inventorydb** - Inventory Service

**Benefits:**
- Service independence
- Schema evolution per service
- Technology choice per service (if needed)
- Fault isolation

**Trade-offs:**
- No distributed transactions
- Must use eventual consistency
- Requires event-driven patterns

### Common Tables Across Services

Each service implements similar infrastructure tables:

**outbox** - Transactional outbox
```sql
CREATE TABLE outbox (
  id UUID PRIMARY KEY,
  aggregate_id UUID,
  topic VARCHAR(255),
  key VARCHAR(255),
  payload JSONB,
  status VARCHAR(50) DEFAULT 'PENDING',
  created_at TIMESTAMP,
  delivered_at TIMESTAMP
);
```

**processed_messages** - Idempotency tracking
```sql
CREATE TABLE processed_messages (
  message_id VARCHAR(255) PRIMARY KEY,
  processed_at TIMESTAMP
);
```

## Consistency Model

### Strong Consistency
- Within a single service (ACID transactions in PostgreSQL)
- Order state changes are atomic

### Eventual Consistency
- Across services
- Payment and inventory may complete at different times
- Order eventually reaches FULFILLING when both complete
- Acceptable lag: typically < 1 second in normal operation

## Failure Modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| Order Service down | No new orders, existing orders continue | Restart service, outbox publishes pending events |
| Payment Service down | Orders stuck in APPROVED | Restart service, processes backlog from Kafka |
| Inventory Service down | Orders stuck in APPROVED | Restart service, processes backlog from Kafka |
| Kafka down | Events buffered in outbox | Services continue, events publish when Kafka recovers |
| Database down | Service unavailable | Restore from backup, replay events if needed |
| Network partition | Services can't communicate | Services buffer events locally, catch up when healed |

## Scaling Considerations

### Horizontal Scaling

**Order Service:**
- Stateless API: Scale with load balancer
- Outbox publisher: Single instance or leader election
- Kafka consumers: Partition-based parallelism

**Payment Service:**
- Stateless API: Scale with load balancer
- Kafka consumer: One consumer per partition

**Inventory Service:**
- Stateless API: Scale with load balancer
- Kafka consumer: One consumer per partition
- Database locking limits throughput for same SKU

### Performance Bottlenecks

1. **Inventory Locking**: SELECT FOR UPDATE serializes reservations per SKU
   - **Solution**: Shard by SKU, use optimistic locking, or implement reservation queue

2. **Outbox Polling**: Can lag under high load
   - **Solution**: CDC (Change Data Capture) or Kafka Connect

3. **Kafka Consumer Lag**: Slow processing backs up queue
   - **Solution**: Increase partitions, optimize consumer processing, add replicas

## Security Considerations

### Current Implementation (Demo)
- JWT tokens for authentication (not implemented in MVP)
- Services trust each other (same network)
- No encryption at rest
- No encryption in transit between services

### Production Requirements
- **Authentication**: OAuth 2.0 or JWT with proper signing
- **Authorization**: Role-based access control (RBAC)
- **Encryption**: TLS for all service-to-service communication
- **Secrets Management**: Vault or AWS Secrets Manager
- **Kafka Security**: SASL/SSL authentication + ACLs
- **Database Security**: Encrypted connections, least-privilege users
- **API Gateway**: Rate limiting, DDoS protection

## Monitoring and Observability

### Logs (Pino)
- Structured JSON logs
- Correlation IDs trace requests across services
- Log levels: DEBUG, INFO, WARN, ERROR

### Metrics (Prometheus)
- `/metrics` endpoint on each service
- Key metrics to track:
  - Request rate, latency, errors
  - Kafka consumer lag
  - Outbox queue depth
  - Order state distribution
  - Payment success rate
  - Inventory reservation failures

### Distributed Tracing (Future)
- Add OpenTelemetry for end-to-end tracing
- Track order journey across services

## Trade-offs and Design Decisions

| Decision | Pros | Cons | Alternative |
|----------|------|------|-------------|
| Event-driven | Loose coupling, scalability, resilience | Complexity, eventual consistency | Synchronous HTTP calls |
| Outbox pattern | Guaranteed delivery, no dual-write | Polling lag, extra table | CDC with Debezium |
| Per-service DB | Independence, isolation | No distributed transactions | Shared database |
| Kafka | High throughput, durable, scalable | Operational complexity | RabbitMQ, AWS SQS |
| TypeScript | Type safety, good ecosystem | Slower than Go/Rust | Go, Java, Python |
| Pessimistic locking (inventory) | Prevents overselling | Serializes updates | Optimistic locking |

## Future Enhancements

1. **Saga Pattern**: Implement compensating transactions for complex workflows
2. **Circuit Breakers**: Prevent cascade failures
3. **Rate Limiting**: Protect services from overload
4. **API Gateway**: Centralized routing and authentication
5. **Service Mesh**: Istio/Linkerd for observability and security
6. **CQRS**: Separate read and write models for queries
7. **Event Replay**: Ability to replay events for recovery or testing
8. **Multi-region**: Deploy across regions for DR
9. **Kubernetes**: Container orchestration
10. **GraphQL API**: Flexible querying for clients
