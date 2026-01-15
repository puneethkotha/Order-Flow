import axios from 'axios';

const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:3001';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function demo() {
  console.log('🚀 OrderFlow Demo Script\n');
  console.log('='.repeat(50));

  try {
    // Step 1: Create order
    console.log('\n📦 Step 1: Creating order...');
    const createResponse = await axios.post(`${ORDER_SERVICE_URL}/orders`, {
      customerId: 'demo-customer-001',
      items: [
        { sku: 'WIDGET-001', quantity: 2, price: 29.99 },
        { sku: 'GADGET-001', quantity: 1, price: 49.99 },
      ],
    });

    const orderId = createResponse.data.id;
    console.log(`✅ Order created: ${orderId}`);
    console.log(`   State: ${createResponse.data.state}`);
    console.log(`   Total: $${createResponse.data.total}`);

    // Step 2: Approve order
    console.log('\n✅ Step 2: Approving order...');
    await axios.post(`${ORDER_SERVICE_URL}/orders/${orderId}/approve`);
    console.log(`✅ Order approved: ${orderId}`);
    console.log('   → ORDER_APPROVED event published to Kafka');
    console.log('   → Payment Service will authorize payment');
    console.log('   → Inventory Service will reserve inventory');

    // Step 3: Wait for payment and inventory
    console.log('\n⏳ Step 3: Waiting for payment authorization and inventory reservation...');
    let order = null;
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      await sleep(1000);
      attempts++;

      const response = await axios.get(`${ORDER_SERVICE_URL}/orders/${orderId}`);
      order = response.data;

      console.log(`   [${attempts}s] Order state: ${order.state}`);

      if (order.state === 'FULFILLING') {
        console.log('✅ Order transitioned to FULFILLING!');
        console.log('   ✓ Payment authorized');
        console.log('   ✓ Inventory reserved');
        break;
      }

      if (order.state === 'CANCELLED') {
        console.log('❌ Order was cancelled');
        console.log(`   Reason: Payment or inventory failed`);
        return;
      }

      if (attempts === maxAttempts) {
        console.log('⚠️  Timeout waiting for order to progress');
        console.log(`   Current state: ${order.state}`);
        console.log('   Check service logs for errors');
        return;
      }
    }

    // Step 4: Ship order
    console.log('\n📦 Step 4: Shipping order...');
    await axios.post(`${ORDER_SERVICE_URL}/orders/${orderId}/ship`);
    const shippedResponse = await axios.get(`${ORDER_SERVICE_URL}/orders/${orderId}`);
    console.log(`✅ Order shipped: ${orderId}`);
    console.log(`   State: ${shippedResponse.data.state}`);

    // Step 5: Complete order
    console.log('\n🎉 Step 5: Completing order...');
    await axios.post(`${ORDER_SERVICE_URL}/orders/${orderId}/complete`);
    const completedResponse = await axios.get(`${ORDER_SERVICE_URL}/orders/${orderId}`);
    console.log(`✅ Order completed: ${orderId}`);
    console.log(`   State: ${completedResponse.data.state}`);
    console.log(`   Version: ${completedResponse.data.version}`);

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('🎊 Demo completed successfully!');
    console.log('\n📊 Order Journey:');
    console.log('   DRAFT → APPROVED → FULFILLING → SHIPPED → COMPLETED');
    console.log('\n🔍 Key Features Demonstrated:');
    console.log('   ✓ Event-driven architecture (Kafka)');
    console.log('   ✓ Transactional outbox pattern');
    console.log('   ✓ Idempotent consumers');
    console.log('   ✓ Out-of-order event handling');
    console.log('   ✓ Order state machine');
    console.log('   ✓ Service orchestration');
    console.log('\n💡 Try exploring:');
    console.log(`   - View order: curl ${ORDER_SERVICE_URL}/orders/${orderId}`);
    console.log(`   - Kafka UI: http://localhost:8080`);
    console.log(`   - Database: docker exec -it orderflow-postgres psql -U orderflow -d orderdb`);

    console.log('\n' + '='.repeat(50) + '\n');
  } catch (error: any) {
    console.error('\n❌ Demo failed:');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Error: ${JSON.stringify(error.response.data, null, 2)}`);
    } else if (error.request) {
      console.error('   No response received from server');
      console.error('   Make sure services are running:');
      console.error('   - npm run docker:up');
      console.error('   - cd services/order-service && npm run dev');
      console.error('   - cd services/payment-service && npm run dev');
      console.error('   - cd services/inventory-service && npm run dev');
    } else {
      console.error(`   ${error.message}`);
    }
    process.exit(1);
  }
}

demo();
