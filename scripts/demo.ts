import axios from 'axios';

const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:3001';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function demo() {
  console.log('OrderFlow demo');
  console.log('='.repeat(50));

  try {
    console.log('\nStep 1: creating order');
    const createResponse = await axios.post(`${ORDER_SERVICE_URL}/orders`, {
      customerId: 'demo-customer-001',
      items: [
        { sku: 'WIDGET-001', quantity: 2, price: 29.99 },
        { sku: 'GADGET-001', quantity: 1, price: 49.99 },
      ],
    });

    const orderId = createResponse.data.id;
    console.log(`  order created: ${orderId}`);
    console.log(`  state: ${createResponse.data.state}`);
    console.log(`  total: ${createResponse.data.total}`);

    console.log('\nStep 2: approving order');
    await axios.post(`${ORDER_SERVICE_URL}/orders/${orderId}/approve`);
    console.log('  ORDER_APPROVED published; payment authorizes and inventory reserves');

    console.log('\nStep 3: waiting for payment authorization and inventory reservation');
    let order = null;
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      await sleep(1000);
      attempts++;

      const response = await axios.get(`${ORDER_SERVICE_URL}/orders/${orderId}`);
      order = response.data;
      console.log(`  [${attempts}s] state: ${order.state}`);

      if (order.state === 'FULFILLING') {
        console.log('  order reached FULFILLING (payment authorized, inventory reserved, capture requested)');
        break;
      }
      if (order.state === 'CANCELLED') {
        console.log('  order cancelled (payment or inventory failed); compensation ran');
        return;
      }
      if (attempts === maxAttempts) {
        console.log(`  timeout; current state: ${order.state}`);
        return;
      }
    }

    console.log('\nStep 4: shipping order');
    await axios.post(`${ORDER_SERVICE_URL}/orders/${orderId}/ship`);
    const shippedResponse = await axios.get(`${ORDER_SERVICE_URL}/orders/${orderId}`);
    console.log(`  state: ${shippedResponse.data.state}`);

    console.log('\nStep 5: completing order');
    await axios.post(`${ORDER_SERVICE_URL}/orders/${orderId}/complete`);
    const completedResponse = await axios.get(`${ORDER_SERVICE_URL}/orders/${orderId}`);
    console.log(`  state: ${completedResponse.data.state}`);
    console.log(`  version: ${completedResponse.data.version}`);

    console.log('\n' + '='.repeat(50));
    console.log('Demo completed. Journey: DRAFT -> APPROVED -> FULFILLING -> SHIPPED -> COMPLETED');
    console.log(`  view order:  curl ${ORDER_SERVICE_URL}/orders/${orderId}`);
    console.log('  Kafka UI:    http://localhost:8080');
  } catch (error: any) {
    console.error('\nDemo failed:');
    if (error.response) {
      console.error(`  status: ${error.response.status}`);
      console.error(`  error: ${JSON.stringify(error.response.data, null, 2)}`);
    } else if (error.request) {
      console.error('  no response received; make sure the services are running:');
      console.error('  - npm run docker:up');
      console.error('  - npm run services:dev');
    } else {
      console.error(`  ${error.message}`);
    }
    process.exit(1);
  }
}

demo();
