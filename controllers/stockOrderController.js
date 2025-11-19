const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Product = require('../models/Product');
const FactoryInventory = require('../models/FactoryInventory');
const FactoryInventoryHistory = require('../models/FactoryInventoryHistory');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

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

const notifyUsers = async (io, users, type, message, data, saveToDb = false, isRtl) => {
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

const createStockOrder = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const isRtl = req.query.isRtl === 'true';
    const { items, notes, notesEn, priority = 'medium' } = req.body;

    if (!items?.length || !Array.isArray(items)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'مصفوفة العناصر مطلوبة ويجب أن تكون صالحة' : 'Items array is required and must be valid' });
    }

    for (const item of items) {
      if (!isValidObjectId(item.product) || !Number.isInteger(item.quantity) || item.quantity < 1 || typeof item.price !== 'number' || item.price < 0) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'بيانات العنصر غير صالحة (معرف المنتج، الكمية، أو السعر)' : 'Invalid item data (product ID, quantity, or price)' });
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
    const products = await Product.find({ _id: { $in: productIds } }).select('price name nameEn unit unitEn department expiryDays').lean().session(session);
    if (products.length !== productIds.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
    }

    for (const item of mergedItems) {
      const product = products.find(p => p._id.toString() === item.product.toString());
      if (product.price !== item.price) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? `السعر غير متطابق للمنتج ${item.product}` : `Price mismatch for product ${item.product}` });
      }
    }

    const orderNumber = `STOCK-${Date.now()}`;
    const newOrder = new Order({
      orderNumber,
      orderType: 'stock',
      items: mergedItems,
      status: req.user.role === 'chef' ? 'pending' : 'approved',
      notes: notes?.trim() || '',
      notesEn: notesEn?.trim() || notes?.trim() || '',
      priority: priority?.trim() || 'medium',
      createdBy: req.user.id,
      totalAmount: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      adjustedTotal: mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0),
      statusHistory: [{
        status: req.user.role === 'chef' ? 'pending' : 'approved',
        changedBy: req.user.id,
        notes: notes?.trim() || (isRtl ? 'تم إنشاء طلب مخزون' : 'Stock order created'),
        notesEn: notesEn?.trim() || 'Stock order created',
        changedAt: new Date(),
      }],
    });

    await newOrder.save({ session, context: { isRtl } });

    const populatedOrder = await Order.findById(newOrder._id)
      .populate({ path: 'items.product', select: 'name nameEn price unit unitEn department' })
      .populate('createdBy', 'username name nameEn')
      .setOptions({ context: { isRtl } })
      .session(session)
      .lean();

    const io = req.app.get('io');
    const adminUsers = await User.find({ role: 'admin' }).select('_id').lean().session(session);
    const productionUsers = await User.find({ role: 'production' }).select('_id').lean().session(session);

    const eventId = `${newOrder._id}-stockOrderCreated`;
    const totalQuantity = mergedItems.reduce((sum, item) => sum + item.quantity, 0);
    const totalAmount = mergedItems.reduce((sum, item) => sum + item.quantity * item.price, 0);

    const notificationData = {
      orderId: newOrder._id,
      orderNumber: newOrder.orderNumber,
      totalQuantity,
      totalAmount,
      items: populatedOrder.items.map(item => ({
        productId: item.product?._id,
        productName: isRtl ? item.product?.name : (item.product?.nameEn || item.product?.name || 'Unknown'),
        quantity: item.quantity,
        price: item.price,
        unit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
      })),
      status: newOrder.status,
      priority: newOrder.priority,
      eventId,
      isRtl,
      type: 'persistent',
    };

    await notifyUsers(
      io,
      [...adminUsers, ...productionUsers],
      'stockOrderCreated',
      isRtl ? `تم إنشاء طلب مخزون رقم ${newOrder.orderNumber}` : `Stock order ${newOrder.orderNumber} created`,
      notificationData,
      true,
      isRtl
    );

    await emitSocketEvent(io, ['admin', 'production'], 'stockOrderCreated', notificationData, isRtl);

    await session.commitTransaction();
    res.status(201).json({
      success: true,
      data: populatedOrder,
      message: isRtl ? 'تم إنشاء طلب المخزون بنجاح' : 'Stock order created successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error(`[${new Date().toISOString()}] Error creating stock order:`, err);
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  } finally {
    session.endSession();
  }
};

module.exports = { createStockOrder };