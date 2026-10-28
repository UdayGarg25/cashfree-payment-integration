const express = require('express');
const router = express.Router();
const validatePayment = require('../middleware/validatePayment');
const paymentController = require('../controllers/paymentController');

/**
 * @route   POST /api/payments
 * @desc    Create a payment order and return payment session ID
 * @access  Public
 */
router.post('/', validatePayment, paymentController.createPayment);

/**
 * @route   GET /api/payments/:orderId
 * @desc    Get status of an existing payment order
 * @access  Public
 */
router.get('/:orderId', paymentController.getPaymentStatus);

module.exports = router;
