const { describe, it } = require('node:test');
const assert = require('node:assert');
const validatePayment = require('../../src/middleware/validatePayment');

function runMiddleware(reqBody) {
  const req = { body: reqBody };
  let responseData = null;
  let responseStatus = null;
  const res = {
    status(code) {
      responseStatus = code;
      return {
        json(data) {
          responseData = data;
        },
      };
    },
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  validatePayment(req, res, next);
  return { nextCalled, responseStatus, responseData, req };
}

describe('Payment Validation Middleware Unit Tests', () => {
  it('should accept valid payment payload', () => {
    const { nextCalled, req } = runMiddleware({
      studentId: 'STU1001',
      amount: 1500.5,
      customerName: 'Rahul Verma',
      customerEmail: 'rahul@example.com',
      customerPhone: '9876543210',
    });

    assert.strictEqual(nextCalled, true);
    assert.strictEqual(req.validatedPayment.studentId, 'STU1001');
    assert.strictEqual(req.validatedPayment.amount, 1500.5);
    assert.strictEqual(req.validatedPayment.customerEmail, 'rahul@example.com');
  });

  it('should reject missing or empty studentId', () => {
    const { nextCalled, responseStatus, responseData } = runMiddleware({
      studentId: '   ',
      amount: 100,
      customerName: 'Rahul',
      customerEmail: 'rahul@example.com',
      customerPhone: '9876543210',
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(responseStatus, 400);
    assert.ok(responseData.errors.some(e => e.includes('studentId')));
  });

  it('should reject zero or negative amount', () => {
    const zeroTest = runMiddleware({
      studentId: 'STU1001',
      amount: 0,
      customerName: 'Rahul',
      customerEmail: 'rahul@example.com',
      customerPhone: '9876543210',
    });
    assert.strictEqual(zeroTest.nextCalled, false);
    assert.strictEqual(zeroTest.responseStatus, 400);
    assert.ok(zeroTest.responseData.errors.some(e => e.includes('greater than zero')));

    const negTest = runMiddleware({
      studentId: 'STU1001',
      amount: -50,
      customerName: 'Rahul',
      customerEmail: 'rahul@example.com',
      customerPhone: '9876543210',
    });
    assert.strictEqual(negTest.nextCalled, false);
    assert.strictEqual(negTest.responseStatus, 400);
  });

  it('should reject amounts with more than two decimal places', () => {
    const { nextCalled, responseStatus, responseData } = runMiddleware({
      studentId: 'STU1001',
      amount: 100.125,
      customerName: 'Rahul',
      customerEmail: 'rahul@example.com',
      customerPhone: '9876543210',
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(responseStatus, 400);
    assert.ok(responseData.errors.some(e => e.includes('two decimal places')));
  });

  it('should reject invalid email format', () => {
    const { nextCalled, responseStatus, responseData } = runMiddleware({
      studentId: 'STU1001',
      amount: 100,
      customerName: 'Rahul',
      customerEmail: 'invalid-email-address',
      customerPhone: '9876543210',
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(responseStatus, 400);
    assert.ok(responseData.errors.some(e => e.includes('valid email address')));
  });

  it('should reject non-10-digit phone number', () => {
    const { nextCalled, responseStatus, responseData } = runMiddleware({
      studentId: 'STU1001',
      amount: 100,
      customerName: 'Rahul',
      customerEmail: 'rahul@example.com',
      customerPhone: '12345',
    });

    assert.strictEqual(nextCalled, false);
    assert.strictEqual(responseStatus, 400);
    assert.ok(responseData.errors.some(e => e.includes('10-digit mobile number')));
  });
});

