// controllers/sales.js
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const Return = require('../models/Return');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Create a sale (محسن بدعم lang و isRtl، و transformed data)
const createSale = async (req, res) => {
  const { items, totalAmount, status = 'completed', paymentMethod = 'cash', customerName, customerPhone, notes, lang = 'ar' } = req.body;
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('إنشاء بيع - أخطاء التحقق:', errors.array());
      await session.abortTransaction();
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const branchId = req.user.branchId;

    // Validate items
    for (const item of items) {
      if (!isValidObjectId(item.product) || item.quantity < 1 || item.unitPrice < 0) {
        console.log('إنشاء بيع - عنصر غير صالح:', { product: item.product, quantity: item.quantity, unitPrice: item.unitPrice });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'بيانات العنصر غير صالحة' : 'Invalid item data' });
      }
      const inventory = await Inventory.findOne({ product: item.product, branch: branchId }).session(session);
      if (!inventory || inventory.currentStock < item.quantity) {
        console.log('إنشاء بيع - الكمية غير كافية:', { product: item.product, currentStock: inventory?.currentStock, requestedQuantity: item.quantity });
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient stock for product ${item.product}` });
      }
    }

    const saleCount = await Sale.countDocuments({}).session(session);
    const saleNumber = `SALE-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${saleCount + 1}`;

    const sale = new Sale({
      saleNumber,
      branch: branchId,
      items: items.map(item => ({
        product: item.product,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
      totalAmount,
      status,
      paymentMethod,
      customerName: customerName?.trim(),
      customerPhone: customerPhone?.trim(),
      notes: notes?.trim(),
      createdBy: req.user.id,
    });

    await sale.save({ session });

    // Update inventory for completed sales
    if (status === 'completed') {
      for (const item of items) {
        const inventory = await Inventory.findOneAndUpdate(
          { product: item.product, branch: branchId },
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
          { session }
        );

        const historyEntry = new InventoryHistory({
          product: item.product,
          branch: branchId,
          action: 'sale',
          quantity: -item.quantity,
          reference: `بيع #${saleNumber}`,
          createdBy: req.user.id,
        });
        await historyEntry.save({ session });

        req.io?.emit('inventoryUpdated', {
          branchId,
          productId: item.product,
          quantity: inventory.currentStock,
          type: 'sale',
        });
      }
    }

    const populatedSale = await Sale.findById(sale._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .session(session)
      .lean();

    // Transform for language
    populatedSale.branch.displayName = isRtl ? (populatedSale.branch?.name || 'غير معروف') : (populatedSale.branch?.nameEn || populatedSale.branch?.name || 'Unknown');
    populatedSale.items = populatedSale.items.map((item) => ({
      ...item,
      productName: item.product?.name || 'منتج محذوف',
      productNameEn: item.product?.nameEn,
      displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
      displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
      department: item.product?.department
        ? {
            ...item.product.department,
            displayName: isRtl ? (item.product.department.name || 'غير معروف') : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
          }
        : undefined,
    }));

    req.io?.emit('saleCreated', {
      saleId: sale._id,
      branchId,
      saleNumber,
      items,
      totalAmount: sale.totalAmount,
      createdAt: sale.createdAt,
    });

    console.log('إنشاء بيع - تم بنجاح:', {
      saleId: sale._id,
      branchId,
      itemsCount: items.length,
    });

    await session.commitTransaction();
    res.status(201).json(populatedSale);
  } catch (err) {
    await session.abortTransaction();
    console.error('خطأ في إنشاء البيع:', { error: err.message, stack: err.stack, requestBody: req.body });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  } finally {
    session.endSession();
  }
};

// Get all sales (محسن بدعم returns و transformed)
const getSales = async (req, res) => {
  const { branch, page = 1, limit = 10, status, startDate, endDate, lang = 'ar' } = req.query;
  const isRtl = lang === 'ar';
  try {
    const query = {};

    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (req.user.role === 'branch') {
      if (!req.user.branchId || !isValidObjectId(req.user.branchId)) {
        console.log('جلب المبيعات - معرف الفرع غير صالح:', { userId: req.user.id, branchId: req.user.branchId });
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
      }
      query.branch = req.user.branchId;
    }

    if (status) query.status = status;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const sales = await Sale.find(query)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 })
      .lean();

    const total = await Sale.countDocuments(query);

    const saleIds = sales.map((s) => s._id);
    const returns = await Return.find({ order: { $in: saleIds } })
      .populate('order', 'saleNumber')
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn',
      })
      .lean();

    const transformedSales = sales.map((sale) => ({
      ...sale,
      orderNumber: sale.saleNumber,
      branch: sale.branch ? {
        ...sale.branch,
        displayName: isRtl ? (sale.branch.name || 'غير معروف') : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
      } : {
        displayName: isRtl ? 'غير معروف' : 'Unknown',
      },
      items: sale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'منتج محذوف',
        productNameEn: item.product?.nameEn,
        displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: isRtl ? (item.product.department.name || 'غير معروف') : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
            }
          : undefined,
      })),
      createdAt: new Date(sale.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      returns: returns
        .filter((ret) => ret.order?._id.toString() === sale._id.toString())
        .map((ret) => ({
          _id: ret._id,
          returnNumber: ret.returnNumber,
          status: ret.status,
          items: ret.items.map((item) => ({
            product: item.product?._id || item.product,
            productName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
            productNameEn: item.product?.nameEn,
            quantity: item.quantity,
            reason: item.reason,
          })),
          reason: ret.reason,
          createdAt: new Date(ret.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          }),
        })),
    }));

    console.log('جلب المبيعات - تم بنجاح:', {
      count: sales.length,
      userId: req.user.id,
      query,
    });

    res.status(200).json({ sales: transformedSales, total, returns });
  } catch (err) {
    console.error('خطأ في جلب المبيعات:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

// Get sale by ID (محسن بـ transformed)
const getSaleById = async (req, res) => {
  const { id } = req.params;
  const { lang = 'ar' } = req.query;
  const isRtl = lang === 'ar';
  try {
    if (!isValidObjectId(id)) {
      console.log('جلب بيع - معرف البيع غير صالح:', { id });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف البيع غير صالح' : 'Invalid sale ID' });
    }

    const sale = await Sale.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn unit unitEn department price', populate: { path: 'department', select: 'name nameEn' } })
      .populate('createdBy', 'username')
      .lean();

    if (!sale) {
      console.log('جلب بيع - البيع غير موجود:', { id });
      return res.status(404).json({ success: false, message: isRtl ? 'البيع غير موجود' : 'Sale not found' });
    }

    if (req.user.role === 'branch' && sale.branch?.toString() !== req.user.branchId?.toString()) {
      console.log('جلب بيع - غير مخول:', { userId: req.user.id, branchId: sale.branch, userBranchId: req.user.branchId });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للوصول إلى هذا البيع' : 'Unauthorized to access this sale' });
    }

    const returns = await Return.find({ order: id })
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn',
      })
      .lean();

    const transformedSale = {
      ...sale,
      orderNumber: sale.saleNumber,
      branch: sale.branch ? {
        ...sale.branch,
        displayName: isRtl ? (sale.branch.name || 'غير معروف') : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
      } : {
        displayName: isRtl ? 'غير معروف' : 'Unknown',
      },
      items: sale.items.map((item) => ({
        ...item,
        productName: item.product?.name || 'منتج محذوف',
        productNameEn: item.product?.nameEn,
        displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        department: item.product?.department
          ? {
              ...item.product.department,
              displayName: isRtl ? (item.product.department.name || 'غير معروف') : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
            }
          : undefined,
      })),
      createdAt: new Date(sale.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
      returns: returns.map((ret) => ({
        _id: ret._id,
        returnNumber: ret.returnNumber,
        status: ret.status,
        items: ret.items.map((item) => ({
          product: item.product?._id || item.product,
          productName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
          productNameEn: item.product?.nameEn,
          quantity: item.quantity,
          reason: item.reason,
        })),
        reason: ret.reason,
        createdAt: new Date(ret.createdAt).toLocaleDateString(isRtl ? 'ar-EG' : 'en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }),
      })),
    };

    console.log('جلب بيع - تم بنجاح:', { saleId: id, userId: req.user.id });

    res.status(200).json(transformedSale);
  } catch (err) {
    console.error('خطأ في جلب البيع:', { error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

module.exports = {
  createSale,
  getSales,
  getSaleById,
};