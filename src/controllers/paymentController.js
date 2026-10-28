const paymentService = require('../services/paymentService');

/**
 * Controller to handle POST /api/payments
 */
async function createPayment(req, res, next) {
  try {
    const paymentData = req.validatedPayment;

    const result = await paymentService.initiatePayment(paymentData);

    return res.status(201).json({
      status: 'SUCCESS',
      message: 'Payment order created successfully',
      data: {
        orderId: result.orderId,
        status: result.status,
        paymentSessionId: result.paymentSessionId,
        cfOrderId: result.cfOrderId,
        amount: result.amount,
        currency: result.currency,
        createdAt: result.createdAt,
      },
    });
  } catch (error) {
    if (error.cashfreeDetails) {
      return res.status(error.status || 502).json({
        status: 'ERROR',
        message: error.message,
        code: error.code || 'GATEWAY_ERROR',
      });
    }

    if (error.code === 'CASHFREE_CREDENTIALS_MISSING') {
      return res.status(500).json({
        status: 'ERROR',
        message: error.message,
        code: error.code,
      });
    }

    next(error);
  }
}

/**
 * Controller to handle GET /api/payments/:orderId
 */
async function getPaymentStatus(req, res, next) {
  try {
    const { orderId } = req.params;

    const result = await paymentService.getPaymentStatus(orderId);

    return res.status(200).json({
      status: 'SUCCESS',
      data: result,
    });
  } catch (error) {
    if (error.status === 404 || error.code === 'ORDER_NOT_FOUND') {
      return res.status(404).json({
        status: 'FAIL',
        message: error.message,
      });
    }

    if (error.status === 400) {
      return res.status(400).json({
        status: 'FAIL',
        message: error.message,
      });
    }

    next(error);
  }
}

/**
 * Controller to handle POST /api/webhooks/cashfree
 */
async function handleWebhook(req, res, next) {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const rawBody = req.rawBody || JSON.stringify(req.body);

    const result = await paymentService.processWebhookEvent({
      payload: req.body,
      rawBody,
      signature,
      timestamp,
    });

    return res.status(200).json({
      status: 'SUCCESS',
      message: result.message,
      data: {
        orderId: result.orderId,
        status: result.status,
      },
    });
  } catch (error) {
    if (error.status === 401 || error.code === 'INVALID_WEBHOOK_SIGNATURE') {
      return res.status(401).json({
        status: 'FAIL',
        message: error.message,
      });
    }

    if (error.status === 400 || error.code === 'MALFORMED_WEBHOOK_PAYLOAD' || error.code === 'INVALID_EVENT_DATA') {
      return res.status(400).json({
        status: 'FAIL',
        message: error.message,
      });
    }

    if (error.status === 404 || error.code === 'ORDER_NOT_FOUND') {
      return res.status(404).json({
        status: 'FAIL',
        message: error.message,
      });
    }

    next(error);
  }
}

module.exports = {
  createPayment,
  getPaymentStatus,
  handleWebhook,
};
