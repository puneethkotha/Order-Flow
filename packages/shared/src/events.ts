import { z } from 'zod';

// Base event schema
export const BaseEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.string(),
  aggregateId: z.string(),
  timestamp: z.string().datetime(),
  correlationId: z.string().uuid(),
  version: z.number().int().positive(),
});

export type BaseEvent = z.infer<typeof BaseEventSchema>;

// Order Events
export const OrderCreatedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('ORDER_CREATED'),
  payload: z.object({
    orderId: z.string(),
    customerId: z.string(),
    items: z.array(
      z.object({
        sku: z.string(),
        quantity: z.number().int().positive(),
        price: z.number().positive(),
      })
    ),
    total: z.number().positive(),
  }),
});

export type OrderCreatedEvent = z.infer<typeof OrderCreatedEventSchema>;

export const OrderApprovedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('ORDER_APPROVED'),
  payload: z.object({
    orderId: z.string(),
    customerId: z.string(),
    total: z.number().positive(),
    items: z.array(
      z.object({
        sku: z.string(),
        quantity: z.number().int().positive(),
        price: z.number().positive(),
      })
    ),
  }),
});

export type OrderApprovedEvent = z.infer<typeof OrderApprovedEventSchema>;

export const OrderStateChangedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('ORDER_STATE_CHANGED'),
  payload: z.object({
    orderId: z.string(),
    previousState: z.string(),
    newState: z.string(),
    reason: z.string().optional(),
  }),
});

export type OrderStateChangedEvent = z.infer<typeof OrderStateChangedEventSchema>;

export const OrderCancelledEventSchema = BaseEventSchema.extend({
  eventType: z.literal('ORDER_CANCELLED'),
  payload: z.object({
    orderId: z.string(),
    reason: z.string(),
    reasonCode: z.string(),
  }),
});

export type OrderCancelledEvent = z.infer<typeof OrderCancelledEventSchema>;

// Capture command (coordinator -> payment), reachable only from FULFILLING.
export const CaptureRequestedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('CAPTURE_REQUESTED'),
  payload: z.object({
    orderId: z.string(),
    amount: z.number().positive(),
  }),
});

export type CaptureRequestedEvent = z.infer<typeof CaptureRequestedEventSchema>;

// Payment Events
export const PaymentAuthorizedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('PAYMENT_AUTHORIZED'),
  payload: z.object({
    paymentId: z.string(),
    orderId: z.string(),
    amount: z.number().positive(),
  }),
});

export type PaymentAuthorizedEvent = z.infer<typeof PaymentAuthorizedEventSchema>;

export const PaymentFailedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('PAYMENT_FAILED'),
  payload: z.object({
    paymentId: z.string(),
    orderId: z.string(),
    amount: z.number().positive(),
    reason: z.string(),
  }),
});

export type PaymentFailedEvent = z.infer<typeof PaymentFailedEventSchema>;

export const PaymentCapturedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('PAYMENT_CAPTURED'),
  payload: z.object({
    paymentId: z.string(),
    orderId: z.string(),
    amount: z.number().positive(),
  }),
});

export type PaymentCapturedEvent = z.infer<typeof PaymentCapturedEventSchema>;

// Compensation acknowledgements (payment -> coordinator).
export const PaymentVoidedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('PAYMENT_VOIDED'),
  payload: z.object({
    paymentId: z.string(),
    orderId: z.string(),
    amount: z.number().positive(),
  }),
});

export type PaymentVoidedEvent = z.infer<typeof PaymentVoidedEventSchema>;

export const PaymentRefundedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('PAYMENT_REFUNDED'),
  payload: z.object({
    paymentId: z.string(),
    orderId: z.string(),
    amount: z.number().positive(),
  }),
});

export type PaymentRefundedEvent = z.infer<typeof PaymentRefundedEventSchema>;

// Inventory Events
export const InventoryReservedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('INVENTORY_RESERVED'),
  payload: z.object({
    reservationId: z.string(),
    orderId: z.string(),
    items: z.array(
      z.object({
        sku: z.string(),
        quantity: z.number().int().positive(),
      })
    ),
  }),
});

export type InventoryReservedEvent = z.infer<typeof InventoryReservedEventSchema>;

export const InventoryFailedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('INVENTORY_FAILED'),
  payload: z.object({
    orderId: z.string(),
    reason: z.string(),
    failedItems: z.array(
      z.object({
        sku: z.string(),
        requestedQuantity: z.number().int().positive(),
        availableQuantity: z.number().int().nonnegative(),
      })
    ),
  }),
});

export type InventoryFailedEvent = z.infer<typeof InventoryFailedEventSchema>;

// Compensation acknowledgement (inventory -> coordinator).
export const InventoryReleasedEventSchema = BaseEventSchema.extend({
  eventType: z.literal('INVENTORY_RELEASED'),
  payload: z.object({
    orderId: z.string(),
    items: z.array(
      z.object({
        sku: z.string(),
        quantity: z.number().int().positive(),
      })
    ),
  }),
});

export type InventoryReleasedEvent = z.infer<typeof InventoryReleasedEventSchema>;

// Union type for all events
export type DomainEvent =
  | OrderCreatedEvent
  | OrderApprovedEvent
  | OrderStateChangedEvent
  | OrderCancelledEvent
  | CaptureRequestedEvent
  | PaymentAuthorizedEvent
  | PaymentFailedEvent
  | PaymentCapturedEvent
  | PaymentVoidedEvent
  | PaymentRefundedEvent
  | InventoryReservedEvent
  | InventoryFailedEvent
  | InventoryReleasedEvent;

// Event type constants
export const EventTypes = {
  ORDER_CREATED: 'ORDER_CREATED',
  ORDER_APPROVED: 'ORDER_APPROVED',
  ORDER_STATE_CHANGED: 'ORDER_STATE_CHANGED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  CAPTURE_REQUESTED: 'CAPTURE_REQUESTED',
  PAYMENT_AUTHORIZED: 'PAYMENT_AUTHORIZED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_CAPTURED: 'PAYMENT_CAPTURED',
  PAYMENT_VOIDED: 'PAYMENT_VOIDED',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
  INVENTORY_RESERVED: 'INVENTORY_RESERVED',
  INVENTORY_FAILED: 'INVENTORY_FAILED',
  INVENTORY_RELEASED: 'INVENTORY_RELEASED',
} as const;

// Kafka Topics
export const Topics = {
  ORDER_EVENTS: 'order.events',
  PAYMENT_EVENTS: 'payment.events',
  INVENTORY_EVENTS: 'inventory.events',
  DLQ: 'order.dlq',
} as const;
