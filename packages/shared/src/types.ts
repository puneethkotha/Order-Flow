export enum OrderState {
  DRAFT = 'DRAFT',
  APPROVED = 'APPROVED',
  FULFILLING = 'FULFILLING',
  SHIPPED = 'SHIPPED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  AUTHORIZED = 'AUTHORIZED',
  FAILED = 'FAILED',
}

export enum InventoryReservationStatus {
  PENDING = 'PENDING',
  RESERVED = 'RESERVED',
  FAILED = 'FAILED',
  RELEASED = 'RELEASED',
}

export interface Order {
  id: string;
  customerId: string;
  state: OrderState;
  total: number;
  items: OrderItem[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderItem {
  sku: string;
  quantity: number;
  price: number;
}

export interface Payment {
  id: string;
  orderId: string;
  amount: number;
  status: PaymentStatus;
  idempotencyKey: string;
  createdAt: Date;
}

export interface InventoryReservation {
  id: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: InventoryReservationStatus;
  createdAt: Date;
}
