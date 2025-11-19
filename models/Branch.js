const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  nameEn: { type: String, trim: true, required: false },
  code: { type: String, required: true, unique: true, trim: true },
  address: { type: String, required: true, trim: true },
  addressEn: { type: String, trim: true, required: false },
  city: { type: String, required: true, trim: true },
  cityEn: { type: String, trim: true, required: false },
  phone: { type: String, trim: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

branchSchema.virtual('displayName').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.name : (this.nameEn || this.name);
});

branchSchema.virtual('displayAddress').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.address : (this.addressEn || this.address);
});

branchSchema.virtual('displayCity').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? this.city : (this.cityEn || this.city);
});

branchSchema.set('toJSON', { virtuals: true });
branchSchema.set('toObject', { virtuals: true });

module.exports = mongoose.models.Branch || mongoose.model('Branch', branchSchema);