const crypto = require('crypto');
const { pool } = require('../config/db');
const { generateOrderId, formatCustomerId } = require('../utils/orderGenerator');
const cashfreeService = require('./cashfreeService');

/**
 * Initiates a new payment:
 * 1. Generates a secure, unique merchant order ID.
 * 2. Persists initial payment record in PostgreSQL with status 'CREATED'.
 * 3. Calls Cashfree Sandbox API to create order session with timeout.
 * 4. On success: Updates payment record to 'PENDING' with payment_session_id and cf_order_id.
 * 5. On failure:
 *    - If ambiguous (network timeout / 504), transitions to 'REQUIRES_RECONCILIATION' so it can be safely reconciled.
 *    - If definitive client/gateway rejection (4xx), transitions to 'FAILED'.
 *
 * @param {Object} paymentData
 * @param {string} paymentData.studentId
 * @param {number} paymentData.amount
 * @param {string} [paymentData.currency='INR']
 * @param {string} paymentData.customerName
 * @param {string} paymentData.customerEmail
 * @param {string} paymentData.customerPhone
 * @returns {Promise<Object>} Payment initiation response
 */
async function initiatePayment({ studentId, amount, currency = 'INR', customerName, customerEmail, customerPhone }) {
  const orderId = generateOrderId();
  const customerId = formatCustomerId(studentId);
  const formattedAmount = Number(amount.toFixed(2));
  const orderCurrency = currency || 'INR';

  // Step 1: Insert payment record with initial status 'CREATED' within a transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insertSql = `
      INSERT INTO payments (order_id, student_id, amount, currency, status)
      VALUES ($1, $2, $3, $4, 'CREATED')
      RETURNING id, order_id, student_id, amount, currency, status, created_at;
    `;
    await client.query(insertSql, [orderId, studentId, formattedAmount, orderCurrency]);

    await client.query('COMMIT');
  } catch (dbError) {
    await client.query('ROLLBACK');
    throw dbError;
  } finally {
    client.release();
  }

  // Step 2: Request Cashfree Payment Gateway order creation
  try {
    const cashfreeResponse = await cashfreeService.createOrder({
      orderId,
      amount: formattedAmount,
      currency: orderCurrency,
      customerId,
      customerName,
      customerEmail,
      customerPhone,
    });

    const cashfreeOrderId = String(cashfreeResponse.cf_order_id || '');
    const paymentSessionId = cashfreeResponse.payment_session_id;

    // Step 3: Transition status to 'PENDING' and persist Cashfree identifiers
    const updateSql = `
      UPDATE payments
      SET status = 'PENDING',
          cashfree_order_id = $1,
          payment_session_id = $2
      WHERE order_id = $3
      RETURNING id, order_id, student_id, amount, currency, status, cashfree_order_id, payment_session_id, created_at, updated_at;
    `;
    const updateResult = await pool.query(updateSql, [cashfreeOrderId, paymentSessionId, orderId]);
    const updatedRecord = updateResult.rows[0];

    return {
      orderId: updatedRecord.order_id,
      status: updatedRecord.status,
      paymentSessionId: updatedRecord.payment_session_id,
      cfOrderId: updatedRecord.cashfree_order_id,
      amount: Number(updatedRecord.amount),
      currency: updatedRecord.currency,
      createdAt: updatedRecord.created_at,
    };
  } catch (gatewayError) {
    // Step 4: Handle gateway failure without corrupting state
    // If ambiguous outcome (timeout or network error), set to REQUIRES_RECONCILIATION so future check/webhook can recover it.
    const targetStatus = gatewayError.isAmbiguous ? 'REQUIRES_RECONCILIATION' : 'FAILED';

    try {
      await pool.query(
        `UPDATE payments SET status = $1 WHERE order_id = $2 AND status = 'CREATED'`,
        [targetStatus, orderId]
      );
    } catch (updateError) {
      console.error(`Failed to update status to ${targetStatus} for order ${orderId}:`, updateError.message);
    }

    throw gatewayError;
  }
}

/**
 * Retrieves the status of a payment by its merchant orderId:
 * 1. Checks local PostgreSQL record.
 * 2. If record is already 'PAID', returns immediately (never downgraded).
 * 3. If record is 'PENDING', 'CREATED', or 'REQUIRES_RECONCILIATION', reconciles with Cashfree API.
 * 4. Verifies order amount and ID match.
 * 5. Updates local record if Cashfree confirms state change.
 * 6. If gateway is temporarily unreachable, returns local status gracefully.
 *
 * @param {string} orderId
 * @returns {Promise<Object>} Payment status details
 */
async function getPaymentStatus(orderId) {
  if (!orderId || typeof orderId !== 'string' || !orderId.trim()) {
    const error = new Error('orderId parameter is required.');
    error.status = 400;
    throw error;
  }

  const cleanOrderId = orderId.trim();

  // Step 1: Retrieve local record
  const localRes = await pool.query('SELECT * FROM payments WHERE order_id = $1', [cleanOrderId]);
  if (localRes.rows.length === 0) {
    const error = new Error(`Payment with orderId "${cleanOrderId}" was not found.`);
    error.status = 404;
    error.code = 'ORDER_NOT_FOUND';
    throw error;
  }

  let record = localRes.rows[0];

  // If already confirmed as PAID, return immediately to prevent any accidental downgrade
  if (record.status === 'PAID') {
    return formatPaymentRecord(record);
  }

  // Step 2: Attempt reconciliation with Cashfree PG
  try {
    const cfOrder = await cashfreeService.getOrder(cleanOrderId);

    // Verify order ID and amount match
    if (cfOrder.order_id && cfOrder.order_id !== cleanOrderId) {
      console.warn(`Mismatch in order ID returned by Cashfree: ${cfOrder.order_id} vs ${cleanOrderId}`);
    }

    if (cfOrder.order_amount !== undefined && Math.abs(parseFloat(cfOrder.order_amount) - parseFloat(record.amount)) > 0.01) {
      console.warn(`Mismatch in order amount: Gateway=${cfOrder.order_amount}, Local=${record.amount}`);
    }

    const cfStatus = (cfOrder.order_status || '').toUpperCase();
    let newStatus = null;
    let cfPaymentId = null;

    if (cfStatus === 'PAID') {
      newStatus = 'PAID';
      // Fetch specific payment attempts to record cf_payment_id
      try {
        const paymentsList = await cashfreeService.getOrderPayments(cleanOrderId);
        const successfulPayment = paymentsList.find(p => (p.payment_status || '').toUpperCase() === 'SUCCESS');
        if (successfulPayment && successfulPayment.cf_payment_id) {
          cfPaymentId = String(successfulPayment.cf_payment_id);
        }
      } catch (payFetchErr) {
        console.warn(`Could not fetch payment attempts for ${cleanOrderId}:`, payFetchErr.message);
      }
    } else if (cfStatus === 'EXPIRED') {
      newStatus = 'FAILED';
    } else if (cfStatus === 'TERMINATED') {
      newStatus = 'CANCELLED';
    } else if (cfStatus === 'ACTIVE') {
      newStatus = 'PENDING';
    }

    // Step 3: If status changed and current status is not PAID, update database atomically
    if (newStatus && newStatus !== record.status && record.status !== 'PAID') {
      const updateRes = await pool.query(
        `UPDATE payments
         SET status = $1,
             cashfree_payment_id = COALESCE($2, cashfree_payment_id)
         WHERE order_id = $3 AND status != 'PAID'
         RETURNING *`,
        [newStatus, cfPaymentId, cleanOrderId]
      );
      if (updateRes.rows.length > 0) {
        record = updateRes.rows[0];
      }
    }
  } catch (cfError) {
    if (cfError.status === 404) {
      // If order was in REQUIRES_RECONCILIATION and Cashfree has no record of it, it genuinely failed at gateway
      if (record.status === 'REQUIRES_RECONCILIATION') {
        const failRes = await pool.query(
          `UPDATE payments SET status = 'FAILED' WHERE order_id = $1 RETURNING *`,
          [cleanOrderId]
        );
        if (failRes.rows.length > 0) {
          record = failRes.rows[0];
        }
      }
      console.warn(`Order ${cleanOrderId} not found on Cashfree gateway.`);
    } else {
      console.warn(`Cashfree gateway temporarily unavailable for ${cleanOrderId}; returning local status.`);
    }
  }

  return formatPaymentRecord(record);
}

/**
 * Processes incoming Cashfree webhook events:
 * 1. Verifies HMAC-SHA256 signature using rawBody and timestamp.
 * 2. Checks idempotency against webhook_events table in an atomic transaction.
 * 3. Acquires transaction row lock on payments table.
 * 4. Validates event amount and currency against stored record.
 * 5. Applies state transition (preventing any downgrade from PAID to FAILED/CANCELLED).
 *
 * @param {Object} params
 * @param {Object} params.payload - Parsed webhook event JSON
 * @param {string} params.rawBody - Exact unparsed request body string
 * @param {string} params.signature - x-webhook-signature header
 * @param {string} params.timestamp - x-webhook-timestamp header
 * @returns {Promise<Object>} Processing outcome
 */
async function processWebhookEvent({ payload, rawBody, signature, timestamp }) {
  // Step 1: Verify Webhook Signature
  const isValidSignature = cashfreeService.verifyWebhookSignature({
    rawBody,
    signature,
    timestamp,
  });

  if (!isValidSignature) {
    const error = new Error('Invalid Cashfree webhook signature.');
    error.status = 401;
    error.code = 'INVALID_WEBHOOK_SIGNATURE';
    throw error;
  }

  if (!payload || typeof payload !== 'object') {
    const error = new Error('Malformed webhook event payload.');
    error.status = 400;
    error.code = 'MALFORMED_WEBHOOK_PAYLOAD';
    throw error;
  }

  const eventType = payload.type || payload.event;
  const orderData = payload.data && payload.data.order;
  const paymentData = payload.data && payload.data.payment;
  const orderId = (orderData && orderData.order_id) || (payload.order && payload.order.order_id);

  if (!eventType || !orderId) {
    const error = new Error('Missing event type or order_id in webhook payload.');
    error.status = 400;
    error.code = 'INVALID_EVENT_DATA';
    throw error;
  }

  // Step 2: Idempotency deduplication via webhook_events table
  const cfPaymentId = paymentData && paymentData.cf_payment_id ? String(paymentData.cf_payment_id) : null;
  const eventId = payload.event_id || (cfPaymentId ? `${eventType}_${cfPaymentId}` : crypto.createHash('sha256').update(rawBody).digest('hex'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Deduplication check
    const dedupRes = await client.query(
      `INSERT INTO webhook_events (event_id, order_id, event_type, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [eventId, orderId, eventType, JSON.stringify(payload)]
    );

    if (dedupRes.rowCount === 0) {
      await client.query('COMMIT');
      return {
        success: true,
        isDuplicate: true,
        message: 'Webhook event already processed (idempotent)',
        orderId,
        eventType,
      };
    }

    // Step 3: Row lock payment record for update
    const paymentRes = await client.query(
      'SELECT * FROM payments WHERE order_id = $1 FOR UPDATE',
      [orderId]
    );

    if (paymentRes.rows.length === 0) {
      await client.query('ROLLBACK');
      const error = new Error(`Payment with orderId "${orderId}" not found in database.`);
      error.status = 404;
      error.code = 'ORDER_NOT_FOUND';
      throw error;
    }

    const currentRecord = paymentRes.rows[0];

    // Step 4: Validate event against stored record
    if (orderData && orderData.order_amount !== undefined) {
      const eventAmount = parseFloat(orderData.order_amount);
      const recordAmount = parseFloat(currentRecord.amount);
      if (Math.abs(eventAmount - recordAmount) > 0.01) {
        await client.query('ROLLBACK');
        const mismatchErr = new Error(`Webhook order_amount mismatch: Event=${eventAmount}, Stored=${recordAmount}`);
        mismatchErr.status = 400;
        mismatchErr.code = 'AMOUNT_MISMATCH';
        throw mismatchErr;
      }
    }

    if (orderData && orderData.order_currency && orderData.order_currency !== currentRecord.currency) {
      await client.query('ROLLBACK');
      const currErr = new Error(`Webhook order_currency mismatch: Event=${orderData.order_currency}, Stored=${currentRecord.currency}`);
      currErr.status = 400;
      currErr.code = 'CURRENCY_MISMATCH';
      throw currErr;
    }

    // Step 5: State Machine Transitions
    let targetStatus = null;
    if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' || (paymentData && paymentData.payment_status === 'SUCCESS')) {
      targetStatus = 'PAID';
    } else if (eventType === 'PAYMENT_FAILED_WEBHOOK' || (paymentData && paymentData.payment_status === 'FAILED')) {
      targetStatus = 'FAILED';
    } else if (eventType === 'PAYMENT_USER_DROPPED_WEBHOOK' || (paymentData && paymentData.payment_status === 'USER_DROPPED')) {
      targetStatus = 'CANCELLED';
    }

    // Protection rule: Never downgrade a confirmed PAID order
    if (currentRecord.status === 'PAID') {
      if (targetStatus && targetStatus !== 'PAID') {
        console.warn(`Received out-of-order event ${eventType} for already PAID order ${orderId}. Ignored state downgrade.`);
      }
      await client.query('COMMIT');
      return {
        success: true,
        orderId,
        status: 'PAID',
        message: 'Order already PAID. State preserved.',
      };
    }

    // Apply valid transition
    if (targetStatus) {
      const updateRes = await client.query(
        `UPDATE payments
         SET status = $1,
             cashfree_payment_id = COALESCE($2, cashfree_payment_id)
         WHERE order_id = $3 AND status != 'PAID'
         RETURNING *`,
        [targetStatus, cfPaymentId, orderId]
      );
      await client.query('COMMIT');

      const updated = updateRes.rows[0] || currentRecord;
      return {
        success: true,
        orderId,
        status: updated.status,
        message: `Payment status updated to ${updated.status}`,
      };
    }

    // Unhandled event type acknowledged safely
    await client.query('COMMIT');
    return {
      success: true,
      orderId,
      status: currentRecord.status,
      message: `Event ${eventType} acknowledged without status change`,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function formatPaymentRecord(record) {
  return {
    orderId: record.order_id,
    studentId: record.student_id,
    amount: Number(record.amount),
    currency: record.currency,
    status: record.status,
    cashfreeOrderId: record.cashfree_order_id,
    cashfreePaymentId: record.cashfree_payment_id,
    paymentSessionId: record.payment_session_id,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

module.exports = {
  initiatePayment,
  getPaymentStatus,
  processWebhookEvent,
  formatPaymentRecord,
};
