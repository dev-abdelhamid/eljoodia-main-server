const mongoose = require('mongoose');

const saleSchema = new mongoose.Schema(
  {
    saleNumber: { type: String, required: true, unique: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    items: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
        quantity: { type: Number, required: true, min: 1 },
        unitPrice: { type: Number, required: true, min: 0 },
      },
    ],
    totalAmount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['completed', 'pending', 'canceled'], default: 'completed' },
    paymentMethod: { type: String, enum: ['cash', 'card', 'credit'], default: 'cash' },
    customerName: { type: String, trim: true },
    customerPhone: { type: String, trim: true },
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

saleSchema.virtual('displayName').get(function () {
  return this.saleNumber;
});

saleSchema.index({ branch: 1, createdAt: -1 });
saleSchema.index({ saleNumber: 1 });

module.exports = mongoose.model('Sale', saleSchema);