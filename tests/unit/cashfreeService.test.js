const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const cashfreeService = require('../../src/services/cashfreeService');

describe('Cashfree Service Unit Tests (Mocked Gateway)', () => {
  const originalFetch = global.fetch;
  const mockSecret = 'test_secret_key_mock_1234567890';
  const mockAppId = 'test_app_id_mock_12345';

  beforeEach(() => {
    process.env.CASHFREE_APP_ID = mockAppId;
    process.env.CASHFREE_SECRET_KEY = mockSecret;
    process.env.CASHFREE_API_VERSION = '2023-08-01';
    process.env.CASHFREE_ENV = 'SANDBOX';
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should successfully build request and parse Cashfree createOrder response', async () => {
    let captured = null;
    global.fetch = async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          cf_order_id: '987654321',
          order_id: captured.body.order_id,
          payment_session_id: 'session_mock_success_token',
          order_status: 'ACTIVE',
        }),
      };
    };

    const result = await cashfreeService.createOrder({
      orderId: 'order_test_101',
      amount: 1500,
      customerId: 'cust_01',
      customerName: 'Test Student',
      customerEmail: 'test@student.edu',
      customerPhone: '9876543210',
    });

    assert.strictEqual(captured.url, 'https://sandbox.cashfree.com/pg/orders');
    assert.strictEqual(captured.options.headers['x-client-id'], mockAppId);
    assert.strictEqual(captured.options.headers['x-api-version'], '2023-08-01');
    assert.strictEqual(captured.body.order_id, 'order_test_101');
    assert.strictEqual(captured.body.order_amount, 1500);
    assert.strictEqual(captured.body.order_currency, 'INR');
    assert.strictEqual(result.cf_order_id, '987654321');
    assert.strictEqual(result.payment_session_id, 'session_mock_success_token');
  });

  it('should handle gateway failure in createOrder without leaking secrets', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({
        message: 'Order already exists with this order_id',
        code: 'order_already_exists',
        type: 'invalid_request_error',
      }),
    });

    await assert.rejects(
      async () => {
        await cashfreeService.createOrder({
          orderId: 'order_test_dup',
          amount: 500,
          customerId: 'cust_01',
          customerName: 'Test',
          customerEmail: 'test@student.edu',
          customerPhone: '9876543210',
        });
      },
      (err) => {
        assert.strictEqual(err.status, 502);
        assert.strictEqual(err.code, 'order_already_exists');
        assert.ok(err.message.includes('Order already exists'));
        assert.ok(!err.message.includes(mockSecret));
        return true;
      }
    );
  });

  it('should fetch order details via getOrder', async () => {
    let requestedUrl = null;
    global.fetch = async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          order_id: 'order_test_101',
          order_status: 'PAID',
          order_amount: 1500,
        }),
      };
    };

    const order = await cashfreeService.getOrder('order_test_101');
    assert.strictEqual(requestedUrl, 'https://sandbox.cashfree.com/pg/orders/order_test_101');
    assert.strictEqual(order.order_status, 'PAID');
  });

  it('should correctly verify valid webhook HMAC-SHA256 signature', () => {
    const timestamp = String(Date.now());
    const rawBody = JSON.stringify({
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: { order: { order_id: 'order_123', order_amount: 500 } },
    });

    const signature = crypto
      .createHmac('sha256', mockSecret)
      .update(timestamp + rawBody)
      .digest('base64');

    const isValid = cashfreeService.verifyWebhookSignature({
      rawBody,
      signature,
      timestamp,
    });

    assert.strictEqual(isValid, true, 'Valid signature must be accepted');
  });

  it('should reject tampered or invalid webhook signatures', () => {
    const timestamp = String(Date.now());
    const rawBody = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK' });
    const wrongSignature = 'invalid_base64_signature_here=';

    const isValid = cashfreeService.verifyWebhookSignature({
      rawBody,
      signature: wrongSignature,
      timestamp,
    });

    assert.strictEqual(isValid, false, 'Tampered signature must be rejected');
  });

  it('should reject webhook verification when parameters are missing', () => {
    assert.strictEqual(cashfreeService.verifyWebhookSignature({ rawBody: '', signature: 'abc', timestamp: '123' }), false);
    assert.strictEqual(cashfreeService.verifyWebhookSignature({ rawBody: '{}', signature: '', timestamp: '123' }), false);
    assert.strictEqual(cashfreeService.verifyWebhookSignature({ rawBody: '{}', signature: 'abc', timestamp: '' }), false);
  });
});

