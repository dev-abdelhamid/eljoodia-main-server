const mongoose = require('mongoose');

const productionAssignmentSchema = new mongoose.Schema({
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
  },
  factoryOrder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FactoryOrder',
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  itemId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  chef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chef',
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    min: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'completed', 'rejected'], 
    default: 'pending',
  },
  startedAt: {
    type: Date,
  },
  completedAt: {
    type: Date,
  },
  rejectedAt: {
    type: Date,
  },
  notes: {
    type: String,
    trim: true,
  },
}, {
  timestamps: true,
});

productionAssignmentSchema.index({ order: 1, itemId: 1 }, { unique: true, sparse: true });
productionAssignmentSchema.index({ factoryOrder: 1, itemId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('ProductionAssignment', productionAssignmentSchema);