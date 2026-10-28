const crypto = require('crypto');

/**
 * Cashfree Payment Gateway Service
 * Handles communication with Cashfree API v2023-08-01 / v2025-01-01
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

function getCashfreeConfig() {
  const appId = process.env.CASHFREE_APP_ID;
  const secretKey = process.env.CASHFREE_SECRET_KEY;
  const apiVersion = process.env.CASHFREE_API_VERSION || '2023-08-01';
  const env = (process.env.CASHFREE_ENV || 'SANDBOX').toUpperCase();

  const baseUrl = process.env.CASHFREE_BASE_URL ||
    (env === 'PRODUCTION' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg');

  return {
    appId,
    secretKey,
    apiVersion,
    baseUrl,
  };
}

/**
 * Helper to execute fetch with timeout and safe error categorization.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response;
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      const timeoutErr = new Error(`Cashfree gateway request timed out after ${timeoutMs}ms`);
      timeoutErr.status = 504;
      timeoutErr.code = 'GATEWAY_TIMEOUT';
      timeoutErr.isAmbiguous = true;
      throw timeoutErr;
    }
    const netErr = new Error(`Cashfree gateway network error: ${error.message}`);
    netErr.status = 502;
    netErr.code = 'NETWORK_ERROR';
    netErr.isAmbiguous = true;
    throw netErr;
  }
}

/**
 * Creates an order in Cashfree Payment Gateway.
 *
 * @param {Object} params
 * @param {string} params.orderId - Unique merchant order identifier
 * @param {number} params.amount - Order amount in INR (two decimal places)
 * @param {string} [params.currency='INR'] - Order currency
 * @param {string} params.customerId - Unique customer identifier
 * @param {string} params.customerName - Name of the customer/student
 * @param {string} params.customerEmail - Email address of the customer
 * @param {string} params.customerPhone - 10-digit mobile number
 * @returns {Promise<Object>} Cashfree response including payment_session_id and cf_order_id
 */
async function createOrder({ orderId, amount, currency = 'INR', customerId, customerName, customerEmail, customerPhone }) {
  const config = getCashfreeConfig();

  if (!config.appId || !config.secretKey) {
    const error = new Error('Cashfree sandbox credentials are not configured in environment variables.');
    error.status = 500;
    error.code = 'CASHFREE_CREDENTIALS_MISSING';
    throw error;
  }

  const endpoint = `${config.baseUrl}/orders`;

  const requestPayload = {
    order_id: orderId,
    order_amount: Number(amount.toFixed(2)),
    order_currency: currency || 'INR',
    customer_details: {
      customer_id: customerId,
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone,
    },
  };

  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-client-id': config.appId,
      'x-client-secret': config.secretKey,
      'x-api-version': config.apiVersion,
    },
    body: JSON.stringify(requestPayload),
  });

  const responseData = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = responseData.message || responseData.error || response.statusText || 'Failed to create Cashfree order';
    const error = new Error(`Cashfree gateway error: ${errorMsg}`);
    error.status = response.status >= 400 && response.status < 500 ? 502 : 500;
    error.code = responseData.code || 'CASHFREE_API_ERROR';
    error.cashfreeDetails = {
      status: response.status,
      code: responseData.code,
      message: responseData.message,
      type: responseData.type,
    };
    throw error;
  }

  return responseData;
}

/**
 * Fetches order details from Cashfree Payment Gateway.
 *
 * @param {string} orderId - Merchant order ID
 * @returns {Promise<Object>} Order details from Cashfree
 */
async function getOrder(orderId) {
  const config = getCashfreeConfig();

  if (!config.appId || !config.secretKey) {
    const error = new Error('Cashfree sandbox credentials are not configured in environment variables.');
    error.status = 500;
    error.code = 'CASHFREE_CREDENTIALS_MISSING';
    throw error;
  }

  const endpoint = `${config.baseUrl}/orders/${encodeURIComponent(orderId)}`;

  const response = await fetchWithTimeout(endpoint, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-client-id': config.appId,
      'x-client-secret': config.secretKey,
      'x-api-version': config.apiVersion,
    },
  });

  const responseData = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMsg = responseData.message || responseData.error || response.statusText || 'Failed to fetch Cashfree order';
    const error = new Error(`Cashfree gateway error: ${errorMsg}`);
    error.status = response.status === 404 ? 404 : (response.status >= 400 && response.status < 500 ? 502 : 500);
    error.code = responseData.code || 'CASHFREE_ORDER_FETCH_FAILED';
    error.cashfreeDetails = {
      status: response.status,
      code: responseData.code,
      message: responseData.message,
      type: responseData.type,
    };
    throw error;
  }

  return responseData;
}

/**
 * Fetches payments attempted for an order from Cashfree Payment Gateway.
 *
 * @param {string} orderId - Merchant order ID
 * @returns {Promise<Array>} Array of payment attempts
 */
async function getOrderPayments(orderId) {
  const config = getCashfreeConfig();

  if (!config.appId || !config.secretKey) {
    const error = new Error('Cashfree sandbox credentials are not configured in environment variables.');
    error.status = 500;
    error.code = 'CASHFREE_CREDENTIALS_MISSING';
    throw error;
  }

  const endpoint = `${config.baseUrl}/orders/${encodeURIComponent(orderId)}/payments`;

  const response = await fetchWithTimeout(endpoint, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-client-id': config.appId,
      'x-client-secret': config.secretKey,
      'x-api-version': config.apiVersion,
    },
  });

  const responseData = await response.json().catch(() => ([]));

  if (!response.ok) {
    const errorMsg = (responseData && responseData.message) || response.statusText || 'Failed to fetch order payments';
    const error = new Error(`Cashfree gateway error: ${errorMsg}`);
    error.status = response.status >= 400 && response.status < 500 ? 502 : 500;
    error.code = (responseData && responseData.code) || 'CASHFREE_PAYMENTS_FETCH_FAILED';
    throw error;
  }

  return Array.isArray(responseData) ? responseData : [];
}

/**
 * Verifies HMAC-SHA256 signature for incoming Cashfree webhooks.
 * Signed string is timestamp + rawBody.
 *
 * @param {Object} params
 * @param {string} params.rawBody - Exact unparsed request body string
 * @param {string} params.signature - x-webhook-signature header
 * @param {string} params.timestamp - x-webhook-timestamp header
 * @returns {boolean} True if signature is valid
 */
function verifyWebhookSignature({ rawBody, signature, timestamp }) {
  if (!signature || !timestamp || !rawBody) {
    return false;
  }

  const config = getCashfreeConfig();
  if (!config.secretKey) {
    return false;
  }

  try {
    const payloadToSign = String(timestamp) + String(rawBody);
    const expectedSignature = crypto
      .createHmac('sha256', config.secretKey)
      .update(payloadToSign)
      .digest('base64');

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const receivedBuffer = Buffer.from(signature, 'utf8');

    if (expectedBuffer.length !== receivedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
  } catch (err) {
    console.error('Error during webhook signature verification:', err.message);
    return false;
  }
}

module.exports = {
  createOrder,
  getOrder,
  getOrderPayments,
  verifyWebhookSignature,
  getCashfreeConfig,
};
