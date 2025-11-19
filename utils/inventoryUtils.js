const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const InventoryHistory = require('../models/InventoryHistory');

const updateInventoryStock = async ({
  branch,
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
}) => {
  try {
    if (!mongoose.isValidObjectId(branch) || !mongoose.isValidObjectId(product) || !mongoose.isValidObjectId(createdBy)) {
      throw new Error('Invalid branch, product, or user ID');
    }

    const inventory = await Inventory.findOne({ branch, product }).session(session);
    if (!inventory) {
      const newInventory = new Inventory({
        product,
        branch,
        createdBy,
        minStockLevel: 0,
        maxStockLevel: 1000,
        currentStock: 0,
        pendingReturnStock: 0,
        damagedStock: 0,
      });
      await newInventory.save({ session });
    }

    const currentInventory = await Inventory.findOne({ branch, product }).session(session);

    const updates = {
      $inc: {
        currentStock: isPending ? -quantity : type === 'return_rejected' ? quantity : 0,
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

    const updatedInventory = await Inventory.findOneAndUpdate(
      { branch, product, __v: currentInventory.__v },
      updates,
      { new: true, session }
    );

    if (!updatedInventory) {
      throw new Error('Failed to update inventory due to version conflict');
    }

    if (updatedInventory.currentStock < 0 || updatedInventory.pendingReturnStock < 0 || updatedInventory.damagedStock < 0) {
      throw new Error('Stock cannot be negative');
    }

    const historyEntry = new InventoryHistory({
      product,
      branch,
      action: type,
      quantity: type === 'return_rejected' ? quantity : -quantity,
      reference,
      referenceType,
      referenceId,
      createdBy,
      notes,
      createdAt: new Date(),
    });
    await historyEntry.save({ session });

    console.log(`[${new Date().toISOString()}] Inventory updated:`, {
      product,
      branch,
      type,
      quantity,
      currentStock: updatedInventory.currentStock,
      pendingReturnStock: updatedInventory.pendingReturnStock,
      damagedStock: updatedInventory.damagedStock,
    });

    return updatedInventory;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error updating inventory stock:`, {
      message: error.message,
      stack: error.stack,
      branch,
      product,
      type,
      quantity,
    });
    throw error;
  }
};

module.exports = { updateInventoryStock };