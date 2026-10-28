/**
 * Middleware to validate payment initiation payload.
 */
function validatePayment(req, res, next) {
  const { studentId, amount, currency, customerName, customerEmail, customerPhone } = req.body;
  const errors = [];

  // studentId validation
  if (!studentId || typeof studentId !== 'string' || !studentId.trim()) {
    errors.push('studentId is required and must be a non-empty string.');
  }

  // amount validation
  const numAmount = Number(amount);
  if (amount === undefined || amount === null || isNaN(numAmount) || !isFinite(numAmount)) {
    errors.push('amount is required and must be a valid number.');
  } else if (numAmount <= 0) {
    errors.push('amount must be greater than zero.');
  } else {
    // Check decimal precision (at most 2 decimal places)
    const amountStr = String(amount);
    const decimalParts = amountStr.split('.');
    if (decimalParts.length > 1 && decimalParts[1].length > 2) {
      errors.push('amount cannot have more than two decimal places.');
    }
  }

  // currency validation (optional, defaults to INR)
  let validatedCurrency = 'INR';
  if (currency !== undefined && currency !== null) {
    if (typeof currency !== 'string' || currency.trim().toUpperCase() !== 'INR') {
      errors.push('currency must be "INR" for current integration.');
    } else {
      validatedCurrency = currency.trim().toUpperCase();
    }
  }

  // customerName validation
  if (!customerName || typeof customerName !== 'string' || customerName.trim().length < 2) {
    errors.push('customerName is required and must be at least 2 characters.');
  }

  // customerEmail validation
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!customerEmail || typeof customerEmail !== 'string' || !emailRegex.test(customerEmail.trim())) {
    errors.push('customerEmail is required and must be a valid email address.');
  }

  // customerPhone validation (10 digits for mobile numbers)
  const phoneRegex = /^[0-9]{10}$/;
  const cleanPhone = typeof customerPhone === 'string' ? customerPhone.trim() : String(customerPhone || '');
  if (!customerPhone || !phoneRegex.test(cleanPhone)) {
    errors.push('customerPhone is required and must be a valid 10-digit mobile number/phone.');
  }

  if (errors.length > 0) {
    return res.status(400).json({
      status: 'FAIL',
      message: 'Validation failed',
      errors,
    });
  }

  // Normalize validated values on request object
  req.validatedPayment = {
    studentId: studentId.trim(),
    amount: Number(numAmount.toFixed(2)),
    currency: validatedCurrency,
    customerName: customerName.trim(),
    customerEmail: customerEmail.trim().toLowerCase(),
    customerPhone: cleanPhone,
  };

  next();
}

module.exports = validatePayment;
