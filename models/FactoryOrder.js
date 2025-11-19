
const mongoose = require('mongoose');
const factoryOrderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    required: [true, 'رقم الطلب مطلوب'],
    unique: true,
    trim: true,
    index: true,
  },
  items: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'المنتج مطلوب'],
    },
    quantity: {
      type: Number,
      required: [true, 'الكمية مطلوبة'],
      min: [1, 'الكمية يجب أن تكون أكبر من 0'],
    },
    status: {
      type: String,
      enum: ['pending', 'assigned', 'in_progress', 'completed'],
      default: 'pending',
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
    },
    startedAt: Date,
    completedAt: Date,
    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
  }],
  status: {
    type: String,
    enum: ['requested', 'pending', 'approved', 'in_production', 'completed', 'cancelled'],
    default: 'pending',
  },
  notes: {
    type: String,
    trim: true,
    required: false,
  },
  notesEn: {
    type: String,
    trim: true,
    required: false,
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedAt: Date,
  statusHistory: [{
    status: String,
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    changedAt: Date,
    notes: String,
  }],
  inventoryProcessed: {
    type: Boolean,
    default: false
  }
}, { timestamps: true, toJSON: { virtuals: true } });
factoryOrderSchema.index({ orderNumber: 1 });
factoryOrderSchema.index({ status: 1, priority: 1 });
module.exports = mongoose.model('FactoryOrder', factoryOrderSchema);
