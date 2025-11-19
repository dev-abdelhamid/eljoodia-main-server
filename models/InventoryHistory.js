// models/InventoryHistory.js
const mongoose = require('mongoose');

const inventoryHistorySchema = new mongoose.Schema({
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
  action: {
    type: String,
    enum: ['delivery', 'return_pending', 'return_rejected', 'return_approved', 'sale', 'sale_cancelled', 'sale_deleted', 'adjustment', 'restock'],
    required: [true, 'الإجراء مطلوب'],
  },
  quantity: {
    type: Number,
    required: [true, 'الكمية مطلوبة'],
  },
  reference: { type: String, trim: true },
  referenceType: { type: String, enum: ['order', 'return', 'sale', 'adjustment', 'transfer'] },
  referenceId: { type: mongoose.Schema.Types.ObjectId, refPath: 'referenceType' },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [false, 'معرف المستخدم مطلوب'],
  },
  notes: { type: String, trim: true },
  isDamaged: { type: Boolean, default: false },
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// فهارس للأداء
inventoryHistorySchema.index({ product: 1, branch: 1, createdAt: -1 });
inventoryHistorySchema.index({ referenceType: 1, referenceId: 1 });
inventoryHistorySchema.index({ branch: 1, createdAt: -1 });

module.exports = mongoose.model('InventoryHistory', inventoryHistorySchema);