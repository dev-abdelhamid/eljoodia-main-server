const express = require('express');
const { body } = require('express-validator');
const mongoose = require('mongoose');
const { auth, authorize } = require('../middleware/auth');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Department = require('../models/department');

const router = express.Router();

router.get('/', auth, authorize('admin'), async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;
    const users = await User.find()
      .populate('branch', 'name nameEn code')
      .populate('department', 'name nameEn code');
    const transformedUsers = users.map(user => ({
      ...user.toObject({ context: { isRtl } }),
      name: isRtl ? user.name : user.displayName,
      branch: user.branch ? {
        ...user.branch.toObject({ context: { isRtl } }),
        name: isRtl ? user.branch.name : user.branch.displayName
      } : null,
      department: user.department ? {
        ...user.department.toObject({ context: { isRtl } }),
        name: isRtl ? user.department.name : user.department.displayName
      } : null
    }));
    res.status(200).json(transformedUsers);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get users error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.get('/:id', auth, authorize('admin'), async (req, res) => {
  try {
    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
    }
    const user = await User.findById(req.params.id)
      .populate('branch', 'name nameEn code')
      .populate('department', 'name nameEn code');
    if (!user) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }
    const transformedUser = {
      ...user.toObject({ context: { isRtl } }),
      name: isRtl ? user.name : user.displayName,
      branch: user.branch ? {
        ...user.branch.toObject({ context: { isRtl } }),
        name: isRtl ? user.branch.name : user.branch.displayName
      } : null,
      department: user.department ? {
        ...user.department.toObject({ context: { isRtl } }),
        name: isRtl ? user.department.name : user.department.displayName
      } : null
    };
    res.status(200).json(transformedUser);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get user error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/check-email', auth, authorize('admin'), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'الإيميل مطلوب' });
    }
    const existingEmail = await User.findOne({ email: email.trim().toLowerCase() });
    res.status(200).json({ available: !existingEmail });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Check email error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/', [
  auth,
  authorize('admin'),
  body('name').notEmpty().withMessage('الاسم مطلوب'),
  body('username').notEmpty().withMessage('اسم المستخدم مطلوب'),
  body('password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
  body('role').isIn(['admin', 'branch', 'chef', 'production']).withMessage('الدور غير صالح'),
  body('branch').custom((value, { req }) => {
    if (req.body.role === 'branch' && (!value || !mongoose.isValidObjectId(value))) {
      throw new Error('معرف الفرع مطلوب ويجب أن يكون صالحًا لدور الفرع');
    }
    return true;
  }),
  body('department').custom((value, { req }) => {
    if (req.body.role === 'chef' && (!value || !mongoose.isValidObjectId(value))) {
      throw new Error('معرف القسم مطلوب ويجب أن يكون صالحًا لدور الشيف');
    }
    return true;
  }),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { name, nameEn, username, password, email, phone, role, branch, department, isActive } = req.body;
    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;

    const existingUser = await User.findOne({ username: username.trim() }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `اسم المستخدم '${username}' مستخدم بالفعل` });
    }

    if (email) {
      const existingEmail = await User.findOne({ email: email.trim().toLowerCase() }).session(session);
      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: `الإيميل '${email}' مستخدم بالفعل` });
      }
    }

    if (role === 'branch' && branch) {
      const existingBranch = await Branch.findById(branch).session(session);
      if (!existingBranch) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: 'الفرع غير موجود' });
      }
      if (existingBranch.user) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: 'الفرع مرتبط بمستخدم آخر' });
      }
    }

    if (role === 'chef' && department) {
      const existingDepartment = await Department.findById(department).session(session);
      if (!existingDepartment) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: 'القسم غير موجود' });
      }
    }

    const newUser = new User({
      name: name.trim(),
      nameEn: nameEn ? nameEn.trim() : undefined,
      username: username.trim(),
      password,
      role,
      email: email ? email.trim().toLowerCase() : undefined,
      phone: phone ? phone.trim() : undefined,
      branch: role === 'branch' ? branch : undefined,
      department: role === 'chef' ? department : undefined,
      isActive: isActive ?? true,
    });
    await newUser.save({ session });

    if (role === 'branch' && branch) {
      const branchDoc = await Branch.findById(branch).session(session);
      branchDoc.user = newUser._id;
      await branchDoc.save({ session });
    }

    await session.commitTransaction();
    session.endSession();

    const populatedUser = await User.findById(newUser._id)
      .populate('branch', 'name nameEn code')
      .populate('department', 'name nameEn code');

    res.status(201).json({
      ...populatedUser.toObject({ context: { isRtl } }),
      name: isRtl ? populatedUser.name : populatedUser.displayName,
      branch: populatedUser.branch ? {
        ...populatedUser.branch.toObject({ context: { isRtl } }),
        name: isRtl ? populatedUser.branch.name : populatedUser.branch.displayName
      } : null,
      department: populatedUser.department ? {
        ...populatedUser.department.toObject({ context: { isRtl } }),
        name: isRtl ? populatedUser.department.name : populatedUser.department.displayName
      } : null
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error(`[${new Date().toISOString()}] Create user error:`, err.message, err.stack);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ message: `${field} مستخدم بالفعل`, field, value: err.keyValue[field] });
    }
    res.status(400).json({ message: 'خطأ في إنشاء المستخدم', error: err.message });
  }
});

router.put('/:id', [
  auth,
  authorize('admin'),
  body('name').notEmpty().withMessage('الاسم مطلوب'),
  body('username').notEmpty().withMessage('اسم المستخدم مطلوب'),
  body('role').isIn(['admin', 'branch', 'chef', 'production']).withMessage('الدور غير صالح'),
  body('branch').custom((value, { req }) => {
    if (req.body.role === 'branch' && (!value || !mongoose.isValidObjectId(value))) {
      throw new Error('معرف الفرع مطلوب ويجب أن يكون صالحًا لدور الفرع');
    }
    return true;
  }),
  body('department').custom((value, { req }) => {
    if (req.body.role === 'chef' && (!value || !mongoose.isValidObjectId(value))) {
      throw new Error('معرف القسم مطلوب ويجب أن يكون صالحًا لدور الشيف');
    }
    return true;
  }),
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { name, nameEn, username, email, phone, role, branch, department, isActive } = req.body;
    const isRtl = req.query.isRtl === 'true' || req.query.isRtl === true;

    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
    }

    const user = await User.findById(req.params.id).session(session);
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    const existingUser = await User.findOne({ username: username.trim(), _id: { $ne: req.params.id } }).session(session);
    if (existingUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `اسم المستخدم '${username}' مستخدم بالفعل` });
    }

    if (email) {
      const existingEmail = await User.findOne({ email: email.trim().toLowerCase(), _id: { $ne: req.params.id } }).session(session);
      if (existingEmail) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: `الإيميل '${email}' مستخدم بالفعل` });
      }
    }

    if (role === 'branch' && branch) {
      const existingBranch = await Branch.findById(branch).session(session);
      if (!existingBranch) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: 'الفرع غير موجود' });
      }
      if (existingBranch.user && existingBranch.user.toString() !== req.params.id) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: 'الفرع مرتبط بمستخدم آخر' });
      }
    }

    if (role === 'chef' && department) {
      const existingDepartment = await Department.findById(department).session(session);
      if (!existingDepartment) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: 'القسم غير موجود' });
      }
    }

    if (user.role === 'branch' && user.branch && (role !== 'branch' || branch !== user.branch.toString())) {
      const oldBranch = await Branch.findById(user.branch).session(session);
      if (oldBranch) {
        oldBranch.user = undefined;
        await oldBranch.save({ session });
      }
    }

    user.name = name.trim();
    user.nameEn = nameEn ? nameEn.trim() : undefined;
    user.username = username.trim();
    user.email = email ? email.trim().toLowerCase() : undefined;
    user.phone = phone ? phone.trim() : undefined;
    user.role = role;
    user.branch = role === 'branch' ? branch : undefined;
    user.department = role === 'chef' ? department : undefined;
    user.isActive = isActive ?? user.isActive;
    await user.save({ session });

    if (role === 'branch' && branch) {
      const branchDoc = await Branch.findById(branch).session(session);
      branchDoc.user = user._id;
      await branchDoc.save({ session });
    }

    await session.commitTransaction();
    session.endSession();

    const populatedUser = await User.findById(user._id)
      .populate('branch', 'name nameEn code')
      .populate('department', 'name nameEn code');

    res.status(200).json({
      ...populatedUser.toObject({ context: { isRtl } }),
      name: isRtl ? populatedUser.name : populatedUser.displayName,
      branch: populatedUser.branch ? {
        ...populatedUser.branch.toObject({ context: { isRtl } }),
        name: isRtl ? populatedUser.branch.name : populatedUser.branch.displayName
      } : null,
      department: populatedUser.department ? {
        ...populatedUser.department.toObject({ context: { isRtl } }),
        name: isRtl ? populatedUser.department.name : populatedUser.department.displayName
      } : null
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error(`[${new Date().toISOString()}] Update user error:`, err.message, err.stack);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ message: `${field} مستخدم بالفعل`, field, value: err.keyValue[field] });
    }
    res.status(400).json({ message: 'خطأ في تحديث المستخدم', error: err.message });
  }
});

router.delete('/:id', auth, authorize('admin'), async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
    }

    const user = await User.findById(req.params.id).session(session);
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    if (user.role === 'branch' && user.branch) {
      const branch = await Branch.findById(user.branch).session(session);
      if (branch) {
        let ordersCount = 0, inventoryCount = 0;
        try {
          ordersCount = await mongoose.model('Order').countDocuments({ branch: branch._id }).session(session);
        } catch (err) {
          console.warn(`[${new Date().toISOString()}] Order model not found or query failed:`, err.message);
        }
        try {
          inventoryCount = await mongoose.model('Inventory').countDocuments({ branch: branch._id }).session(session);
        } catch (err) {
          console.warn(`[${new Date().toISOString()}] Inventory model not found or query failed:`, err.message);
        }

        if (ordersCount > 0 || inventoryCount > 0) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({ message: 'لا يمكن حذف المستخدم لوجود طلبات أو مخزون مرتبط بالفرع' });
        }

        branch.user = undefined;
        await branch.save({ session });
      }
    }

    await user.deleteOne({ session });
    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: 'تم حذف المستخدم بنجاح' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error(`[${new Date().toISOString()}] Delete user error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في السيرفر', error: err.message });
  }
});

router.post('/:id/reset-password', [
  auth,
  authorize('admin'),
  body('password').isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل')
], async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: 'معرف المستخدم غير صالح' });
    }

    const user = await User.findById(req.params.id).session(session);
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    user.password = req.body.password;
    await user.save({ session });

    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ message: 'تم إعادة تعيين كلمة المرور بنجاح' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    console.error(`[${new Date().toISOString()}] Reset password error:`, err.message, err.stack);
    res.status(500).json({ message: 'خطأ في إعادة تعيين كلمة المرور', error: err.message });
  }
});

module.exports = router;