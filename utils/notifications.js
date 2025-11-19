const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Order = require('../models/Order');
const FactoryOrder = require('../models/FactoryOrder');
const Return = require('../models/Return');
const Sale = require('../models/Sale');
const ProductionAssignment = require('../models/ProductionAssignment');

const createNotification = async (userId, type, message, data = {}, io, saveToDb = false, isRtl = false) => {
  try {
    console.log(`[${new Date().toISOString()}] Creating notification for user ${userId}:`, { type, message, data, saveToDb, isRtl });

    if (!mongoose.isValidObjectId(userId)) {
      throw new Error(isRtl ? 'معرف المستخدم غير صالح' : 'Invalid user ID');
    }

    const validTypes = [
      'orderCreated', 'orderCompleted', 'taskAssigned', 'orderApproved',
      'orderInTransit', 'orderDelivered', 'branchConfirmedReceipt',
      'taskStarted', 'taskCompleted', 'returnCreated', 'returnStatusUpdated',
      'saleCreated', 'factoryOrderCreated', 'factoryTaskAssigned', 'factoryOrderCompleted',
    ];
    if (!validTypes.includes(type)) {
      throw new Error(isRtl ? `نوع الإشعار غير صالح: ${type}` : `Invalid notification type: ${type}`);
    }

    if (!io || typeof io.to !== 'function') {
      throw new Error(isRtl ? 'خطأ في تهيئة Socket.IO' : 'Socket.IO not initialized');
    }

    const eventId = data.eventId || `${data.orderId || data.factoryOrderId || data.returnId || data.saleId || data.taskId || 'generic'}-${type}-${userId}`;
    if (saveToDb) {
      const existingNotification = await Notification.findOne({ 'data.eventId': eventId }).lean();
      if (existingNotification) {
        console.warn(`[${new Date().toISOString()}] Duplicate notification detected for eventId: ${eventId}`);
        return existingNotification;
      }
    }

    const targetUser = await User.findById(userId)
      .select('username role branch department')
      .populate('branch', 'name nameEn')
      .lean();

    if (!targetUser) {
      throw new Error(isRtl ? 'المستخدم غير موجود' : 'User not found');
    }

    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
    let notification;
    if (saveToDb) {
      notification = new Notification({
        _id: uuidv4(),
        user: userId,
        type,
        message: message.trim(),
        data: { ...data, eventId },
        read: false,
        createdAt: new Date(),
      });
      await notification.save();
    }

    const populatedNotification = saveToDb
      ? await Notification.findById(notification._id).populate('user', 'username role branch').lean()
      : { _id: uuidv4(), user: targetUser, type, message, data: { ...data, eventId }, read: false, createdAt: new Date() };

    const eventData = {
      _id: populatedNotification._id,
      type: populatedNotification.type,
      message: populatedNotification.message,
      data: {
        ...populatedNotification.data,
        branchId: data.branchId || targetUser.branch?._id?.toString(),
        orderId: data.orderId,
        factoryOrderId: data.factoryOrderId,
        taskId: data.taskId,
        chefId: data.chefId,
        saleId: data.saleId,
        returnId: data.returnId,
      },
      read: populatedNotification.read,
      user: {
        _id: targetUser._id,
        username: targetUser.username,
        role: targetUser.role,
        branch: targetUser.branch || null,
      },
      createdAt: populatedNotification.createdAt,
      sound: `${baseUrl}/sounds/notification.mp3`,
      soundType: 'notification',
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };

    const roles = {
      orderCreated: ['admin', 'branch', 'production'],
      orderCompleted: ['admin', 'branch', 'production', 'chef'],
      taskAssigned: ['admin', 'production', 'chef'],
      orderApproved: ['admin', 'production', 'branch'],
      orderInTransit: ['admin', 'production', 'branch'],
      orderDelivered: ['admin', 'production', 'branch'],
      branchConfirmedReceipt: ['admin', 'production', 'branch'],
      taskStarted: ['admin', 'production', 'chef'],
      taskCompleted: ['admin', 'production', 'chef'],
      returnCreated: ['admin', 'branch', 'production'],
      returnStatusUpdated: ['admin', 'branch', 'production'],
      saleCreated: ['admin', 'branch'],
      factoryOrderCreated: ['admin', 'production'],
      factoryTaskAssigned: ['admin', 'production', 'chef'],
      factoryOrderCompleted: ['admin', 'production', 'chef'],
    }[type] || [];

    const rooms = new Set([`user-${userId}`]);
    if (roles.includes('admin')) rooms.add('admin');
    if (roles.includes('production')) rooms.add('production');
    if (roles.includes('branch') && (data.branchId || targetUser.branch?._id)) rooms.add(`branch-${data.branchId || targetUser.branch._id}`);
    if (roles.includes('chef') && data.chefId) rooms.add(`chef-${data.chefId}`);

    rooms.forEach(room => {
      io.to(room).emit('newNotification', eventData);
      console.log(`[${new Date().toISOString()}] Notification sent to room: ${room}`, eventData);
    });

    return notification || populatedNotification;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error creating notification:`, {
      message: err.message,
      stack: err.stack,
      userId,
      type,
      data,
    });
    throw err;
  }
};

const setupNotifications = (io, socket) => {
  const handleOrderCreated = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session).lean();
      if (!order) return;

      const message = data.isRtl ? `طلب جديد ${orderNumber} من ${order.branch?.name || 'غير معروف'}` : 
                                  `New order ${orderNumber} from ${order.branch?.nameEn || order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-orderCreated-${Date.now()}`,
        type: 'orderCreated',
        message,
        data: { orderId, branchId, eventId: `${orderId}-orderCreated`, isRtl: data.isRtl },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderCreated', message, eventData.data, io, true, data.isRtl);
      }

      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order created:`, { error: err.message, stack: err.stack });
    } finally {
      session.endSession();
    }
  };

  const handleFactoryOrderCreated = async (data) => {
    const { factoryOrderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const factoryOrder = await FactoryOrder.findById(factoryOrderId).populate('branch', 'name nameEn').session(session).lean();
      if (!factoryOrder) return;

      const message = data.isRtl ? `طلب مصنع جديد ${orderNumber} من ${factoryOrder.branch?.name || 'غير معروف'}` : 
                                  `New factory order ${orderNumber} from ${factoryOrder.branch?.nameEn || factoryOrder.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${factoryOrderId}-factoryOrderCreated-${Date.now()}`,
        type: 'factoryOrderCreated',
        message,
        data: { factoryOrderId, branchId, eventId: `${factoryOrderId}-factoryOrderCreated`, isRtl: data.isRtl },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers]) {
        await createNotification(user._id, 'factoryOrderCreated', message, eventData.data, io, true, data.isRtl);
      }

      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling factory order created:`, { error: err.message, stack: err.stack });
    } finally {
      session.endSession();
    }
  };

  const handleTaskAssigned = async (data) => {
    const { orderId, taskId, chefId, productId, productName, quantity, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session).lean();
      if (!order) return;

      const message = data.isRtl ? `تم تعيينك لإنتاج ${productName || 'غير معروف'} في الطلب ${order.orderNumber || 'غير معروف'}` : 
                                  `Assigned to produce ${productName || 'Unknown'} for order ${order.orderNumber || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-taskAssigned-${Date.now()}`,
        type: 'taskAssigned',
        message,
        data: { orderId, taskId, branchId: order.branch?._id || branchId, chefId, productId, productName, quantity, eventId: `${taskId}-taskAssigned`, isRtl: data.isRtl },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await createNotification(chefId, 'taskAssigned', message, eventData.data, io, false, data.isRtl);

      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task assigned:`, { error: err.message, stack: err.stack });
    } finally {
      session.endSession();
    }
  };

  const handleFactoryTaskAssigned = async (data) => {
    const { factoryOrderId, taskId, chefId, productId, productName, quantity, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const factoryOrder = await FactoryOrder.findById(factoryOrderId).populate('branch', 'name nameEn').session(session).lean();
      if (!factoryOrder) return;

      const message = data.isRtl ? `تم تعيينك لإنتاج ${productName || 'غير معروف'} في طلب المصنع ${factoryOrder.orderNumber || 'غير معروف'}` : 
                                  `Assigned to produce ${productName || 'Unknown'} for factory order ${factoryOrder.orderNumber || 'Unknown'}`;
      const eventData = {
        _id: `${factoryOrderId}-factoryTaskAssigned-${Date.now()}`,
        type: 'factoryTaskAssigned',
        message,
        data: { factoryOrderId, taskId, branchId: factoryOrder.branch?._id || branchId, chefId, productId, productName, quantity, eventId: `${taskId}-factoryTaskAssigned`, isRtl: data.isRtl },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await createNotification(chefId, 'factoryTaskAssigned', message, eventData.data, io, false, data.isRtl);

      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling factory task assigned:`, { error: err.message, stack: err.stack });
    } finally {
      session.endSession();
    }
  };

  const handleOrderApproved = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session).lean();
      if (!order) return;

      const message = data.isRtl ? `تم اعتماد الطلب ${orderNumber} من ${order.branch?.name || 'غير معروف'}` : 
                                  `Order ${orderNumber} approved from ${order.branch?.nameEn || order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-orderApproved-${Date.now()}`,
        type: 'orderApproved',
        message,
        data: { orderId, branchId, eventId: `${orderId}-orderApproved`, isRtl: data.isRtl },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderApproved', message, eventData.data, io, false, data.isRtl);
      }

      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order approved:`, { error: err.message, stack: err.stack });
    } finally {
      session.endSession();
    }
  };

  const handleOrderInTransit = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session).lean();
      if (!order) return;

      const message = data.isRtl ? `الطلب ${orderNumber} في طريقه إلى ${order.branch?.name || 'غير معروف'}` : 
                                  `Order ${orderNumber} is in transit to ${order.branch?.nameEn || order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-orderInTransit-${Date.now()}`,
        type: 'orderInTransit',
        message,
        data: { orderId, branchId, eventId: `${orderId}-orderInTransit`, isRtl: data.isRtl },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderInTransit', message, eventData.data, io, false, data.isRtl);
      }

      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order in transit:`, { error: err.message, stack: err.stack });
    } finally {
      session.endSession();
    }
  };

  const handleOrderDelivered = async (data) => {
    const { orderId, orderNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session).lean();
      if (!order) return;

      const message = data.isRtl ? `تم توصيل الطلب ${orderNumber} إلى ${order.branch?.name || 'غير معروف'}` : 
                                  `Order ${orderNumber} delivered to ${order.branch?.nameEn || order.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-orderDelivered-${Date.now()}`,
        type: 'orderDelivered',
        message,
        data: { orderId, branchId, eventId: `${orderId}-orderDelivered`, isRtl: data.isRtl },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'orderDelivered', message, eventData.data, io, false, data.isRtl);
      }

      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling order delivered:`, { error: err.message, stack: err.stack });
    } finally {
      session.endSession();
    }
  };

 

  const handleTaskStarted = async (data) => {
    const { orderId, taskId, chefId, productName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session).lean();
      if (!order) return;

      const message = data.isRtl ? `بدأ الشيف العمل على (${productName || 'غير معروف'}) في الطلب ${order.orderNumber || 'غير معروف'}` : 
                                  `Chef started working on (${productName || 'Unknown'}) for order ${order.orderNumber || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-taskStarted-${Date.now()}`,
        type: 'taskStarted',
        message,
        data: { orderId, taskId, branchId: order.branch?._id, chefId, eventId: `${taskId}-taskStarted`, isRtl: data.isRtl },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await createNotification(chefId, 'taskStarted', message, eventData.data, io, false, data.isRtl);

      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task started:`, { error: err.message, stack: err.stack });
    } finally {
      session.endSession();
    }
  };

  const handleTaskCompleted = async (data) => {
    const { orderId, taskId, chefId, productName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const order = await Order.findById(orderId).populate('branch', 'name nameEn').session(session);
      if (!order) return;

      const message = data.isRtl ? `تم إكمال مهمة (${productName || 'غير معروف'}) في الطلب ${order.orderNumber || 'غير معروف'}` : 
                                  `Task (${productName || 'Unknown'}) completed for order ${order.orderNumber || 'Unknown'}`;
      const eventData = {
        _id: `${orderId}-taskCompleted-${Date.now()}`,
        type: 'taskCompleted',
        message,
        data: { orderId, taskId, branchId: order.branch?._id, chefId, eventId: `${taskId}-taskCompleted`, isRtl: data.isRtl },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await createNotification(chefId, 'taskCompleted', message, eventData.data, io, false, data.isRtl);

      const allTasksCompleted = await ProductionAssignment.find({ order: orderId }).session(session).lean();
      const isOrderCompleted = allTasksCompleted.every(task => task.status === 'completed');

      if (isOrderCompleted) {
        order.status = 'completed';
        order.statusHistory.push({
          status: 'completed',
          changedBy: chefId,
          changedAt: new Date(),
        });
        await order.save({ session });

        const completionMessage = data.isRtl ? `تم اكتمال الطلب ${order.orderNumber} بالكامل` : `Order ${order.orderNumber} fully completed`;
        const completionEventData = {
          _id: `${orderId}-orderCompleted-${Date.now()}`,
          type: 'orderCompleted',
          message: completionMessage,
          data: { orderId, branchId: order.branch?._id, eventId: `${orderId}-orderCompleted`, isRtl: data.isRtl },
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          vibrate: [200, 100, 200],
          timestamp: new Date().toISOString(),
        };

        const completionRooms = new Set(['admin', 'production', `branch-${order.branch?._id}`, `chef-${chefId}`]);
        completionRooms.forEach(room => io.to(room).emit('newNotification', completionEventData));

        const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
        const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
        const branchUsers = await User.find({ role: 'branch', branch: order.branch?._id }).select('_id').lean();
        const chefUsers = await User.find({ _id: chefId }).select('_id').lean();

        for (const user of [...adminUsers, ...productionUsers, ...branchUsers, ...chefUsers]) {
          await createNotification(user._id, 'orderCompleted', completionMessage, completionEventData.data, io, true, data.isRtl);
        }
      }

      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling task completed:`, { error: err.message, stack: err.stack });
    } finally {
      session.endSession();
    }
  };

  const handleFactoryTaskCompleted = async (data) => {
    const { factoryOrderId, taskId, chefId, productName } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const factoryOrder = await FactoryOrder.findById(factoryOrderId).populate('branch', 'name nameEn').session(session);
      if (!factoryOrder) return;

      const message = data.isRtl ? `تم إكمال مهمة (${productName || 'غير معروف'}) في طلب المصنع ${factoryOrder.orderNumber || 'غير معروف'}` : 
                                  `Task (${productName || 'Unknown'}) completed for factory order ${factoryOrder.orderNumber || 'Unknown'}`;
      const eventData = {
        _id: `${factoryOrderId}-factoryTaskCompleted-${Date.now()}`,
        type: 'factoryTaskCompleted',
        message,
        data: { factoryOrderId, taskId, branchId: factoryOrder.branch?._id, chefId, eventId: `${taskId}-factoryTaskCompleted`, isRtl: data.isRtl },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `chef-${chefId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      await createNotification(chefId, 'factoryTaskCompleted', message, eventData.data, io, false, data.isRtl);

      const allTasksCompleted = await ProductionAssignment.find({ factoryOrder: factoryOrderId }).session(session).lean();
      const isOrderCompleted = allTasksCompleted.every(task => task.status === 'completed');

      if (isOrderCompleted) {
        factoryOrder.status = 'completed';
        factoryOrder.statusHistory.push({
          status: 'completed',
          changedBy: chefId,
          changedAt: new Date(),
        });
        await factoryOrder.save({ session });

        const completionMessage = data.isRtl ? `تم اكتمال طلب المصنع ${factoryOrder.orderNumber} بالكامل` : `Factory order ${factoryOrder.orderNumber} fully completed`;
        const completionEventData = {
          _id: `${factoryOrderId}-factoryOrderCompleted-${Date.now()}`,
          type: 'factoryOrderCompleted',
          message: completionMessage,
          data: { factoryOrderId, branchId: factoryOrder.branch?._id, eventId: `${factoryOrderId}-factoryOrderCompleted`, isRtl: data.isRtl },
          read: false,
          createdAt: new Date().toISOString(),
          sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
          vibrate: [200, 100, 200],
          timestamp: new Date().toISOString(),
        };

        const completionRooms = new Set(['admin', 'production', `branch-${factoryOrder.branch?._id}`, `chef-${chefId}`]);
        completionRooms.forEach(room => io.to(room).emit('newNotification', completionEventData));

        const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
        const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
        const chefUsers = await User.find({ _id: chefId }).select('_id').lean();

        for (const user of [...adminUsers, ...productionUsers, ...chefUsers]) {
          await createNotification(user._id, 'factoryOrderCompleted', completionMessage, completionEventData.data, io, true, data.isRtl);
        }
      }

      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling factory task completed:`, { error: err.message, stack: err.stack });
    } finally {
      session.endSession();
    }
  };

  const handleReturnCreated = async (data) => {
    const { returnId, returnNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const returnDoc = await Return.findById(returnId).populate('branch', 'name nameEn').session(session).lean();
      if (!returnDoc) return;

      const message = data.isRtl ? `طلب إرجاع جديد ${returnNumber} من ${returnDoc.branch?.name || 'غير معروف'}` : 
                                  `New return ${returnNumber} from ${returnDoc.branch?.nameEn || returnDoc.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${returnId}-returnCreated-${Date.now()}`,
        type: 'returnCreated',
        message,
        data: { returnId, branchId, eventId: data.eventId || `${returnId}-returnCreated`, isRtl: data.isRtl },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'returnCreated', message, eventData.data, io, true, data.isRtl);
      }

      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling return created:`, { error: err.message, stack: err.stack });
    } finally {
      session.endSession();
    }
  };

  const handleReturnStatusUpdated = async (data) => {
    const { returnId, status, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const returnDoc = await Return.findById(returnId).populate('branch', 'name nameEn').session(session).lean();
      if (!returnDoc) return;

      const message = data.isRtl ? `طلب إرجاع ${returnDoc.returnNumber || `RET-${returnId.slice(-6)}`} ${status === 'approved' ? 'موافق عليه' : 'مرفوض'}` : 
                                  `Return ${returnDoc.returnNumber || `RET-${returnId.slice(-6)}`} ${status === 'approved' ? 'approved' : 'rejected'}`;
      const eventData = {
        _id: `${returnId}-returnStatusUpdated-${Date.now()}`,
        type: 'returnStatusUpdated',
        message,
        data: { returnId, branchId, status, eventId: data.eventId || `${returnId}-return${status === 'approved' ? 'Approved' : 'Rejected'}`, isRtl: data.isRtl },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', 'production', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const productionUsers = await User.find({ role: 'production' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...productionUsers, ...branchUsers]) {
        await createNotification(user._id, 'returnStatusUpdated', message, eventData.data, io, true, data.isRtl);
      }

      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling return status updated:`, { error: err.message, stack: err.stack });
    } finally {
      session.endSession();
    }
  };

  const handleSaleCreated = async (data) => {
    const { saleId, saleNumber, branchId } = data;
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const sale = await Sale.findById(saleId).populate('branch', 'name nameEn').session(session).lean();
      if (!sale) return;

      const message = data.isRtl ? `بيع جديد ${saleNumber} من ${sale.branch?.name || 'غير معروف'}` : 
                                  `New sale ${saleNumber} from ${sale.branch?.nameEn || sale.branch?.name || 'Unknown'}`;
      const eventData = {
        _id: `${saleId}-saleCreated-${Date.now()}`,
        type: 'saleCreated',
        message,
        data: { saleId, branchId, eventId: data.eventId || `${saleId}-saleCreated`, isRtl: data.isRtl },
        read: false,
        createdAt: new Date().toISOString(),
        sound: 'https://eljoodia-client.vercel.app/sounds/notification.mp3',
        vibrate: [200, 100, 200],
        timestamp: new Date().toISOString(),
      };

      const rooms = new Set(['admin', `branch-${branchId}`]);
      rooms.forEach(room => io.to(room).emit('newNotification', eventData));

      const adminUsers = await User.find({ role: 'admin' }).select('_id').lean();
      const branchUsers = await User.find({ role: 'branch', branch: branchId }).select('_id').lean();

      for (const user of [...adminUsers, ...branchUsers]) {
        await createNotification(user._id, 'saleCreated', message, eventData.data, io, true, data.isRtl);
      }

      await session.commitTransaction();
    } catch (err) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error(`[${new Date().toISOString()}] Error handling sale created:`, { error: err.message, stack: err.stack });
    } finally {
      session.endSession();
    }
  };

  socket.on('orderCreated', handleOrderCreated);
  socket.on('factoryOrderCreated', handleFactoryOrderCreated);
  socket.on('taskAssigned', handleTaskAssigned);
  socket.on('factoryTaskAssigned', handleFactoryTaskAssigned);
  socket.on('orderApproved', handleOrderApproved);
  socket.on('orderInTransit', handleOrderInTransit);
  socket.on('orderDelivered', handleOrderDelivered);
  socket.on('taskStarted', handleTaskStarted);
  socket.on('taskCompleted', handleTaskCompleted);
  socket.on('factoryTaskCompleted', handleFactoryTaskCompleted);
  socket.on('returnCreated', handleReturnCreated);
  socket.on('returnStatusUpdated', handleReturnStatusUpdated);
  socket.on('saleCreated', handleSaleCreated);
};

module.exports = { createNotification, setupNotifications };