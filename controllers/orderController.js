const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const { createNotification } = require('../utils/notifications');
const { syncOrderTasks } = require('./productionController');
const { assignChefs, approveOrder, startTransit, updateOrderStatus } = require('./statusController');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const emitSocketEvent = async (io, rooms, eventName, eventData) => {
  const eventDataWithSound = {
    ...eventData,
    sound: eventData.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: eventData.vibrate || [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: eventData.eventId || `${eventName}-${Date.now()}`,
  };
  const uniqueRooms = [...new Set(rooms)];
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, { rooms: uniqueRooms, eventData: eventDataWithSound });
};

const notifyUsers = async (io, users, type, messageKey, data, saveToDb = false) => {
  const isRtl = data.isRtl ?? true;
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    messageKey,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, messageKey, data, io, saveToDb);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, {
        error: err.message,
        stack: err.stack,
      });
    }
  }
};

const createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { orderNumber, items, status = 'pending', notes, notesEn, priority = 'medium', branchId, requestedDeliveryDate } = req.body;

    const branch = req.user.role === 'branch' ? req.user.branchId : branchId;
    if (!branch || !isValidObjectId(branch)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid branch ID:`, { branch, userId: req.user.id });
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الفرع مطلوب ويجب أن يكون صالحًا' : 'Branch ID is required and must be valid'
      });
    }

    if (!orderNumber || typeof orderNumber !== 'string' || !items?.length || !Array.isArray(items)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Missing or invalid orderNumber or items:`, { orderNumber, items, userId: req.user.id });
      return res.status(400).json({
        success: false,
        message: isRtl ? 'رقم الطلب ومصفوفة العناصر مطلوبة ويجب أن تكون صالحة' : 'Order number and items array are required and must be valid'
      });
    }

    for (const item of items) {
      if (!isValidObjectId(item.product) || typeof item.price !== 'number' || item.price < 0 || !item.quantity || item.quantity < 0.25) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Invalid item data:`, { item, userId: req.user.id });
        return res.status(400).json({
          success: false,
          message: isRtl ? 'بيانات العنصر غير صالحة (معرف المنتج، الكمية، أو السعر)' : 'Invalid item data (product ID, quantity, or price)'
        });
      }
    }

    const mergedItems = items.reduce((acc, item) => {
      const existing = acc.find(i => i.product.toString() === item.product.toString());
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        acc.push({
          product: item.product,
          quantity: item.quantity,
          price: item.price,
          status: 'pending',
          startedAt: null,
          completedAt: null,
        });
      }
      return acc;
    }, []);

    const productIds = mergedItems.map(item => item.product);
    const products = await Product.find({ _id: { $in: productIds } })
      .select('price name nameEn unit unitEn department')
      .populate('department', 'name nameEn code')
      .lean()
      .session(session);

    if (products.length !== productIds.length) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Some products not found:`, { productIds, found: products.map(p => p._id), userId: req.user.id });
      return res.status(400).json({
        success: false,
        message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found'
      });
    }

    for (const item of mergedItems) {
      const product = products.find(p => p._id.toString() === item.product.toString());
      if (product.price !== item.price) {
        await session.abortTransaction();
        console.error(`[${new Date().toISOString()}] Price mismatch for product:`, { productId: item.product, expected: product.price, provided: item.price, userId: req.user.id });
        return res.status(400).json({
          success: false,
          message: isRtl ? `السعر غير متطابق للمنتج ${item.product}` : `Price mismatch for product ${item.product}`
        });
      }
    }

    const newOrder = new Order({
      orderNumber: orderNumber.trim(),
      branch,
      items: mergedItems,
      status,
      notes: notes?.trim() || '',
      notesEn: notesEn?.trim() || notes?.trim() || '',
      priority: priority?.trim() || 'medium',
      createdBy: req.user.id,
      total: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      adjustedTotal: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      requestedDeliveryDate: requestedDeliveryDate ? new Date(requestedDeliveryDate) : null,
      statusHistory: [{
        status,
        changedBy: req.user.id,
        notes: notes?.trim() || (isRtl ? 'تم إنشاء الطلب' : 'Order created'),
        notesEn: notesEn?.trim() || 'Order created',
        changedAt: new Date(),
      }],
    });

    const existingOrder = await Order.findOne({ orderNumber: newOrder.orderNumber, branch }).session(session);
    if (existingOrder) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Duplicate order number:`, { orderNumber, branch, userId: req.user.id });
      return res.status(400).json({
        success: false,
        message: isRtl ? 'رقم الطلب مستخدم بالفعل لهذا الفرع' : 'Order number already used for this branch'
      });
    }

    await newOrder.save({ session });
    await syncOrderTasks(newOrder._id, req.app.get('io'), session);

    const populatedOrder = await Order.findById(newOrder._id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .lean()
      .session(session);

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);
    const branchUsers = await User.find({ role: 'branch', branch }).select('_id').lean().session(session);
    const eventId = `${newOrder._id}-orderCreated`;
    const totalQuantity = mergedItems.reduce((sum, item) => sum + item.quantity, 0);
    const totalAmount = mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0);

    const branchNotificationData = {
      orderId: newOrder._id,
      orderNumber: newOrder.orderNumber,
      branchId: branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'),
      eventId,
      isRtl,
      type: 'toast',
    };
    await notifyUsers(io, branchUsers, 'orderCreated', isRtl ? `تم إنشاء طلبك رقم ${newOrder.orderNumber} بنجاح` : `Order ${newOrder.orderNumber} created successfully`, branchNotificationData, false);

    const adminProductionNotificationData = {
      orderId: newOrder._id,
      orderNumber: newOrder.orderNumber,
      branchId: branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'),
      totalQuantity,
      totalAmount,
      items: populatedOrder.items.map(item => ({
        productId: item.product?._id,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name),
        quantity: item.quantity,
        price: item.price,
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
      })),
      status: newOrder.status,
      priority: newOrder.priority,
      requestedDeliveryDate: newOrder.requestedDeliveryDate ? new Date(newOrder.requestedDeliveryDate).toISOString() : null,
      eventId,
      isRtl,
      type: 'persistent',
    };
    await notifyUsers(io, [...adminUsers, ...productionUsers], 'orderCreated',
      isRtl ? `تم إنشاء طلب رقم ${newOrder.orderNumber} بقيمة ${totalAmount} وكمية ${totalQuantity} من فرع ${populatedOrder.branch?.name || 'غير معروف'}` :
      `Order ${newOrder.orderNumber} created with value ${totalAmount} and quantity ${totalQuantity} from branch ${populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'}`,
      adminProductionNotificationData, true);

    const orderData = {
      ...populatedOrder,
      branchId: branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'),
      displayNotes: populatedOrder.displayNotes,
      items: populatedOrder.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'Unknown'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayRejectReason: item.displayRejectReason,
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      createdByName: isRtl ? populatedOrder.createdBy?.name : (populatedOrder.createdBy?.nameEn || populatedOrder.createdBy?.name || 'Unknown'),
      statusHistory: populatedOrder.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'Unknown'),
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      requestedDeliveryDate: populatedOrder.requestedDeliveryDate ? new Date(populatedOrder.requestedDeliveryDate).toISOString() : null,
      eventId,
      isRtl,
    };

    await emitSocketEvent(io, ['admin', 'production', `branch-${branch}`], 'orderCreated', orderData);
    await session.commitTransaction();

    res.status(201).json({
      success: true,
      data: orderData,
      message: isRtl ? 'تم إنشاء الطلب بنجاح' : 'Order created successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating order:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({
      success: false,
      message: isRtl ? 'خطأ في السيرفر' : 'Server error',
      error: err.message
    });
  } finally {
    session.endSession();
  }
};

const confirmDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const isRtl = req.headers['accept-language']?.includes('ar') || true;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID',
      });
    }

    if (items.length === 0) {
      return res.status(400).json({
        success: false,
        message: isRtl ? 'مصفوفة العناصر مطلوبة ولا يمكن أن تكون فارغة' : 'Items array is required and cannot be empty',
      });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: isRtl ? 'الطلب غير موجود' : 'Order not found',
      });
    }

    if (order.branch.toString() !== req.user.branchId.toString()) {
      return res.status(403).json({
        success: false,
        message: isRtl ? 'غير مخول لتأكيد استلام هذا الطلب' : 'Not authorized to confirm this order',
      });
    }

    if (order.status !== 'in_transit') {
      return res.status(400).json({
        success: false,
        message: isRtl ? 'الطلب يجب أن يكون في حالة النقل (in_transit)' : 'Order must be in transit',
      });
    }

    if (order.status === 'delivered' || order.deliveredAt) {
      return res.status(400).json({
        success: false,
        message: isRtl ? 'تم تأكيد الاستلام مسبقًا' : 'Delivery already confirmed',
      });
    }

    const receivedMap = new Map();
    for (const item of items) {
      if (!item.itemId || !mongoose.Types.ObjectId.isValid(item.itemId)) continue;
      receivedMap.set(item.itemId.toString(), {
        qty: Math.max(0, parseFloat(item.receivedQuantity) || 0),
        rejected: !!item.rejected,
        reason: item.rejected ? String(item.rejectReason || 'غير محدد').trim() : '',
      });
    }

    let newAdjustedTotal = 0;
    const inventoryUpdates = [];
    const historyEntries = [];

    for (const item of order.items) {
      const rec = receivedMap.get(item._id.toString()) || { qty: 0, rejected: true, reason: 'غير محدد' };
      const receivedQty = rec.rejected ? 0 : rec.qty;

      item.receivedQuantity = receivedQty;
      item.rejected = rec.rejected;
      item.rejectReason = rec.reason;
      item.status = rec.rejected ? 'rejected' : 'completed';

      if (!rec.rejected && receivedQty > 0) {
        newAdjustedTotal += receivedQty * item.price;

        inventoryUpdates.push({
          updateOne: {
            filter: { branch: order.branch, product: item.product },
            update: {
              $inc: { currentStock: receivedQty },
              $set: { updatedAt: new Date() },
              $setOnInsert: { createdBy: req.user._id }
            },
            upsert: true,
          },
        });

        historyEntries.push({
          product: item.product,
          branch: order.branch,
          action: 'delivery',
          quantity: receivedQty,
          reference: `تسليم طلب #${order.orderNumber}`,
          referenceType: 'order',
          referenceId: order._id,
          createdBy: req.user._id,
          notes: rec.rejected ? 'مرفوض جزئيًا' : 'مستلم كامل',
        });
      }
    }

    order.status = 'delivered';
    order.deliveredAt = new Date();
    order.confirmedBy = req.user._id;
    order.adjustedTotal = Number(newAdjustedTotal.toFixed(2));

    order.statusHistory.push({
      status: 'delivered',
      changedBy: req.user._id,
      notes: 'تأكيد استلام من الفرع',
      notesEn: 'Delivery confirmed by branch',
      changedAt: new Date(),
    });

    await order.save({ session });

    if (inventoryUpdates.length > 0) {
      await Inventory.bulkWrite(inventoryUpdates, { session });
      await InventoryHistory.insertMany(historyEntries, { session });
    }

    const io = req.app.get('io');
    emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderDelivered', {
      orderId: order._id,
      orderNumber: order.orderNumber,
      deliveredAt: new Date().toISOString(),
      adjustedTotal: order.adjustedTotal,
      branchId: order.branch.toString(),
    });

    await session.commitTransaction();

    res.json({
      success: true,
      message: isRtl ? 'تم تأكيد الاستلام وتحديث المخزون بنجاح' : 'Delivery confirmed successfully',
      data: {
        orderId: order._id,
        orderNumber: order.orderNumber,
        adjustedTotal: order.adjustedTotal,
        deliveredAt: order.deliveredAt,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('confirmDelivery Error:', err);
    res.status(500).json({
      success: false,
      message: 'فشل تأكيد الاستلام',
      error: err.message || 'Unknown error',
    });
  } finally {
    session.endSession();
  }
};

const checkOrderExists = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID in checkOrderExists: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await Order.findById(id).select('_id orderNumber status branch').lean();
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found in checkOrderExists: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (req.user.role === 'branch' && order.branch?.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access in checkOrderExists:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }
    res.status(200).json({ success: true, orderId: id, exists: true });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error checking order existence:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getOrders = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { status, branch, priority } = req.query;
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) query.branch = branch;
    if (priority) query.priority = priority;
    if (req.user.role === 'branch') query.branch = req.user.branchId;

    const orders = await Order.find(query)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .sort({ createdAt: -1 })
      .lean();

    const formattedOrders = orders.map(order => ({
      ...order,
      branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'غير معروف'),
      displayNotes: order.displayNotes,
      items: order.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'غير معروف'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayRejectReason: item.displayRejectReason,
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      createdByName: isRtl ? order.createdBy?.name : (order.createdBy?.nameEn || order.createdBy?.name || 'غير معروف'),
      statusHistory: order.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'غير معروف'),
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      adjustedTotal: order.adjustedTotal,
      createdAt: new Date(order.createdAt).toISOString(),
      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
      transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,
      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
      isRtl,
    }));
    res.status(200).json(formattedOrders);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching orders:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getOrderById = async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      console.error(`[${new Date().toISOString()}] Invalid order ID: ${id}, User: ${req.user.id}`);
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }

    const order = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .lean();

    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${id}, User: ${req.user.id}`);
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }

    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized branch access:`, {
        userBranch: req.user.branchId,
        orderBranch: order.branch?._id,
        userId: req.user.id,
      });
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }

    const formattedOrder = {
      ...order,
      branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'غير معروف'),
      displayNotes: order.displayNotes,
      items: order.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'غير معروف'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayRejectReason: item.displayRejectReason,
        startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
        completedAt: item.completedAt ? new Date(item.completedAt).toISOString() : null,
        isCompleted: item.status === 'completed',
      })),
      createdByName: isRtl ? order.createdBy?.name : (order.createdBy?.nameEn || order.createdBy?.name || 'غير معروف'),
      statusHistory: order.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'غير معروف'),
        changedAt: new Date(history.changedAt).toISOString(),
      })),
      adjustedTotal: order.adjustedTotal,
      createdAt: new Date(order.createdAt).toISOString(),
      approvedAt: order.approvedAt ? new Date(order.approvedAt).toISOString() : null,
      transitStartedAt: order.transitStartedAt ? new Date(order.transitStartedAt).toISOString() : null,
      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt).toISOString() : null,
      isRtl,
    };

    console.log(`[${new Date().toISOString()}] Order fetched successfully: ${id}`);
    res.status(200).json(formattedOrder);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching order by id:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

module.exports = {
  checkOrderExists,
  createOrder,
  getOrders,
  getOrderById,
  assignChefs,
  approveOrder,
  startTransit,
  confirmDelivery,
  updateOrderStatus,
};