const { describe, it } = require('node:test');
const assert = require('node:assert');
const { generateOrderId, formatCustomerId } = require('../../src/utils/orderGenerator');

describe('OrderGenerator Utility Unit Tests', () => {
  it('should generate unique merchant order IDs with expected prefix and format', () => {
    const id1 = generateOrderId();
    const id2 = generateOrderId();

    assert.notStrictEqual(id1, id2, 'Generated IDs must be unique');
    assert.match(id1, /^order_UMS_\d+_[a-f0-9]{8}$/, 'Must match format order_UMS_<timestamp>_<hex>');
    assert.ok(id1.length <= 45, `Order ID length must be <= 45 for Cashfree (was ${id1.length})`);
  });

  it('should sanitize customer ID removing unsupported characters', () => {
    const custId = formatCustomerId('STU/2026@001#XYZ');
    assert.match(custId, /^cust_[a-zA-Z0-9_-]+$/, 'Customer ID must be alphanumeric with underscores/hyphens');
    assert.strictEqual(custId, 'cust_STU_2026_001_XYZ');
  });

  it('should handle empty or fallback student IDs safely', () => {
    const custId = formatCustomerId('');
    assert.strictEqual(custId, 'cust_student');
  });
});

