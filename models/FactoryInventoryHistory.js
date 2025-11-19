
// models/FactoryInventoryHistory.js
const mongoose = require('mongoose');
const factoryInventoryHistorySchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: [true, 'معرف المنتج مطلوب'],
  },
  action: {
    type: String,
    enum: {
      values: ['delivery', 'return_pending', 'return_rejected', 'return_approved', 'sale', 'sale_cancelled', 'sale_deleted', 'adjustment', 'reserve', 'produced_reserved', 'produced_stock', 'shipped'],
      message: 'الإجراء غير صالح',
    },
    required: [true, 'الإجراء مطلوب'],
  },
  quantity: {
    type: Number,
    required: [true, 'الكمية مطلوبة'],
  },
  reference: {
    type: String,
    trim: true,
  },
  referenceType: {
    type: String,
    enum: ['order', 'return', 'sale', 'adjustment'],
  },
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'referenceType',
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
  notes: {
    type: String,
    trim: true,
  },
  isDamaged: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});
factoryInventoryHistorySchema.index({ product: 1, createdAt: -1 });
factoryInventoryHistorySchema.index({ referenceType: 1, referenceId: 1 });
module.exports = mongoose.model('FactoryInventoryHistory', factoryInventoryHistorySchema);
