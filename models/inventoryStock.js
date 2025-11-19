const mongoose = require('mongoose');
const FactoryInventory = require('../models/FactoryInventory');

const updateInventoryStock = async ({ product, quantity, type, reference, referenceType, referenceId, createdBy, session }) => {
  try {
    if (!mongoose.isValidObjectId(product)) {
      throw new Error('Invalid product ID');
    }
    if (quantity < 0) {
      throw new Error('Quantity cannot be negative');
    }

    const inventory = await FactoryInventory.findOne({ product }).session(session);
    if (!inventory) {
      throw new Error('Inventory record not found');
    }

    let update = {};
    switch (type) {
      case 'in':
        update.$inc = { currentStock: quantity };
        break;
      case 'out':
        if (inventory.currentStock < quantity) {
          throw new Error('Insufficient stock');
        }
        update.$inc = { currentStock: -quantity };
        break;
      case 'production':
        update.$inc = { pendingProductionStock: -quantity, currentStock: quantity };
        break;
      default:
        throw new Error('Invalid movement type');
    }

    update.$push = {
      movements: {
        type,
        quantity,
        reference,
        referenceType,
        referenceId,
        createdBy,
        createdAt: new Date(),
      },
    };

    await FactoryInventory.findOneAndUpdate({ product }, update, { new: true, session });

    return { success: true };
  } catch (error) {
    throw new Error(`Failed to update inventory: ${error.message}`);
  }
};

module.exports = { updateInventoryStock };