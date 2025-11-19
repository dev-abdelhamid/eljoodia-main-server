const express = require('express');
const { body, query, param } = require('express-validator');
const { auth, authorize } = require('../middleware/auth');
const {
  getInventory,
  getInventoryByBranch,
  updateStock,
  getInventoryHistory,
  createInventory,
  bulkCreate,
} = require('../controllers/inventory');
const mongoose = require('mongoose');

const router = express.Router();

router.get(
  '/',
  auth,
  authorize('branch', 'admin' , 'production'),
  [
    query('branch').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    query('product').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    query('department').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف القسم غير صالح'),
    query('lowStock').optional().isBoolean().withMessage('حالة المخزون المنخفض يجب أن تكون قيمة منطقية'),
    query('stockStatus').optional().isIn(['low', 'normal', 'high']).withMessage('حالة المخزون يجب أن تكون low، normal، أو high'),
  ],
  getInventory
);

router.get(
  '/branch/:branchId',
  auth,
  authorize('branch', 'admin'),
  [
    param('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    query('department').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف القسم غير صالح'),
    query('stockStatus').optional().isIn(['low', 'normal', 'high']).withMessage('حالة المخزون يجب أن تكون low، normal، أو high'),
  ],
  getInventoryByBranch
);

router.put(
  '/:id',
  auth,
  authorize('admin ', 'production' , 'branch'),
  [
    param('id').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المخزون غير صالح'),
    body('currentStock').optional().isInt({ min: 0 }).withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
    body('minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
  ],
  updateStock
);

router.post(
  '/',
  auth,
  authorize('branch', 'admin'),
  [
    body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    body('productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    body('userId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المستخدم غير صالح'),
    body('currentStock').isInt({ min: 0 }).withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
    body('minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
    body('orderId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الطلبية غير صالح'),
  ],
  createInventory
);

router.post(
  '/bulk',
  auth,
  authorize('branch', 'admin'),
  [
    body('branchId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    body('userId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المستخدم غير صالح'),
    body('orderId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الطلبية غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId').custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    body('items.*.currentStock').isInt({ min: 0 }).withMessage('الكمية الحالية يجب أن تكون عددًا غير سالب'),
    body('items.*.minStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأدنى للمخزون يجب أن يكون عددًا غير سالب'),
    body('items.*.maxStockLevel').optional().isInt({ min: 0 }).withMessage('الحد الأقصى للمخزون يجب أن يكون عددًا غير سالب'),
  ],
  bulkCreate
);

router.get(
  '/history',
  auth,
  authorize('branch', 'admin' , 'production'),
  [
    query('branchId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف الفرع غير صالح'),
    query('productId').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف المنتج غير صالح'),
    query('department').optional().custom((value) => mongoose.isValidObjectId(value)).withMessage('معرف القسم غير صالح'),
    query('period').optional().isIn(['daily', 'weekly', 'monthly']).withMessage('الفترة يجب أن تكون يومية، أسبوعية، أو شهرية'),
  ],
  getInventoryHistory
);

module.exports = router;