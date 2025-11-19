const mongoose = require('mongoose');
const FactoryInventory = require('../models/FactoryInventory');
const FactoryInventoryHistory = require('../models/FactoryInventoryHistory');
const Product = require('../models/Product');
const { updateInventoryStock } = require('./inventoryUtils');

const updateFactoryStock = async ({
  product,
  quantity,
  type,
  reference,
  referenceType,
  referenceId,
  createdBy,
  session,
  notes = '',
  isDamaged = false,
  isPending = false,
  branchId = null,
}) => {
  try {
    if (!mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(createdBy)) {
      throw new Error('معرف المنتج أو المستخدم غير صالح');
    }

    let inventory = await FactoryInventory.findOne({ product }).session(session);
    if (!inventory) {
      inventory = new FactoryInventory({
        product,
        createdBy,
        minStockLevel: 0,
        maxStockLevel: 1000,
        currentStock: 0,
        pendingReturnStock: 0,
        damagedStock: 0,
      });
      await inventory.save({ session });
    }

    // التحقق من تاريخ الصلاحية إذا كان خصم
    if (quantity < 0 && inventory.expirationDate && new Date() > inventory.expirationDate) {
      await FactoryInventory.findOneAndUpdate(
        { product },
        { $inc: { damagedStock: -quantity, currentStock: -(-quantity) } },
        { session }
      );
      isDamaged = true;
    }

    const updates = {
      $inc: {
        currentStock: isPending ? -quantity : type === 'return_rejected' ? quantity : (quantity > 0 ? quantity : -quantity),
        pendingReturnStock: isPending ? quantity : type === 'return_approved' || type === 'return_rejected' ? -quantity : 0,
        damagedStock: isDamaged ? quantity : 0,
        __v: 1,
      },
      $push: {
        movements: {
          type: quantity > 0 ? 'in' : 'out',
          quantity: Math.abs(quantity),
          reference,
          createdBy,
          createdAt: new Date(),
        },
      },
    };

    const updatedInventory = await FactoryInventory.findOneAndUpdate(
      { product, __v: inventory.__v },
      updates,
      { new: true, session }
    );

    if (!updatedInventory) {
      throw new Error('فشل تحديث مخزون المصنع بسبب تعارض الإصدار');
    }

    if (updatedInventory.currentStock < 0 || updatedInventory.pendingReturnStock < 0 || updatedInventory.damagedStock < 0) {
      throw new Error('الكميات لا يمكن أن تكون سالبة');
    }

    // إضافة تاريخ الصلاحية عند الإنتاج
    if (type === 'produced') {
      const productData = await Product.findById(product).session(session);
      if (productData.shelfLife) {
        updatedInventory.expirationDate = new Date(Date.now() + productData.shelfLife * 24 * 60 * 60 * 1000);
        await updatedInventory.save({ session });
      }
    }

    const historyEntry = new FactoryInventoryHistory({
      product,
      action: type,
      quantity: quantity > 0 ? quantity : -quantity,
      reference,
      referenceType,
      referenceId,
      createdBy,
      notes,
      isDamaged,
      createdAt: new Date(),
    });
    await historyEntry.save({ session });

    // ربط مع الفروع إذا كان شحن
    if (branchId && type === 'deducted_for_branch') {
      await updateInventoryStock({
        branch: branchId,
        product,
        quantity: Math.abs(quantity),
        type: 'delivery',
        reference: `شحن من المصنع: ${reference}`,
        referenceType,
        referenceId,
        createdBy,
        session,
      });
    }

    return updatedInventory;
  } catch (error) {
    throw error;
  }
};

module.exports = { updateFactoryStock };