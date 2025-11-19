// Fixed backend code (sales.js)
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const { body, validationResult, query } = require('express-validator');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Return = require('../models/Return');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Create a sale
router.post(
  '/',
  [
    auth,
    authorize('branch', 'admin'),
    body('branch').isMongoId().withMessage('معرف الفرع غير صالح'),
    body('items').isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId').isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.unitPrice').isFloat({ min: 0 }).withMessage('السعر يجب أن يكون رقمًا غير سالب'),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const errors = validationResult(req);
      const { branch, items, paymentMethod, customerName, customerPhone, notes, lang = 'ar' } = req.body;
      const isRtl = lang === 'ar';

      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] إنشاء بيع - أخطاء التحقق:`, errors.array());
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
      }

      if (req.user.role === 'branch' && (!req.user.branchId || branch !== req.user.branchId.toString())) {
        console.error(`[${new Date().toISOString()}] إنشاء بيع - غير مخول أو لا يوجد فرع مخصص:`, {
          userId: req.user.id,
          branch,
          userBranchId: req.user.branchId,
        });
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول أو لا يوجد فرع مخصص' : 'Unauthorized or no branch assigned' });
      }

      const branchDoc = await Branch.findById(branch).session(session);
      if (!branchDoc) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] إنشاء بيع - الفرع غير موجود:`, { branch });
        return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
      }

      for (const item of items) {
        const product = await Product.findById(item.productId).session(session);
        if (!product) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] إنشاء بيع - المنتج غير موجود:`, { productId: item.productId });
          return res.status(404).json({ success: false, message: isRtl ? `المنتج ${item.productId} غير موجود` : `Product ${item.productId} not found` });
        }
        const inventory = await Inventory.findOne({ branch, product: item.productId }).session(session);
        if (!inventory || inventory.currentStock < item.quantity) {
          await session.abortTransaction();
          console.error(`[${new Date().toISOString()}] إنشاء بيع - الكمية غير كافية:`, {
            productId: item.productId,
            currentStock: inventory?.currentStock,
            requestedQuantity: item.quantity,
          });
          return res.status(400).json({
            success: false,
            message: isRtl ? `الكمية غير كافية في المخزون للمنتج ${item.productId}` : `Insufficient stock for product ${item.productId}`,
            error: 'insufficient_stock',
          });
        }
      }

      const saleCount = await Sale.countDocuments().session(session);
      const saleNumber = `SALE-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${saleCount + 1}`;

      const newSale = new Sale({
        saleNumber,
        branch,
        items: items.map((item) => ({
          product: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
        totalAmount: items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
        status: 'completed',
        paymentMethod: paymentMethod || 'cash',
        customerName: customerName?.trim(),
        customerPhone: customerPhone?.trim(),
        notes: notes?.trim(),
        createdBy: req.user.id,
      });

      await newSale.save({ session });

      for (const item of items) {
        const inventory = await Inventory.findOneAndUpdate(
          { branch, product: item.productId },
          {
            $inc: { currentStock: -item.quantity },
            $push: {
              movements: {
                type: 'out',
                quantity: item.quantity,
                reference: `بيع #${saleNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { new: true, session }
        );

        const historyEntry = new InventoryHistory({
          product: item.productId,
          branch,
          action: 'sale',
          quantity: -item.quantity,
          reference: `بيع #${saleNumber}`,
          referenceType: 'sale',
          referenceId: newSale._id,
          createdBy: req.user.id,
          notes: notes?.trim(),
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId: branch,
          productId: item.productId,
          quantity: inventory.currentStock,
          type: 'sale',
        });
      }

      const populatedSale = await Sale.findById(newSale._id)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username')
        .session(session)
        .lean();

      populatedSale.branch.displayName = isRtl ? populatedSale.branch.name : (populatedSale.branch.nameEn || populatedSale.branch.name || 'Unknown');
      populatedSale.items = populatedSale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'منتج محذوف',
        productNameEn: item.product?.nameEn || null,
        displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
            }
          : undefined,
      }));

      req.io?.emit('saleCreated', {
        saleId: newSale._id,
        branchId: branch,
        saleNumber,
        items,
        totalAmount: newSale.totalAmount,
        createdAt: newSale.createdAt.toISOString(),
      });

      console.log(`[${new Date().toISOString()}] إنشاء بيع - تم بنجاح:`, {
        saleId: newSale._id,
        branchId: branch,
        itemsCount: items.length,
      });

      await session.commitTransaction();
      res.status(201).json(populatedSale);
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] خطأ في إنشاء المبيعة:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Update sale
router.put(
  '/:id',
  [
    auth,
    authorize('branch', 'admin'),
    body('items').optional().isArray({ min: 1 }).withMessage('يجب أن تحتوي العناصر على عنصر واحد على الأقل'),
    body('items.*.productId').optional().isMongoId().withMessage('معرف المنتج غير صالح'),
    body('items.*.quantity').optional().isInt({ min: 1 }).withMessage('الكمية يجب أن تكون عددًا صحيحًا إيجابيًا'),
    body('items.*.unitPrice').optional().isFloat({ min: 0 }).withMessage('السعر يجب أن يكون رقمًا غير سالب'),
    body('paymentMethod').optional().isIn(['cash', 'credit_card', 'bank_transfer']).withMessage('طريقة الدفع غير صالحة'),
    body('customerName').optional().isString().trim(),
    body('customerPhone').optional().isString().trim(),
    body('notes').optional().isString().trim(),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const errors = validationResult(req);
      const { id } = req.params;
      const { items, paymentMethod, customerName, customerPhone, notes, lang = 'ar' } = req.body;
      const isRtl = lang === 'ar';

      if (!errors.isEmpty()) {
        console.error(`[${new Date().toISOString()}] تحديث بيع - أخطاء التحقق:`, errors.array());
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
      }

      if (!isValidObjectId(id)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرف بيع غير صالح' : 'Invalid sale ID' });
      }

      const sale = await Sale.findById(id).session(session);
      if (!sale) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
      }

      if (req.user.role === 'branch' && sale.branch.toString() !== req.user.branchId.toString()) {
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لك بالوصول' : 'Unauthorized access' });
      }

      for (const item of sale.items) {
        const inventory = await Inventory.findOneAndUpdate(
          { branch: sale.branch, product: item.product },
          {
            $inc: { currentStock: item.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: item.quantity,
                reference: `تحديث بيع #${sale.saleNumber} (استعادة)`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { new: true, session }
        );

        const historyEntry = new InventoryHistory({
          product: item.product,
          branch: sale.branch,
          action: 'sale_update_restore',
          quantity: item.quantity,
          reference: `تحديث بيع #${sale.saleNumber}`,
          referenceType: 'sale',
          referenceId: sale._id,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId: sale.branch.toString(),
          productId: item.product.toString(),
          quantity: inventory.currentStock,
          type: 'sale_update_restore',
        });
      }

      if (paymentMethod) sale.paymentMethod = paymentMethod;
      if (customerName !== undefined) sale.customerName = customerName?.trim();
      if (customerPhone !== undefined) sale.customerPhone = customerPhone?.trim();
      if (notes !== undefined) sale.notes = notes?.trim();

      if (items) {
        for (const item of items) {
          const product = await Product.findById(item.productId).session(session);
          if (!product) {
            await session.abortTransaction();
            return res.status(404).json({ success: false, message: isRtl ? `المنتج ${item.productId} غير موجود` : `Product ${item.productId} not found` });
          }
          const inventory = await Inventory.findOne({ branch: sale.branch, product: item.productId }).session(session);
          if (!inventory || inventory.currentStock < item.quantity) {
            await session.abortTransaction();
            return res.status(400).json({
              success: false,
              message: isRtl ? `الكمية غير كافية للمنتج ${item.productId}` : `Insufficient stock for product ${item.productId}`,
            });
          }
        }

        sale.items = items.map((item) => ({
          product: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        }));
        sale.totalAmount = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

        for (const item of items) {
          const inventory = await Inventory.findOneAndUpdate(
            { branch: sale.branch, product: item.productId },
            {
              $inc: { currentStock: -item.quantity },
              $push: {
                movements: {
                  type: 'out',
                  quantity: item.quantity,
                  reference: `تحديث بيع #${sale.saleNumber}`,
                  createdBy: req.user.id,
                  createdAt: new Date(),
                },
              },
            },
            { new: true, session }
          );

          const historyEntry = new InventoryHistory({
            product: item.productId,
            branch: sale.branch,
            action: 'sale_update_deduct',
            quantity: -item.quantity,
            reference: `تحديث بيع #${sale.saleNumber}`,
            referenceType: 'sale',
            referenceId: sale._id,
            createdBy: req.user.id,
          });
          await historyEntry.save({ session });

          req.io?.emit('inventoryUpdated', {
            branchId: sale.branch.toString(),
            productId: item.productId,
            quantity: inventory.currentStock,
            type: 'sale_update_deduct',
          });
        }
      }

      await sale.save({ session });

      const populatedSale = await Sale.findById(id)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username')
        .session(session)
        .lean();

      populatedSale.branch.displayName = isRtl ? populatedSale.branch.name : (populatedSale.branch.nameEn || populatedSale.branch.name || 'Unknown');
      populatedSale.items = populatedSale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'منتج محذوف',
        productNameEn: item.product?.nameEn || null,
        displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
            }
          : undefined,
      }));

      req.io?.emit('saleUpdated', {
        saleId: id,
        branchId: sale.branch.toString(),
      });

      console.log(`[${new Date().toISOString()}] تحديث بيع - تم بنجاح:`, { saleId: id });

      await session.commitTransaction();
      res.json(populatedSale);
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] خطأ في تحديث البيع:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

// Get all sales
router.get(
  '/',
  [auth, authorize('branch', 'admin')],
  async (req, res) => {
    const { branch, startDate, endDate, page = 1, limit = 20, sort = '-createdAt', lang = 'ar' } = req.query;
    const isRtl = lang === 'ar';
    try {
      const query = {};

      if (branch && isValidObjectId(branch)) {
        query.branch = branch;
      } else if (req.user.role === 'branch') {
        if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
          console.error(`[${new Date().toISOString()}] جلب المبيعات - لا يوجد فرع مخصص:`, {
            userId: req.user.id,
            branchId: req.user.branchId,
          });
          return res.status(400).json({ success: false, message: isRtl ? 'لا يوجد فرع مخصص' : 'No branch assigned' });
        }
        query.branch = req.user.branchId;
      }

      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
      }

      const total = await Sale.countDocuments(query);
      const sales = await Sale.find(query)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username')
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean();

      const saleIds = sales.map((s) => s._id);
      const returns = await Return.find({ sale: { $in: saleIds } })
        .populate('sale', 'saleNumber')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn',
        })
        .lean();

      const transformedSales = sales.map((sale) => ({
        ...sale,
        orderNumber: sale.saleNumber,
        branch: sale.branch
          ? {
              ...sale.branch,
              displayName: isRtl ? sale.branch.name : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
            }
          : undefined,
        items: (sale.items || []).map((item) => ({
          ...item,
          productName: item.product?.name || 'منتج محذوف',
          productNameEn: item.product?.nameEn || null,
          displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
          displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
          department: item.product?.department
            ? {
                ...item.product.department,
                displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
              }
            : undefined,
        })),
        createdAt: sale.createdAt.toISOString(),
        status: sale.status,
        paymentMethod: sale.paymentMethod,
        customerName: sale.customerName,
        customerPhone: sale.customerPhone,
        notes: sale.notes,
        createdBy: sale.createdBy?.username || 'Unknown',
        returns: (returns || [])
          .filter((ret) => ret.sale?._id.toString() === sale._id.toString())
          .map((ret) => ({
            _id: ret._id,
            returnNumber: ret.returnNumber,
            status: ret.status,
            items: (ret.items || []).map((item) => ({
              product: item.product?._id || item.product,
              productName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
              productNameEn: item.product?.nameEn || null,
              quantity: item.quantity,
              reason: item.reason,
            })),
            reason: ret.reason,
            createdAt: ret.createdAt.toISOString(),
          })),
      }));

      res.json({ success: true, sales: transformedSales, total, returns });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] خطأ في جلب المبيعات:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Sales analytics endpoint (for admin)
router.get(
  '/analytics',
  [auth, authorize('admin' , 'production')],
  async (req, res) => {
    try {
      await mongoose.connection; // Ensure DB connection
      const { branch, startDate, endDate, lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';
      const query = {};

      if (branch && isValidObjectId(branch)) {
        query.branch = new mongoose.Types.ObjectId(branch);
      }
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
      }

      const totalSales = await Sale.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalSales: { $sum: '$totalAmount' },
            totalCount: { $sum: 1 },
            averageOrderValue: { $avg: '$totalAmount' },
          },
        },
      ]).catch(() => [{ totalSales: 0, totalCount: 0, averageOrderValue: 0 }]);

      const branchSales = await Sale.aggregate([
        { $match: query },
        {
          $group: {
            _id: '$branch',
            totalSales: { $sum: '$totalAmount' },
            saleCount: { $sum: 1 },
            averageOrderValue: { $avg: '$totalAmount' },
          },
        },
        {
          $lookup: {
            from: 'branches',
            localField: '_id',
            foreignField: '_id',
            as: 'branch',
          },
        },
        { $unwind: '$branch' },
        {
          $project: {
            branchId: '$_id',
            branchName: '$branch.name',
            branchNameEn: '$branch.nameEn',
            displayName: isRtl ? '$branch.name' : { $ifNull: ['$branch.nameEn', '$branch.name', 'Unknown'] },
            totalSales: 1,
            saleCount: 1,
            averageOrderValue: { $round: ['$averageOrderValue', 2] },
          },
        },
        { $sort: { totalSales: -1 } },
        { $limit: 10 },
      ]).catch(() => []);

      const leastBranchSales = await Sale.aggregate([
        { $match: query },
        {
          $group: {
            _id: '$branch',
            totalSales: { $sum: '$totalAmount' },
            saleCount: { $sum: 1 },
            averageOrderValue: { $avg: '$totalAmount' },
          },
        },
        {
          $lookup: {
            from: 'branches',
            localField: '_id',
            foreignField: '_id',
            as: 'branch',
          },
        },
        { $unwind: '$branch' },
        {
          $project: {
            branchId: '$_id',
            branchName: '$branch.name',
            branchNameEn: '$branch.nameEn',
            displayName: isRtl ? '$branch.name' : { $ifNull: ['$branch.nameEn', '$branch.name', 'Unknown'] },
            totalSales: 1,
            saleCount: 1,
            averageOrderValue: { $round: ['$averageOrderValue', 2] },
          },
        },
        { $sort: { totalSales: 1 } },
        { $limit: 10 },
      ]).catch(() => []);

      const productSales = await Sale.aggregate([
        { $match: query },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
          },
        },
        {
          $lookup: {
            from: 'products',
            localField: '_id',
            foreignField: '_id',
            as: 'product',
            pipeline: [{ $project: { name: 1, nameEn: 1 } }],
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            productId: '$_id',
            productName: { $ifNull: ['$product.name', 'منتج محذوف'] },
            productNameEn: '$product.nameEn',
            displayName: isRtl ? { $ifNull: ['$product.name', 'منتج محذوف'] } : { $ifNull: ['$product.nameEn', '$product.name', 'Deleted Product'] },
            totalQuantity: 1,
            totalRevenue: 1,
          },
        },
        { $sort: { totalQuantity: -1 } },
        { $limit: 10 },
      ]).catch(() => []);

      const leastProductSales = await Sale.aggregate([
        { $match: query },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
          },
        },
        {
          $lookup: {
            from: 'products',
            localField: '_id',
            foreignField: '_id',
            as: 'product',
            pipeline: [{ $project: { name: 1, nameEn: 1 } }],
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            productId: '$_id',
            productName: { $ifNull: ['$product.name', 'منتج محذوف'] },
            productNameEn: '$product.nameEn',
            displayName: isRtl ? { $ifNull: ['$product.name', 'منتج محذوف'] } : { $ifNull: ['$product.nameEn', '$product.name', 'Deleted Product'] },
            totalQuantity: 1,
            totalRevenue: 1,
          },
        },
        { $sort: { totalQuantity: 1 } },
        { $limit: 10 },
      ]).catch(() => []);

      const departmentSales = await Sale.aggregate([
        { $match: query },
        { $unwind: '$items' },
        {
          $lookup: {
            from: 'products',
            localField: 'items.product',
            foreignField: '_id',
            as: 'product',
            pipeline: [{ $project: { department: 1, name: 1, nameEn: 1 } }],
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: '$product.department',
            totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
            totalQuantity: { $sum: '$items.quantity' },
          },
        },
        {
          $lookup: {
            from: 'departments',
            localField: '_id',
            foreignField: '_id',
            as: 'department',
            pipeline: [{ $project: { name: 1, nameEn: 1 } }],
          },
        },
        { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            departmentId: '$_id',
            departmentName: { $ifNull: ['$department.name', 'غير معروف'] },
            departmentNameEn: '$department.nameEn',
            displayName: isRtl ? { $ifNull: ['$department.name', 'غير معروف'] } : { $ifNull: ['$department.nameEn', '$department.name', 'Unknown'] },
            totalRevenue: 1,
            totalQuantity: 1,
          },
        },
        { $sort: { totalRevenue: -1 } },
        { $limit: 10 },
      ]).catch(() => []);

      const leastDepartmentSales = await Sale.aggregate([
        { $match: query },
        { $unwind: '$items' },
        {
          $lookup: {
            from: 'products',
            localField: 'items.product',
            foreignField: '_id',
            as: 'product',
            pipeline: [{ $project: { department: 1, name: 1, nameEn: 1 } }],
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: '$product.department',
            totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
            totalQuantity: { $sum: '$items.quantity' },
          },
        },
        {
          $lookup: {
            from: 'departments',
            localField: '_id',
            foreignField: '_id',
            as: 'department',
            pipeline: [{ $project: { name: 1, nameEn: 1 } }],
          },
        },
        { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            departmentId: '$_id',
            departmentName: { $ifNull: ['$department.name', 'غير معروف'] },
            departmentNameEn: '$department.nameEn',
            displayName: isRtl ? { $ifNull: ['$department.name', 'غير معروف'] } : { $ifNull: ['$department.nameEn', '$department.name', 'Unknown'] },
            totalRevenue: 1,
            totalQuantity: 1,
          },
        },
        { $sort: { totalRevenue: 1 } },
        { $limit: 10 },
      ]).catch(() => []);

      const dateFormat = startDate && endDate && (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24) > 30 ? 'month' : 'day';
      const salesTrends = await Sale.aggregate([
        { $match: query },
        {
          $group: {
            _id: {
              $dateToString: {
                format: dateFormat === 'month' ? '%Y-%m' : '%Y-%m-%d',
                date: '$createdAt',
              },
            },
            totalSales: { $sum: '$totalAmount' },
            saleCount: { $sum: 1 },
          },
        },
        {
          $project: {
            period: '$_id',
            totalSales: 1,
            saleCount: 1,
            _id: 0,
          },
        },
        { $sort: { period: 1 } },
      ]).catch(() => []);

      const topCustomers = await Sale.aggregate([
        { $match: { ...query, customerName: { $ne: null, $ne: '' } } },
        {
          $group: {
            _id: { name: '$customerName', phone: '$customerPhone' },
            totalSpent: { $sum: '$totalAmount' },
            purchaseCount: { $sum: 1 },
          },
        },
        {
          $project: {
            customerName: '$_id.name',
            customerPhone: '$_id.phone',
            totalSpent: 1,
            purchaseCount: 1,
            _id: 0,
          },
        },
        { $sort: { totalSpent: -1 } },
        { $limit: 5 },
      ]).catch(() => []);

      const returnMatch = {};
      if (query.createdAt) returnMatch['saleDoc.createdAt'] = query.createdAt;
      if (query.branch) returnMatch['saleDoc.branch'] = query.branch;

      const returnStats = await Return.aggregate([
        {
          $lookup: {
            from: 'sales',
            localField: 'sale',
            foreignField: '_id',
            as: 'saleDoc',
          },
        },
        { $unwind: '$saleDoc' },
        { $match: returnMatch },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalQuantity: { $sum: { $sum: '$items.quantity' } },
          },
        },
        {
          $project: {
            status: '$_id',
            count: 1,
            totalQuantity: 1,
            _id: 0,
          },
        },
      ]).catch(() => []);

      const topProduct = productSales.length > 0
        ? productSales[0]
        : { productId: null, productName: isRtl ? 'غير معروف' : 'Unknown', displayName: isRtl ? 'غير معروف' : 'Unknown', totalQuantity: 0, totalRevenue: 0 };

      const response = {
        success: true,
        branchSales: branchSales || [],
        leastBranchSales: leastBranchSales || [],
        productSales: productSales || [],
        leastProductSales: leastProductSales || [],
        departmentSales: departmentSales || [],
        leastDepartmentSales: leastDepartmentSales || [],
        totalSales: totalSales[0]?.totalSales || 0,
        totalCount: totalSales[0]?.totalCount || 0,
        averageOrderValue: totalSales[0]?.averageOrderValue ? totalSales[0].averageOrderValue.toFixed(2) : '0.00',
        returnRate: totalSales[0]?.totalCount ? ((returnStats.reduce((sum, stat) => sum + stat.count, 0) / totalSales[0].totalCount) * 100).toFixed(2) : '0.00',
        topProduct,
        salesTrends: salesTrends || [],
        topCustomers: topCustomers || [],
        returnStats: returnStats || [],
      };

      res.json(response);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] خطأ في جلب إحصائيات المبيعات:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Branch analytics endpoint (for branch users)
router.get(
  '/branch-analytics',
  [
    auth,
    authorize('branch'),
    query('startDate').optional().isISO8601().toDate().withMessage('تاريخ البداية غير صالح'),
    query('endDate').optional().isISO8601().toDate().withMessage('تاريخ النهاية غير صالح'),
    query('lang').optional().isIn(['ar', 'en']).withMessage('اللغة غير صالحة'),
  ],
  async (req, res) => {
    try {
      await mongoose.connection; // Ensure DB connection
      const { startDate, endDate, lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';

      // Validate user role and branch
      if (req.user.role !== 'branch' || !req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.error(`[${new Date().toISOString()}] Branch analytics - Invalid user:`, {
          userId: req.user.id,
          role: req.user.role,
          branchId: req.user.branchId,
        });
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول أو لا يوجد فرع مخصص' : 'Unauthorized or no branch assigned' });
      }

      // Validate branch existence
      const branchDoc = await Branch.findById(req.user.branchId);
      if (!branchDoc) {
        console.error(`[${new Date().toISOString()}] Branch analytics - Branch not found:`, { branchId: req.user.branchId });
        return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
      }

      // Build query
      const query = { branch: new mongoose.Types.ObjectId(req.user.branchId) };
      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(new Date(endDate).setHours(23, 59, 59, 999));
      }

      console.log(`[${new Date().toISOString()}] Branch analytics - Query:`, {
        branchId: req.user.branchId,
        startDate: query.createdAt?.$gte,
        endDate: query.createdAt?.$lte,
      });

      // Check for sales
      const saleCount = await Sale.countDocuments(query).catch(() => 0);
      if (saleCount === 0) {
        console.warn(`[${new Date().toISOString()}] Branch analytics - No sales found:`, { branchId: req.user.branchId });
        return res.json({
          success: true,
          totalSales: 0,
          totalCount: 0,
          averageOrderValue: '0.00',
          returnRate: '0.00',
          topProduct: {
            productId: null,
            productName: isRtl ? 'غير معروف' : 'Unknown',
            productNameEn: null,
            displayName: isRtl ? 'غير معروف' : 'Unknown',
            totalQuantity: 0,
            totalRevenue: 0,
          },
          productSales: [],
          leastProductSales: [],
          departmentSales: [],
          leastDepartmentSales: [],
          salesTrends: [],
          topCustomers: [],
          returnStats: [],
        });
      }

      // Aggregations
      const totalSales = await Sale.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalSales: { $sum: '$totalAmount' },
            totalCount: { $sum: 1 },
            averageOrderValue: { $avg: '$totalAmount' },
          },
        },
      ]).catch(() => [{ totalSales: 0, totalCount: 0, averageOrderValue: 0 }]);

      const productSales = await Sale.aggregate([
        { $match: query },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
          },
        },
        {
          $lookup: {
            from: 'products',
            localField: '_id',
            foreignField: '_id',
            as: 'product',
            pipeline: [{ $project: { name: 1, nameEn: 1 } }],
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            productId: '$_id',
            productName: { $ifNull: ['$product.name', 'منتج محذوف'] },
            productNameEn: '$product.nameEn',
            displayName: isRtl ? { $ifNull: ['$product.name', 'منتج محذوف'] } : { $ifNull: ['$product.nameEn', '$product.name', 'Deleted Product'] },
            totalQuantity: 1,
            totalRevenue: 1,
          },
        },
        { $sort: { totalQuantity: -1 } },
        { $limit: 5 },
      ]).catch(() => []);

      const leastProductSales = await Sale.aggregate([
        { $match: query },
        { $unwind: '$items' },
        {
          $group: {
            _id: '$items.product',
            totalQuantity: { $sum: '$items.quantity' },
            totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
          },
        },
        {
          $lookup: {
            from: 'products',
            localField: '_id',
            foreignField: '_id',
            as: 'product',
            pipeline: [{ $project: { name: 1, nameEn: 1 } }],
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            productId: '$_id',
            productName: { $ifNull: ['$product.name', 'منتج محذوف'] },
            productNameEn: '$product.nameEn',
            displayName: isRtl ? { $ifNull: ['$product.name', 'منتج محذوف'] } : { $ifNull: ['$product.nameEn', '$product.name', 'Deleted Product'] },
            totalQuantity: 1,
            totalRevenue: 1,
          },
        },
        { $sort: { totalQuantity: 1 } },
        { $limit: 5 },
      ]).catch(() => []);

      const departmentSales = await Sale.aggregate([
        { $match: query },
        { $unwind: '$items' },
        {
          $lookup: {
            from: 'products',
            localField: 'items.product',
            foreignField: '_id',
            as: 'product',
            pipeline: [{ $project: { department: 1, name: 1, nameEn: 1 } }],
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: '$product.department',
            totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
            totalQuantity: { $sum: '$items.quantity' },
          },
        },
        {
          $lookup: {
            from: 'departments',
            localField: '_id',
            foreignField: '_id',
            as: 'department',
            pipeline: [{ $project: { name: 1, nameEn: 1 } }],
          },
        },
        { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            departmentId: '$_id',
            departmentName: { $ifNull: ['$department.name', 'غير معروف'] },
            departmentNameEn: '$department.nameEn',
            displayName: isRtl ? { $ifNull: ['$department.name', 'غير معروف'] } : { $ifNull: ['$department.nameEn', '$department.name', 'Unknown'] },
            totalRevenue: 1,
            totalQuantity: 1,
          },
        },
        { $sort: { totalRevenue: -1 } },
        { $limit: 5 },
      ]).catch(() => []);

      const leastDepartmentSales = await Sale.aggregate([
        { $match: query },
        { $unwind: '$items' },
        {
          $lookup: {
            from: 'products',
            localField: 'items.product',
            foreignField: '_id',
            as: 'product',
            pipeline: [{ $project: { department: 1, name: 1, nameEn: 1 } }],
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: '$product.department',
            totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
            totalQuantity: { $sum: '$items.quantity' },
          },
        },
        {
          $lookup: {
            from: 'departments',
            localField: '_id',
            foreignField: '_id',
            as: 'department',
            pipeline: [{ $project: { name: 1, nameEn: 1 } }],
          },
        },
        { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            departmentId: '$_id',
            departmentName: { $ifNull: ['$department.name', 'غير معروف'] },
            departmentNameEn: '$department.nameEn',
            displayName: isRtl ? { $ifNull: ['$department.name', 'غير معروف'] } : { $ifNull: ['$department.nameEn', '$department.name', 'Unknown'] },
            totalRevenue: 1,
            totalQuantity: 1,
          },
        },
        { $sort: { totalRevenue: 1 } },
        { $limit: 5 },
      ]).catch(() => []);

      const dateFormat = startDate && endDate && (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24) > 30 ? 'month' : 'day';
      const salesTrends = await Sale.aggregate([
        { $match: query },
        {
          $group: {
            _id: {
              $dateToString: {
                format: dateFormat === 'month' ? '%Y-%m' : '%Y-%m-%d',
                date: '$createdAt',
              },
            },
            totalSales: { $sum: '$totalAmount' },
            saleCount: { $sum: 1 },
          },
        },
        {
          $project: {
            period: '$_id',
            totalSales: 1,
            saleCount: 1,
            _id: 0,
          },
        },
        { $sort: { period: 1 } },
      ]).catch(() => []);

      const topCustomers = await Sale.aggregate([
        { $match: { ...query, customerName: { $ne: null, $ne: '' } } },
        {
          $group: {
            _id: { name: '$customerName', phone: '$customerPhone' },
            totalSpent: { $sum: '$totalAmount' },
            purchaseCount: { $sum: 1 },
          },
        },
        {
          $project: {
            customerName: '$_id.name',
            customerPhone: '$_id.phone',
            totalSpent: 1,
            purchaseCount: 1,
            _id: 0,
          },
        },
        { $sort: { totalSpent: -1 } },
        { $limit: 5 },
      ]).catch(() => []);

      const returnMatch = {};
      if (query.createdAt) returnMatch['saleDoc.createdAt'] = query.createdAt;
      if (query.branch) returnMatch['saleDoc.branch'] = query.branch;

      const returnStats = await Return.aggregate([
        {
          $lookup: {
            from: 'sales',
            localField: 'sale',
            foreignField: '_id',
            as: 'saleDoc',
          },
        },
        { $unwind: '$saleDoc' },
        { $match: returnMatch },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalQuantity: { $sum: { $sum: '$items.quantity' } },
          },
        },
        {
          $project: {
            status: '$_id',
            count: 1,
            totalQuantity: 1,
            _id: 0,
          },
        },
      ]).catch(() => []);

      const topProduct = productSales.length > 0
        ? productSales[0]
        : {
            productId: null,
            productName: isRtl ? 'غير معروف' : 'Unknown',
            productNameEn: null,
            displayName: isRtl ? 'غير معروف' : 'Unknown',
            totalQuantity: 0,
            totalRevenue: 0,
          };

      const response = {
        success: true,
        totalSales: totalSales[0]?.totalSales || 0,
        totalCount: totalSales[0]?.totalCount || 0,
        averageOrderValue: totalSales[0]?.averageOrderValue ? totalSales[0].averageOrderValue.toFixed(2) : '0.00',
        returnRate: totalSales[0]?.totalCount ? ((returnStats.reduce((sum, stat) => sum + stat.count, 0) / totalSales[0].totalCount) * 100).toFixed(2) : '0.00',
        topProduct,
        productSales,
        leastProductSales,
        departmentSales,
        leastDepartmentSales,
        salesTrends,
        topCustomers,
        returnStats,
      };

      console.log(`[${new Date().toISOString()}] Branch analytics - Success:`, {
        branchId: req.user.branchId,
        totalSales: response.totalSales,
        totalCount: response.totalCount,
        productSalesCount: response.productSales.length,
        departmentSalesCount: response.departmentSales.length,
      });

      res.json(response);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Branch analytics - Error:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Get sale by ID
router.get(
  '/:id',
  [auth, authorize('branch', 'admin')],
  async (req, res) => {
    try {
      const { id } = req.params;
      const { lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';

      if (!isValidObjectId(id)) {
        console.error(`[${new Date().toISOString()}] جلب بيع - معرف غير صالح:`, { id });
        return res.status(400).json({ success: false, message: isRtl ? 'معرف بيع غير صالح' : 'Invalid sale ID' });
      }

      const sale = await Sale.findById(id)
        .populate('branch', 'name nameEn')
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username')
        .lean();

      if (!sale) {
        console.error(`[${new Date().toISOString()}] جلب بيع - البيع غير موجود:`, { id });
        return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
      }

      if (req.user.role === 'branch' && sale.branch._id.toString() !== req.user.branchId?.toString()) {
        console.error(`[${new Date().toISOString()}] جلب بيع - غير مخول:`, { userId: req.user.id, branchId: sale.branch._id });
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للوصول إلى هذا البيع' : 'Unauthorized to access this sale' });
      }

      const returns = await Return.find({ sale: id })
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn',
        })
        .lean();

      const transformedSale = {
        ...sale,
        orderNumber: sale.saleNumber,
        branch: sale.branch
          ? {
              ...sale.branch,
              displayName: isRtl ? sale.branch.name : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
            }
          : undefined,
        items: (sale.items || []).map((item) => ({
          ...item,
          productName: item.product?.name || 'منتج محذوف',
          productNameEn: item.product?.nameEn || null,
          displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
          displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
          department: item.product?.department
            ? {
                ...item.product.department,
                displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
              }
            : undefined,
        })),
        createdAt: sale.createdAt.toISOString(),
        status: sale.status,
        paymentMethod: sale.paymentMethod,
        customerName: sale.customerName,
        customerPhone: sale.customerPhone,
        notes: sale.notes,
        createdBy: sale.createdBy?.username || 'Unknown',
        returns: (returns || []).map((ret) => ({
          _id: ret._id,
          returnNumber: ret.returnNumber,
          status: ret.status,
          items: (ret.items || []).map((item) => ({
            product: item.product?._id || item.product,
            productName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
            productNameEn: item.product?.nameEn || null,
            quantity: item.quantity,
            reason: item.reason,
          })),
          reason: ret.reason,
          createdAt: ret.createdAt.toISOString(),
        })),
      };

      console.log(`[${new Date().toISOString()}] جلب بيع - تم بنجاح:`, { saleId: id });

      res.json({ success: true, sale: transformedSale });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] خطأ في جلب البيع:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    }
  }
);

// Delete sale
router.delete(
  '/:id',
  [auth, authorize('branch', 'admin')],
  async (req, res) => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { id } = req.params;
      const { lang = 'ar' } = req.query;
      const isRtl = lang === 'ar';

      if (!isValidObjectId(id)) {
        console.error(`[${new Date().toISOString()}] حذف بيع - معرف غير صالح:`, { id });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرف بيع غير صالح' : 'Invalid sale ID' });
      }

      const sale = await Sale.findById(id).session(session);
      if (!sale) {
        console.error(`[${new Date().toISOString()}] حذف بيع - البيع غير موجود:`, { id });
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
      }

      if (req.user.role === 'branch' && sale.branch.toString() !== req.user.branchId.toString()) {
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مصرح لك بالوصول' : 'Unauthorized access' });
      }

      // Restore inventory
      for (const item of sale.items) {
        const inventory = await Inventory.findOneAndUpdate(
          { branch: sale.branch, product: item.product },
          {
            $inc: { currentStock: item.quantity },
            $push: {
              movements: {
                type: 'in',
                quantity: item.quantity,
                reference: `إلغاء بيع #${sale.saleNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { new: true, session }
        );

        const historyEntry = new InventoryHistory({
          product: item.product,
          branch: sale.branch,
          action: 'sale_cancelled',
          quantity: item.quantity,
          reference: `إلغاء بيع #${sale.saleNumber}`,
          referenceType: 'sale',
          referenceId: sale._id,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId: sale.branch.toString(),
          productId: item.product.toString(),
          quantity: inventory.currentStock,
          type: 'sale_cancelled',
        });
      }

      await Sale.deleteOne({ _id: id }).session(session);
      req.io?.emit('saleDeleted', { saleId: id, branchId: sale.branch.toString() });

      console.log(`[${new Date().toISOString()}] حذف بيع - تم بنجاح:`, { saleId: id, branchId: sale.branch });
      await session.commitTransaction();
      res.json({ success: true, message: isRtl ? 'تم حذف البيع بنجاح' : 'Sale deleted successfully' });
    } catch (err) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] خطأ في حذف البيع:`, { error: err.message, stack: err.stack });
      res.status(500).json({ success: false, message: lang === 'ar' ? 'خطأ في السيرفر' : 'Server error', error: err.message });
    } finally {
      session.endSession();
    }
  }
);

module.exports = router;