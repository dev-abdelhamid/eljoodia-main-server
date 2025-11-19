// inventoryController.js (للـ inventory)
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Order = require('../models/Order');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');
const isValidObjectId = (id) => mongoose.isValidObjectId(id);
const translateField = (item, field, lang) => {
  return lang === 'ar' ? item[field] || item[`${field}En`] || 'غير معروف' : item[`${field}En`] || item[field] || 'Unknown';
};
const createInventory = async (req, res) => {
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
    const { branchId, productId, userId, currentStock, minStockLevel = 10, maxStockLevel = 100, orderId } = req.body;
    if (!isValidObjectId(branchId) || !isValidObjectId(productId) || !isValidObjectId(userId) || currentStock < 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع، المنتج، المستخدم، أو الكمية غير صالحة' : 'Invalid branch, product, user ID, or quantity' });
    }
    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المستخدم غير موجود' : 'User not found' });
    }
    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Not authorized to create inventory for this branch' });
    }
    const [product, branch] = await Promise.all([
      Product.findById(productId).session(session),
      Branch.findById(branchId).session(session),
    ]);
    if (!product) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المنتج غير موجود' : 'Product not found' });
    }
    if (!branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
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
      if (order.status !== 'delivered') {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'يجب أن تكون الطلبية في حالة "تم التسليم"' : 'Order must be in delivered status' });
      }
      // تحقق من التكرار: إذا كان هناك movement سابق لهذا الorderId
      const existingMovement = await Inventory.findOne({
        branch: branchId,
        product: productId,
        'movements.reference': { $regex: new RegExp(orderId, 'i') },
      }).session(session);
      if (existingMovement) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'تم معالجة هذا الطلب سابقاً في المخزون' : 'This order has already been processed in inventory' });
      }
      reference = `تأكيد تسليم الطلبية #${orderId} بواسطة ${req.user.username}`;
      // تحديث الطلب لمنع التكرار (افتراض أن Order schema لديه field inventoryProcessed)
      order.inventoryProcessed = true;
      await order.save({ session });
    }
    const inventory = await Inventory.findOneAndUpdate(
      { branch: branchId, product: productId },
      {
        $setOnInsert: {
          product: productId,
          branch: branchId,
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
    const historyEntry = new InventoryHistory({
      product: productId,
      branch: branchId,
      action: 'restock',
      quantity: currentStock,
      reference,
      referenceType: orderId ? 'order' : 'adjustment',
      referenceId: orderId || null,
      createdBy: userId,
    });
    await historyEntry.save({ session });
    if (inventory.currentStock <= inventory.minStockLevel) {
      req.io?.emit('lowStockWarning', {
        branchId,
        productId,
        productName: translateField(product, 'name', lang),
        currentStock: inventory.currentStock,
        minStockLevel: inventory.minStockLevel,
        timestamp: new Date().toISOString(),
      });
    }
    req.io?.emit('inventoryUpdated', {
      branchId,
      productId,
      quantity: inventory.currentStock,
      type: 'restock',
      reference,
    });
    const populatedItem = await Inventory.findById(inventory._id)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .session(session)
      .lean();
    await session.commitTransaction();
    res.status(201).json({ success: true, inventory: populatedItem });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] خطأ في إنشاء المخزون:`, {
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
const bulkCreate = async (req, res) => {
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
    const { branchId, userId, orderId, items } = req.body;
    if (!isValidObjectId(branchId) || !isValidObjectId(userId) || !Array.isArray(items) || !items.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع، المستخدم، أو العناصر غير صالحة' : 'Invalid branch, user ID, or items' });
    }
    const user = await User.findById(userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المستخدم غير موجود' : 'User not found' });
    }
    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لإنشاء مخزون لهذا الفرع' : 'Not authorized to create inventory for this branch' });
    }
    const branch = await Branch.findById(branchId).session(session);
    if (!branch) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
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
      if (order.status !== 'delivered') {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'يجب أن تكون الطلبية في حالة "تم التسليم"' : 'Order must be in delivered status' });
      }
      // تحقق من التكرار للدفعة
      const existingMovements = await Inventory.find({
        branch: branchId,
        'movements.reference': { $regex: new RegExp(orderId, 'i') },
      }).session(session);
      if (existingMovements.length > 0) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'تم معالجة هذا الطلب سابقاً في المخزون' : 'This order has already been processed in inventory' });
      }
      reference = `تأكيد تسليم الطلبية #${orderId} بواسطة ${req.user.username}`;
      // تحديث الطلب
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
          filter: { branch: branchId, product: productId },
          update: {
            $setOnInsert: {
              product: productId,
              branch: branchId,
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
        branch: branchId,
        action: 'restock',
        quantity: currentStock,
        reference,
        referenceType: orderId ? 'order' : 'adjustment',
        referenceId: orderId || null,
        createdBy: userId,
      });
    }
    const result = await Inventory.bulkWrite(bulkOps, { session });
    await InventoryHistory.insertMany(historyEntries, { session });
    const inventoryIds = Object.values(result.upsertedIds || {}).map((id) => id);
    const modifiedIds = Object.keys(result.modifiedCount || {}).map((id) => mongoose.Types.ObjectId(id));
    const allIds = [...inventoryIds, ...modifiedIds];
    const inventories = await Inventory.find({ _id: { $in: allIds } }).session(session);
    for (const inventory of inventories) {
      if (inventory.currentStock <= inventory.minStockLevel) {
        const product = products.find((p) => p._id.toString() === inventory.product.toString());
        req.io?.emit('lowStockWarning', {
          branchId,
          productId: inventory.product.toString(),
          productName: translateField(product, 'name', lang),
          currentStock: inventory.currentStock,
          minStockLevel: inventory.minStockLevel,
          timestamp: new Date().toISOString(),
        });
      }
      req.io?.emit('inventoryUpdated', {
        branchId,
        productId: inventory.product.toString(),
        quantity: inventory.currentStock,
        type: 'restock',
        reference,
      });
    }
    const populatedItems = await Inventory.find({ _id: { $in: allIds } })
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
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
const getInventoryByBranch = async (req, res) => {
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
    const { branchId } = req.params;
    const { department, stockStatus } = req.query;
    if (!isValidObjectId(branchId)) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }
    if (req.user.role === 'branch' && branchId !== req.user.branchId?.toString()) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لعرض مخزون هذا الفرع' : 'Not authorized to view inventory for this branch' });
    }
    const branch = await Branch.findById(branchId).lean();
    if (!branch) {
      return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
    }
    const query = { branch: branchId };
    if (department && isValidObjectId(department)) {
      query['product.department'] = department;
    }
    if (stockStatus) {
      const inventories = await Inventory.find({ branch: branchId }).lean();
      const filteredIds = inventories
        .filter((item) => {
          const isLow = item.currentStock <= item.minStockLevel;
          const isHigh = item.currentStock >= item.maxStockLevel;
          return stockStatus === 'low' ? isLow : stockStatus === 'high' ? isHigh : !isLow && !isHigh;
        })
        .map((item) => item._id);
      query['_id'] = { $in: filteredIds };
    }
    const inventories = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .lean();
    const transformedInventories = inventories.map((item) => ({
      ...item,
      status:
        item.currentStock <= item.minStockLevel
          ? 'low'
          : item.currentStock >= item.maxStockLevel
          ? 'full'
          : 'normal',
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn || item.branch?.name || 'غير معروف',
      productName: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name || 'غير معروف',
      unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
      departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف',
    }));
    res.status(200).json({ success: true, inventory: transformedInventories });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في جلب مخزون الفرع:`, {
      error: err.message,
      stack: err.stack,
      params: req.params,
      query: req.query,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};
const getInventory = async (req, res) => {
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
    const { branch, product, department, lowStock, stockStatus } = req.query;
    const query = {};
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (product && isValidObjectId(product)) query.product = product;
    if (department && isValidObjectId(department)) query['product.department'] = department;
    if (lowStock === 'true') {
      const inventories = await Inventory.find().lean();
      const filteredIds = inventories
        .filter((item) => item.currentStock <= item.minStockLevel)
        .map((item) => item._id);
      query['_id'] = { $in: filteredIds };
    } else if (stockStatus) {
      const inventories = await Inventory.find().lean();
      const filteredIds = inventories
        .filter((item) => {
          const isLow = item.currentStock <= item.minStockLevel;
          const isHigh = item.currentStock >= item.maxStockLevel;
          return stockStatus === 'low' ? isLow : stockStatus === 'high' ? isHigh : !isLow && !isHigh;
        })
        .map((item) => item._id);
      query['_id'] = { $in: filteredIds };
    }
    const inventories = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy', 'username name nameEn')
      .populate('updatedBy', 'username name nameEn')
      .lean();
    const transformedInventories = inventories.map((item) => ({
      ...item,
      status:
        item.currentStock <= item.minStockLevel
          ? 'low'
          : item.currentStock >= item.maxStockLevel
          ? 'full'
          : 'normal',
      branchName: isRtl ? item.branch?.name : item.branch?.nameEn || item.branch?.name || 'غير معروف',
      productName: isRtl ? item.product?.name : item.product?.nameEn || item.product?.name || 'غير معروف',
      unit: isRtl ? item.product?.unit || 'غير محدد' : item.product?.unitEn || item.product?.unit || 'N/A',
      departmentName: isRtl ? item.product?.department?.name : item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف',
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
const updateStock = async (req, res) => {
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
    const inventory = await Inventory.findById(id).session(session);
    if (!inventory) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'عنصر المخزون غير موجود' : 'Inventory item not found' });
    }
    if (req.user.role === 'branch' && inventory.branch.toString() !== req.user.branchId?.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث مخزون هذا الفرع' : 'Not authorized to update inventory for this branch' });
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
    const updatedInventory = await Inventory.findByIdAndUpdate(
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
      const historyEntry = new InventoryHistory({
        product: inventory.product,
        branch: inventory.branch,
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
      req.io?.emit('lowStockWarning', {
        branchId: updatedInventory.branch.toString(),
        productId: updatedInventory.product.toString(),
        productName: translateField(product, 'name', lang),
        currentStock: updatedInventory.currentStock,
        minStockLevel: updatedInventory.minStockLevel,
        timestamp: new Date().toISOString(),
      });
    }
    req.io?.emit('inventoryUpdated', {
      branchId: updatedInventory.branch.toString(),
      productId: updatedInventory.product.toString(),
      quantity: updatedInventory.currentStock,
      minStockLevel: updatedInventory.minStockLevel,
      maxStockLevel: updatedInventory.maxStockLevel,
      type: 'adjustment',
      reference,
    });
    const populatedItem = await Inventory.findById(updatedInventory._id)
      .populate({
        path: 'product',
        select: 'name nameEn price unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
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
const getInventoryHistory = async (req, res) => {
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
    const { branchId, productId, department, period, groupBy } = req.query;
    const query = {};
    if (branchId && isValidObjectId(branchId)) query.branch = branchId;
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
      history = await InventoryHistory.aggregate([
        { $match: query },
        groupStage,
        { $sort: { _id: -1 } },
      ]);
    } else {
      history = await InventoryHistory.find(query)
        .populate({
          path: 'product',
          select: 'name nameEn',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('branch', 'name nameEn')
        .populate('createdBy', 'username name nameEn')
        .lean();
    }
    const transformedHistory = history.map((entry) => ({
      _id: entry._id,
      date: entry.createdAt || entry._id, // للتجميع، استخدم _id كتاريخ
      type: entry.action || entry.actions, // إذا تجميع، أرجع الactions
      quantity: entry.quantity || entry.totalQuantity,
      description: entry.reference,
      productId: entry.product?._id,
      branchId: entry.branch?._id,
      department: entry.product?.department,
      productName: isRtl ? entry.product?.name : entry.product?.nameEn || entry.product?.name || 'غير معروف',
      branchName: isRtl ? entry.branch?.name : entry.branch?.nameEn || entry.branch?.name || 'غير معروف',
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
  createInventory,
  bulkCreate,
  getInventoryByBranch,
  getInventory,
  updateStock,
  getInventoryHistory,
};