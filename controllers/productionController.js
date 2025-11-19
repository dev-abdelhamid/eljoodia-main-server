const mongoose = require('mongoose');
const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const emitSocketEvent = async (io, rooms, eventName, eventData, isRtl) => {
  const eventDataWithSound = {
    ...eventData,
    sound: eventData.sound || 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
    vibrate: eventData.vibrate || [200, 100, 200],
    timestamp: new Date().toISOString(),
    eventId: eventData.eventId || `${eventName}-${Date.now()}`,
    isRtl,
  };
  const uniqueRooms = [...new Set(rooms)];
  uniqueRooms.forEach(room => io.to(room).emit(eventName, eventDataWithSound));
  console.log(`[${new Date().toISOString()}] Emitted ${eventName}:`, { rooms: uniqueRooms, eventData: eventDataWithSound });
};

const notifyUsers = async (io, users, type, messageKey, data, saveToDb = false, isRtl) => {
  const message = isRtl ? `رسالة عربي لـ ${messageKey}` : `English message for ${messageKey}`; // Replace with actual translation logic
  console.log(`[${new Date().toISOString()}] Notifying users for ${type}:`, {
    users: users.map(u => u._id),
    message,
    data,
  });
  for (const user of users) {
    try {
      await createNotification(user._id, type, message, data, io, saveToDb);
      console.log(`[${new Date().toISOString()}] Successfully notified user ${user._id} for ${type}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed to notify user ${user._id} for ${type}:`, err);
    }
  }
};

const createTask = async (req, res) => {
  const session = await mongoose.startSession();
  const isRtl = req.query.isRtl === 'true';
  try {
    session.startTransaction();
    const { order, product, chef, quantity, itemId } = req.body;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(order) || !mongoose.isValidObjectId(product) ||
        !mongoose.isValidObjectId(chef) || !quantity || quantity < 1 ||
        !mongoose.isValidObjectId(itemId)) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid input for createTask:`, { order, product, chef, quantity, itemId });
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب، المنتج، الشيف، الكمية، ومعرف العنصر الصالحة مطلوبة' : 'Order, product, chef, quantity, and item ID are required and must be valid' });
    }

    const orderDoc = await Order.findById(order).session(session).setOptions({ context: { isRtl } });
    if (!orderDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order not found for createTask: ${order}`);
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    if (orderDoc.status !== 'approved') {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Order ${order} not approved for task creation`);
      return res.status(400).json({ success: false, message: isRtl ? 'يجب الموافقة على الطلب قبل تعيين المهام' : 'Order must be approved before assigning tasks' });
    }

    const productDoc = await Product.findById(product).populate('department').session(session).setOptions({ context: { isRtl } });
    if (!productDoc) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Product not found: ${product}`);
      return res.status(404).json({ success: false, message: isRtl ? 'المنتج غير موجود' : 'Product not found' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: chef }).session(session);
    const chefDoc = await User.findById(chef).populate('department').session(session).setOptions({ context: { isRtl } });
    if (!chefDoc || chefDoc.role !== 'chef' || !chefProfile ||
        chefProfile.department.toString() !== productDoc.department._id.toString()) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid chef or department mismatch:`, {
        chefId: chef,
        chefRole: chefDoc?.role,
        chefDepartment: chefDoc?.department?._id,
        productDepartment: productDoc?.department?._id
      });
      return res.status(400).json({ success: false, message: isRtl ? 'الشيف غير صالح أو غير متطابق مع قسم المنتج' : 'Invalid chef or department mismatch' });
    }

    const orderItem = orderDoc.items.id(itemId);
    if (!orderItem || orderItem.product.toString() !== product) {
      await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Invalid order item or product mismatch:`, { itemId, product });
      return res.status(400).json({ success: false, message: isRtl ? `العنصر ${itemId} غير موجود في الطلب أو لا يتطابق مع المنتج` : `Item ${itemId} not found in order or does not match product` });
    }

    console.log(`[${new Date().toISOString()}] Creating task:`, { orderId: order, itemId, product, chef, quantity });

    const newAssignment = new ProductionAssignment({
      order,
      product,
      chef: chefDoc._id,
      quantity,
      itemId,
      status: 'pending'
    });
    await newAssignment.save({ session });

    orderItem.status = 'assigned';
    orderItem.assignedTo = chefDoc._id;
    orderItem.department = productDoc.department._id;
    await orderDoc.save({ session });

    await syncOrderTasks(order._id, io, session, isRtl);

    await session.commitTransaction();

    const populatedAssignment = await ProductionAssignment.findById(newAssignment._id)
      .populate('order', 'orderNumber')
      .populate('product', 'name nameEn unit unitEn')
      .populate('chef', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .lean();

    const taskAssignedEvent = {
      ...populatedAssignment,
      branchId: orderDoc.branch,
      branchName: isRtl ? orderDoc.branch.name : (orderDoc.branch.nameEn || orderDoc.branch.name || 'Unknown'),
      itemId,
      eventId: `${itemId}-taskAssigned`,
      productName: isRtl ? populatedAssignment.product.name : (populatedAssignment.product.nameEn || populatedAssignment.product.name || 'Unknown'),
      chefName: isRtl ? populatedAssignment.chef.name : (populatedAssignment.chef.nameEn || populatedAssignment.chef.name || 'Unknown'),
      isRtl,
    };
    await emitSocketEvent(io, [`chef-${chefDoc._id}`, 'admin', 'production', `branch-${orderDoc.branch}`], 'taskAssigned', taskAssignedEvent, isRtl);
    await notifyUsers(io, [{ _id: chefDoc._id }], 'taskAssigned',
      isRtl ? `تم تعيينك لإنتاج ${populatedAssignment.product.name} في الطلب ${orderDoc.orderNumber}` : `Assigned to produce ${populatedAssignment.product.nameEn || populatedAssignment.product.name} for order ${orderDoc.orderNumber}`,
      { taskId: newAssignment._id, orderId: order, orderNumber: orderDoc.orderNumber, branchId: orderDoc.branch, eventId: `${itemId}-taskAssigned`, isRtl },
      false, isRtl
    );

    res.status(201).json(taskAssignedEvent);
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating task:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const getTasks = async (req, res) => {
  const isRtl = req.query.isRtl === 'true';
  try {
    const tasks = await ProductionAssignment.find()
      .populate('order', 'orderNumber _id branch')
      .populate({
        path: 'product',
        select: 'name nameEn department',
        populate: { path: 'department', select: 'name nameEn code' }
      })
      .populate('chef', 'username name nameEn')
      .sort({ updatedAt: -1 })
      .setOptions({ context: { isRtl } })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks:`,
        tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })));
    }

    const formattedTasks = validTasks.map(task => ({
      ...task,
      productName: isRtl ? task.product.name : (task.product.nameEn || task.product.name || 'Unknown'),
      departmentName: isRtl ? task.product.department.name : (task.product.department.nameEn || task.product.department.name || 'Unknown'),
      chefName: isRtl ? task.chef.name : (task.chef.nameEn || task.chef.name || 'Unknown'),
      branchName: isRtl ? task.order.branch.name : (task.order.branch.nameEn || task.order.branch.name || 'Unknown'),
      isRtl,
    }));

    res.status(200).json(formattedTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching tasks:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getChefTasks = async (req, res) => {
  const isRtl = req.query.isRtl === 'true';
  try {
    const { chefId } = req.params;
    if (!mongoose.isValidObjectId(chefId)) {
      console.error(`[${new Date().toISOString()}] Invalid chefId: ${chefId}`);
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الشيف غير صالح' : 'Invalid chef ID' });
    }

    const tasks = await ProductionAssignment.find({ chef: chefId })
      .populate('order', 'orderNumber _id branch')
      .populate({
        path: 'product',
        select: 'name nameEn department',
        populate: { path: 'department', select: 'name nameEn code' }
      })
      .populate('chef', 'username name nameEn')
      .sort({ updatedAt: -1 })
      .setOptions({ context: { isRtl } })
      .lean();

    const validTasks = tasks.filter(task => task.order && task.product && task.itemId);
    if (validTasks.length !== tasks.length) {
      console.warn(`[${new Date().toISOString()}] Filtered invalid tasks for chef ${chefId}:`,
        tasks.filter(task => !task.order || !task.product || !task.itemId)
          .map(t => ({ id: t._id, order: t.order?._id, product: t.product?._id, itemId: t.itemId })));
    }

    const formattedTasks = validTasks.map(task => ({
      ...task,
      productName: isRtl ? task.product.name : (task.product.nameEn || task.product.name || 'Unknown'),
      departmentName: isRtl ? task.product.department.name : (task.product.department.nameEn || task.product.department.name || 'Unknown'),
      chefName: isRtl ? task.chef.name : (task.chef.nameEn || task.chef.name || 'Unknown'),
      branchName: isRtl ? task.order.branch.name : (task.order.branch.nameEn || task.order.branch.name || 'Unknown'),
      isRtl,
    }));

    res.status(200).json(formattedTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const updateTaskStatus = async (req, res) => {
  const session = await mongoose.startSession();
  const isRtl = req.query.isRtl === 'true';
  try {
    session.startTransaction();
    const { status } = req.body;
    const { orderId, taskId } = req.params;
    const io = req.app.get('io');

    if (!mongoose.isValidObjectId(orderId) || !mongoose.isValidObjectId(taskId)) {
      console.error(`[${new Date().toISOString()}] Invalid orderId or taskId:`, { orderId, taskId });
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الطلب أو المهمة غير صالح' : 'Invalid order or task ID' });
    }

    const task = await ProductionAssignment.findById(taskId).populate('order').session(session).setOptions({ context: { isRtl } });
    if (!task) {
      console.error(`[${new Date().toISOString()}] Task not found: ${taskId}`);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'المهمة غير موجودة' : 'Task not found' });
    }
    if (!task.itemId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} has no itemId`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'معرف العنصر مفقود في المهمة' : 'Item ID missing in task' });
    }
    if (task.order._id.toString() !== orderId) {
      console.error(`[${new Date().toISOString()}] Task ${taskId} does not match order ${orderId}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'المهمة لا تتطابق مع الطلب' : 'Task does not match order' });
    }

    const chefProfile = await mongoose.model('Chef').findOne({ user: req.user.id }).session(session);
    if (!chefProfile || task.chef.toString() !== chefProfile._id.toString()) {
      console.error(`[${new Date().toISOString()}] Unauthorized task update:`, { userId: req.user.id, taskChef: task.chef });
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لتحديث هذه المهمة' : 'Unauthorized to update this task' });
    }

    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      console.error(`[${new Date().toISOString()}] Invalid status: ${status}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'حالة غير صالحة' : 'Invalid status' });
    }
    if (task.status === 'completed' && status === 'completed') {
      console.warn(`[${new Date().toISOString()}] Task ${taskId} already completed`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'المهمة مكتملة بالفعل' : 'Task already completed' });
    }

    console.log(`[${new Date().toISOString()}] Updating task ${taskId} for item ${task.itemId} to status: ${status}`);

    task.status = status;
    if (status === 'in_progress') task.startedAt = new Date();
    if (status === 'completed') task.completedAt = new Date();
    await task.save({ session });

    const order = await Order.findById(orderId).session(session).setOptions({ context: { isRtl } });
    if (!order) {
      console.error(`[${new Date().toISOString()}] Order not found: ${orderId}`);
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: isRtl ? 'الطلب غير موجود' : 'Order not found' });
    }
    const orderItem = order.items.id(task.itemId);
    if (!orderItem) {
      console.error(`[${new Date().toISOString()}] Order item not found: ${task.itemId}`);
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? `العنصر ${task.itemId} غير موجود في الطلب` : `Item ${task.itemId} not found in order` });
    }

    orderItem.status = status;
    if (status === 'in_progress') orderItem.startedAt = new Date();
    if (status === 'completed') orderItem.completedAt = new Date();
    console.log(`[${new Date().toISOString()}] Updated order item ${task.itemId} status to ${status}`);

    if (status === 'in_progress' && order.status === 'approved') {
      order.status = 'in_production';
      order.statusHistory.push({
        status: 'in_production',
        changedBy: req.user.id,
        changedAt: new Date(),
        notes: isRtl ? 'بدأ الإنتاج' : 'Production started',
        notesEn: 'Production started',
      });
      console.log(`[${new Date().toISOString()}] Updated order ${orderId} status to 'in_production'`);
      const usersToNotify = await User.find({ role: { $in: ['chef', 'admin', 'production'] } }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'orderStatusUpdated',
        isRtl ? `بدأ إنتاج الطلب ${order.orderNumber}` : `Production started for order ${order.orderNumber}`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, eventId: `${orderId}-orderStatusUpdated-in_production`, isRtl },
        false, isRtl
      );
      const orderStatusUpdatedEvent = {
        orderId,
        status: 'in_production',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: isRtl ? order.branch.name : (order.branch.nameEn || order.branch.name || 'Unknown'),
        eventId: `${orderId}-orderStatusUpdated-in_production`,
        isRtl,
      };
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderStatusUpdated', orderStatusUpdatedEvent, isRtl);
    }

    if (order.items.every(i => i.status === 'completed') && order.status === 'in_production') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: req.user.id,
        changedAt: new Date(),
        notes: isRtl ? 'جميع العناصر مكتملة' : 'All items completed',
        notesEn: 'All items completed',
      });
      console.log(`[${new Date().toISOString()}] Updated order ${orderId} status to 'completed'`);
      const usersToNotify = await User.find({ role: { $in: ['admin', 'production', 'branch', 'chef'] }, branch: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'orderCompleted',
        isRtl ? `تم إكمال الطلب ${order.orderNumber}` : `Order ${order.orderNumber} completed`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, status: 'completed', eventId: `${orderId}-orderCompleted`, isRtl },
        false, isRtl
      );
      const orderCompletedEvent = {
        orderId,
        status: 'completed',
        user: req.user,
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: isRtl ? order.branch.name : (order.branch.nameEn || order.branch.name || 'Unknown'),
        eventId: `${orderId}-orderCompleted`,
        isRtl,
      };
      await emitSocketEvent(io, ['admin', 'production', `branch-${order.branch}`], 'orderCompleted', orderCompletedEvent, isRtl);
    }

    order.markModified('items');
    await order.save({ session });

    await syncOrderTasks(orderId, io, session, isRtl);

    await session.commitTransaction();

    const populatedTask = await ProductionAssignment.findById(taskId)
      .populate('order', 'orderNumber branch')
      .populate('product', 'name nameEn')
      .populate('chef', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .lean();

    const formattedTask = {
      ...populatedTask,
      productName: isRtl ? populatedTask.product.name : (populatedTask.product.nameEn || populatedTask.product.name || 'Unknown'),
      chefName: isRtl ? populatedTask.chef.name : (populatedTask.chef.nameEn || populatedTask.chef.name || 'Unknown'),
      branchName: isRtl ? populatedTask.order.branch.name : (populatedTask.order.branch.nameEn || populatedTask.order.branch.name || 'Unknown'),
      isRtl,
    };

    const taskStatusUpdatedEvent = {
      taskId,
      status,
      orderId,
      orderNumber: task.order.orderNumber,
      branchId: order.branch,
      branchName: isRtl ? task.order.branch.name : (task.order.branch.nameEn || task.order.branch.name || 'Unknown'),
      itemId: task.itemId,
      productName: isRtl ? populatedTask.product.name : (populatedTask.product.nameEn || populatedTask.product.name || 'Unknown'),
      eventId: `${taskId}-taskStatusUpdated-${status}`,
      isRtl,
    };
    await emitSocketEvent(io, [`chef-${task.chef}`, 'admin', 'production', `branch-${order.branch}`], 'itemStatusUpdated', taskStatusUpdatedEvent, isRtl);

    if (status === 'completed') {
      const taskCompletedEvent = {
        taskId,
        orderId,
        orderNumber: task.order.orderNumber,
        branchId: order.branch,
        branchName: isRtl ? task.order.branch.name : (task.order.branch.nameEn || task.order.branch.name || 'Unknown'),
        completedAt: new Date().toISOString(),
        chef: { _id: task.chef._id },
        itemId: task.itemId,
        productName: isRtl ? populatedTask.product.name : (populatedTask.product.nameEn || populatedTask.product.name || 'Unknown'),
        eventId: `${taskId}-taskCompleted`,
        isRtl,
      };
      await emitSocketEvent(io, [`chef-${task.chef}`, 'admin', 'production', `branch-${order.branch}`], 'taskCompleted', taskCompletedEvent, isRtl);
      await notifyUsers(io, [{ _id: task.chef._id }], 'taskCompleted',
        isRtl ? `تم إكمال مهمة للطلب ${task.order.orderNumber}` : `Task completed for order ${task.order.orderNumber}`,
        { taskId, orderId, orderNumber: task.order.orderNumber, branchId: order.branch, eventId: `${taskId}-taskCompleted`, isRtl },
        false, isRtl
      );
    }

    res.status(200).json({ success: true, task: formattedTask });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error updating task status:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

const syncOrderTasks = async (orderId, io, session, isRtl) => {
  try {
    const order = await Order.findById(orderId).session(session).setOptions({ context: { isRtl } });
    if (!order) throw new Error(isRtl ? `الطلب ${orderId} غير موجود` : `Order ${orderId} not found`);

    const tasks = await ProductionAssignment.find({ order: orderId }).session(session).setOptions({ context: { isRtl } }).lean();
    for (const task of tasks) {
      const item = order.items.find(i => i._id.toString() === task.itemId.toString());
      if (item && item.status !== task.status) {
        item.status = task.status;
        if (task.status === 'completed') {
          item.completedAt = task.completedAt || new Date();
        }
        await emitSocketEvent(io, [
          'admin',
          'production',
          `department-${item.department?._id}`,
          `branch-${order.branch}`,
          `chef-${task.chef}`,
          'all-departments'
        ], 'itemStatusUpdated', {
          orderId,
          itemId: item._id,
          status: task.status,
          productName: isRtl ? item.product.name : (item.product.nameEn || item.product.name || 'Unknown'),
          orderNumber: order.orderNumber,
          branchId: order.branch,
          branchName: isRtl ? order.branch.name : (order.branch.nameEn || order.branch.name || 'Unknown'),
          sound: 'https://eljoodia-client.vercel.app/sounds/status-updated.mp3',
          vibrate: [200, 100, 200],
          eventId: `${task._id}-itemStatusUpdated-${task.status}`,
          isRtl,
        }, isRtl);
      }
    }
    if (order.items.every(i => i.status === 'completed') && order.status === 'in_production') {
      order.status = 'completed';
      order.statusHistory.push({
        status: 'completed',
        changedBy: null,
        changedAt: new Date(),
        notes: isRtl ? 'جميع العناصر مكتملة عبر المزامنة' : 'All items completed via sync',
        notesEn: 'All items completed via sync',
      });
      await order.save({ session });
      await emitSocketEvent(io, [
        'admin',
        'production',
        `branch-${order.branch}`,
        'all-departments'
      ], 'orderCompleted', {
        orderId,
        status: 'completed',
        orderNumber: order.orderNumber,
        branchId: order.branch,
        branchName: isRtl ? order.branch.name : (order.branch.nameEn || order.branch.name || 'Unknown'),
        eventId: `${orderId}-orderCompleted`,
        isRtl,
      }, isRtl);
      const usersToNotify = await User.find({ role: { $in: ['admin', 'production', 'branch', 'chef'] }, branch: order.branch }).select('_id').lean();
      await notifyUsers(io, usersToNotify, 'orderCompleted',
        isRtl ? `تم إكمال الطلب ${order.orderNumber}` : `Order ${order.orderNumber} completed`,
        { orderId, orderNumber: order.orderNumber, branchId: order.branch, status: 'completed', eventId: `${orderId}-orderCompleted`, isRtl },
        false, isRtl
      );
    }
    order.markModified('items');
    await order.save({ session });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error syncing order tasks:`, err);
    throw err;
  }
};

module.exports = { createTask, getTasks, getChefTasks, syncOrderTasks, updateTaskStatus };