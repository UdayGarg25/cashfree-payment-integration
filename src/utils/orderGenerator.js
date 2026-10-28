const crypto = require('crypto');

/**
 * Generates a unique merchant order identifier.
 * Cashfree requires order_id to be alphanumeric, hyphens, and underscores (max 50 chars).
 * Format: order_UMS_<timestamp>_<hex> (approx 32 chars)
 * @returns {string} Unique order ID
 */
function generateOrderId() {
  const timestamp = Date.now();
  const randomHex = crypto.randomBytes(4).toString('hex');
  return `order_UMS_${timestamp}_${randomHex}`;
}

/**
 * Sanitizes or generates a valid Cashfree customer_id from student_id.
 * Cashfree requires customer_id to be alphanumeric with underscores/hyphens (max 50 chars).
 * @param {string|number} studentId
 * @returns {string} Sanitized customer ID
 */
function formatCustomerId(studentId) {
  const sanitized = String(studentId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return `cust_${sanitized || 'student'}`;
}

module.exports = {
  generateOrderId,
  formatCustomerId,
};

