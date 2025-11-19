
// controllers/factoryInventoryController.js
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const FactoryInventory = require('../models/FactoryInventory');
const FactoryInventoryHistory = require('../models/FactoryInventoryHistory');
const Product = require('../models/Product');
const User = require('../models/User');
const Order = require('../models/Order');
const isValidObjectId = (id) => mongoose.isValidObjectId(id);
const translateField = (item, field, lang) => {
  return lang === 'ar' ? item[field] || item[`${field}En`] || 'غير معروف' : item[`${field}En`] || item[field] || 'Unknown';
};
const createFactoryInventory = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
    }
    const { productId, userId, currentStock, minStockLevel = 10, maxStockLevel = 100, orderId } = req.body;
    if (!isValidObjectId(productId) || !isValidObjectId(userId) || currentStock < 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف المنتج، المستخدم، أو الكمية غير صالحة' : 'Invalid product, user ID, or quantity' });
    }
    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المستخدم غير موجود' : 'User not found' });
    }
    const product = await Product.findById(productId).session(session);
    if (!product) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المنتج غير موجود' : 'Product not found' });
    }
    let reference = `إنشاء مخزون بواسطة ${req.user.username}`;
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
      }
      if (order.status !== 'completed') {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'يجب أن تكون الطلبية في حالة "مكتمل"' : 'Order must be in completed status' });
      }
      const existingMovement = await FactoryInventory.findOne({
        product: productId,
        'movements.reference': { $regex: new RegExp(orderId, 'i') },
      }).session(session);
      if (existingMovement) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'تم معالجة هذا الطلب سابقاً في المخزون' : 'This order has already been processed in inventory' });
      }
      reference = `تأكيد إكمال الطلبية #${orderId} بواسطة ${req.user.username}`;
      order.inventoryProcessed = true;
      await order.save({ session });
    }
    const inventory = await FactoryInventory.findOneAndUpdate(
      { product: productId },
      {
        $setOnInsert: {
          product: productId,
          minStockLevel,
          maxStockLevel,
          createdBy: userId,
        },
        $inc: { currentStock },
        $push: {
          movements: {
            type: 'in',
            quantity: currentStock,
            reference,
            createdBy: userId,
            createdAt: new Date(),
          },
        },
        updatedBy: userId,
      },
      { upsert: true, new: true, session }
    );
    const historyEntry = new FactoryInventoryHistory({
      product: productId,
      action: 'restock',
      quantity: currentStock,
      reference,
      referenceType: orderId ? 'order' : 'adjustment',
      referenceId: orderId || null,
      createdBy: userId,
    });
    await historyEntry.save({ session });
    if (inventory.currentStock <= inventory.minStockLevel) {
      req.io?.emit('lowFactoryStockWarning', {
        productId,
        productName: translateField(product, 'name', lang),
        currentStock: inventory.currentStock,
        minStockLevel: inventory.minStockLevel,
      });
    }
    req.io?.emit('factoryInventoryUpdated', {
      productId,
      quantity: inventory.currentStock,
      type: 'restock',
      reference,
    });
    const populatedItem = await FactoryInventory.findById(inventory._id)
      .populate({
        path: 'product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();
    await session.commitTransaction();
    res.status(201).json({ success: true, inventory: populatedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error('Error in createFactoryInventory:', err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};
const bulkCreateFactory = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array(),
      });
    }
    const { userId, orderId, items } = req.body;
    if (!isValidObjectId(userId) || (orderId && !isValidObjectId(orderId)) || !Array.isArray(items) || !items.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف المستخدم، أو العناصر غير صالحة' : 'Invalid user ID or items' });
    }
    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المستخدم غير موجود' : 'User not found' });
    }
    let reference = `إنشاء دفعة مخزون بواسطة ${req.user.username}`;
    if (orderId) {
      if (!isValidObjectId(orderId)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
      }
      const order = await Order.findById(orderId).session(session);
      if (!order) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
      }
      if (order.status !== 'completed') {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'يجب أن تكون الطلبية في حالة "مكتمل"' : 'Order must be in completed status' });
      }
      const existingMovements = await FactoryInventory.find({
        'movements.reference': { $regex: new RegExp(orderId, 'i') },
      }).session(session);
      if (existingMovements.length > 0) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'تم معالجة هذا الطلب سابقاً في المخزون' : 'This order has already been processed in inventory' });
      }
      reference = `تأكيد تسليم الطلبية #${orderId} بواسطة ${req.user.username}`;
      order.inventoryProcessed = true;
      await order.save({ session });
    }
    const productIds = items.map((item) => item.productId);
    const products = await Product.find({ _id: { $in: productIds } }).session(session);
    if (products.length !== productIds.length) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }
    const bulkOps = [];
    const historyEntries = [];
    for (const item of items) {
      const { productId, currentStock, minStockLevel = 10, maxStockLevel = 100 } = item;
      if (!isValidObjectId(productId) || currentStock < 0) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `بيانات غير صالحة للمنتج ${productId}` : `Invalid data for product ${productId}` });
      }
      const product = products.find((p) => p._id.toString() === productId);
      if (!product) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? `المنتج ${productId} غير موجود` : `Product ${productId} not found` });
      }
      bulkOps.push({
        updateOne: {
          filter: { product: productId },
          update: {
            $setOnInsert: {
              product: productId,
              minStockLevel,
              maxStockLevel,
              createdBy: userId,
            },
            $inc: { currentStock },
            $push: {
              movements: {
                type: 'in',
                quantity: currentStock,
                reference,
                createdBy: userId,
                createdAt: new Date(),
              },
            },
            updatedBy: userId,
          },
          upsert: true,
        },
      });
      historyEntries.push({
        product: productId,
        action: 'restock',
        quantity: currentStock,
        reference,
        referenceType: orderId ? 'order' : 'adjustment',
        referenceId: orderId || null,
        createdBy: userId,
      });
    }
    const result = await FactoryInventory.bulkWrite(bulkOps, { session });
    await FactoryInventoryHistory.insertMany(historyEntries, { session });
    const inventoryIds = Object.values(result.upsertedIds || {}).map((id) => id);
    const modifiedIds = Object.keys(result.modifiedCount || {}).map((id) => mongoose.Types.ObjectId(id));
    const allIds = [...inventoryIds, ...modifiedIds];
    const inventories = await FactoryInventory.find({ _id: { $in: allIds } }).session(session);
    for (const inventory of inventories) {
      if (inventory.currentStock <= inventory.minStockLevel) {
        const product = products.find((p) => p._id.toString() === inventory.product.toString());
        req.io?.emit('lowFactoryStockWarning', {
          productId: inventory.product.toString(),
          productName: translateField(product, 'name', lang),
          currentStock: inventory.currentStock,
          minStockLevel: inventory.minStockLevel,
          timestamp: new Date().toISOString(),
        });
      }
      req.io?.emit('factoryInventoryUpdated', {
        productId: inventory.product.toString(),
        quantity: inventory.currentStock,
        type: 'restock',
        reference,
      });
    }
    const populatedItems = await FactoryInventory.find({ _id: { $in: allIds } })
      .populate({
        path: 'product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();
    await session.commitTransaction();
    res.status(201).json({ success: true, inventories: populatedItems });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في إنشاء دفعة المخزون:`, {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    else if (err.message.includes('تم معالجة')) status = 400;
    res.status(status).json({ success: false, message, error: err.message });
  } finally {
    session.endSession();
  }
};
const getFactoryInventory = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array(),
      });
    }
    const { product, department, lowStock, stockStatus } = req.query;
    const match = {};
    if (product && isValidObjectId(product)) match._id = new mongoose.Types.ObjectId(product);
    if (department && isValidObjectId(department)) match.department = new mongoose.Types.ObjectId(department);
    const products = await Product.aggregate([
      { $match: match },
      {
        $lookup: {
          from: 'factoryinventories',
          localField: '_id',
          foreignField: 'product',
          as: 'inventory',
        },
      },
      { $unwind: { path: '$inventory', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          name: 1,
          nameEn: 1,
          unit: 1,
          unitEn: 1,
          department: 1,
          code: 1,
          currentStock: { $ifNull: ['$inventory.currentStock', 0] },
          minStockLevel: { $ifNull: ['$inventory.minStockLevel', 0] },
          maxStockLevel: { $ifNull: ['$inventory.maxStockLevel', 1000] },
          inventoryId: '$inventory._id',
          createdBy: '$inventory.createdBy',
          updatedBy: '$inventory.updatedBy',
        },
      },
      {
        $lookup: {
          from: 'departments',
          localField: 'department',
          foreignField: '_id',
          as: 'department',
        },
      },
      { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'users',
          localField: 'createdBy',
          foreignField: '_id',
          as: 'createdBy',
        },
      },
      { $unwind: { path: '$createdBy', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'users',
          localField: 'updatedBy',
          foreignField: '_id',
          as: 'updatedBy',
        },
      },
      { $unwind: { path: '$updatedBy', preserveNullAndEmptyArrays: true } },
    ]);
    let filteredProducts = products;
    if (lowStock === 'true') {
      filteredProducts = filteredProducts.filter((p) => p.currentStock <= p.minStockLevel);
    } else if (stockStatus) {
      filteredProducts = filteredProducts.filter((p) => {
        const isLow = p.currentStock <= p.minStockLevel;
        const isHigh = p.currentStock >= p.maxStockLevel;
        return stockStatus === 'low' ? isLow : stockStatus === 'high' ? isHigh : !isLow && !isHigh;
      });
    }
    const transformedInventories = filteredProducts.map((item) => ({
      _id: item.inventoryId || item._id.toString(),
      product: {
        _id: item._id.toString(),
        name: item.name,
        nameEn: item.nameEn,
        unit: item.unit,
        unitEn: item.unitEn,
        department: item.department ? {
          _id: item.department._id.toString(),
          name: item.department.name,
          nameEn: item.department.nameEn,
        } : null,
        code: item.code,
      },
      currentStock: item.currentStock,
      minStockLevel: item.minStockLevel,
      maxStockLevel: item.maxStockLevel,
      status:
        item.currentStock <= item.minStockLevel
          ? 'low'
          : item.currentStock >= item.maxStockLevel
          ? 'full'
          : 'normal',
      createdBy: item.createdBy ? {
        username: item.createdBy.username,
        name: item.createdBy.name,
        nameEn: item.createdBy.nameEn,
      } : null,
      updatedBy: item.updatedBy ? {
        username: item.updatedBy.username,
        name: item.updatedBy.name,
        nameEn: item.updatedBy.nameEn,
      } : null,
    }));
    res.status(200).json({ success: true, inventory: transformedInventories });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في جلب كل المخزون:`, {
      error: err.message,
      stack: err.stack,
      query: req.query,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};
const updateFactoryStock = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array(),
      });
    }
    const { id } = req.params;
    const { currentStock, minStockLevel, maxStockLevel } = req.body;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف المخزون غير صالح' : 'Invalid inventory ID' });
    }
    const inventory = await FactoryInventory.findById(id).session(session);
    if (!inventory) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'عنصر المخزون غير موجود' : 'Inventory item not found' });
    }
    const updates = {};
    if (currentStock !== undefined && !isNaN(currentStock) && currentStock >= 0) {
      updates.currentStock = currentStock;
    }
    if (minStockLevel !== undefined && !isNaN(minStockLevel) && minStockLevel >= 0) {
      updates.minStockLevel = minStockLevel;
    }
    if (maxStockLevel !== undefined && !isNaN(maxStockLevel) && maxStockLevel >= 0) {
      updates.maxStockLevel = maxStockLevel;
    }
    if (Object.keys(updates).length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'لا توجد بيانات للتحديث' : 'No data to update' });
    }
    if (updates.minStockLevel !== undefined && updates.maxStockLevel !== undefined && updates.maxStockLevel <= updates.minStockLevel) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الحد الأقصى يجب أن يكون أكبر من الحد الأدنى' : 'Max stock level must be greater than min stock level' });
    }
    const reference = `تحديث المخزون بواسطة ${req.user.username}`;
    updates.updatedBy = req.user.id;
    const updatedInventory = await FactoryInventory.findByIdAndUpdate(
      id,
      {
        $set: updates,
        $push: {
          movements: {
            type: 'adjustment',
            quantity: currentStock !== undefined ? currentStock - inventory.currentStock : 0,
            reference,
            createdBy: req.user.id,
            createdAt: new Date(),
          },
        },
      },
      { new: true, session }
    );
    if (currentStock !== undefined && currentStock !== inventory.currentStock) {
      const historyEntry = new FactoryInventoryHistory({
        product: inventory.product,
        action: 'adjustment',
        quantity: currentStock - inventory.currentStock,
        reference,
        referenceType: 'adjustment',
        referenceId: null,
        createdBy: req.user.id,
      });
      await historyEntry.save({ session });
    }
    if (updatedInventory.currentStock <= updatedInventory.minStockLevel) {
      const product = await Product.findById(updatedInventory.product).session(session);
      req.io?.emit('lowFactoryStockWarning', {
        productId: updatedInventory.product.toString(),
        productName: translateField(product, 'name', lang),
        currentStock: updatedInventory.currentStock,
        minStockLevel: updatedInventory.minStockLevel,
        timestamp: new Date().toISOString(),
      });
    }
    req.io?.emit('factoryInventoryUpdated', {
      productId: updatedInventory.product.toString(),
      quantity: updatedInventory.currentStock,
      minStockLevel: updatedInventory.minStockLevel,
      maxStockLevel: updatedInventory.maxStockLevel,
      type: 'adjustment',
      reference,
    });
    const populatedItem = await FactoryInventory.findById(updatedInventory._id)
      .populate({
        path: 'product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();
    await session.commitTransaction();
    res.status(200).json({ success: true, inventory: populatedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في تحديث المخزون:`, {
      error: err.message,
      stack: err.stack,
      params: req.params,
      body: req.body,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    res.status(status).json({ success: false, message, error: err.message });
  } finally {
    session.endSession();
  }
};
const getFactoryInventoryHistory = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error',
        errors: errors.array(),
      });
    }
    const { productId, department, period, groupBy } = req.query;
    const query = {};
    if (productId && isValidObjectId(productId)) query.product = productId;
    if (department && isValidObjectId(department)) query['product.department'] = department;
    if (period) {
      const now = new Date();
      let startDate;
      if (period === 'daily') {
        startDate = new Date(now.setHours(0, 0, 0, 0));
      } else if (period === 'weekly') {
        startDate = new Date(now.setDate(now.getDate() - now.getDay()));
        startDate.setHours(0, 0, 0, 0);
      } else if (period === 'monthly') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      }
      query.createdAt = { $gte: startDate };
    }
    let history;
    if (groupBy) {
      let groupStage;
      if (groupBy === 'day') {
        groupStage = {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            totalQuantity: { $sum: '$quantity' },
            actions: { $push: { action: '$action', quantity: '$quantity', reference: '$reference' } },
          },
        };
      } else if (groupBy === 'week') {
        groupStage = {
          $group: {
            _id: { $week: '$createdAt' },
            totalQuantity: { $sum: '$quantity' },
            actions: { $push: { action: '$action', quantity: '$quantity', reference: '$reference' } },
          },
        };
      } else if (groupBy === 'month') {
        groupStage = {
          $group: {
            _id: { $month: '$createdAt' },
            totalQuantity: { $sum: '$quantity' },
            actions: { $push: { action: '$action', quantity: '$quantity', reference: '$reference' } },
          },
        };
      }
      history = await FactoryInventoryHistory.aggregate([
        { $match: query },
        groupStage,
        { $sort: { _id: -1 } },
      ]);
    } else {
      history = await FactoryInventoryHistory.find(query)
        .populate({
          path: 'product',
          select: 'name nameEn',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('createdBy', 'username name nameEn')
        .lean();
    }
    const transformedHistory = history.map((entry) => ({
      _id: entry._id,
      date: entry.createdAt || entry._id,
      type: entry.action || entry.actions,
      quantity: entry.quantity || entry.totalQuantity,
      description: entry.reference,
      productId: entry.product?._id,
      department: entry.product?.department,
      productName: isRtl ? entry.product?.name : entry.product?.nameEn || entry.product?.name || 'غير معروف',
      createdByName: isRtl ? entry.createdBy?.name : entry.createdBy?.nameEn || entry.createdBy?.name || 'غير معروف',
    }));
    res.status(200).json({ success: true, history: transformedHistory });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في جلب تاريخ المخزون:`, {
      error: err.message,
      stack: err.stack,
      query: req.query,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};
module.exports = {
  createFactoryInventory,
  bulkCreateFactory,
  getFactoryInventory,
  updateFactoryStock,
  getFactoryInventoryHistory,
};