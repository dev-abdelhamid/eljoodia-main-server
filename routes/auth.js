const express = require('express');
const router = express.Router();
const { check, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Department = require('../models/department');
const { auth } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

const refreshTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 10,
  message: 'طلبات تجديد التوكن كثيرة جدًا، حاول مرة أخرى لاحقًا.',
});

const getPermissions = (role) => {
  switch (role) {
    case 'admin':
      return ['manage_users', 'manage_branches', 'manage_products', 'view_reports', 'manage_orders'];
    case 'production':
      return ['manage_orders', 'view_reports'];
    case 'branch':
      return ['create_orders', 'view_branch_orders', 'manage_inventory'];
    case 'chef':
      return ['update_order_items', 'view_assigned_orders'];
    default:
      return [];
  }
};

const generateAccessToken = (user) => {
  return jwt.sign(
    { id: user._id, username: user.username, role: user.role, branchId: user.branch, departmentId: user.department },
    process.env.JWT_ACCESS_SECRET || 'your_access_secret',
    {
      expiresIn: process.env.JWT_ACCESS_EXPIRE || '15m',
      issuer: process.env.JWT_ISSUER || 'your_jwt_issuer',
      audience: process.env.JWT_AUDIENCE || 'your_jwt_audience',
    }
  );
};

const generateRefreshToken = (user) => {
  return jwt.sign(
    { id: user._id, username: user.username, role: user.role },
    process.env.JWT_REFRESH_SECRET || 'your_refresh_secret',
    {
      expiresIn: '7d',
      issuer: process.env.JWT_ISSUER || 'your_jwt_issuer',
      audience: process.env.JWT_AUDIENCE || 'your_jwt_audience',
    }
  );
};

// Login endpoint
router.post(
  '/login',
  [
    options((req, res) => {
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.sendStatus(200);
  }),
    check('username', 'اسم المستخدم مطلوب').not().isEmpty(),
    check('password', 'كلمة المرور مطلوبة').not().isEmpty(),
    
 

  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array(), message: 'بيانات الإدخال غير صالحة' });
      }

      const { username, password } = req.body;
      const user = await User.findOne({ username: { $regex: `^${username}$`, $options: 'i' } })
        .select('+password')
        .populate('branch', 'name nameEn code address city phone')
        .populate('department', 'name nameEn code description');

      if (!user) {
        return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      }

      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
      }

      const accessToken = generateAccessToken(user);
      const refreshToken = generateRefreshToken(user);
      user.lastLogin = new Date();
      await user.save();

      const userData = {
        id: user._id.toString(),
        username: user.username,
        role: user.role,
        name: user.name,
        nameEn: user.nameEn,
        email: user.email,
        phone: user.phone,
        isActive: user.isActive,
        lastLogin: user.lastLogin?.toISOString(),
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
        branchId: user.branch ? user.branch._id.toString() : undefined,
        chefDepartment: user.department ? user.department._id.toString() : undefined,
        branch: user.branch
          ? {
              id: user.branch._id.toString(),
              name: user.branch.name,
              nameEn: user.branch.nameEn,
              code: user.branch.code,
              address: user.branch.address,
              city: user.branch.city,
              phone: user.branch.phone,
            }
          : undefined,
        department: user.department
          ? {
              id: user.department._id.toString(),
              name: user.department.name,
              nameEn: user.department.nameEn,
              code: user.department.code,
              description: user.department.description,
            }
          : undefined,
        permissions: getPermissions(user.role),
      };

      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); // إضافة CORS header
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.json({ success: true, token: accessToken, refreshToken, user: userData });
    } catch (error) {
      console.error(`خطأ في تسجيل الدخول في ${new Date().toISOString()}:`, error);
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); // إضافة CORS header في الأخطاء
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.status(500).json({ success: false, message: 'حدث خطأ في الخادم' });
    }
  }
);

// Refresh Token endpoint
router.post('/refresh-token', refreshTokenLimiter, async (req, res) => {
  const refreshToken = req.body.refreshToken || req.header('Authorization')?.replace('Bearer ', '');
  if (!refreshToken) {
    return res.status(401).json({ success: false, message: 'الـ Refresh Token مطلوب' });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id)
      .populate('branch', 'name nameEn code address city phone')
      .populate('department', 'name nameEn code description');
    if (!user) {
      return res.status(401).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    const userData = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      name: user.name,
      nameEn: user.nameEn,
      email: user.email,
      phone: user.phone,
      isActive: user.isActive,
      lastLogin: user.lastLogin?.toISOString(),
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      branchId: user.branch ? user.branch._id.toString() : undefined,
      chefDepartment: user.department ? user.department._id.toString() : undefined,
      branch: user.branch
        ? {
            id: user.branch._id.toString(),
            name: user.branch.name,
            nameEn: user.branch.nameEn,
            code: user.branch.code,
            address: user.branch.address,
            city: user.branch.city,
            phone: user.branch.phone,
          }
        : undefined,
      department: user.department
        ? {
            id: user.department._id.toString(),
            name: user.department.name,
            nameEn: user.department.nameEn,
            code: user.department.code,
            description: user.department.description,
          }
        : undefined,
      permissions: getPermissions(user.role),
    };

    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); // إضافة CORS header
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.status(200).json({ success: true, token: newAccessToken, refreshToken: newRefreshToken, user: userData });
  } catch (err) {
    console.error(`خطأ في تجديد التوكن في ${new Date().toISOString()}:`, err);
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); // إضافة CORS header في الأخطاء
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.status(401).json({ success: false, message: 'الـ Refresh Token غير صالح أو منتهي الصلاحية' });
  }
});

// Get profile
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('-password')
      .populate('branch', 'name nameEn code address city phone')
      .populate('department', 'name nameEn code description');

    if (!user) {
      return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    }

    const userData = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      name: user.name,
      nameEn: user.nameEn,
      email: user.email,
      phone: user.phone,
      isActive: user.isActive,
      lastLogin: user.lastLogin?.toISOString(),
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      branchId: user.branch ? user.branch._id.toString() : undefined,
      chefDepartment: user.department ? user.department._id.toString() : undefined,
      branch: user.branch
        ? {
            id: user.branch._id.toString(),
            name: user.branch.name,
            nameEn: user.branch.nameEn,
            code: user.branch.code,
            address: user.branch.address,
            city: user.branch.city,
            phone: user.branch.phone,
          }
        : undefined,
      department: user.department
        ? {
            id: user.department._id.toString(),
            name: user.department.name,
            nameEn: user.department.nameEn,
            code: user.department.code,
            description: user.department.description,
          }
        : undefined,
      permissions: getPermissions(user.role),
    };

    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); // إضافة CORS header
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.json({ success: true, user: userData });
  } catch (error) {
    console.error(`خطأ في جلب الملف الشخصي في ${new Date().toISOString()}:`, error);
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); // إضافة CORS header في الأخطاء
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم' });
  }
});

// Update profile
router.put(
  '/update-profile',
  [
    auth,
    check('name', 'الاسم مطلوب').optional().not().isEmpty(),
    check('email', 'البريد الإلكتروني غير صالح').optional().isEmail(),
    check('phone', 'رقم الهاتف غير صالح').optional().isMobilePhone('any'),
    check('password', 'كلمة المرور يجب أن تكون 6 أحرف على الأقل').optional().isLength({ min: 6 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array(), message: 'بيانات الإدخال غير صالحة' });
      }

      const { name, nameEn, email, phone, password } = req.body;

      const updateData = {
        name: name?.trim(),
        nameEn: nameEn?.trim(),
        email: email?.trim().toLowerCase(),
        phone: phone?.trim(),
      };

      if (password) {
        const salt = await bcrypt.genSalt(10);
        updateData.password = await bcrypt.hash(password, salt);
      }

      const user = await User.findByIdAndUpdate(req.user.id, { $set: updateData }, { new: true })
        .select('-password')
        .populate('branch', 'name nameEn code address city phone')
        .populate('department', 'name nameEn code description');

      if (!user) {
        return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
      }

      const userData = {
        id: user._id.toString(),
        username: user.username,
        role: user.role,
        name: user.name,
        nameEn: user.nameEn,
        email: user.email,
        phone: user.phone,
        isActive: user.isActive,
        lastLogin: user.lastLogin?.toISOString(),
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
        branchId: user.branch ? user.branch._id.toString() : undefined,
        chefDepartment: user.department ? user.department._id.toString() : undefined,
        branch: user.branch
          ? {
              id: user.branch._id.toString(),
              name: user.branch.name,
              nameEn: user.branch.nameEn,
              code: user.branch.code,
              address: user.branch.address,
              city: user.branch.city,
              phone: user.branch.phone,
            }
          : undefined,
        department: user.department
          ? {
              id: user.department._id.toString(),
              name: user.department.name,
              nameEn: user.department.nameEn,
              code: user.department.code,
              description: user.department.description,
            }
          : undefined,
        permissions: getPermissions(user.role),
      };

      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); // إضافة CORS header
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.json({ success: true, user: userData });
    } catch (error) {
      console.error(`خطأ في تحديث الملف الشخصي في ${new Date().toISOString()}:`, error);
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); // إضافة CORS header في الأخطاء
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.status(500).json({ success: false, message: 'حدث خطأ في الخادم' });
    }
  }
);

// Register endpoint
router.post(
  '/register',
  [
    check('username', 'اسم المستخدم مطلوب').not().isEmpty(),
    check('password', 'كلمة المرور مطلوبة').isLength({ min: 6 }),
    check('name', 'الاسم مطلوب').not().isEmpty(),
    check('role', 'الدور مطلوب').isIn(['admin', 'branch', 'chef', 'production']),
    check('email', 'البريد الإلكتروني غير صالح').optional().isEmail(),
    check('phone', 'رقم الهاتف غير صالح').optional().isMobilePhone('any'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array(), message: 'بيانات الإدخال غير صالحة' });
      }

      const { username, password, name, role, email, phone, branch, department } = req.body;

      const existingUser = await User.findOne({ $or: [{ username }, { email }] });
      if (existingUser) {
        return res.status(400).json({ success: false, message: 'اسم المستخدم أو البريد الإلكتروني موجود بالفعل' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const user = new User({
        username,
        password: hashedPassword,
        name,
        role,
        email,
        phone,
        branch: role === 'branch' ? branch : undefined,
        department: role === 'chef' ? department : undefined,
      });

      await user.save();

      const accessToken = generateAccessToken(user);
      const refreshToken = generateRefreshToken(user);

      const populatedUser = await User.findById(user._id)
        .populate('branch', 'name nameEn code address city phone')
        .populate('department', 'name nameEn code description');

      const userData = {
        id: user._id.toString(),
        username: user.username,
        role: user.role,
        name: user.name,
        nameEn: user.nameEn,
        email: user.email,
        phone: user.phone,
        isActive: user.isActive,
        lastLogin: user.lastLogin?.toISOString(),
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
        branchId: user.branch ? user.branch._id.toString() : undefined,
        chefDepartment: user.department ? user.department._id.toString() : undefined,
        branch: populatedUser.branch
          ? {
              id: populatedUser.branch._id.toString(),
              name: populatedUser.branch.name,
              nameEn: populatedUser.branch.nameEn,
              code: populatedUser.branch.code,
              address: populatedUser.branch.address,
              city: populatedUser.branch.city,
              phone: populatedUser.branch.phone,
            }
          : undefined,
        department: populatedUser.department
          ? {
              id: populatedUser.department._id.toString(),
              name: populatedUser.department.name,
              nameEn: populatedUser.department.nameEn,
              code: populatedUser.department.code,
              description: populatedUser.department.description,
            }
          : undefined,
        permissions: getPermissions(user.role),
      };

      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); // إضافة CORS header
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.status(201).json({ success: true, token: accessToken, refreshToken, user: userData });
    } catch (error) {
      console.error(`خطأ في التسجيل في ${new Date().toISOString()}:`, error);
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*'); // إضافة CORS header في الأخطاء
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.status(500).json({ success: false, message: 'حدث خطأ في الخادم' });
    }
  }
);

module.exports = router;