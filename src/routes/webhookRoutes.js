const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

/**
 * @route   POST /api/webhooks/cashfree
 * @desc    Receive and process Cashfree webhook notifications
 * @access  Public (Signature verified)
 */
router.post('/cashfree', paymentController.handleWebhook);

module.exports = router;

