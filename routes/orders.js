const express = require('express');
const { body, param } = require('express-validator');
const {
  createOrder,
  getOrders,
  updateOrderStatus,
  assignChefs,
  confirmDelivery,
  getOrderById,
  checkOrderExists
} = require('../controllers/orderController');

const {
  createTask,
  getTasks,
  getChefTasks,
  updateTaskStatus
} = require('../controllers/productionController');
const { auth, authorize } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const confirmDeliveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests to confirm delivery, please try again later',
  headers: true,
});

router.get('/:id/check', [
  auth,
  param('id').isMongoId().withMessage('Invalid order ID'),
], checkOrderExists);

router.post('/tasks', [
  auth,
  authorize('admin', 'production'),
  body('order').isMongoId().withMessage('Invalid order ID'),
  body('product').isMongoId().withMessage('Invalid product ID'),
  body('chef').isMongoId().withMessage('Invalid chef ID'),
  body('quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('itemId').isMongoId().withMessage('Invalid itemId'),
], createTask);

router.get('/tasks', auth, getTasks);

router.get('/tasks/chef/:chefId', [
  auth,
  authorize('chef'),
  param('chefId').isMongoId().withMessage('Invalid chef ID'),
], getChefTasks);

router.post('/', [
  auth,
  authorize('branch'),
  body('items').isArray({ min: 1 }).withMessage('Items are required'),
  body('items.*.product').isMongoId().withMessage('Invalid product ID'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('items.*.price').isNumeric({ min: 0 }).withMessage('Price must be non-negative'),
], createOrder);

router.get('/', auth, getOrders);

router.get('/:id', [
  auth,
  param('id').isMongoId().withMessage('Invalid order ID'),
], getOrderById);

router.patch('/:id/status', [
  auth,
  authorize('production', 'admin'),
  param('id').isMongoId().withMessage('Invalid order ID'),
  body('status').isIn(['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled']).withMessage('Invalid status'),
  body('rejectedItems').optional().isArray(),
  body('rejectedItems.*.itemId').isMongoId().withMessage('Invalid item ID'),
  body('rejectedItems.*.reason').isString().trim().isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'كمية ناقصة', 'نفاد المخزون', 'غير متاح', 'أخرى', '']).withMessage('Invalid reject reason'),
], updateOrderStatus);

router.patch(
  '/:id/confirm-delivery',
  auth,
  authorize('branch'),
  [
    param('id').isMongoId().withMessage('معرف الطلب غير صالح'),
    
    body('items').isArray({ min: 1 }).withMessage('مصفوفة العناصر مطلوبة'),
    body('items.*.itemId')
      .isMongoId()
      .withMessage('معرف العنصر غير صالح'),   

    body('items.*.receivedQuantity'),

    body('items.*.rejected')
      .optional()
      .isBoolean(),

    body('items.*.rejectReason')
      .optional()
      .isString()
      .trim()
  ],
  confirmDelivery
);

router.patch('/:orderId/tasks/:taskId/status', [
  auth,
  authorize('chef'),
  body('status').isIn(['pending', 'in_progress', 'completed' , 'rejected']).withMessage('Invalid task status'),
], updateTaskStatus);

router.patch('/:id/assign', [
  auth,
  authorize('production', 'admin'),
  body('items').isArray({ min: 1 }).withMessage('Items array is required'),
  body('items.*.itemId').isMongoId().withMessage('Invalid itemId'),
  body('items.*.assignedTo').optional().isMongoId().withMessage('Invalid assignedTo'),
  body('items.*.rejected').optional().isBoolean(),
  body('items.*.rejectReason').optional().isString().trim().isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'كمية ناقصة', 'نفاد المخزون', 'غير متاح', 'أخرى', '']).withMessage('Invalid reject reason'),
], assignChefs);

module.exports = router;