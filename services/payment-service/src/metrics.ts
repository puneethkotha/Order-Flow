import client from 'prom-client';

/** Real Prometheus metrics for payment-service. */
export const register = new client.Registry();
register.setDefaultLabels({ service: 'payment-service' });
client.collectDefaultMetrics({ register });

export const httpRequests = new client.Counter({
  name: 'orderflow_http_requests_total',
  help: 'Total HTTP requests handled',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [register],
});

export const paymentsAuthorized = new client.Counter({
  name: 'orderflow_payments_authorized_total',
  help: 'Payments authorized',
  registers: [register],
});

export const paymentsCaptured = new client.Counter({
  name: 'orderflow_payments_captured_total',
  help: 'Payments captured',
  registers: [register],
});

export const paymentsCompensated = new client.Counter({
  name: 'orderflow_payments_compensated_total',
  help: 'Authorizations voided or refunded',
  labelNames: ['kind'] as const,
  registers: [register],
});
