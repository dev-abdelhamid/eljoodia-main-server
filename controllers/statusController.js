const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const validateStatusTransition = (currentStatus, newStatus) => {
  const validTransitions = {
    pending: ['approved', 'cancelled'],
    approved: ['in_production', 'cancelled'],
    in_production: ['completed', 'cancelled'],
    completed: ['in_transit'],
    in_transit: ['delivered'],
    delivered: [],
    cancelled: [],
  };
  return validTransitions[currentStatus]?.includes(newStatus) ?? false;
};

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

const assignChefs = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { items, notes, notesEn } = req.body;
    const { id: orderId } = req.params;
    if (!isValidObjectId(orderId) || !items?.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب أو مصفوفة العناصر غير صالحة' : 'Invalid order ID or items array' });
    }
    const order = await Order.findById(orderId)
      .populate({ path: 'items.product', populate: { path: 'department', select: 'name nameEn code isActive' } })
      .populate('branch')
      .setOptions({ context: { isRtl } })
      .session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (req.user.role === 'branch' && order.branch?._id.toString() !== req.user.branchId.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Unauthorized for this branch' });
    }
    if (order.status !== 'approved' && order.status !== 'in_production') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب في حالة "معتمد" أو "قيد الإنتاج" لتعيين الشيفات' : 'Order must be in "approved" or "in_production" status to assign chefs' });
    }
    const chefIds = items.filter(item => !item.rejected).map(item => item.assignedTo).filter(isValidObjectId);
    const chefs = await User.find({ _id: { $in: chefIds }, role: 'chef' }).lean();
    const chefProfiles = await mongoose.model('Chef').find({ user: { $in: chefIds } }).lean();
    const chefMap = new Map(chefs.map(c => [c._id.toString(), c]));
    const chefProfileMap = new Map(chefProfiles.map(p => [p.user.toString(), p]));
    const io = req.app.get('io'); // <--- الحصول على مثيل Socket.IO
    const assignments = [];
    const chefNotifications = [];
    for (const item of items) {
      const itemId = item.itemId || item._id;
      if (!isValidObjectId(itemId)) {
        throw new Error(isRtl ? `معرفات غير صالحة: ${itemId}` : `Invalid IDs: ${itemId}`);
      }
      const orderItem = order.items.find(i => i._id.toString() === itemId);
      if (!orderItem) {
        throw new Error(isRtl ? `العنصر ${itemId} غير موجود` : `Item ${itemId} not found`);
      }
      const existingTask = await mongoose.model('ProductionAssignment').findOne({ order: orderId, itemId }).session(session);
      if (existingTask && existingTask.chef.toString() !== item.assignedTo && !item.rejected) {
        throw new Error(isRtl ? 'لا يمكن إعادة تعيين المهمة لشيف آخر' : 'Cannot reassign task to another chef');
      }
      if (item.rejected) {
        orderItem.rejected = true;
        orderItem.rejectReason = item.rejectReason || 'أخرى';
        orderItem.status = 'rejected';
        order.statusHistory.push({
          status: 'rejected',
          changedBy: req.user.id,
          notes: `رفض العنصر ${orderItem.product.name} بسبب ${orderItem.rejectReason}`,
          notesEn: `Item ${orderItem.product.nameEn || orderItem.product.name} rejected due to ${orderItem.rejectReasonEn || orderItem.rejectReason}`,
          changedAt: new Date(),
        });
      } else {
        const chef = chefMap.get(item.assignedTo);
        const chefProfile = chefProfileMap.get(item.assignedTo);
        if (!chef || !chefProfile) {
          throw new Error(isRtl ? 'الشيف غير صالح' : 'Invalid chef');
        }
        orderItem.assignedTo = item.assignedTo;
        orderItem.status = 'assigned';
        assignments.push(
          mongoose.model('ProductionAssignment').findOneAndUpdate(
            { order: orderId, itemId },
            { chef: chefProfile._id, product: orderItem.product._id, quantity: orderItem.quantity, status: 'pending', itemId, order: orderId },
            { upsert: true, session }
          )
        );
        chefNotifications.push({
          userId: item.assignedTo,
          message: isRtl ? `تم تعيينك لإنتاج ${orderItem.product.name} في الطلب ${order.orderNumber}` : `Assigned to produce ${orderItem.product.nameEn || orderItem.product.name} for order ${order.orderNumber}`,
          data: {
            orderId,
            orderNumber: order.orderNumber,
            branchId: order.branch?._id,
            branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'غير معروف'),
            taskId: itemId, // <--- استخدام itemId بدلاً من taskId المفقود
            productId: orderItem.product._id,
            productName: isRtl ? orderItem.product.name : (orderItem.product.nameEn || orderItem.product.name),
            quantity: orderItem.quantity,
            eventId: `${itemId}-task_assigned`,
            isRtl,
          },
        });
      }
    }
    await Promise.all(assignments);
    order.markModified('items');
    order.statusHistory.push({
      status: order.status,
      changedBy: req.user.id,
      notes: notes?.trim(),
      notesEn: notesEn?.trim(),
      changedAt: new Date(),
    });
    await order.save({ session, context: { isRtl } });
    const populatedOrder = await Order.findById(orderId)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();
    const taskAssignedEventData = {
      _id: `${orderId}-taskAssigned-${Date.now()}`,
      type: 'taskAssigned',
      message: isRtl ? `تم تعيين الشيفات بنجاح للطلب ${order.orderNumber}` : `Chefs assigned successfully for order ${order.orderNumber}`,
      data: {
        orderId,
        orderNumber: order.orderNumber,
        branchId: order.branch?._id,
        branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'غير معروف'),
        eventId: `${orderId}-task_assigned`,
        isRtl,
      },
      read: false,
      createdAt: new Date().toISOString(),
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
    const branchUsers = order.branch ? await User.find({ role: 'branch', branch: order.branch._id }).select('_id').lean() : [];
    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers, ...branchUsers],
      'taskAssigned',
      taskAssignedEventData.message,
      taskAssignedEventData.data,
      false
    );
    for (const chefNotif of chefNotifications) {
      await notifyUsers(
        io,
        [{ _id: chefNotif.userId }],
        'taskAssigned',
        chefNotif.message,
        chefNotif.data,
        false
      );
    }

    // --- إضافة هذا الجزء ---
    // إرسال إشعار Socket.IO مخصص للشيفين المُعيَّنين
    if (io) {
      chefIds.forEach(chefId => {
        const chefRoom = `chef-${chefId}`;
        // يمكنك إرسال بيانات أكثر تفصيلاً هنا إذا أردت تحديث UI مباشرة
        io.to(chefRoom).emit('taskAssignedToChef', {
          orderId,
          orderNumber: order.orderNumber,
          branchId: order.branch?._id,
          branchName: isRtl ? order.branch?.name : (order.branch?.nameEn || order.branch?.name || 'غير معروف'),
          items: order.items.filter(item => item.assignedTo?.toString() === chefId).map(item => ({
            _id: item._id,
            productId: item.product._id,
            productName: isRtl ? item.product.name : (item.product.nameEn || item.product.name),
            quantity: item.quantity,
            unit: isRtl ? (item.product.unit || 'وحدة') : (item.product.unitEn || item.product.unit || 'unit'),
            status: item.status,
            assignedTo: { _id: chefId, name: chefMap.get(chefId)?.name || 'Unknown Chef' },
          })),
          eventId: `${orderId}-task_assigned_to_chef-${Date.now()}`,
          timestamp: new Date().toISOString(),
        });
      });
    }
    // --- نهاية الإضافة ---

    const rooms = new Set(['admin', 'production', `branch-${order.branch?._id}`]);
    chefIds.forEach(chefId => rooms.add(`chef-${chefId}`));
    await emitSocketEvent(io, rooms, 'taskAssigned', taskAssignedEventData);
    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      displayNotes: populatedOrder.displayNotes,
      items: populatedOrder.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'غير معروف'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayRejectReason: item.displayRejectReason,
      })),
      createdByName: isRtl ? populatedOrder.createdBy?.name : (populatedOrder.createdBy?.nameEn || populatedOrder.createdBy?.name || 'غير معروف'),
      statusHistory: populatedOrder.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'غير معروف'),
      })),
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      isRtl,
    });
  } catch (err) {
    const isRtl = req.query.isRtl === 'true'; // Fix: Define isRtl in catch block
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error assigning chefs:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const approveOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    const { rejectedItems } = req.body;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await Order.findById(id).setOptions({ context: { isRtl } }).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (order.status !== 'pending') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الطلب ليس في حالة "معلق"' : 'Order is not in "pending" status' });
    }
    if (req.user.role !== 'admin' && req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لاعتماد الطلب' : 'Unauthorized to approve order' });
    }
    if (rejectedItems && Array.isArray(rejectedItems)) {
      for (const rej of rejectedItems) {
        const item = order.items.find(i => i._id.toString() === rej.itemId);
        if (item) {
          item.rejected = true;
          item.rejectReason = rej.reason || 'أخرى';
          item.status = 'rejected';
          order.statusHistory.push({
            status: 'rejected',
            changedBy: req.user.id,
            notes: `رفض العنصر ${item.product.name} بسبب ${item.rejectReason}`,
            notesEn: `Item ${item.product.nameEn || item.product.name} rejected due to ${item.rejectReasonEn || item.rejectReason}`,
            changedAt: new Date(),
          });
        }
      }
      if (order.items.every(i => i.rejected)) {
        order.status = 'cancelled';
        order.statusHistory.push({
          status: 'cancelled',
          changedBy: req.user.id,
          notes: 'تم إلغاء الطلب بسبب رفض جميع العناصر',
          notesEn: 'Order cancelled due to all items rejected',
          changedAt: new Date(),
        });
        await order.save({ session, context: { isRtl } });
        await session.commitTransaction();
        return res.status(200).json({ success: true, message: isRtl ? 'تم إلغاء الطلب بسبب رفض جميع العناصر' : 'Order cancelled due to all items rejected' });
      }
      order.markModified('items');
    }
    order.status = 'approved';
    order.approvedBy = req.user.id;
    order.approvedAt = new Date();
    order.statusHistory.push({
      status: 'approved',
      changedBy: req.user.id,
      notes: isRtl ? 'تم اعتماد الطلب' : 'Order approved',
      notesEn: 'Order approved',
      changedAt: new Date(),
    });
    await order.save({ session, context: { isRtl } });
    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();
    const eventId = `${id}-order_approved`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      status: 'approved',
      eventId,
      isRtl,
    };
    await notifyUsers(
      io,
      usersToNotify,
      'orderApproved',
      isRtl ? `تم اعتماد الطلب ${order.orderNumber}` : `Order ${order.orderNumber} approved`,
      eventData,
      false
    );
    const orderData = {
      orderId: id,
      status: 'approved',
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      displayNotes: populatedOrder.displayNotes,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId,
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      isRtl,
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderApproved', orderData);
    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      displayNotes: populatedOrder.displayNotes,
      items: populatedOrder.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'غير معروف'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayRejectReason: item.displayRejectReason,
      })),
      createdByName: isRtl ? populatedOrder.createdBy?.name : (populatedOrder.createdBy?.nameEn || populatedOrder.createdBy?.name || 'غير معروف'),
      statusHistory: populatedOrder.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'غير معروف'),
      })),
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      isRtl,
    });
  } catch (err) {
    const isRtl = req.query.isRtl === 'true'; // Fix: Define isRtl in catch block
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error approving order:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const startTransit = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    const order = await Order.findById(id).setOptions({ context: { isRtl } }).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (order.status !== 'completed') {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'يجب أن يكون الطلب في حالة "مكتمل" لبدء التوصيل' : 'Order must be in "completed" status to start transit' });
    }
    if (req.user.role !== 'production') {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لبدء التوصيل' : 'Unauthorized to start transit' });
    }
    order.status = 'in_transit';
    order.transitStartedAt = new Date();
    order.statusHistory.push({
      status: 'in_transit',
      changedBy: req.user.id,
      notes: isRtl ? 'تم شحن الطلب بواسطة الإنتاج' : 'Order shipped by production',
      notesEn: 'Order shipped by production',
      changedAt: new Date(),
    });
    await order.save({ session, context: { isRtl } });
    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();
    const eventId = `${id}-order_in_transit`;
    const eventData = {
      orderId: id,
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      status: 'in_transit',
      eventId,
      isRtl,
    };
    await notifyUsers(
      io,
      usersToNotify,
      'orderInTransit',
      isRtl ? `الطلب ${order.orderNumber} في طريقه إلى الفرع ${populatedOrder.branch?.name || 'غير معروف'}` : `Order ${order.orderNumber} is on its way to branch ${populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'Unknown'}`,
      eventData,
      true
    );
    const orderData = {
      orderId: id,
      status: 'in_transit',
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      displayNotes: populatedOrder.displayNotes,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId,
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      isRtl,
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderInTransit', orderData);
    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      displayNotes: populatedOrder.displayNotes,
      items: populatedOrder.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'غير معروف'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayRejectReason: item.displayRejectReason,
      })),
      createdByName: isRtl ? populatedOrder.createdBy?.name : (populatedOrder.createdBy?.nameEn || populatedOrder.createdBy?.name || 'غير معروف'),
      statusHistory: populatedOrder.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'غير معروف'),
      })),
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      isRtl,
    });
  } catch (err) {
    const isRtl = req.query.isRtl === 'true'; // Fix: Define isRtl in catch block
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error starting transit:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const updateOrderStatus = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { id } = req.params;
    const { status, notes, notesEn, rejectedItems } = req.body;
    if (!isValidObjectId(id)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب غير صالح' : 'Invalid order ID' });
    }
    if (!status) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'الحالة مطلوبة' : 'Status is required' });
    }
    const order = await Order.findById(id).setOptions({ context: { isRtl } }).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (!validateStatusTransition(order.status, status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? `لا يمكن تغيير الحالة من ${order.status} إلى ${status}` : `Cannot change status from ${order.status} to ${status}` });
    }
    if (req.user.role !== 'admin' && req.user.role !== 'production' && (req.user.role !== 'branch' || order.branch.toString() !== req.user.branchId.toString())) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث حالة الطلب' : 'Unauthorized to update order status' });
    }
    if (status === 'approved' && rejectedItems && Array.isArray(rejectedItems)) {
      let allRejected = true;
      for (const rej of rejectedItems) {
        const item = order.items.find(i => i._id.toString() === rej.itemId);
        if (item) {
          item.rejected = true;
          item.rejectReason = rej.reason || 'أخرى';
          item.status = 'rejected';
          order.statusHistory.push({
            status: 'rejected',
            changedBy: req.user.id,
            notes: `رفض العنصر ${item.product.name} بسبب ${item.rejectReason}`,
            notesEn: `Item ${item.product.nameEn || item.product.name} rejected due to ${item.rejectReasonEn || item.rejectReason}`,
            changedAt: new Date(),
          });
        } else {
          allRejected = false;
        }
      }
      if (order.items.every(i => i.rejected)) {
        status = 'cancelled';
        order.statusHistory.push({
          status: 'cancelled',
          changedBy: req.user.id,
          notes: 'تم إلغاء الطلب بسبب رفض جميع العناصر',
          notesEn: 'Order cancelled due to all items rejected',
          changedAt: new Date(),
        });
      }
      order.markModified('items');
    }
    order.status = status;
    order.statusHistory.push({
      status,
      changedBy: req.user.id,
      notes: notes?.trim() || `Status updated to ${status}`,
      notesEn: notesEn?.trim() || `Status updated to ${status}`,
      changedAt: new Date(),
    });
    if (status === 'delivered') order.deliveredAt = new Date();
    if (status === 'in_transit') order.transitStartedAt = new Date();
    if (status === 'approved') order.approvedAt = new Date();
    await order.save({ session, context: { isRtl } });
    const populatedOrder = await Order.findById(id)
      .populate('branch', 'name nameEn')
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department', populate: { path: 'department', select: 'name nameEn code' } })
      .populate('items.assignedTo', 'username name nameEn')
      .populate('createdBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();
    const io = req.app.get('io');
    const usersToNotify = await User.find({
      $or: [
        { role: { $in: ['admin', 'production'] } },
        { role: 'branch', branch: order.branch },
      ],
    }).select('_id role').lean();
    const eventId = `${id}-order_status_updated-${status}`;
    const eventType = status === 'delivered' ? 'orderDelivered' : 'orderStatusUpdated';
    const messageKey = status === 'delivered'
      ? isRtl ? `تم توصيل الطلب ${order.orderNumber}` : `Order ${order.orderNumber} delivered`
      : isRtl ? `تم تحديث حالة الطلب ${order.orderNumber} إلى ${status}` : `Order ${order.orderNumber} status updated to ${status}`;
    const saveToDb = status === 'completed' || status === 'delivered';
    await notifyUsers(
      io,
      usersToNotify,
      eventType,
      messageKey,
      { orderId: id, orderNumber: order.orderNumber, branchId: order.branch, status, eventId, isRtl },
      saveToDb
    );
    const orderData = {
      orderId: id,
      status,
      user: { id: req.user.id, username: req.user.username },
      orderNumber: order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      displayNotes: populatedOrder.displayNotes,
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      eventId,
      sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
      vibrate: [200, 100, 200],
      isRtl,
    };
    await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], eventType, orderData);
    await session.commitTransaction();
    res.status(200).json({
      ...populatedOrder,
      branchName: isRtl ? populatedOrder.branch?.name : (populatedOrder.branch?.nameEn || populatedOrder.branch?.name || 'غير معروف'),
      displayNotes: populatedOrder.displayNotes,
      items: populatedOrder.items.map(item => ({
        ...item,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'غير معروف'),
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
        departmentName: isRtl ? item.product?.department?.name : (item.product?.department?.nameEn || item.product?.department?.name || 'غير معروف'),
        assignedToName: isRtl ? item.assignedTo?.name : (item.assignedTo?.nameEn || item.assignedTo?.name || 'غير معين'),
        displayRejectReason: item.displayRejectReason,
      })),
      createdByName: isRtl ? populatedOrder.createdBy?.name : (populatedOrder.createdBy?.nameEn || populatedOrder.createdBy?.name || 'غير معروف'),
      statusHistory: populatedOrder.statusHistory.map(history => ({
        ...history,
        displayNotes: history.displayNotes,
        changedByName: isRtl ? history.changedBy?.name : (history.changedBy?.nameEn || history.changedBy?.name || 'غير معروف'),
      })),
      adjustedTotal: populatedOrder.adjustedTotal,
      createdAt: new Date(populatedOrder.createdAt).toISOString(),
      isRtl,
    });
  } catch (err) {
    const isRtl = req.query.isRtl === 'true'; // Fix: Define isRtl in catch block
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating order status:`, {
      error: err.message,
      userId: req.user.id,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = {
  assignChefs,
  approveOrder,
  startTransit,
  updateOrderStatus,
};