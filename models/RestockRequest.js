const mongoose = require('mongoose');

const restockRequestSchema = new mongoose.Schema({
  product: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Product', 
    required: [true, 'معرف المنتج مطلوب'] 
  },
  branch: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Branch', 
    required: [true, 'معرف الفرع مطلوب'] 
  },
  requestedQuantity: { 
    type: Number, 
    required: [true, 'الكمية المطلوبة مطلوبة'], 
    min: [1, 'الكمية المطلوبة يجب أن تكون أكبر من 0'] 
  },
  status: { 
    type: String, 
    enum: {
      values: ['pending', 'approved', 'rejected'],
      message: 'الحالة يجب أن تكون إما pending أو approved أو rejected'
    }, 
    default: 'pending' 
  },
  notes: { 
    type: String, 
    trim: true, 
    default: '' 
  },
  createdBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: [true, 'معرف المستخدم الذي أنشأ الطلب مطلوب'] 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  approvedAt: { 
    type: Date 
  },
  approvedBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  },
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// إضافة فهرس لتحسين الأداء عند البحث
restockRequestSchema.index({ product: 1, branch: 1, status: 1 });

module.exports = mongoose.model('RestockRequest', restockRequestSchema);