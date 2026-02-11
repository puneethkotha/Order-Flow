# OrderFlow Architecture Diagrams

## System Architecture

```
                                    ┌─────────────────────────────────────┐
                                    │         Client / API Users          │
                                    └──────────────┬──────────────────────┘
                                                   │
                                                   │ HTTP
                                                   ▼
                    ┌──────────────────────────────────────────────────────┐
                    │          Order Service (Port 3001)                   │
                    │  ┌────────────────────────────────────────────────┐  │
                    │  │  API: Create, Approve, Ship, Complete Orders  │  │
                    │  │  State Machine: DRAFT → APPROVED → FULFILLING │  │
                    │  │                → SHIPPED → COMPLETED           │  │
                    │  └────────────────────────────────────────────────┘  │
                    │                                                      │
                    │  ┌──────────────┐  ┌────────────────────────────┐  │
                    │  │   Outbox     │  │  Payment/Inventory Event   │  │
                    │  │  Publisher   │  │      Consumers             │  │
                    │  └──────────────┘  └────────────────────────────┘  │
                    └──────────┬───────────────────┬───────────────────────┘
                               │                   │
                               │                   │
                    ┌──────────▼───────────────────▼─────────────┐
                    │         PostgreSQL (orderdb)               │
                    │  • orders                                  │
                    │  • order_events (audit log)                │
                    │  • order_state_tracking                    │
                    │  • outbox (transactional outbox)           │
                    │  • processed_messages (idempotency)        │
                    └────────────────────────────────────────────┘
                               │
                               │ Events published
                               ▼
    ┌──────────────────────────────────────────────────────────────────────┐
    │                      Apache Kafka Cluster                            │
    │  ┌────────────────┐  ┌──────────────────┐  ┌────────────────────┐  │
    │  │ order.events   │  │ payment.events   │  │ inventory.events   │  │
    │  └────────────────┘  └──────────────────┘  └────────────────────┘  │
    │  ┌────────────────┐                                                 │
    │  │   order.dlq    │  (Dead Letter Queue)                           │
    │  └────────────────┘                                                 │
    └───────┬──────────────────────────┬───────────────────────────────────┘
            │                          │
            │ ORDER_APPROVED           │ ORDER_APPROVED
            │                          │
    ┌───────▼──────────────┐   ┌──────▼────────────────────┐
    │  Payment Service     │   │  Inventory Service        │
    │    (Port 3002)       │   │     (Port 3003)           │
    │                      │   │                           │
    │ ┌─────────────────┐  │   │ ┌──────────────────────┐  │
    │ │ Idempotency Key │  │   │ │ Pessimistic Locking │  │
    │ │   Validation    │  │   │ │ (SELECT FOR UPDATE) │  │
    │ └─────────────────┘  │   │ └──────────────────────┘  │
    │                      │   │                           │
    │ ┌─────────────────┐  │   │ ┌──────────────────────┐  │
    │ │  Authorize      │  │   │ │  Reserve Inventory   │  │
    │ │  Payment        │  │   │ │  (Check Stock)       │  │
    │ └─────────────────┘  │   │ └──────────────────────┘  │
    └──────┬───────────────┘   └───────┬───────────────────┘
           │                           │
           │                           │
    ┌──────▼───────────────┐   ┌───────▼────────────────────┐
    │ PostgreSQL           │   │ PostgreSQL                 │
    │   (paymentdb)        │   │   (inventorydb)            │
    │ • payments           │   │ • inventory_items          │
    │ • outbox             │   │ • inventory_reservations   │
    │ • processed_messages │   │ • outbox                   │
    └──────┬───────────────┘   │ • processed_messages       │
           │                   └───────┬────────────────────┘
           │                           │
           │ PAYMENT_AUTHORIZED        │ INVENTORY_RESERVED
           │ PAYMENT_FAILED            │ INVENTORY_FAILED
           └───────────┬───────────────┘
                       │
                       │ Events published back to Kafka
                       ▼
            ┌──────────────────────┐
            │  Order Service       │
            │  Event Consumers     │
            │  (Update State)      │
            └──────────────────────┘
```

## Order State Machine

```
                            ┌─────────┐
                            │  DRAFT  │ ◄─── Order Created
                            └────┬────┘
                                 │
                                 │ approve()
                                 │
                            ┌────▼────────┐
                            │  APPROVED   │
                            └─────────────┘
                                 │
                                 │ Wait for BOTH:
                                 │  • PAYMENT_AUTHORIZED
                                 │  • INVENTORY_RESERVED
                                 │
                            ┌────▼─────────┐
                            │  FULFILLING  │
                            └──────┬───────┘
                                   │
                                   │ ship()
                                   │
                              ┌────▼────┐
                              │ SHIPPED │
                              └────┬────┘
                                   │
                                   │ complete()
                                   │
                             ┌─────▼──────┐
                             │ COMPLETED  │
                             └────────────┘

                  ┌──────────────────────────────┐
                  │  Any state (except COMPLETED)│
                  │         ↓                    │
                  │    PAYMENT_FAILED            │
                  │    INVENTORY_FAILED          │
                  │    Manual Cancellation       │
                  │         ↓                    │
                  │    ┌───────────┐             │
                  │    │ CANCELLED │             │
                  │    └───────────┘             │
                  └──────────────────────────────┘
```

## Event Flow - Happy Path

```
1. Client Request
   │
   └─► POST /orders (create)
       │
       └─► Order Service
           │
           ├─► Database: Insert order (state: DRAFT)
           └─► Response: Order ID

2. Order Approval
   │
   └─► POST /orders/:id/approve
       │
       └─► Order Service
           │
           ├─► Database Transaction:
           │   ├─ Update order (state: APPROVED)
           │   └─ Insert into outbox table (ORDER_APPROVED event)
           │
           └─► Outbox Publisher (polls every 1s)
               │
               └─► Kafka: Publish ORDER_APPROVED to order.events

3. Parallel Processing
   │
   ├─► Payment Service                   ├─► Inventory Service
   │   │                                 │   │
   │   ├─ Kafka Consumer                 │   ├─ Kafka Consumer
   │   │  (reads ORDER_APPROVED)         │   │  (reads ORDER_APPROVED)
   │   │                                 │   │
   │   ├─ Check Idempotency              │   ├─ Check Idempotency
   │   │  (processed_messages table)     │   │  (processed_messages table)
   │   │                                 │   │
   │   ├─ Authorize Payment              │   ├─ Reserve Inventory
   │   │  (90% success rate - demo)      │   │  (SELECT FOR UPDATE)
   │   │                                 │   │
   │   ├─ Database Transaction:          │   ├─ Database Transaction:
   │   │  ├─ Insert payment record       │   │  ├─ Reserve quantity
   │   │  ├─ Insert outbox event         │   │  ├─ Insert reservation
   │   │  └─ Mark message processed      │   │  ├─ Insert outbox event
   │   │                                 │   │  └─ Mark message processed
   │   │                                 │   │
   │   └─► Kafka: PAYMENT_AUTHORIZED     │   └─► Kafka: INVENTORY_RESERVED

4. State Transition
   │
   └─► Order Service Event Consumers
       │
       ├─► Received: PAYMENT_AUTHORIZED
       │   └─ Update order_state_tracking (payment_authorized = true)
       │
       ├─► Received: INVENTORY_RESERVED
       │   └─ Update order_state_tracking (inventory_reserved = true)
       │
       └─► Check: Both payment AND inventory ready?
           │
           └─► YES → Transition to FULFILLING
               │
               ├─► Database Transaction:
               │   ├─ Update order (state: FULFILLING)
               │   └─ Insert outbox (ORDER_STATE_CHANGED event)
               │
               └─► Kafka: Publish ORDER_STATE_CHANGED

5. Shipping & Completion
   │
   ├─► POST /orders/:id/ship
   │   └─► State: FULFILLING → SHIPPED
   │
   └─► POST /orders/:id/complete
       └─► State: SHIPPED → COMPLETED
```

## Production Patterns

### 1. Transactional Outbox Pattern

```
┌──────────────────────────────────────────────────┐
│           Business Transaction                   │
│                                                  │
│  ┌────────────────────────────────────────┐     │
│  │  1. Update Business Entity             │     │
│  │     (e.g., order.state = APPROVED)     │     │
│  │                                         │     │
│  │  2. Insert Event into Outbox Table     │     │
│  │     (event_type, payload, status)      │     │
│  │                                         │     │
│  │  COMMIT                                 │     │
│  └────────────────────────────────────────┘     │
└──────────────────────────────────────────────────┘
                    │
                    ▼
       ┌────────────────────────────┐
       │   Outbox Publisher         │
       │   (Separate Process)       │
       │                            │
       │   Polls every 1 second     │
       │   SELECT * FROM outbox     │
       │   WHERE status = PENDING   │
       └─────────────┬──────────────┘
                     │
                     ▼
            ┌────────────────┐
            │     Kafka      │
            │   (Publish)    │
            └────────┬───────┘
                     │
                     ▼
          ┌──────────────────────┐
          │   Mark as DELIVERED  │
          │   in outbox table    │
          └──────────────────────┘
```

### 2. Idempotent Consumer

```
         Kafka Message Arrives
                │
                ▼
    ┌───────────────────────────┐
    │  Generate Message ID      │
    │  topic-partition-offset   │
    └───────────┬───────────────┘
                │
                ▼
    ┌───────────────────────────┐
    │  Check processed_messages │
    │  WHERE message_id = ?     │
    └───────────┬───────────────┘
                │
        ┌───────┴────────┐
        │                │
     Found            Not Found
        │                │
        ▼                ▼
    ┌────────┐    ┌──────────────────┐
    │ Skip   │    │  Process Message │
    │(Already│    │                  │
    │Processed)    │  1. Execute logic│
    └────────┘    │  2. Insert into  │
                  │     processed_    │
                  │     messages      │
                  └──────────────────┘
```

### 3. Out-of-Order Event Handling

```
Order State Tracking Table:
┌──────────┬──────────────────┬──────────────────┐
│ order_id │payment_authorized│inventory_reserved│
├──────────┼──────────────────┼──────────────────┤
│ 123-abc  │      false       │      false       │
└──────────┴──────────────────┴──────────────────┘

Scenario A: Payment arrives first
│
├─► PAYMENT_AUTHORIZED arrives
│   └─► Update: payment_authorized = true
│   └─► Check: inventory_reserved? NO → Wait
│
└─► INVENTORY_RESERVED arrives
    └─► Update: inventory_reserved = true
    └─► Check: BOTH true? YES → Transition to FULFILLING

Scenario B: Inventory arrives first  
│
├─► INVENTORY_RESERVED arrives
│   └─► Update: inventory_reserved = true
│   └─► Check: payment_authorized? NO → Wait
│
└─► PAYMENT_AUTHORIZED arrives
    └─► Update: payment_authorized = true
    └─► Check: BOTH true? YES → Transition to FULFILLING

Result: Order progresses correctly regardless of event order!
```

## Key Metrics & Monitoring

```
┌─────────────────────────────────────────────────┐
│              Service Metrics                    │
├─────────────────────────────────────────────────┤
│  • Request Rate (orders/sec)                    │
│  • Request Latency (p50, p95, p99)              │
│  • Error Rate (% failed requests)               │
│  • Order State Distribution                     │
├─────────────────────────────────────────────────┤
│              Kafka Metrics                      │
├─────────────────────────────────────────────────┤
│  • Consumer Lag (messages behind)               │
│  • Message Throughput (msgs/sec)                │
│  • Failed Messages → DLQ count                  │
├─────────────────────────────────────────────────┤
│            Database Metrics                     │
├─────────────────────────────────────────────────┤
│  • Outbox Queue Depth (pending events)          │
│  • Query Latency                                │
│  • Connection Pool Usage                        │
│  • Lock Wait Time (inventory)                   │
└─────────────────────────────────────────────────┘
```

## Failure Scenarios

```
┌───────────────────────────────────────────────────────────┐
│  Failure                │  Impact         │  Recovery     │
├─────────────────────────┼─────────────────┼───────────────┤
│ Kafka Down              │ Events buffered │ Outbox holds  │
│                         │ in outbox       │ events, auto  │
│                         │                 │ publishes when│
│                         │                 │ Kafka back    │
├─────────────────────────┼─────────────────┼───────────────┤
│ Payment Service Down    │ Orders stuck in │ Consumer      │
│                         │ APPROVED state  │ catches up    │
│                         │                 │ from offset   │
├─────────────────────────┼─────────────────┼───────────────┤
│ Inventory Out of Stock  │ Order cancelled │ INVENTORY_    │
│                         │                 │ FAILED event  │
│                         │                 │ triggers      │
│                         │                 │ cancellation  │
├─────────────────────────┼─────────────────┼───────────────┤
│ Payment Gateway Fails   │ Order cancelled │ PAYMENT_      │
│                         │                 │ FAILED event  │
│                         │                 │ triggers      │
│                         │                 │ cancellation  │
├─────────────────────────┼─────────────────┼───────────────┤
│ Database Connection     │ Service         │ Restart       │
│ Lost                    │ unavailable     │ service,      │
│                         │                 │ reconnect     │
└───────────────────────────────────────────────────────────┘
```

## Technology Stack

```
┌──────────────────────────────────────────┐
│           Application Layer              │
│  • TypeScript + Node.js 20+              │
│  • Fastify (HTTP framework)              │
│  • Zod (Schema validation)               │
└──────────────────────────────────────────┘
                    │
┌──────────────────────────────────────────┐
│           Messaging Layer                │
│  • Apache Kafka (Event streaming)        │
│  • kafkajs (Client library)              │
│  • Idempotent producers                  │
└──────────────────────────────────────────┘
                    │
┌──────────────────────────────────────────┐
│            Data Layer                    │
│  • PostgreSQL 15 (ACID transactions)     │
│  • pg (Client library)                   │
│  • Per-service databases                 │
└──────────────────────────────────────────┘
                    │
┌──────────────────────────────────────────┐
│        Observability Layer               │
│  • Pino (Structured logging)             │
│  • prom-client (Metrics)                 │
│  • Correlation IDs                       │
└──────────────────────────────────────────┘
                    │
┌──────────────────────────────────────────┐
│          Infrastructure                  │
│  • Docker + Docker Compose               │
│  • GitHub Actions (CI/CD)                │
│  • Jest (Testing)                        │
└──────────────────────────────────────────┘
```
