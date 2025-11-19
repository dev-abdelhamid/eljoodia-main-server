// routes/factoryOrderRoutes.js
const express = require('express');
const { body, param, query } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  createFactoryOrder,
  getFactoryOrders,
  getFactoryOrderById,
  assignFactoryChefs,
  updateFactoryOrderStatus,
  confirmFactoryProduction,
  approveFactoryOrder,
  updateItemStatus,
  getAvailableProducts
} = require('../controllers/factoryOrderController');
const router = express.Router();
const validateOrderId = [
  param('id').isMongoId().withMessage((value, { req }) => req.query.isRtl === 'true' ? 'معرف الطلب غير صالح' : 'Invalid order ID'),
];
router.post(
  '/',
  [
    auth,
    authorize('chef', 'production', 'admin'),
    body('orderNumber').trim().notEmpty().withMessage((value, { req }) => req.query.isRtl === 'true' ? 'رقم الطلب مطلوب' : 'Order number is required'),
    body('items').isArray({ min: 1 }).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'العناصر مطلوبة' : 'Items are required'),
    body('items.*.product').isMongoId().withMessage((value, { req }) => req.query.isRtl === 'true' ? 'معرف المنتج غير صالح' : 'Invalid product ID'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'الكمية يجب أن تكون على الأقل 1' : 'Quantity must be at least 1'),
    body('notes').optional().isString().trim(),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'الأولوية غير صالحة' : 'Invalid priority'),
  ],
  createFactoryOrder
);
router.get(
  '/',
  [
    auth,
    authorize('chef', 'production', 'admin'),
    query('status').optional().isIn(['requested', 'pending', 'approved', 'in_production', 'completed', 'cancelled']).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'حالة غير صالحة' : 'Invalid status'),
    query('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'الأولوية غير صالحة' : 'Invalid priority'),
  ],
  getFactoryOrders
);
router.get('/:id', [auth, authorize('chef', 'production', 'admin'), ...validateOrderId], getFactoryOrderById);
router.patch(
  '/:id/assign',
  [
    auth,
    authorize('production', 'admin'),
    ...validateOrderId,
    body('items').isArray({ min: 1 }).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'مصفوفة العناصر مطلوبة' : 'Items array is required'),
    body('items.*.itemId').isMongoId().withMessage((value, { req }) => req.query.isRtl === 'true' ? 'معرف العنصر غير صالح' : 'Invalid itemId'),
    body('items.*.assignedTo').isMongoId().withMessage((value, { req }) => req.query.isRtl === 'true' ? 'معرف الشيف غير صالح' : 'Invalid assignedTo'),
    body('notes').optional().isString().trim(),
  ],
  assignFactoryChefs
);
router.patch(
  '/:id/status',
  [
    auth,
    authorize('chef', 'production', 'admin'),
    ...validateOrderId,
    body('status').isIn(['requested', 'pending', 'approved', 'in_production', 'completed', 'cancelled']).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'حالة غير صالحة' : 'Invalid status'),
  ],
  updateFactoryOrderStatus
);
router.patch('/:id/approve', [auth, authorize('production', 'admin'), ...validateOrderId], approveFactoryOrder);
router.patch('/:id/items/:itemId/status', [
  auth,
  authorize('chef', 'production', 'admin'),
  param('itemId').isMongoId().withMessage((value, { req }) => req.query.isRtl === 'true' ? 'معرف العنصر غير صالح' : 'Invalid item ID'),
  body('status').isIn(['pending', 'assigned', 'in_progress', 'completed']).withMessage((value, { req }) => req.query.isRtl === 'true' ? 'حالة العنصر غير صالحة' : 'Invalid item status'),
], updateItemStatus);
router.patch('/:id/confirm-production', [auth, authorize('production', 'admin'), ...validateOrderId], confirmFactoryProduction);
router.get('/available-products', [auth, authorize('chef', 'production', 'admin')], getAvailableProducts);
module.exports = router; 