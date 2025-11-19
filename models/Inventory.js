const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, 'معرف المنتج مطلوب'],
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: [true, 'معرف الفرع مطلوب'],
  },
  currentStock: {
    type: Number,
    required: [true, 'الكمية الحالية مطلوبة'],
    min: [0, 'الكمية الحالية يجب أن تكون غير سالبة'],
    default: 0,
  },
  pendingReturnStock: {
    type: Number,
    required: [true, 'الكمية المحجوزة للإرجاع مطلوبة'],
    min: [0, 'الكمية المحجوزة يجب أن تكون غير سالبة'],
    default: 0,
  },
  damagedStock: {
    type: Number,
    required: [true, 'الكمية التالفة مطلوبة'],
    min: [0, 'الكمية التالفة يجب أن تكون غير سالبة'],
    default: 0,
  },
  minStockLevel: {
    type: Number,
    required: [true, 'الحد الأدنى للمخزون مطلوب'],
    min: [0, 'الحد الأدنى للمخزون يجب أن يكون غير سالب'],
    default: 0,
  },
  maxStockLevel: {
    type: Number,
    min: [0, 'الحد الأقصى للمخزون يجب أن يكون غير سالب'],
    default: 1000,
    validate: {
      validator: function (value) {
        return value >= this.minStockLevel;
      },
      message: 'الحد الأقصى يجب أن يكون أكبر من أو يساوي الحد الأدنى',
    },
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'معرف المستخدم الذي أنشأ السجل مطلوب'],
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  movements: [{
    type: {
      type: String,
      enum: {
        values: ['in', 'out'],
        message: 'نوع الحركة يجب أن يكون إما in أو out',
      },
      required: true,
    },
    quantity: {
      type: Number,
      required: [true, 'الكمية مطلوبة'],
      min: [0, 'الكمية يجب أن تكون غير سالبة'],
    },
    reference: {
      type: String,
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'معرف المستخدم مطلوب'],
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }],
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

inventorySchema.index({ product: 1, branch: 1 }, { unique: true });

inventorySchema.pre('save', function (next) {
  if (this.currentStock < 0 || this.pendingReturnStock < 0 || this.damagedStock < 0) {
    return next(new Error('الكميات لا يمكن أن تكون سالبة'));
  }
  next();
});

module.exports = mongoose.model('Inventory', inventorySchema);