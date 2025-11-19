const rateLimit = require('express-rate-limit');

/**
 * Rate limiter for confirming delivery
 */
const confirmDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'طلبات تأكيد التوصيل كثيرة جدًا، حاول مرة أخرى لاحقًا',
  headers: true,
});

/**
 * Rate limiter for notification endpoints
 */
const notificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'طلبات الإشعارات كثيرة جدًا، حاول مرة أخرى لاحقًا',
  headers: true,
});

module.exports = {
  confirmDeliveryLimiter,
  notificationLimiter,
};