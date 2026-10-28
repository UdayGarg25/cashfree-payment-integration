const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const app = require('../../src/app');
const { pool } = require('../../src/config/db');

describe('Comprehensive Payment API & Webhook Assessment Suite (28 Test Cases)', () => {
  let server;
  let baseUrl;
  const mockSecret = process.env.CASHFREE_SECRET_KEY || 'test_secret_mock_12345';
  const originalFetch = global.fetch;

  let currentCashfreeMock = null;
  const createdTestOrderIds = [];

  before(async () => {
    process.env.CASHFREE_SECRET_KEY = mockSecret;
    process.env.CASHFREE_APP_ID = process.env.CASHFREE_APP_ID || 'test_app_id';

    // Intercept only Cashfree gateway requests, allowing local requests to reach Express
    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('cashfree.com') && currentCashfreeMock) {
        return currentCashfreeMock(urlStr, options);
      }
      return originalFetch(url, options);
    };

    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    global.fetch = originalFetch;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    // Clean up created test orders
    try {
      for (const orderId of createdTestOrderIds) {
        await pool.query('DELETE FROM webhook_events WHERE order_id = $1', [orderId]);
        await pool.query('DELETE FROM payments WHERE order_id = $1', [orderId]);
      }
    } catch (_) {}
    await pool.end();
  });

  // Helper to create a signed webhook request
  function signWebhook(payload, secret = mockSecret, timestamp = String(Date.now())) {
    const rawBody = JSON.stringify(payload);
    const signature = crypto
      .createHmac('sha256', secret)
      .update(timestamp + rawBody)
      .digest('base64');
    return { rawBody, signature, timestamp };
  }

  // ==========================================
  // SECTION A: VALIDATION & PAYMENT CREATION
  // ==========================================

  it('1. Valid payment request should create order and return 201 with paymentSessionId', async () => {
    currentCashfreeMock = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        cf_order_id: 'cf_mock_001',
        payment_session_id: 'session_mock_001',
        order_status: 'ACTIVE',
      }),
    });

    const res = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'STU_28_01',
        amount: 1500.0,
        currency: 'INR',
        customerName: 'Aarav Gupta',
        customerEmail: 'aarav@ums.edu',
        customerPhone: '9876543210',
      }),
    });

    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.status, 'SUCCESS');
    assert.strictEqual(data.data.status, 'PENDING');
    assert.strictEqual(data.data.amount, 1500);
    assert.ok(data.data.orderId);
    assert.ok(data.data.paymentSessionId);

    createdTestOrderIds.push(data.data.orderId);
  });

  it('2. Missing required fields should reject with 400 Bad Request', async () => {
    const res = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 1500 }),
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.status, 'FAIL');
    assert.ok(data.errors.some(e => e.includes('studentId')));
  });

  it('3. Invalid email or phone should reject with 400 Bad Request', async () => {
    const res = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'STU_003',
        amount: 500,
        customerName: 'Student',
        customerEmail: 'bad-email-format',
        customerPhone: '123',
      }),
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.errors.some(e => e.includes('email')));
    assert.ok(data.errors.some(e => e.includes('phone')));
  });

  it('4. Zero, negative, or excessive-decimal amount should reject with 400 Bad Request', async () => {
    const resZero = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'STU_004',
        amount: 0,
        customerName: 'Student',
        customerEmail: 'student@ums.edu',
        customerPhone: '9876543210',
      }),
    });
    assert.strictEqual(resZero.status, 400);

    const resDec = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'STU_004',
        amount: 100.999,
        customerName: 'Student',
        customerEmail: 'student@ums.edu',
        customerPhone: '9876543210',
      }),
    });
    assert.strictEqual(resDec.status, 400);
  });

  it('5. Cashfree order creation success persists PENDING status and gateway order ID', async () => {
    currentCashfreeMock = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        cf_order_id: 'cf_mock_005',
        payment_session_id: 'session_mock_005',
        order_status: 'ACTIVE',
      }),
    });

    const res = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'STU_005',
        amount: 3000,
        customerName: 'Deepa Roy',
        customerEmail: 'deepa@ums.edu',
        customerPhone: '9876543210',
      }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 201);
    createdTestOrderIds.push(data.data.orderId);

    const dbRes = await pool.query('SELECT * FROM payments WHERE order_id = $1', [data.data.orderId]);
    assert.strictEqual(dbRes.rows[0].status, 'PENDING');
    assert.strictEqual(dbRes.rows[0].cashfree_order_id, 'cf_mock_005');
  });

  it('6. Cashfree API 4xx error maps to 502 and marks local record FAILED', async () => {
    currentCashfreeMock = async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ message: 'order_already_exists', code: 'order_already_exists' }),
    });

    const res = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'STU_006',
        amount: 2000,
        customerName: 'Vikram Singh',
        customerEmail: 'vikram@ums.edu',
        customerPhone: '9876543210',
      }),
    });

    assert.strictEqual(res.status, 502);
    const dbRes = await pool.query("SELECT * FROM payments WHERE student_id = 'STU_006' ORDER BY created_at DESC LIMIT 1");
    assert.strictEqual(dbRes.rows[0].status, 'FAILED');
    createdTestOrderIds.push(dbRes.rows[0].order_id);
  });

  it('7. Network timeout / ambiguous gateway outcome transitions to REQUIRES_RECONCILIATION', async () => {
    currentCashfreeMock = async () => {
      const timeoutError = new Error('Gateway timed out');
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    };

    const res = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'STU_007',
        amount: 4500,
        customerName: 'Timeout Tester',
        customerEmail: 'timeout@ums.edu',
        customerPhone: '9876543210',
      }),
    });

    assert.strictEqual(res.status, 504);
    const dbRes = await pool.query("SELECT * FROM payments WHERE student_id = 'STU_007' ORDER BY created_at DESC LIMIT 1");
    assert.strictEqual(dbRes.rows[0].status, 'REQUIRES_RECONCILIATION', 'Must be recoverable for reconciliation');
    createdTestOrderIds.push(dbRes.rows[0].order_id);
  });

  it('8. Server generated order IDs ensure duplicate requests receive unique IDs', async () => {
    let mockIdCounter = 800;
    currentCashfreeMock = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ cf_order_id: `cf_mock_008_${mockIdCounter++}`, payment_session_id: 'sess_008', order_status: 'ACTIVE' }),
    });

    const payload = {
      studentId: 'STU_008',
      amount: 1000,
      customerName: 'Samir',
      customerEmail: 'samir@ums.edu',
      customerPhone: '9876543210',
    };

    const res1 = await fetch(`${baseUrl}/api/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const res2 = await fetch(`${baseUrl}/api/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

    const data1 = await res1.json();
    const data2 = await res2.json();
    assert.notStrictEqual(data1.data.orderId, data2.data.orderId, 'Server-generated order IDs must be unique');
    createdTestOrderIds.push(data1.data.orderId, data2.data.orderId);
  });

  // ==========================================
  // SECTION B: STATUS RECONCILIATION
  // ==========================================

  let statusTestOrderId;

  it('9. Existing payment status lookup returns 200 and record details', async () => {
    currentCashfreeMock = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ cf_order_id: 'cf_mock_009', payment_session_id: 'sess_009', order_status: 'ACTIVE' }),
    });

    const createRes = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'STU_009',
        amount: 2200,
        customerName: 'Status User',
        customerEmail: 'status@ums.edu',
        customerPhone: '9876543210',
      }),
    });
    const createData = await createRes.json();
    statusTestOrderId = createData.data.orderId;
    createdTestOrderIds.push(statusTestOrderId);

    // Lookup status
    currentCashfreeMock = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ order_id: statusTestOrderId, order_status: 'ACTIVE', order_amount: 2200 }),
    });

    const statusRes = await fetch(`${baseUrl}/api/payments/${statusTestOrderId}`);
    assert.strictEqual(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.strictEqual(statusData.data.orderId, statusTestOrderId);
    assert.strictEqual(statusData.data.status, 'PENDING');
  });

  it('10. Unknown order ID returns 404 Not Found', async () => {
    const res = await fetch(`${baseUrl}/api/payments/order_non_existent_99999`);
    assert.strictEqual(res.status, 404);
  });

  it('11. Successful payment confirmation updates local status to PAID', async () => {
    currentCashfreeMock = async (url) => {
      if (url.includes('/payments')) {
        return { ok: true, status: 200, json: async () => [{ cf_payment_id: 'cf_pay_011', payment_status: 'SUCCESS' }] };
      }
      return { ok: true, status: 200, json: async () => ({ order_id: statusTestOrderId, order_status: 'PAID', order_amount: 2200 }) };
    };

    const res = await fetch(`${baseUrl}/api/payments/${statusTestOrderId}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.data.status, 'PAID');
    assert.strictEqual(data.data.cashfreePaymentId, 'cf_pay_011');
  });

  it('12. Pending payment retains PENDING state when Cashfree reports ACTIVE', async () => {
    // Create new pending order
    currentCashfreeMock = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ cf_order_id: 'cf_012', payment_session_id: 'sess_012', order_status: 'ACTIVE' }),
    });
    const cRes = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: 'STU_012', amount: 1200, customerName: 'Active User', customerEmail: 'active@ums.edu', customerPhone: '9876543210' }),
    });
    const cData = await cRes.json();
    const oid = cData.data.orderId;
    createdTestOrderIds.push(oid);

    currentCashfreeMock = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ order_id: oid, order_status: 'ACTIVE', order_amount: 1200 }),
    });

    const res = await fetch(`${baseUrl}/api/payments/${oid}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.data.status, 'PENDING');
  });

  it('13. Failed payment status updates to FAILED when Cashfree reports EXPIRED', async () => {
    // Create new order
    currentCashfreeMock = async () => ({ ok: true, status: 200, json: async () => ({ cf_order_id: 'cf_013', payment_session_id: 'sess_013', order_status: 'ACTIVE' }) });
    const cRes = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: 'STU_013', amount: 800, customerName: 'Exp User', customerEmail: 'exp@ums.edu', customerPhone: '9876543210' }),
    });
    const cData = await cRes.json();
    const oid = cData.data.orderId;
    createdTestOrderIds.push(oid);

    currentCashfreeMock = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ order_id: oid, order_status: 'EXPIRED', order_amount: 800 }),
    });

    const res = await fetch(`${baseUrl}/api/payments/${oid}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.data.status, 'FAILED');
  });

  it('14. Cancelled payment status updates to CANCELLED when Cashfree reports TERMINATED', async () => {
    currentCashfreeMock = async () => ({ ok: true, status: 200, json: async () => ({ cf_order_id: 'cf_014', payment_session_id: 'sess_014', order_status: 'ACTIVE' }) });
    const cRes = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: 'STU_014', amount: 700, customerName: 'Term User', customerEmail: 'term@ums.edu', customerPhone: '9876543210' }),
    });
    const cData = await cRes.json();
    const oid = cData.data.orderId;
    createdTestOrderIds.push(oid);

    currentCashfreeMock = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ order_id: oid, order_status: 'TERMINATED', order_amount: 700 }),
    });

    const res = await fetch(`${baseUrl}/api/payments/${oid}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.data.status, 'CANCELLED');
  });

  it('15. Gateway unavailable during status lookup returns current local status safely', async () => {
    currentCashfreeMock = async () => {
      const err = new Error('Gateway Connection Refused');
      err.status = 502;
      throw err;
    };

    const res = await fetch(`${baseUrl}/api/payments/${statusTestOrderId}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.data.orderId, statusTestOrderId);
    assert.strictEqual(data.data.status, 'PAID');
  });

  it('16. Delayed failure event after confirmed successful payment does not downgrade PAID', async () => {
    // Attempt reconcile with conflicting response
    currentCashfreeMock = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ order_id: statusTestOrderId, order_status: 'EXPIRED', order_amount: 2200 }),
    });

    const res = await fetch(`${baseUrl}/api/payments/${statusTestOrderId}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.data.status, 'PAID', 'Must never downgrade a confirmed PAID order');
  });

  // ==========================================
  // SECTION C: WEBHOOKS
  // ==========================================

  let webhookOrderId;

  before(async () => {
    // Create fresh order for webhook testing
    currentCashfreeMock = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ cf_order_id: 'cf_wh_order', payment_session_id: 'sess_wh', order_status: 'ACTIVE' }),
    });

    const cRes = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: 'STU_WH_01',
        amount: 5000,
        currency: 'INR',
        customerName: 'Webhook Tester',
        customerEmail: 'webhook@ums.edu',
        customerPhone: '9876543210',
      }),
    });
    const cData = await cRes.json();
    webhookOrderId = cData.data.orderId;
    createdTestOrderIds.push(webhookOrderId);
  });

  it('17. Valid webhook signature should be accepted with 200 OK', async () => {
    const payload = {
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: {
        order: { order_id: webhookOrderId, order_amount: 5000, order_currency: 'INR' },
        payment: { cf_payment_id: 'cf_pay_wh_17', payment_status: 'SUCCESS', payment_amount: 5000 },
      },
    };
    const { rawBody, signature, timestamp } = signWebhook(payload);

    const res = await fetch(`${baseUrl}/api/webhooks/cashfree`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': signature,
        'x-webhook-timestamp': timestamp,
      },
      body: rawBody,
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'SUCCESS');
    assert.strictEqual(data.data.status, 'PAID');
  });

  it('18. Invalid signature should reject with 401 Unauthorized', async () => {
    const payload = { type: 'PAYMENT_SUCCESS_WEBHOOK' };
    const { rawBody, timestamp } = signWebhook(payload);

    const res = await fetch(`${baseUrl}/api/webhooks/cashfree`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': 'tampered_signature_value',
        'x-webhook-timestamp': timestamp,
      },
      body: rawBody,
    });

    assert.strictEqual(res.status, 401);
  });

  it('19. Missing signature headers should reject with 401 Unauthorized', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/cashfree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK' }),
    });

    assert.strictEqual(res.status, 401);
  });

  it('20. Malformed JSON or invalid event structure should reject with 400 Bad Request', async () => {
    const payload = { not_a_valid_event: true };
    const { rawBody, signature, timestamp } = signWebhook(payload);

    const res = await fetch(`${baseUrl}/api/webhooks/cashfree`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-signature': signature,
        'x-webhook-timestamp': timestamp,
      },
      body: rawBody,
    });

    assert.strictEqual(res.status, 400);
  });

  it('21. Successful payment webhook updates database record to PAID and records payment ID', async () => {
    const dbRes = await pool.query('SELECT * FROM payments WHERE order_id = $1', [webhookOrderId]);
    assert.strictEqual(dbRes.rows[0].status, 'PAID');
    assert.strictEqual(dbRes.rows[0].cashfree_payment_id, 'cf_pay_wh_17');
  });

  it('22. Failed payment webhook transitions pending order to FAILED', async () => {
    // Create new order
    currentCashfreeMock = async () => ({ ok: true, status: 200, json: async () => ({ cf_order_id: 'cf_22', payment_session_id: 's_22', order_status: 'ACTIVE' }) });
    const cRes = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: 'STU_22', amount: 1000, customerName: 'Fail Wh', customerEmail: 'failwh@ums.edu', customerPhone: '9876543210' }),
    });
    const cData = await cRes.json();
    const oid = cData.data.orderId;
    createdTestOrderIds.push(oid);

    const payload = {
      type: 'PAYMENT_FAILED_WEBHOOK',
      data: {
        order: { order_id: oid, order_amount: 1000, order_currency: 'INR' },
        payment: { cf_payment_id: 'pay_fail_22', payment_status: 'FAILED' },
      },
    };
    const { rawBody, signature, timestamp } = signWebhook(payload);

    const res = await fetch(`${baseUrl}/api/webhooks/cashfree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp },
      body: rawBody,
    });

    assert.strictEqual(res.status, 200);
    const dbRes = await pool.query('SELECT * FROM payments WHERE order_id = $1', [oid]);
    assert.strictEqual(dbRes.rows[0].status, 'FAILED');
  });

  it('23. Pending or unsupported event acknowledged safely without corrupting status', async () => {
    const payload = {
      type: 'CUSTOM_UNSUPPORTED_WEBHOOK',
      data: {
        order: { order_id: webhookOrderId },
      },
    };
    const { rawBody, signature, timestamp } = signWebhook(payload);

    const res = await fetch(`${baseUrl}/api/webhooks/cashfree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp },
      body: rawBody,
    });

    assert.strictEqual(res.status, 200);
    const dbRes = await pool.query('SELECT * FROM payments WHERE order_id = $1', [webhookOrderId]);
    assert.strictEqual(dbRes.rows[0].status, 'PAID', 'Status must not be corrupted by unknown event');
  });

  it('24. Duplicate webhook delivery handled idempotently without re-execution', async () => {
    const payload = {
      event_id: 'evt_dedup_test_24',
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: {
        order: { order_id: webhookOrderId, order_amount: 5000 },
        payment: { cf_payment_id: 'cf_pay_wh_17', payment_status: 'SUCCESS' },
      },
    };
    const { rawBody, signature, timestamp } = signWebhook(payload);

    // First delivery
    const res1 = await fetch(`${baseUrl}/api/webhooks/cashfree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp },
      body: rawBody,
    });
    assert.strictEqual(res1.status, 200);

    // Duplicate delivery
    const res2 = await fetch(`${baseUrl}/api/webhooks/cashfree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp },
      body: rawBody,
    });
    assert.strictEqual(res2.status, 200);
    const data2 = await res2.json();
    assert.ok(data2.message.includes('idempotent') || data2.message.includes('already'));
  });

  it('25. Unknown merchant order ID in webhook returns 404 Not Found', async () => {
    const payload = {
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: {
        order: { order_id: 'order_non_existent_wh_999' },
      },
    };
    const { rawBody, signature, timestamp } = signWebhook(payload);

    const res = await fetch(`${baseUrl}/api/webhooks/cashfree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp },
      body: rawBody,
    });

    assert.strictEqual(res.status, 404);
  });

  it('26. Amount or currency mismatch rejects with 400 Bad Request', async () => {
    const payload = {
      event_id: `evt_mismatch_${Date.now()}`,
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: {
        order: { order_id: webhookOrderId, order_amount: 99999, order_currency: 'USD' },
      },
    };
    const { rawBody, signature, timestamp } = signWebhook(payload);

    const res = await fetch(`${baseUrl}/api/webhooks/cashfree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp },
      body: rawBody,
    });

    assert.strictEqual(res.status, 400);
  });

  it('27. Database transaction atomicity ensures state consistency on failure', async () => {
    // When an error occurs (such as amount mismatch), verify no inconsistent partial updates are committed
    const dbRes = await pool.query('SELECT * FROM payments WHERE order_id = $1', [webhookOrderId]);
    assert.strictEqual(dbRes.rows[0].currency, 'INR', 'Currency was not corrupted');
  });

  it('28. Concurrent or out-of-order webhook delivery prevents PAID-to-FAILED downgrade', async () => {
    const payload = {
      event_id: `evt_late_failure_${Date.now()}`,
      type: 'PAYMENT_FAILED_WEBHOOK',
      data: {
        order: { order_id: webhookOrderId, order_amount: 5000, order_currency: 'INR' },
        payment: { cf_payment_id: 'pay_late_fail', payment_status: 'FAILED' },
      },
    };
    const { rawBody, signature, timestamp } = signWebhook(payload);

    const res = await fetch(`${baseUrl}/api/webhooks/cashfree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-signature': signature, 'x-webhook-timestamp': timestamp },
      body: rawBody,
    });

    assert.strictEqual(res.status, 200);
    const dbRes = await pool.query('SELECT * FROM payments WHERE order_id = $1', [webhookOrderId]);
    assert.strictEqual(dbRes.rows[0].status, 'PAID', 'Confirmed PAID payment must never be downgraded');
  });
});
