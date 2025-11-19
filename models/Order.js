const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    unique: true,
    required: true,
    trim: true,
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
  },
  items: [{
    _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
    },
    receivedQuantity: {
      type: Number,
      default: 0,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ['pending', 'assigned', 'in_progress', 'completed', 'rejected'],
      default: 'pending',
    },
    rejected: {
      type: Boolean,
      default: false,
    },
    rejectReason: {
      type: String,
      enum: ['تالف', 'لم يصل', 'نفاد المخزون', 'غير متاح', 'أخرى', ''],
      default: 'أخرى',
      trim: true,
    },
    rejectReasonEn: {
      type: String,
      enum: ['Damaged', 'Not Delivered', 'Out of Stock', 'Not Available', 'Other', ''],
      default: 'Other',
      trim: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    startedAt: { type: Date },
    completedAt: { type: Date },
  }],
  total: {
    type: Number,
    required: true,
    min: 0,
  },
  adjustedTotal: {
    type: Number,
    default: 0,
    min: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'in_production', 'completed', 'in_transit', 'delivered', 'cancelled'],
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
    trim: true,
  },
  requestedDeliveryDate: {
    type: Date,
    required: false,
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
  confirmedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedAt: { type: Date },
  deliveredAt: { type: Date },
  transitStartedAt: { type: Date },
  statusHistory: [{
    status: String,
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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
    changedAt: {
      type: Date,
      default: Date.now,
    },
  }],
}, {
  timestamps: true,
});

// Mapping للترجمة التلقائية لأسباب الرفض
const rejectReasonMapping = {
  'تالف': 'Damaged',
  'لم يصل': 'Not Delivered',
  'نفاد المخزون': 'Out of Stock',
  'غير متاح': 'Not Available',
  'أخرى': 'Other',
  '': ''
};

// تعبئة الحقل الإنجليزي تلقائيًا
orderSchema.pre('save', function(next) {
  this.items.forEach(item => {
    item.rejectReasonEn = rejectReasonMapping[item.rejectReason] || '';
  });
  next();
});

// Virtuals للعرض الذكي
orderSchema.virtual('displayNotes').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.notes || 'غير محدد') : (this.notesEn || this.notes || 'N/A');
});

orderSchema.virtual('items.$*.displayRejectReason').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl
    ? (this.rejectReason || 'غير محدد')
    : (this.rejectReasonEn || this.rejectReason || 'N/A');
});

orderSchema.virtual('statusHistory.$*.displayNotes').get(function() {
  const isRtl = this.options?.context?.isRtl ?? true;
  return isRtl ? (this.notes || 'غير محدد') : (this.notesEn || this.notes || 'N/A');
});

// الحسابات + تحديث الحالة تلقائيًا
orderSchema.pre('save', async function(next) {
  try {
    // تصفية العناصر غير الصالحة
    this.items = this.items.filter(item => item.quantity > 0 && item.product);

    // ضمان القيم الافتراضية
    this.items.forEach(item => {
      item.quantity = item.quantity || 0;
      item.receivedQuantity = item.receivedQuantity || 0;
    });

    // تحديث حالة العنصر بناءً على التخصيص أو الرفض
    this.items.forEach(item => {
      if (item.assignedTo && item.status === 'pending' && !item.rejected) {
        item.status = 'assigned';
      }
      if (item.rejected) {
        item.status = 'rejected';
      }
    });

    // حساب الإجمالي الأصلي (الكمية المطلوبة)
    this.total = this.items.reduce((sum, item) => {
      return item.rejected ? sum : sum + (item.quantity * item.price);
    }, 0);

    // حساب الإجمالي الفعلي بعد التسليم (الكمية المستلمة فقط)
    this.adjustedTotal = this.items.reduce((sum, item) => {
      return item.rejected ? sum : sum + (item.receivedQuantity * item.price);
    }, 0);

    // تحديث حالة الطلب تلقائيًا
    if (this.isModified('items')) {
      const allDone = this.items.every(i => i.status === 'completed' || i.status === 'rejected');

      if (allDone && !['completed', 'in_transit', 'delivered'].includes(this.status)) {
        this.status = 'completed';
        this.statusHistory.push({
          status: 'completed',
          changedBy: this.approvedBy || this.createdBy,
          changedAt: new Date(),
        });
      }

      if (this.items.every(i => i.rejected)) {
        this.status = 'cancelled';
        this.statusHistory.push({
          status: 'cancelled',
          changedBy: this.approvedBy || this.createdBy,
          notes: 'جميع العناصر مرفوضة',
          notesEn: 'All items rejected',
          changedAt: new Date(),
        });
      }
    }

    // الانتقال إلى in_production إذا كان هناك عنصر في التنفيذ
    if (this.isModified('items') && this.status === 'approved') {
      const hasInProgress = this.items.some(i => i.status === 'in_progress' && !i.rejected);
      if (hasInProgress && this.status !== 'in_production') {
        this.status = 'in_production';
        this.statusHistory.push({
          status: 'in_production',
          changedBy: this.approvedBy || this.createdBy,
          changedAt: new Date(),
        });
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

// الفهرسة
orderSchema.index({ orderNumber: 1, branch: 1 });
orderSchema.index({ 'items.rejectReasonEn': 1 });

// تفعيل الـ virtuals في الاستعلامات والـ JSON
orderSchema.set('toJSON', { virtuals: true });
orderSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Order', orderSchema);