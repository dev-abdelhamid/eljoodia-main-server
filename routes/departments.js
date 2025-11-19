const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const mongoose = require('mongoose');
const Department = require('../models/department');
const Product = require('../models/Product'); // Assuming Product model exists

// Get all departments with pagination and search
router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const { page = 1, limit = 12, search = '' } = req.query;
    const query = search
      ? {
          $or: [
            { name: { $regex: search, $options: 'i' } },
            { nameEn: { $regex: search, $options: 'i' } },
            { code: { $regex: search, $options: 'i' } },
          ],
          isActive: true
        }
      : { isActive: true };

    const departments = await Department.find(query)
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });

    const total = await Department.countDocuments(query);
    const totalPages = Math.ceil(total / parseInt(limit));

    res.status(200).json({
      data: departments,
      totalPages,
      currentPage: parseInt(page),
      totalItems: total
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get departments error:`, err);
    res.status(500).json({ 
      message: req.query.isRtl === 'true' ? 'خطأ في الخادم' : 'Server error', 
      error: err.message 
    });
  }
});

// Get single department by ID
router.get('/:id', authMiddleware.auth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ 
        message: req.query.isRtl === 'true' ? 'معرف القسم غير صالح' : 'Invalid department ID' 
      });
    }
    const department = await Department.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ 
        message: req.query.isRtl === 'true' ? 'القسم غير موجود' : 'Department not found' 
      });
    }
    res.status(200).json(department);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get department error:`, err);
    res.status(500).json({ 
      message: req.query.isRtl === 'true' ? 'خطأ في الخادم' : 'Server error', 
      error: err.message 
    });
  }
});

// Create a new department
router.post('/', authMiddleware.auth, async (req, res) => {
  try {
    const { name, nameEn, code, description } = req.body;

    // Validate required fields
    if (!name || !code) {
      return res.status(400).json({ 
        message: req.query.isRtl === 'true' ? 'الاسم والكود مطلوبان' : 'Name and code are required' 
      });
    }

    // Check for duplicate name or code
    const existingDepartment = await Department.findOne({
      $or: [{ name }, { code }],
    });
    if (existingDepartment) {
      return res.status(400).json({
        message: existingDepartment.name === name
          ? (req.query.isRtl === 'true' ? 'اسم القسم موجود بالفعل' : 'Department name already exists')
          : (req.query.isRtl === 'true' ? 'كود القسم موجود بالفعل' : 'Department code already exists')
      });
    }

    const department = new Department({
      name,
      nameEn: nameEn || undefined,
      code,
      description: description || undefined,
      createdBy: req.user._id,
    });

    await department.save();
    res.status(201).json(department);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Create department error:`, err);
    res.status(400).json({ 
      message: req.query.isRtl === 'true' ? 'خطأ في إنشاء القسم' : 'Error creating department', 
      error: err.message 
    });
  }
});

// Update a department
router.put('/:id', authMiddleware.auth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ 
        message: req.query.isRtl === 'true' ? 'معرف القسم غير صالح' : 'Invalid department ID' 
      });
    }
    const { name, nameEn, code, description } = req.body;
    const department = await Department.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ 
        message: req.query.isRtl === 'true' ? 'القسم غير موجود' : 'Department not found' 
      });
    }

    // Validate required fields
    if (name && name !== department.name) {
      const existingName = await Department.findOne({ name, _id: { $ne: req.params.id } });
      if (existingName) {
        return res.status(400).json({ 
          message: req.query.isRtl === 'true' ? 'اسم القسم موجود بالفعل' : 'Department name already exists' 
        });
      }
    }
    if (code && code !== department.code) {
      const existingCode = await Department.findOne({ code, _id: { $ne: req.params.id } });
      if (existingCode) {
        return res.status(400).json({ 
          message: req.query.isRtl === 'true' ? 'كود القسم موجود بالفعل' : 'Department code already exists' 
        });
      }
    }

    department.name = name || department.name;
    department.nameEn = nameEn !== undefined ? nameEn : department.nameEn;
    department.code = code || department.code;
    department.description = description !== undefined ? description : department.description;

    await department.save();
    res.status(200).json(department);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Update department error:`, err);
    res.status(400).json({ 
      message: req.query.isRtl === 'true' ? 'خطأ في تحديث القسم' : 'Error updating department', 
      error: err.message 
    });
  }
});

// Delete a department
router.delete('/:id', authMiddleware.auth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ 
        message: req.query.isRtl === 'true' ? 'معرف القسم غير صالح' : 'Invalid department ID' 
      });
    }
    const department = await Department.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ 
        message: req.query.isRtl === 'true' ? 'القسم غير موجود' : 'Department not found' 
      });
    }

    // Check if department is referenced by any products
    const productCount = await Product.countDocuments({ department: req.params.id });
    if (productCount > 0) {
      return res.status(400).json({ 
        message: req.query.isRtl === 'true' ? 'لا يمكن حذف القسم لوجود منتجات مرتبطة به' : 'Cannot delete department with associated products' 
      });
    }
ئ
    await Department.deleteOne({ _id: req.params.id });
    res.status(200).json({ 
      message: req.query.isRtl === 'true' ? 'تم حذف القسم بنجاح' : 'Department deleted successfully' 
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Delete department error:`, err);
    res.status(500).json({ 
      message: req.query.isRtl === 'true' ? 'خطأ في الخادم' : 'Server error', 
      error: err.message 
    });
  }
});

module.exports = router;