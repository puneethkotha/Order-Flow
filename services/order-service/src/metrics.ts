import client from 'prom-client';

/**
 * Real Prometheus metrics for order-service, replacing the previous
 * placeholder /metrics string. Default process metrics plus an HTTP request
 * counter and a handful of saga-domain counters.
 */
export const register = new client.Registry();
register.setDefaultLabels({ service: 'order-service' });
client.collectDefaultMetrics({ register });

export const httpRequests = new client.Counter({
  name: 'orderflow_http_requests_total',
  help: 'Total HTTP requests handled',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});

export const ordersCreated = new client.Counter({
  name: 'orderflow_orders_created_total',
  help: 'Orders created',
  registers: [register],
});

export const ordersFulfilling = new client.Counter({
  name: 'orderflow_orders_fulfilling_total',
  help: 'Orders that transitioned to FULFILLING',
  registers: [register],
});

export const ordersCancelled = new client.Counter({
  name: 'orderflow_orders_cancelled_total',
  help: 'Orders cancelled',
  labelNames: ['reason_code'] as const,
  registers: [register],
});
