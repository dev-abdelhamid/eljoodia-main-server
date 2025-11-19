const mongoose = require('mongoose');

const returnItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, 'معرف المنتج مطلوب'],
  },
  quantity: {
    type: Number,
    required: [true, 'الكمية مطلوبة'],
    min: [1, 'الكمية يجب أن تكون أكبر من 0'],
  },
  price: {
    type: Number,
    required: false,
    min: [0, 'السعر يجب أن يكون غير سالب'],
    default: 0,
  },
  reason: {
    type: String,
    required: [true, 'سبب الإرجاع مطلوب'],
    enum: {
      values: ['تالف', 'منتج خاطئ', 'كمية زائدة', 'أخرى'],
      message: 'سبب الإرجاع غير صالح',
    },
  },
  reasonEn: {
    type: String,
    required: [true, 'سبب الإرجاع بالإنجليزية مطلوب'],
    enum: {
      values: ['Damaged', 'Wrong Item', 'Excess Quantity', 'Other'],
      message: 'سبب الإرجاع بالإنجليزية غير صالح',
    },
  },
});

returnItemSchema.pre('save', async function (next) {
  const reasonMap = {
    'تالف': 'Damaged',
    'منتج خاطئ': 'Wrong Item',
    'كمية زائدة': 'Excess Quantity',
    'أخرى': 'Other',
  };
  if (this.reason && !this.reasonEn) {
    this.reasonEn = reasonMap[this.reason];
  }
  if (this.reasonEn && this.reason && reasonMap[this.reason] !== this.reasonEn) {
    return next(new Error('سبب الإرجاع وسبب الإرجاع بالإنجليزية يجب أن يتطابقا'));
  }
  if (this.price == null || isNaN(this.price) || this.price < 0) {
    const product = await mongoose.model('Product').findById(this.product).lean();
    if (!product) {
      return next(new Error('المنتج غير موجود'));
    }
    this.price = product.price || 0;
  }
  next();
});

const returnSchema = new mongoose.Schema({
  returnNumber: {
    type: String,
    required: [true, 'رقم الإرجاع مطلوب'],
    unique: true,
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, 'معرف الفرع مطلوب'],
  },
  items: [returnItemSchema],
  status: {
    type: String,
    enum: {
      values: ['pending_approval', 'approved', 'rejected'],
      message: 'حالة الإرجاع غير صالحة',
    },
    default: 'pending_approval',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'معرف المستخدم مطلوب'],
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  notes: {
    type: String,
    trim: true,
    default: '',
  },
  reviewNotes: {
    type: String,
    trim: true,
    default: '',
  },
  reviewedAt: {
    type: Date,
  },
  statusHistory: [{
    status: {
      type: String,
      enum: ['pending_approval', 'approved', 'rejected'],
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    notes: {
      type: String,
      trim: true,
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
  }],
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

returnSchema.index({ branch: 1, createdAt: -1 });
returnSchema.index({ returnNumber: 1 }, { unique: true });

module.exports = mongoose.model('Return', returnSchema);