# Local Development Guide

## Prerequisites

- **Node.js**: v18+ (v20 recommended)
- **npm**: v9+
- **Docker**: v20+ with Docker Compose
- **PostgreSQL**: v15+ (via Docker)
- **Kafka**: v3+ (via Docker)

## Initial Setup

### 1. Clone and Install Dependencies

```bash
# Clone the repository
git clone <your-repo-url>
cd orderflow

# Install root dependencies
npm install

# Install all workspace dependencies
npm install --workspaces
```

### 2. Start Infrastructure

```bash
# Start PostgreSQL + Kafka + Zookeeper
npm run docker:up

# Verify services are running
docker ps

# Expected output:
# - orderflow-postgres (port 5432)
# - orderflow-kafka (port 9092)
# - orderflow-zookeeper (port 2181)
# - orderflow-kafka-ui (port 8080) - optional UI

# View logs
npm run docker:logs

# Access Kafka UI (optional)
open http://localhost:8080
```

### 3. Setup Environment Files

```bash
# Order Service
cp services/order-service/.env.example services/order-service/.env

# Payment Service
cp services/payment-service/.env.example services/payment-service/.env

# Inventory Service
cp services/inventory-service/.env.example services/inventory-service/.env
```

**Note:** Default `.env.example` values work out of the box for local development.

### 4. Run Database Migrations

```bash
# Order Service migrations
cd services/order-service
npm run migrate

# Payment Service migrations
cd ../payment-service
npm run migrate

# Inventory Service migrations
cd ../inventory-service
npm run migrate

# Seed inventory data
npm run seed

# Return to root
cd ../..
```

**Expected Output:**
```
Starting migrations...
Applying migration: create_orders_table
Applying migration: create_order_events_table
...
All migrations completed
```

### 5. Build Services

```bash
# Build all services
npm run build

# Or build individually
cd services/order-service && npm run build
cd services/payment-service && npm run build
cd services/inventory-service && npm run build
```

### 6. Start Services

#### Option A: Development Mode (Watch Mode)

```bash
# Terminal 1: Order Service
cd services/order-service
npm run dev

# Terminal 2: Payment Service
cd services/payment-service
npm run dev

# Terminal 3: Inventory Service
cd services/inventory-service
npm run dev
```

#### Option B: Production Mode

```bash
# Terminal 1
cd services/order-service && npm start

# Terminal 2
cd services/payment-service && npm start

# Terminal 3
cd services/inventory-service && npm start
```

#### Option C: All Services (Background)

```bash
# From root (not recommended for debugging)
npm run services:dev
```

### 7. Verify Services are Running

```bash
# Check health endpoints
curl http://localhost:3001/health  # Order Service
curl http://localhost:3002/health  # Payment Service
curl http://localhost:3003/health  # Inventory Service
```

**Expected Response:**
```json
{
  "status": "healthy",
  "service": "order-service",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Running the Demo

```bash
# Run the demo script
npm run demo
```

The demo script will:
1. Create a new order
2. Approve the order
3. Wait for payment authorization
4. Wait for inventory reservation
5. Transition order to FULFILLING
6. Ship the order
7. Complete the order

## Development Workflow

### Making Changes

1. **Edit code** in any service
2. **Watch mode** automatically recompiles (if using `npm run dev`)
3. **Check logs** in the service terminal
4. **Test changes** via API calls or demo script

### Database Changes

1. **Add migration** to `src/db/migrations.ts`
2. **Increment version** number
3. **Run migration**: `npm run migrate`
4. **Verify** in database:
   ```bash
   docker exec -it orderflow-postgres psql -U orderflow -d orderdb
   \dt  # List tables
   \d orders  # Describe orders table
   ```

### Kafka Inspection

#### Using Kafka UI (Recommended)
- Open http://localhost:8080
- View topics, messages, consumer groups

#### Using CLI
```bash
# List topics
docker exec orderflow-kafka kafka-topics --list --bootstrap-server localhost:9092

# Consume messages from topic
docker exec orderflow-kafka kafka-console-consumer \
  --bootstrap-server localhost:9092 \
  --topic order.events \
  --from-beginning

# Describe consumer group
docker exec orderflow-kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe \
  --group order-service-group
```

## Testing the System

### Manual API Testing

#### 1. Create an Order

```bash
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "customer-123",
    "items": [
      { "sku": "WIDGET-001", "quantity": 2, "price": 29.99 },
      { "sku": "GADGET-001", "quantity": 1, "price": 49.99 }
    ]
  }'
```

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "customerId": "customer-123",
  "state": "DRAFT",
  "total": 109.97,
  "items": [...],
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

#### 2. Approve the Order

```bash
ORDER_ID="550e8400-e29b-41d4-a716-446655440000"

curl -X POST http://localhost:3001/orders/$ORDER_ID/approve
```

**Response:**
```json
{
  "message": "Order approved",
  "orderId": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### 3. Check Order Status

```bash
curl http://localhost:3001/orders/$ORDER_ID
```

**Response** (after payment + inventory):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "customerId": "customer-123",
  "state": "FULFILLING",
  "total": 109.97,
  "version": 3,
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:05.000Z"
}
```

#### 4. Ship the Order

```bash
curl -X POST http://localhost:3001/orders/$ORDER_ID/ship
```

#### 5. Complete the Order

```bash
curl -X POST http://localhost:3001/orders/$ORDER_ID/complete
```

#### 6. Get Customer Orders

```bash
curl "http://localhost:3001/orders?customerId=customer-123"
```

### Testing Payment Idempotency

```bash
# Make the same payment request twice with same idempotency key
curl -X POST http://localhost:3002/payments/authorize \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-key-123" \
  -d '{
    "orderId": "550e8400-e29b-41d4-a716-446655440000",
    "amount": 109.97
  }'

# Second call returns cached result (same payment ID)
curl -X POST http://localhost:3002/payments/authorize \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-key-123" \
  -d '{
    "orderId": "550e8400-e29b-41d4-a716-446655440000",
    "amount": 109.97
  }'
```

### Testing Inventory

```bash
# Check inventory levels
curl http://localhost:3003/inventory/WIDGET-001

# Response
{
  "sku": "WIDGET-001",
  "quantity": 100,
  "reservedQuantity": 2,
  "availableQuantity": 98
}
```

## Debugging

### Service Logs

Each service outputs structured JSON logs (or pretty-printed in dev mode):

```bash
# Order Service logs
cd services/order-service
npm run dev  # Watch logs in terminal
```

**Log Format:**
```json
{
  "level": "info",
  "time": "2024-01-15T10:30:00.000Z",
  "service": "order-service",
  "orderId": "550e8400-e29b-41d4-a716-446655440000",
  "correlationId": "660e8400-e29b-41d4-a716-446655440000",
  "msg": "Order approved"
}
```

### Database Inspection

```bash
# Connect to PostgreSQL
docker exec -it orderflow-postgres psql -U orderflow

# Switch database
\c orderdb

# View orders
SELECT id, state, customer_id, total, created_at FROM orders;

# View order events (audit log)
SELECT order_id, event_type, created_at FROM order_events ORDER BY created_at DESC LIMIT 10;

# View outbox (pending events)
SELECT id, topic, status, created_at FROM outbox WHERE status = 'PENDING';

# View processed messages (idempotency)
SELECT message_id, processed_at FROM processed_messages ORDER BY processed_at DESC LIMIT 10;

# Check state tracking
SELECT * FROM order_state_tracking;
```

### Kafka Debugging

```bash
# View consumer lag
docker exec orderflow-kafka kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --describe \
  --group order-service-group-payment

# Expected output shows LAG column (should be 0 or low)
```

### Common Issues

#### 1. Services Won't Start

**Symptom:** `ECONNREFUSED` errors
**Solution:**
```bash
# Ensure Docker services are running
docker ps

# Restart if needed
npm run docker:down
npm run docker:up

# Wait 10-20 seconds for Kafka to be ready
```

#### 2. Database Connection Errors

**Symptom:** `Connection terminated unexpectedly`
**Solution:**
```bash
# Check PostgreSQL is running
docker logs orderflow-postgres

# Verify connection
docker exec -it orderflow-postgres psql -U orderflow -d orderdb -c "SELECT 1"
```

#### 3. Kafka Consumer Lag

**Symptom:** Events not processing
**Solution:**
```bash
# Check consumer is running
curl http://localhost:3001/health

# Check Kafka logs
docker logs orderflow-kafka

# Restart service
cd services/order-service
npm run dev
```

#### 4. Orders Stuck in APPROVED

**Symptom:** Order doesn't transition to FULFILLING
**Solution:**
```bash
# Check payment and inventory services are running
curl http://localhost:3002/health
curl http://localhost:3003/health

# Check state tracking
docker exec -it orderflow-postgres psql -U orderflow -d orderdb \
  -c "SELECT * FROM order_state_tracking WHERE order_id = 'YOUR_ORDER_ID'"

# Check logs for errors
cd services/payment-service && npm run dev
cd services/inventory-service && npm run dev
```

## Cleanup

### Stop Services

```bash
# Stop all Docker containers
npm run docker:down

# Remove volumes (deletes all data)
docker-compose -f docker/docker-compose.yml down -v
```

### Reset Everything

```bash
# Stop services
npm run docker:down

# Remove node_modules
rm -rf node_modules services/*/node_modules packages/*/node_modules

# Remove build artifacts
rm -rf services/*/dist packages/*/dist

# Reinstall
npm install
npm run build
```

## Running Tests

```bash
# Run all tests
npm test

# Run tests for specific service
cd services/order-service
npm test

# Run integration tests (requires Docker)
npm run test:integration
```

## Code Quality

```bash
# Lint all code
npm run lint

# Format code (if configured)
npm run format
```

## Environment Variables Reference

### Order Service

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | HTTP server port |
| `DATABASE_URL` | `postgresql://...` | PostgreSQL connection string |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka broker addresses (comma-separated) |
| `KAFKA_CLIENT_ID` | `order-service` | Kafka client identifier |
| `KAFKA_GROUP_ID` | `order-service-group` | Kafka consumer group |
| `JWT_SECRET` | `your-secret-key...` | JWT signing secret |
| `NODE_ENV` | `development` | Environment (development/production) |
| `LOG_LEVEL` | `info` | Logging level (debug/info/warn/error) |

### Payment Service

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3002 | HTTP server port |
| `DATABASE_URL` | `postgresql://...` | PostgreSQL connection string |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka broker addresses |
| `KAFKA_CLIENT_ID` | `payment-service` | Kafka client identifier |
| `KAFKA_GROUP_ID` | `payment-service-group` | Kafka consumer group |
| `NODE_ENV` | `development` | Environment |
| `LOG_LEVEL` | `info` | Logging level |

### Inventory Service

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3003 | HTTP server port |
| `DATABASE_URL` | `postgresql://...` | PostgreSQL connection string |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka broker addresses |
| `KAFKA_CLIENT_ID` | `inventory-service` | Kafka client identifier |
| `KAFKA_GROUP_ID` | `inventory-service-group` | Kafka consumer group |
| `NODE_ENV` | `development` | Environment |
| `LOG_LEVEL` | `info` | Logging level |

## Next Steps

- Read [ARCHITECTURE.md](./ARCHITECTURE.md) for system design details
- Read [RUNBOOK.md](./RUNBOOK.md) for operations and troubleshooting
- Run the demo script: `npm run demo`
- Try creating orders via API
- Explore Kafka UI at http://localhost:8080
