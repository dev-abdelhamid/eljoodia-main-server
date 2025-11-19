const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult, param, query } = require('express-validator');
const { createReturn, approveReturn, getAll, getById, getBranches, getAvailableStock, getProducts } = require('../controllers/returnController');
const Return = require('../models/Return');
const mongoose = require('mongoose');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

router.get(
  '/',
  [auth, authorize('branch', 'production', 'admin')],
  getAll
);

router.post(
  '/',
  [
    auth,
    authorize('branch'),
    body('branchId').custom((value) => isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الفرع غير صالح' : 'Invalid branch ID'),
    body('items').isArray({ min: 1 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'يجب إدخال عنصر واحد على الأقل' : 'At least one item is required'),
    body('items.*.product').custom((value) => isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف المنتج غير صالح' : 'Invalid product ID'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الكمية يجب أن تكون عدد صحيح إيجابي' : 'Quantity must be a positive integer'),
    body('items.*.reason').isIn(['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى']).withMessage((_, { req }) => req.query.lang === 'ar' ? 'سبب الإرجاع غير صالح' : 'Invalid return reason'),
    body('notes').optional().trim(),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const isRtl = req.query.lang === 'ar';
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array().map(err => ({
          field: err.param,
          message: err.msg,
          value: err.value,
        })),
      });
    }
    next();
  },
  createReturn
);

router.put(
  '/:id',
  [
    auth,
    authorize('production', 'admin'),
    param('id').custom((value) => isValidObjectId(value)).withMessage((_, { req }) => req.query.lang === 'ar' ? 'معرف الإرجاع غير صالح' : 'Invalid return ID'),
    body('status').isIn(['approved', 'rejected']).withMessage((_, { req }) => req.query.lang === 'ar' ? 'الحالة يجب أن تكون إما موافق عليها أو مرفوضة' : 'Status must be either approved or rejected'),
    body('reviewNotes').optional().trim(),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const isRtl = req.query.lang === 'ar';
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array().map(err => ({
          field: err.param,
          message: err.msg,
          value: err.value,
        })),
      });
    }
    next();
  },
  approveReturn
);

router.get(
  '/branches',
  [auth, authorize('branch', 'production', 'admin')],
  getBranches
);

router.get(
  '/products',
  [auth, authorize('branch', 'production', 'admin')],
  getProducts
);

router.get(
  '/:id',
  [auth, authorize('branch', 'production', 'admin')],
  getById
);

router.get(
  '/inventory/available',
  [auth, authorize('branch', 'production', 'admin')],
  getAvailableStock
);

module.exports = router;