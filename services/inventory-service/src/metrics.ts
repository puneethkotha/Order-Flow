import client from 'prom-client';

/** Real Prometheus metrics for inventory-service. */
export const register = new client.Registry();
register.setDefaultLabels({ service: 'inventory-service' });
client.collectDefaultMetrics({ register });

export const httpRequests = new client.Counter({
  name: 'orderflow_http_requests_total',
  help: 'Total HTTP requests handled',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});

export const inventoryReserved = new client.Counter({
  name: 'orderflow_inventory_reserved_total',
  help: 'Inventory reservations granted',
  registers: [register],
});

export const inventoryReleased = new client.Counter({
  name: 'orderflow_inventory_released_total',
  help: 'Inventory reservations released (compensation)',
  registers: [register],
});
