import { OrderAggregate } from '../domain/OrderAggregate';
import { OrderState } from '@orderflow/shared';

describe('OrderAggregate', () => {
  const sampleItems = [
    { sku: 'WIDGET-001', quantity: 2, price: 29.99 },
    { sku: 'GADGET-001', quantity: 1, price: 49.99 },
  ];

  describe('create', () => {
    it('should create a new order in DRAFT state', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);

      expect(order.state).toBe(OrderState.DRAFT);
      expect(order.customerId).toBe('customer-123');
      expect(order.items).toEqual(sampleItems);
      expect(order.total).toBe(109.97);
      expect(order.version).toBe(1);
    });

    it('should calculate total correctly', () => {
      const items = [
        { sku: 'A', quantity: 3, price: 10.0 },
        { sku: 'B', quantity: 2, price: 25.5 },
      ];
      const order = OrderAggregate.create('customer-123', items);

      expect(order.total).toBe(81.0); // (3 * 10) + (2 * 25.5)
    });
  });

  describe('approve', () => {
    it('should transition from DRAFT to APPROVED', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);
      order.approve();

      expect(order.state).toBe(OrderState.APPROVED);
      expect(order.version).toBe(2);
    });

    it('should throw error if not in DRAFT state', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);
      order.approve();

      expect(() => order.approve()).toThrow('Cannot approve order in state APPROVED');
    });
  });

  describe('startFulfilling', () => {
    it('should transition from APPROVED to FULFILLING', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);
      order.approve();
      order.startFulfilling();

      expect(order.state).toBe(OrderState.FULFILLING);
      expect(order.version).toBe(3);
    });

    it('should throw error if not in APPROVED state', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);

      expect(() => order.startFulfilling()).toThrow('Cannot start fulfilling order in state DRAFT');
    });
  });

  describe('ship', () => {
    it('should transition from FULFILLING to SHIPPED', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);
      order.approve();
      order.startFulfilling();
      order.ship();

      expect(order.state).toBe(OrderState.SHIPPED);
      expect(order.version).toBe(4);
    });

    it('should throw error if not in FULFILLING state', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);
      order.approve();

      expect(() => order.ship()).toThrow('Cannot ship order in state APPROVED');
    });
  });

  describe('complete', () => {
    it('should transition from SHIPPED to COMPLETED', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);
      order.approve();
      order.startFulfilling();
      order.ship();
      order.complete();

      expect(order.state).toBe(OrderState.COMPLETED);
      expect(order.version).toBe(5);
    });

    it('should throw error if not in SHIPPED state', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);
      order.approve();
      order.startFulfilling();

      expect(() => order.complete()).toThrow('Cannot complete order in state FULFILLING');
    });
  });

  describe('cancel', () => {
    it('should transition to CANCELLED from any state except COMPLETED', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);
      order.cancel('Test cancellation');

      expect(order.state).toBe(OrderState.CANCELLED);
      expect(order.version).toBe(2);
    });

    it('should throw error if trying to cancel completed order', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);
      order.approve();
      order.startFulfilling();
      order.ship();
      order.complete();

      expect(() => order.cancel('Test')).toThrow('Cannot cancel completed order');
    });
  });

  describe('canTransitionToFulfilling', () => {
    it('should return true when both payment and inventory are ready', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);
      order.approve();

      expect(order.canTransitionToFulfilling(true, true)).toBe(true);
    });

    it('should return false when payment is not authorized', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);
      order.approve();

      expect(order.canTransitionToFulfilling(false, true)).toBe(false);
    });

    it('should return false when inventory is not reserved', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);
      order.approve();

      expect(order.canTransitionToFulfilling(true, false)).toBe(false);
    });

    it('should return false when not in APPROVED state', () => {
      const order = OrderAggregate.create('customer-123', sampleItems);

      expect(order.canTransitionToFulfilling(true, true)).toBe(false);
    });
  });
});
