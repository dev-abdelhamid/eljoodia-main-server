const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const FactoryOrder = require('../models/FactoryOrder');
const Product = require('../models/Product');
const User = require('../models/User');
const FactoryInventory = require('../models/FactoryInventory');
const FactoryInventoryHistory = require('../models/FactoryInventoryHistory');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const translateField = (item, field, lang) => {
  return lang === 'ar' ? item[field] || item[`${field}En`] || 'غير معروف' : item[`${field}En`] || item[field] || 'Unknown';
};

const createFactoryOrder = async (req, res) => {
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
    const { orderNumber, items, notes, priority } = req.body;
    if (!items.every(item => isValidObjectId(item.product) && item.quantity > 0)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'بيانات المنتج أو الكمية غير صالحة' : 'Invalid product or quantity data' });
    }
    const products = await Product.find({ _id: { $in: items.map(i => i.product) } }).populate('department', 'name nameEn').session(session);
    if (products.length !== items.length) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }
    if (req.user.role === 'chef') {
      const userDept = req.user.department.toString();
      if (!products.every(p => p.department._id.toString() === userDept)) {
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'يمكنك فقط طلب منتجات قسمك' : 'You can only request products from your department' });
      }
    }
    const orderItems = items.map(item => {
      const prod = products.find(p => p._id.toString() === item.product.toString());
      let assignedTo;
      let itemStatus = 'pending';
      if (req.user.role !== 'chef' && item.assignedTo) {
        assignedTo = item.assignedTo;
        itemStatus = 'assigned';
      } else if (req.user.role === 'chef') {
        assignedTo = req.user.id;
        itemStatus = 'assigned';
      }
      return {
        product: item.product,
        quantity: item.quantity,
        status: itemStatus,
        assignedTo: assignedTo || undefined,
        department: prod.department._id,
      };
    });
    const allAssigned = orderItems.every(i => i.status === 'assigned');
    const order = new FactoryOrder({
      orderNumber,
      items: orderItems,
      status: req.user.role === 'chef' ? 'requested' : allAssigned ? 'in_production' : 'approved',
      notes: notes || '',
      priority: priority || 'medium',
      createdBy: req.user.id,
    });
    await order.save({ session });
    const populatedOrder = await FactoryOrder.findById(order._id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role
        }),
      })
      .session(session)
      .lean();
    await session.commitTransaction();
    req.io?.emit('newFactoryOrder', populatedOrder);
    res.status(201).json({ success: true, data: populatedOrder, message: isRtl ? 'تم إنشاء الطلب بنجاح' : 'Order created successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating factory order:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const getFactoryOrders = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error', errors: errors.array() });
    }
    const { status, priority, department, sortBy, sortOrder } = req.query;
    const query = {};
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (department && isValidObjectId(department)) query['items.department'] = department;
    if (req.user.role === 'production' && req.user.department) {
      query['items.department'] = req.user.department._id;
    }
    if (req.user.role === 'chef') {
      query['items.assignedTo'] = req.user.id;
    }
    const orders = await FactoryOrder.find(query)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role
        }),
      })
      .sort({ [sortBy || 'createdAt']: sortOrder === 'desc' ? -1 : 1 })
      .lean();
    res.status(200).json({ success: true, data: orders, message: isRtl ? 'تم جلب الطلبات بنجاح' : 'Orders fetched successfully' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching factory orders:`, err.message);
    res.status(500).json({ success: false, data: [], message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getFactoryOrderById = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role
        }),
      })
      .lean();
    if (!order) {
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (req.user.role === 'chef' && !order.items.some(item => item.assignedTo && item.assignedTo._id.toString() === req.user.id.toString())) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مصرح للوصول إلى هذا الطلب' : 'Not authorized to access this order' });
    }
    res.status(200).json({ success: true, data: order, message: isRtl ? 'تم جلب الطلب بنجاح' : 'Order fetched successfully' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching factory order:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const approveFactoryOrder = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    if (!['admin', 'production'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مصرح بالموافقة' : 'Not authorized to approve' });
    }
    const order = await FactoryOrder.findById(id);
    if (!order) {
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (order.status !== 'requested') {
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب ليس في حالة الطلب' : 'Order is not in requested status' });
    }
    order.status = 'approved';
    await order.save();
    const populatedOrder = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role
        }),
      })
      .lean();
    req.io?.emit('orderStatusUpdated', { orderId: id, status: 'approved' });
    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم الموافقة على الطلب' : 'Order approved successfully' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error approving factory order:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const assignFactoryChefs = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const { id } = req.params;
    const { items } = req.body;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    if (!['admin', 'production'].includes(req.user.role)) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مصرح بتعيين الشيفات' : 'Not authorized to assign chefs' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'قائمة العناصر غير صالحة' : 'Invalid items list' });
    }
    const order = await FactoryOrder.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (order.status !== 'approved') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب لم يتم الموافقة عليه' : 'Order not approved' });
    }
    const chefIds = items.map(i => i.assignedTo).filter(id => id);
    if (chefIds.length > 0 && !chefIds.every(id => isValidObjectId(id))) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرفات الشيفات غير صالحة' : 'Invalid chef IDs' });
    }
    const chefs = await User.find({ _id: { $in: chefIds } }).session(session);
    const products = await Product.find({ _id: { $in: order.items.map(i => i.product) } }).session(session);
    for (const item of items) {
      const orderItem = order.items.find(i => i._id.toString() === item.itemId);
      if (!orderItem) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'العنصر غير موجود' : 'Item not found' });
      }
      const product = products.find(p => p._id.toString() === orderItem.product.toString());
      const chef = chefs.find(c => c._id.toString() === item.assignedTo);
      if (chef && product && chef.department.toString() !== product.department.toString()) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'الشيف لا ينتمي إلى قسم المنتج' : 'Chef does not belong to product department' });
      }
      orderItem.assignedTo = item.assignedTo || undefined;
      orderItem.status = item.assignedTo ? 'assigned' : 'pending';
    }
    order.status = order.items.every(i => i.status === 'assigned') ? 'in_production' : 'approved';
    await order.save({ session });
    const populatedOrder = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role
        }),
      })
      .session(session)
      .lean();
    await session.commitTransaction();
    req.io?.emit('taskAssigned', { orderId: id, items: populatedOrder.items });
    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم تعيين الشيفات بنجاح' : 'Chefs assigned successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const updateItemStatus = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const { id: orderId, itemId } = req.params;
    const { status } = req.body;
    if (!isValidObjectId(orderId) || !isValidObjectId(itemId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب أو العنصر غير صالح' : 'Invalid order or item ID' });
    }
    if (!['pending', 'assigned', 'completed'].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'حالة العنصر غير صالحة' : 'Invalid item status' });
    }
    const order = await FactoryOrder.findById(orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    const item = order.items.find(i => i._id.toString() === itemId);
    if (!item) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'العنصر غير موجود' : 'Item not found' });
    }
    if (req.user.role === 'chef' && (!item.assignedTo || item.assignedTo.toString() !== req.user.id.toString())) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مصرح بتحديث هذا العنصر' : 'Not authorized to update this item' });
    }
    item.status = status;
    order.status = order.items.every(i => i.status === 'completed') ? 'completed' : order.status;
    await order.save({ session });
    const populatedOrder = await FactoryOrder.findById(orderId)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role
        }),
      })
      .session(session)
      .lean();
    await session.commitTransaction();
    req.io?.emit('itemStatusUpdated', { orderId, itemId, status });
    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم تحديث حالة العنصر' : 'Item status updated successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating item status:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const updateFactoryOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['requested', 'pending', 'approved', 'in_production', 'completed', 'stocked', 'cancelled'];
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    if (!validStatuses.includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'حالة الطلب غير صالحة' : 'Invalid order status' });
    }
    if (!['admin', 'production'].includes(req.user.role)) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مصرح بتحديث حالة الطلب' : 'Not authorized to update order status' });
    }
    const order = await FactoryOrder.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    const validTransitions = {
      requested: ['approved', 'cancelled'],
      pending: ['approved', 'cancelled'],
      approved: ['in_production', 'cancelled'],
      in_production: ['completed', 'cancelled'],
      completed: ['stocked'],
      stocked: [],
      cancelled: [],
    };
    if (!validTransitions[order.status].includes(status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'انتقال الحالة غير صالح' : 'Invalid status transition' });
    }
    order.status = status;
    await order.save({ session });
    if (status === 'stocked') {
      for (const item of order.items) {
        const inventory = await FactoryInventory.findOne({ product: item.product }).session(session);
        if (inventory) {
          inventory.quantity += item.quantity;
          await inventory.save({ session });
        } else {
          const newInventory = new FactoryInventory({
            product: item.product,
            quantity: item.quantity,
            department: item.department,
          });
          await newInventory.save({ session });
        }
        const history = new FactoryInventoryHistory({
          product: item.product,
          quantity: item.quantity,
          action: 'stocked',
          order: order._id,
          performedBy: req.user.id,
        });
        await history.save({ session });
      }
    }
    const populatedOrder = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role
        }),
      })
      .session(session)
      .lean();
    await session.commitTransaction();
    req.io?.emit('orderStatusUpdated', { orderId: id, status });
    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم تحديث حالة الطلب' : 'Order status updated successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating factory order status:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const confirmFactoryProduction = async (req, res) => {
  const session = await mongoose.startSession();
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    session.startTransaction();
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await FactoryOrder.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (order.status !== 'completed') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب لم يتم إكماله' : 'Order not completed' });
    }
    if (order.inventoryProcessed) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب تم معالجته بالفعل' : 'Order already processed' });
    }
    for (const item of order.items) {
      const inventory = await FactoryInventory.findOne({ product: item.product }).session(session);
      if (inventory) {
        inventory.quantity += item.quantity;
        await inventory.save({ session });
      } else {
        const newInventory = new FactoryInventory({
          product: item.product,
          quantity: item.quantity,
          department: item.department,
        });
        await newInventory.save({ session });
      }
      const history = new FactoryInventoryHistory({
        product: item.product,
        quantity: item.quantity,
        action: 'stocked',
        order: order._id,
        performedBy: req.user.id,
      });
      await history.save({ session });
    }
    order.inventoryProcessed = true;
    await order.save({ session });
    const populatedOrder = await FactoryOrder.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('items.assignedTo', 'username name nameEn department')
      .populate({
        path: 'createdBy',
        select: 'username name nameEn role',
        transform: (doc) => ({
          _id: doc._id,
          username: doc.username,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
          role: doc.role
        }),
      })
      .session(session)
      .lean();
    await session.commitTransaction();
    req.io?.emit('orderStatusUpdated', { orderId: id, status: 'stocked' });
    res.status(200).json({ success: true, data: populatedOrder, message: isRtl ? 'تم تأكيد الإنتاج' : 'Production confirmed successfully' });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error confirming factory production:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const getAvailableProducts = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  try {
    let query = { isActive: true };
    if (req.user.role === 'chef' && req.user.department) {
      query.department = req.user.department;
    }
    const products = await Product.find(query)
      .select('name nameEn code department unit unitEn')
      .populate({
        path: 'department',
        select: 'name nameEn',
        transform: (doc) => ({
          _id: doc._id,
          name: doc.name,
          nameEn: doc.nameEn,
          displayName: translateField(doc, 'name', lang),
        }),
      })
      .lean();
    const transformedProducts = products.map(p => ({
      ...p,
      displayName: translateField(p, 'name', lang),
      displayUnit: translateField(p, 'unit', lang),
    }));
    res.status(200).json({ success: true, data: transformedProducts, message: isRtl ? 'تم جلب المنتجات المتاحة بنجاح' : 'Available products fetched successfully' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching available products:`, err.message);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

module.exports = {
  createFactoryOrder,
  approveFactoryOrder,
  getFactoryOrders,
  getFactoryOrderById,
  assignFactoryChefs,
  updateItemStatus,
  updateFactoryOrderStatus,
  confirmFactoryProduction,
  getAvailableProducts,
};