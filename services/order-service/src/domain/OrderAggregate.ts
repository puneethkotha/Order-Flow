import { OrderState, OrderItem } from '@orderflow/shared';
import { v4 as uuidv4 } from 'uuid';

export class OrderAggregate {
  constructor(
    public readonly id: string,
    public readonly customerId: string,
    public state: OrderState,
    public readonly items: OrderItem[],
    public readonly total: number,
    public version: number = 1,
    public readonly createdAt: Date = new Date(),
    public updatedAt: Date = new Date()
  ) {}

  static create(customerId: string, items: OrderItem[]): OrderAggregate {
    const id = uuidv4();
    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    return new OrderAggregate(id, customerId, OrderState.DRAFT, items, total);
  }

  approve(): void {
    if (this.state !== OrderState.DRAFT) {
      throw new Error(`Cannot approve order in state ${this.state}`);
    }
    this.state = OrderState.APPROVED;
    this.version++;
    this.updatedAt = new Date();
  }

  startFulfilling(): void {
    if (this.state !== OrderState.APPROVED) {
      throw new Error(`Cannot start fulfilling order in state ${this.state}`);
    }
    this.state = OrderState.FULFILLING;
    this.version++;
    this.updatedAt = new Date();
  }

  ship(): void {
    if (this.state !== OrderState.FULFILLING) {
      throw new Error(`Cannot ship order in state ${this.state}`);
    }
    this.state = OrderState.SHIPPED;
    this.version++;
    this.updatedAt = new Date();
  }

  complete(): void {
    if (this.state !== OrderState.SHIPPED) {
      throw new Error(`Cannot complete order in state ${this.state}`);
    }
    this.state = OrderState.COMPLETED;
    this.version++;
    this.updatedAt = new Date();
  }

  cancel(reason: string): void {
    if (this.state === OrderState.COMPLETED) {
      throw new Error('Cannot cancel completed order');
    }
    this.state = OrderState.CANCELLED;
    this.version++;
    this.updatedAt = new Date();
  }

  canTransitionToFulfilling(paymentAuthorized: boolean, inventoryReserved: boolean): boolean {
    return this.state === OrderState.APPROVED && paymentAuthorized && inventoryReserved;
  }
}
