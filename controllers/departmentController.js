const Department = require('../models/department');

exports.getDepartments = async (req, res) => {
  try {
    const departments = await Department.find({ isActive: true });
    res.json({ success: true, data: departments });
  } catch (error) {
    console.error('Get departments error:', error);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
};

exports.createDepartment = async (req, res) => {
  try {
    const { name, code, description } = req.body;
    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'غير مصرح' });
    }
    const department = new Department({ name, code, description });
    await department.save();
    res.status(201).json({ success: true, data: department });
  } catch (error) {
    console.error('Create department error:', error);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
};

exports.updateDepartment = async (req, res) => {
  try {
    const { name, code, description } = req.body;
    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'غير مصرح' });
    }
    const department = await Department.findByIdAndUpdate(
      req.params.id,
      { name, code, description },
      { new: true, runValidators: true }
    );
    if (!department) {
      return res.status(404).json({ success: false, message: 'القسم غير موجود' });
    }
    res.json({ success: true, data: department });
  } catch (error) {
    console.error('Update department error:', error);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
};

exports.deleteDepartment = async (req, res) => {
  try {
    if (!req.user || !['admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'غير مصرح' });
    }
    const department = await Department.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ success: false, message: 'القسم غير موجود' });
    }
    await department.remove();
    res.json({ success: true, message: 'تم حذف القسم' });
  } catch (error) {
    console.error('Delete department error:', error);
    res.status(500).json({ success: false, message: 'خطأ في الخادم' });
  }
};