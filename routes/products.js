// routes/products.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Product = require('../models/Product');
const Department = require('../models/department');

// GET /products
router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const { page = 1, limit = 12, search = '', department = '' } = req.query;
    const query = { isActive: true };
    if (department) query.department = department;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { nameEn: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
      ];
    }

    const products = await Product.find(query)
      .populate('department', 'name nameEn _id')
      .populate('createdBy', 'name _id')
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await Product.countDocuments(query);
    const totalPages = Math.ceil(total / parseInt(limit));

    res.status(200).json({
      data: products,
      totalPages,
      currentPage: parseInt(page),
      totalItems: total
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get products error:`, err);
    res.status(500).json({ message: 'خطأ في الخادم', error: err.message });
  }
});

// GET /products/:id
router.get('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate('department', 'name nameEn _id')
      .populate('createdBy', 'name _id');
    if (!product) return res.status(404).json({ message: 'المنتج غير موجود' });
    res.status(200).json(product);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get product error:`, err);
    res.status(500).json({ message: 'خطأ في الخادم', error: err.message });
  }
});

// POST /products
router.post('/', authMiddleware.auth, async (req, res) => {
  try {
    const { name, nameEn, code, department, price, unit, unitEn, description, image } = req.body;

    if (!name || !code || !department || !price) {
      return res.status(400).json({ message: 'الاسم، الرمز، القسم، والسعر مطلوبة' });
    }

    const dept = await Department.findById(department);
    if (!dept) return res.status(400).json({ message: 'معرف القسم غير صالح' });

    const existingProduct = await Product.findOne({ code });
    if (existingProduct) return res.status(400).json({ message: 'رمز المنتج موجود بالفعل' });

    const validUnits = ['كيلو', 'قطعة', 'علبة', 'صينية', ''];
    if (unit && !validUnits.includes(unit)) {
      return res.status(400).json({ message: 'وحدة القياس غير صالحة' });
    }

    const product = new Product({
      name: name.trim(),
      nameEn: nameEn?.trim(),
      code: code.trim(),
      department,
      price: parseFloat(price),
      unit: unit || '',
      description: description?.trim(),
      image: image || undefined,
      createdBy: req.user._id,
    });

    await product.save();
    await product.populate('department', 'name nameEn _id');
    await product.populate('createdBy', 'name _id');
    res.status(201).json(product);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Create product error:`, err);
    res.status(400).json({ message: 'خطأ في إنشاء المنتج', error: err.message });
  }
});

// PUT /products/:id
router.put('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const { name, nameEn, code, department, price, unit, description, image } = req.body;
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'المنتج غير موجود' });

    if (name !== undefined && !name) return res.status(400).json({ message: 'الاسم مطلوب' });
    if (code !== undefined && !code) return res.status(400).json({ message: 'الرمز مطلوب' });
    if (price !== undefined && (isNaN(price) || price < 0)) {
      return res.status(400).json({ message: 'السعر يجب أن يكون رقمًا غير سالب' });
    }

    if (department && department !== product.department.toString()) {
      const dept = await Department.findById(department);
      if (!dept) return res.status(400).json({ message: 'معرف القسم غير صالح' });
    }

    if (code && code !== product.code) {
      const existing = await Product.findOne({ code });
      if (existing) return res.status(400).json({ message: 'رمز المنتج موجود بالفعل' });
    }

    const validUnits = ['كيلو', 'قطعة', 'علبة', 'صينية', ''];
    if (unit !== undefined && !validUnits.includes(unit)) {
      return res.status(400).json({ message: 'وحدة القياس غير صالحة' });
    }

    // تحديث الحقول
    if (name !== undefined) product.name = name.trim();
    if (nameEn !== undefined) product.nameEn = nameEn?.trim();
    if (code !== undefined) product.code = code.trim();
    if (department !== undefined) product.department = department;
    if (price !== undefined) product.price = parseFloat(price);
    if (unit !== undefined) product.unit = unit || '';
    if (description !== undefined) product.description = description?.trim();
    if (image !== undefined) product.image = image; // حفظ الصورة

    await product.save();
    await product.populate('department', 'name nameEn _id');
    await product.populate('createdBy', 'name _id');
    res.status(200).json(product);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Update product error:`, err);
    res.status(400).json({ message: 'خطأ في تحديث المنتج', error: err.message });
  }
});

// DELETE /products/:id
router.delete('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'المنتج غير موجود' });
    await product.deleteOne();
    res.status(200).json({ message: 'تم حذف المنتج بنجاح' });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Delete product error:`, err);
    res.status(500).json({ message: 'خطأ في الخادم', error: err.message });
  }
});

module.exports = router;