# OrderFlow

Production-grade event-driven microservices system for distributed order processing.

## Architecture

Event-driven architecture with three microservices:
- **Order Service**: Manages order lifecycle and state machine
- **Payment Service**: Handles payment authorization with idempotency
- **Inventory Service**: Manages inventory reservations

Communication via Kafka with transactional outbox pattern, idempotent consumers, and DLQ handling.

## Order State Machine

```
DRAFT → APPROVED → FULFILLING → SHIPPED → COMPLETED
           ↓
      CANCELLED
```

## Quick Start

```bash
# Install dependencies
npm install

# Start infrastructure (Postgres + Kafka)
npm run docker:up

# Run migrations
cd services/order-service && npm run migrate
cd ../payment-service && npm run migrate
cd ../inventory-service && npm run migrate && npm run seed

# Start services
npm run services:dev

# Run demo
npm run demo
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - System design, event flows, consistency patterns
- [Local Development](docs/LOCAL_DEV.md) - Setup and development guide
- [Runbook](docs/RUNBOOK.md) - Operations, debugging, troubleshooting

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Node.js 18+
- **API Framework**: Fastify
- **Message Broker**: Kafka (kafkajs)
- **Database**: PostgreSQL
- **Auth**: JWT
- **Logging**: Pino
- **Metrics**: Prometheus (prom-client)
- **Testing**: Jest + Testcontainers
- **CI**: GitHub Actions

## Project Structure

```
orderflow/
├── services/
│   ├── order-service/
│   ├── payment-service/
│   └── inventory-service/
├── packages/
│   └── shared/           # Event schemas and contracts
├── docker/               # Docker Compose and DB migrations
├── docs/                 # Architecture and runbooks
├── scripts/              # Demo and utility scripts
└── .github/workflows/    # CI/CD
```

## Production Features

✅ Transactional Outbox Pattern  
✅ Idempotent Consumers  
✅ Out-of-order Event Handling  
✅ Dead Letter Queue (DLQ)  
✅ Retry with Exponential Backoff  
✅ Structured Logging with Correlation IDs  
✅ Prometheus Metrics  
✅ Health Checks  
✅ Database Migrations  
✅ Event Sourcing (Audit Log)  
✅ Integration Tests with Testcontainers  
✅ CI/CD Pipeline  

## License

MIT
