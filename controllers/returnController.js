const { validationResult } = require('express-validator'); // ← السطر ده اللي ناقص!!const mongoose = require('mongoose');
const Return = require('../models/Return');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');
const User = require('../models/User');
const { createNotification } = require('../utils/notifications');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

const generateReturnNumber = async (branchId, session) => {
  const count = await Return.countDocuments({ branch: branchId }).session(session);
  return `RET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${(count + 1).toString().padStart(4, '0')}`;
};

const createReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession();
  let retryCount = 0;
  const maxRetries = 5;

  while (retryCount <= maxRetries) {
    try {
      session.startTransaction();

      const { branchId, items, notes = '' } = req.body;

      if (!isValidObjectId(branchId)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
      }
      if (!Array.isArray(items) || !items.length) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'العناصر مطلوبة' : 'Items are required' });
      }

      const branch = await Branch.findById(branchId).session(session);
      if (!branch) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'الفرع غير موجود' : 'Branch not found' });
      }

      if (req.user.role === 'branch' && req.user.branchId?.toString() !== branchId) {
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Not authorized for this branch' });
      }

      const productIds = items.map(item => item.product);
      const products = await Product.find({ _id: { $in: productIds } }).session(session);
      if (products.length !== productIds.length) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'بعض المنتجات غير موجودة' : 'Some products not found' });
      }

      const returnItems = items.map(item => ({
        product: item.product,
        quantity: item.quantity,
        reason: item.reason,
        reasonEn: item.reasonEn,
        price: item.price || products.find(p => p._id.toString() === item.product)?.price || 0,
      }));

      const inventories = await Inventory.find({ branch: branchId, product: { $in: productIds } })
        .select('product currentStock pendingReturnStock __v')
        .session(session);
      for (const item of returnItems) {
        const inventory = inventories.find(inv => inv.product.toString() === item.product);
        if (!inventory || inventory.currentStock < item.quantity) {
          await session.abortTransaction();
          return res.status(422).json({
            success: false,
            message: isRtl ? `الكمية غير كافية للمنتج ${item.product}` : `Insufficient quantity for product ${item.product}`,
          });
        }
      }

      const returnNumber = await generateReturnNumber(branchId, session);
      const newReturn = new Return({
        returnNumber,
        branch: branchId,
        items: returnItems,
        status: 'pending_approval',
        createdBy: req.user.id,
        notes,
        statusHistory: [{
          status: 'pending_approval',
          changedBy: req.user.id,
          notes: isRtl ? 'تم إنشاء المرتجع' : 'Return created',
          changedAt: new Date(),
        }],
      });
      await newReturn.save({ session });

      for (const item of returnItems) {
        const inventory = inventories.find(inv => inv.product.toString() === item.product);
        const updatedInventory = await Inventory.findOneAndUpdate(
          { branch: branchId, product: item.product, __v: inventory.__v },
          {
            $inc: {
              currentStock: -item.quantity,
              pendingReturnStock: item.quantity,
              __v: 1,
            },
            $push: {
              movements: {
                type: 'out',
                quantity: item.quantity,
                reference: `مرتجع #${returnNumber}`,
                createdBy: req.user.id,
                createdAt: new Date(),
              },
            },
          },
          { new: true, session }
        );

        if (!updatedInventory) {
          throw new Error(`Failed to update inventory for product ${item.product}`);
        }
      }

      const historyEntries = returnItems.map(item => ({
        product: item.product,
        branch: branchId,
        action: 'return_pending',
        quantity: -item.quantity,
        reference: `مرتجع #${returnNumber}`,
        referenceType: 'return',
        referenceId: newReturn._id,
        createdBy: req.user.id,
        notes: `${item.reason} (${item.reasonEn})`,
        createdAt: new Date(),
      }));
      await InventoryHistory.insertMany(historyEntries, { session });

      await session.commitTransaction();

      const populatedReturn = await Return.findById(newReturn._id)
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department code price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('branch', 'name nameEn')
        .populate('createdBy', 'name nameEn username')
        .lean();

      const formattedReturn = {
        ...populatedReturn,
        branch: populatedReturn.branch
          ? {
              ...populatedReturn.branch,
              displayName: isRtl ? (populatedReturn.branch.name || 'غير معروف') : (populatedReturn.branch.nameEn || populatedReturn.branch.name || 'Unknown'),
            }
          : null,
        items: populatedReturn.items.map(item => ({
          ...item,
          product: item.product
            ? {
                ...item.product,
                displayName: isRtl ? (item.product.name || 'غير معروف') : (item.product.nameEn || item.product.name || 'Unknown'),
                displayUnit: isRtl ? (item.product.unit || 'غير محدد') : (item.product.unitEn || item.product.unit || 'N/A'),
                department: item.product.department
                  ? {
                      ...item.product.department,
                      displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
                    }
                  : null,
              }
            : null,
          reason: item.reason,
          reasonEn: item.reasonEn,
        })),
        createdByName: isRtl ? (populatedReturn.createdBy?.name || 'غير معروف') : (populatedReturn.createdBy?.nameEn || populatedReturn.createdBy?.name || 'Unknown'),
      };

      const io = req.app.get('io');
      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: branchId },
        ],
      }).select('_id').lean();

      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'returnCreated',
          isRtl ? `طلب إرجاع جديد ${returnNumber} من ${formattedReturn.branch.displayName}` : `New return request ${returnNumber} from ${formattedReturn.branch.displayName}`,
          { returnId: newReturn._id, branchId, eventId: `${newReturn._id}-returnCreated` },
          io,
          true
        );
      }

      console.log(`[${new Date().toISOString()}] إنشاء مرتجع - تم بنجاح:`, {
        returnId: newReturn._id,
        returnNumber,
        branchId,
        userId: req.user.id,
        itemCount: items.length,
      });

      res.status(201).json({ success: true, _id: newReturn._id, ...formattedReturn });
      return;
    } catch (err) {
      await session.abortTransaction();
      if (err.message.includes('conflict at \'currentStock\'') || err.message.includes('conflict at \'pendingReturnStock\'')) {
        retryCount++;
        console.warn(`[${new Date().toISOString()}] Conflict detected, retrying (${retryCount}/${maxRetries}):`, err.message);
        if (retryCount > maxRetries) {
          console.error(`[${new Date().toISOString()}] Max retries reached for createReturn:`, err);
          res.status(409).json({
            success: false,
            message: isRtl ? 'تعارض في الكتابة، حاول مرة أخرى' : 'Write conflict, please try again',
            error: err.message,
          });
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
        continue;
      }
      console.error(`[${new Date().toISOString()}] خطأ في إنشاء المرتجع:`, {
        error: err.message,
        stack: err.stack,
        requestBody: req.body,
      });
      let status = 500;
      let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
      if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
      else if (err.message.includes('غير كافية') || err.message.includes('Insufficient')) status = 422;
      else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
      else if (err.name === 'ValidationError') {
        status = 400;
        message = isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error';
      }
      res.status(status).json({ success: false, message, error: err.message });
      return;
    } finally {
      session.endSession();
    }
  }
};

const approveReturn = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const session = await mongoose.startSession();
  let retryCount = 0;
  const maxRetries = 5;

  while (retryCount <= maxRetries) {
    try {
      session.startTransaction();
      const { id } = req.params;
      const { status, reviewNotes = '' } = req.body;

      if (!isValidObjectId(id)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'معرف الإرجاع غير صالح' : 'Invalid return ID' });
      }
      if (!['approved', 'rejected'].includes(status)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'حالة غير صالحة' : 'Invalid status' });
      }
      if (req.user.role !== 'admin' && req.user.role !== 'production') {
        await session.abortTransaction();
        return res.status(403).json({ success: false, message: isRtl ? 'غير مخول للموافقة على الإرجاع' : 'Not authorized to approve return' });
      }

      const returnRequest = await Return.findById(id).session(session);
      if (!returnRequest) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: isRtl ? 'الإرجاع غير موجود' : 'Return not found' });
      }
      if (returnRequest.status !== 'pending_approval') {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: isRtl ? 'الإرجاع ليس في حالة الانتظار' : 'Return is not pending approval' });
      }

      const inventories = await Inventory.find({
        branch: returnRequest.branch,
        product: { $in: returnRequest.items.map(item => item.product) },
      }).select('product pendingReturnStock currentStock damagedStock __v').session(session);

      for (const item of returnRequest.items) {
        const inventory = inventories.find(inv => inv.product.toString() === item.product.toString());
        if (!inventory || inventory.pendingReturnStock < item.quantity) {
          await session.abortTransaction();
          return res.status(422).json({
            success: false,
            message: isRtl ? `الكمية المحجوزة غير كافية للمنتج ${item.product}` : `Insufficient reserved quantity for product ${item.product}`,
          });
        }
      }

      let adjustedTotal = 0;
      for (const item of returnRequest.items) {
        const inventory = inventories.find(inv => inv.product.toString() === item.product.toString());
        const update = {
          $inc: {
            pendingReturnStock: -item.quantity,
            __v: 1,
          },
          $push: {
            movements: {
              type: status === 'rejected' ? 'damaged' : 'out',
              quantity: item.quantity,
              reference: `مرتجع ${status === 'approved' ? 'موافق عليه' : 'مرفوض'} #${returnRequest.returnNumber}`,
              createdBy: req.user.id,
              createdAt: new Date(),
            },
          },
        };
        if (status === 'rejected') {
          update.$inc.damagedStock = item.quantity;
        }
        if (status === 'approved') {
          adjustedTotal += item.quantity * item.price;
        }

        const updatedInventory = await Inventory.findOneAndUpdate(
          { branch: returnRequest.branch, product: item.product, __v: inventory.__v },
          update,
          { new: true, session }
        );

        if (!updatedInventory) {
          throw new Error(`Failed to update inventory for product ${item.product}`);
        }
      }

      const historyEntries = returnRequest.items.map(item => ({
        product: item.product,
        branch: returnRequest.branch,
        action: status === 'approved' ? 'return_approved' : 'return_rejected',
        quantity: status === 'rejected' ? item.quantity : -item.quantity,
        reference: `مرتجع ${status === 'approved' ? 'موافق عليه' : 'مرفوض'} #${returnRequest.returnNumber}`,
        referenceType: 'return',
        referenceId: returnRequest._id,
        createdBy: req.user.id,
        notes: `${item.reason} (${item.reasonEn})`,
        isDamaged: status === 'rejected',
        createdAt: new Date(),
      }));
      await InventoryHistory.insertMany(historyEntries, { session });

      returnRequest.status = status;
      returnRequest.reviewNotes = reviewNotes.trim();
      returnRequest.reviewedBy = req.user.id;
      returnRequest.reviewedAt = new Date();
      returnRequest.statusHistory.push({
        status,
        changedBy: req.user.id,
        notes: reviewNotes.trim(),
        changedAt: new Date(),
      });

      await returnRequest.save({ session });

      await session.commitTransaction();

      const populatedReturn = await Return.findById(returnRequest._id)
        .populate({
          path: 'items.product',
          select: 'name nameEn unit unitEn department code price',
          populate: { path: 'department', select: 'name nameEn' },
        })
        .populate('branch', 'name nameEn')
        .populate('createdBy reviewedBy', 'name nameEn username')
        .lean();

      const formattedReturn = {
        ...populatedReturn,
        branch: populatedReturn.branch
          ? {
              ...populatedReturn.branch,
              displayName: isRtl ? (populatedReturn.branch.name || 'غير معروف') : (populatedReturn.branch.nameEn || populatedReturn.branch.name || 'Unknown'),
            }
          : null,
        items: populatedReturn.items.map(item => ({
          ...item,
          product: item.product
            ? {
                ...item.product,
                displayName: isRtl ? (item.product.name || 'غير معروف') : (item.product.nameEn || item.product.name || 'Unknown'),
                displayUnit: isRtl ? (item.product.unit || 'غير محدد') : (item.product.unitEn || item.product.unit || 'N/A'),
                department: item.product.department
                  ? {
                      ...item.product.department,
                      displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
                    }
                  : null,
              }
            : null,
          reason: item.reason,
          reasonEn: item.reasonEn,
        })),
        createdByName: isRtl ? (populatedReturn.createdBy?.name || 'غير معروف') : (populatedReturn.createdBy?.nameEn || populatedReturn.createdBy?.name || 'Unknown'),
        reviewedByName: populatedReturn.reviewedBy
          ? isRtl
            ? (populatedReturn.reviewedBy.name || 'غير معروف')
            : (populatedReturn.reviewedBy.nameEn || populatedReturn.reviewedBy.name || 'Unknown')
          : null,
      };

      const io = req.app.get('io');
      const usersToNotify = await User.find({
        $or: [
          { role: { $in: ['admin', 'production'] } },
          { role: 'branch', branch: returnRequest.branch },
        ],
      }).select('_id').lean();

      for (const user of usersToNotify) {
        await createNotification(
          user._id,
          'returnStatusUpdated',
          isRtl ? `طلب إرجاع ${returnRequest.returnNumber} ${status === 'approved' ? 'موافق عليه' : 'مرفوض'}` : `Return request ${returnRequest.returnNumber} ${status === 'approved' ? 'approved' : 'rejected'}`,
          { returnId: returnRequest._id, branchId: returnRequest.branch, eventId: `${returnRequest._id}-return${status === 'approved' ? 'Approved' : 'Rejected'}` },
          io,
          true
        );
      }

      console.log(`[${new Date().toISOString()}] تحديث حالة المرتجع - تم بنجاح:`, {
        returnId: returnRequest._id,
        status,
        branchId: returnRequest.branch,
        userId: req.user.id,
        damagedStockUpdated: status === 'rejected' ? returnRequest.items.reduce((sum, item) => sum + item.quantity, 0) : 0,
      });

      res.status(200).json({ success: true, _id: returnRequest._id, ...formattedReturn });
      return;
    } catch (err) {
      await session.abortTransaction();
      if (err.message.includes('conflict at \'currentStock\'') || err.message.includes('conflict at \'pendingReturnStock\'') || err.message.includes('conflict at \'damagedStock\'')) {
        retryCount++;
        console.warn(`[${new Date().toISOString()}] Conflict detected in approveReturn, retrying (${retryCount}/${maxRetries}):`, err.message);
        if (retryCount > maxRetries) {
          console.error(`[${new Date().toISOString()}] Max retries reached for approveReturn:`, err);
          res.status(409).json({
            success: false,
            message: isRtl ? 'تعارض في الكتابة، حاول مرة أخرى' : 'Write conflict, please try again',
            error: err.message,
          });
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
        continue;
      }
      console.error(`[${new Date().toISOString()}] خطأ في تحديث المرتجع:`, {
        error: err.message,
        stack: err.stack,
        requestBody: req.body,
        returnId: req.params.id,
      });
      let status = 500;
      let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
      if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
      else if (err.message.includes('غير كافية') || err.message.includes('Insufficient')) status = 422;
      else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
      else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
      else if (err.name === 'ValidationError') {
        status = 400;
        message = isRtl ? 'خطأ في التحقق من البيانات' : 'Validation error';
      }
      res.status(status).json({ success: false, message, error: err.message });
      return;
    } finally {
      session.endSession();
    }
  }
};

const getAll = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const { status, branch, search, sort = '-createdAt', page = 1, limit = 10, startDate, endDate, 'items.reasonEn': reasonEn, 'items.product': productId } = req.query;

  try {
    const query = {};
    if (status) query.status = status;
    if (branch && isValidObjectId(branch)) {
      query.branch = branch;
    } else if (branch) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }
    if (req.user.role === 'branch' && req.user.branchId) {
      query.branch = req.user.branchId;
    }
    if (reasonEn) {
      query['items.reasonEn'] = reasonEn;
    }
    if (productId && isValidObjectId(productId)) {
      query['items.product'] = productId;
    } else if (productId) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف المنتج غير صالح' : 'Invalid product ID' });
    }
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    if (search) {
      const products = await Product.find({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { nameEn: { $regex: search, $options: 'i' } },
          { code: { $regex: search, $options: 'i' } },
        ],
      }).select('_id');
      const productIds = products.map(p => p._id);
      query['items.product'] = { $in: productIds };
    }

    const total = await Return.countDocuments(query);
    const returns = await Return.find(query)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code price',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy reviewedBy', 'name nameEn username')
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();

    const formattedReturns = returns.map(ret => ({
      ...ret,
      branch: ret.branch
        ? {
            ...ret.branch,
            displayName: isRtl ? (ret.branch.name || 'غير معروف') : (ret.branch.nameEn || ret.branch.name || 'Unknown'),
          }
        : null,
      items: ret.items.map(item => ({
        ...item,
        product: item.product
          ? {
              ...item.product,
              displayName: isRtl ? (item.product.name || 'غير معروف') : (item.product.nameEn || item.product.name || 'Unknown'),
              displayUnit: isRtl ? (item.product.unit || 'غير محدد') : (item.product.unitEn || item.product.unit || 'N/A'),
              department: item.product.department
                ? {
                    ...item.product.department,
                    displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
                  }
                : null,
            }
          : null,
        reason: item.reason,
        reasonEn: item.reasonEn,
      })),
      createdByName: isRtl ? (ret.createdBy?.name || 'غير معروف') : (ret.createdBy?.nameEn || ret.createdBy?.name || 'Unknown'),
      reviewedByName: ret.reviewedBy
        ? isRtl
          ? (ret.reviewedBy.name || 'غير معروف')
          : (ret.reviewedBy.nameEn || ret.reviewedBy.name || 'Unknown')
        : null,
    }));

    res.status(200).json({
      success: true,
      returns: formattedReturns,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في استرجاع المرتجعات:`, {
      error: err.message,
      stack: err.stack,
      query: req.query,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    res.status(status).json({ success: false, message, error: err.message });
  }
};

const getById = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الإرجاع غير صالح' : 'Invalid return ID' });
    }

    const returnRequest = await Return.findById(id)
      .populate({
        path: 'items.product',
        select: 'name nameEn unit unitEn department code price',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .populate('branch', 'name nameEn')
      .populate('createdBy reviewedBy', 'name nameEn username')
      .lean();

    if (!returnRequest) {
      return res.status(404).json({ success: false, message: isRtl ? 'الإرجاع غير موجود' : 'Return not found' });
    }

    if (req.user.role === 'branch' && req.user.branchId?.toString() !== returnRequest.branch?.toString()) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الإرجاع' : 'Not authorized for this return' });
    }

    const formattedReturn = {
      ...returnRequest,
      branch: returnRequest.branch
        ? {
            ...returnRequest.branch,
            displayName: isRtl ? (returnRequest.branch.name || 'غير معروف') : (returnRequest.branch.nameEn || returnRequest.branch.name || 'Unknown'),
          }
        : null,
      items: returnRequest.items.map(item => ({
        ...item,
        product: item.product
          ? {
              ...item.product,
              displayName: isRtl ? (item.product.name || 'غير معروف') : (item.product.nameEn || item.product.name || 'Unknown'),
              displayUnit: isRtl ? (item.product.unit || 'غير محدد') : (item.product.unitEn || item.product.unit || 'N/A'),
              department: item.product.department
                ? {
                    ...item.product.department,
                    displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name),
                  }
                : null,
            }
          : null,
        reason: item.reason,
        reasonEn: item.reasonEn,
      })),
      createdByName: isRtl ? (returnRequest.createdBy?.name || 'غير معروف') : (returnRequest.createdBy?.nameEn || returnRequest.createdBy?.name || 'Unknown'),
      reviewedByName: returnRequest.reviewedBy
        ? isRtl
          ? (returnRequest.reviewedBy.name || 'غير معروف')
          : (returnRequest.reviewedBy.nameEn || ret.reviewedBy.name || 'Unknown')
        : null,
    };

    res.status(200).json({ success: true, _id: returnRequest._id, ...formattedReturn });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في استرجاع المرتجع:`, {
      error: err.message,
      stack: err.stack,
      returnId: id,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير موجود') || err.message.includes('not found')) status = 404;
    else if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    res.status(status).json({ success: false, message, error: err.message });
  }
};

const updateReturnStatus = async (req, res) => {
  return approveReturn(req, res);
};

const getBranches = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';

  try {
    const query = {};
    if (req.user.role === 'branch' && req.user.branchId) {
      query._id = req.user.branchId;
    }

    const branches = await Branch.find(query).select('name nameEn').lean();
    const formattedBranches = branches.map(branch => ({
      ...branch,
      displayName: isRtl ? (branch.name || 'غير معروف') : (branch.nameEn || branch.name || 'Unknown'),
    }));

    res.status(200).json({ success: true, branches: formattedBranches });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في استرجاع الفروع:`, {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getProducts = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';

  try {
    const products = await Product.find({}).select('name nameEn code price').lean();
    const formattedProducts = products.map(product => ({
      ...product,
      displayName: isRtl ? (product.name || 'غير معروف') : (product.nameEn || product.name || 'Unknown'),
    }));

    res.status(200).json({ success: true, products: formattedProducts });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في استرجاع المنتجات:`, {
      error: err.message,
      stack: err.stack,
    });
    res.status(500).json({ success: false, message: isRtl ? 'خطأ في السيرفر' : 'Server error', error: err.message });
  }
};

const getAvailableStock = async (req, res) => {
  const lang = req.query.lang || 'ar';
  const isRtl = lang === 'ar';
  const { branchId, productIds } = req.query;

  try {
    if (!isValidObjectId(branchId)) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرف الفرع غير صالح' : 'Invalid branch ID' });
    }
    const productIdArray = productIds ? productIds.split(',').filter(id => isValidObjectId(id)) : [];
    if (productIds && productIdArray.length === 0) {
      return res.status(400).json({ success: false, message: isRtl ? 'معرفات المنتجات غير صالحة' : 'Invalid product IDs' });
    }

    if (req.user.role === 'branch' && req.user.branchId?.toString() !== branchId) {
      return res.status(403).json({ success: false, message: isRtl ? 'غير مخول لهذا الفرع' : 'Not authorized for this branch' });
    }

    const query = { branch: branchId };
    if (productIdArray.length > 0) {
      query.product = { $in: productIdArray };
    }

    const inventories = await Inventory.find(query)
      .populate({
        path: 'product',
        select: 'name nameEn unit unitEn department code price',
        populate: { path: 'department', select: 'name nameEn' },
      })
      .lean();

    const formattedInventory = inventories.map(item => ({
      productId: item.product?._id,
      productName: item.product ? (isRtl ? (item.product.name || 'غير معروف') : (item.product.nameEn || item.product.name || 'Unknown')) : 'Unknown',
      available: item.currentStock || 0,
      unit: item.product ? (isRtl ? (item.product.unit || 'غير محدد') : (item.product.unitEn || item.product.unit || 'N/A')) : 'N/A',
      displayUnit: item.product ? (isRtl ? (item.product.unit || 'غير محدد') : (item.product.unitEn || item.product.unit || 'N/A')) : 'N/A',
      departmentName: item.product?.department
        ? isRtl
          ? (item.product.department.name || 'غير معروف')
          : (item.product.department.nameEn || item.product.department.name || 'Unknown')
        : 'Unknown',
      stock: item.currentStock || 0,
      price: item.product?.price || 0,
    }));

    res.status(200).json({ success: true, inventory: formattedInventory });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] خطأ في استرجاع المخزون المتاح:`, {
      error: err.message,
      stack: err.stack,
      query: req.query,
    });
    let status = 500;
    let message = isRtl ? 'خطأ في السيرفر' : 'Server error';
    if (err.message.includes('غير صالح') || err.message.includes('Invalid')) status = 400;
    else if (err.message.includes('غير مخول') || err.message.includes('authorized')) status = 403;
    res.status(status).json({ success: false, message, error: err.message });
  }
};

module.exports = {
  createReturn,
  approveReturn,
  getAll,
  getById,
  updateReturnStatus,
  getBranches,
  getProducts,
  getAvailableStock,
};