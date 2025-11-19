const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth, authorize, getPermissions } = require('../middleware/auth');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const Return = require('../models/Return');
const Sale = require('../models/Sale');
const User = require('../models/User');
const ProductionAssignment = require('../models/ProductionAssignment');

const isValidObjectId = (id) => mongoose.isValidObjectId(id);

// Middleware to ensure authentication and authorization
router.use(auth);
router.use(authorize(['admin', 'branch', 'chef', 'production']));

// Middleware to check specific permissions
const requirePermission = (permission) => (req, res, next) => {
  if (!req.user.permissions.includes(permission)) {
    console.error(`[${new Date().toISOString()}] Permission denied: ${permission} required for ${req.user.id} (${req.user.role})`);
    return res.status(403).json({ success: false, message: 'غير مصرح لك بالوصول' });
  }
  next();
};

// Dashboard Statistics
router.get('/', async (req, res) => {
  try {
    const { period, branchId } = req.query;
    let query = {};
    if (req.user.role === 'branch') {
      query = { branch: req.user.branchId };
    } else if (branchId && isValidObjectId(branchId)) {
      query = { branch: branchId };
    }

    const todayStart = new Date().setHours(0, 0, 0, 0);
    const todayQuery = { ...query, createdAt: { $gte: new Date(todayStart) } };

    if (period === 'today') {
      query = todayQuery;
    }

    const [
      totalOrders,
      dailyOrders,
      totalSales,
      dailySales,
      lowStockItems,
      pendingReturns,
      activeChefs,
      totalTasks,
      completedTasks,
      inProgressTasks,
      inProduction,
      completedToday,
      pendingReviews,
      activeProducts,
    ] = await Promise.all([
      Order.countDocuments(query),
      Order.countDocuments(todayQuery),
      Sale.aggregate([
        { $match: query },
        { $group: { _id: null, totalAmount: { $sum: '$totalAmount' } } },
      ]),
      Sale.aggregate([
        { $match: todayQuery },
        { $group: { _id: null, totalAmount: { $sum: '$totalAmount' } } },
      ]),
      Inventory.countDocuments({ ...query, currentStock: { $lte: '$minStockLevel' } }),
      Return.countDocuments({ ...query, status: 'pending_approval' }),
      User.countDocuments({ role: 'chef', isActive: true }),
      ProductionAssignment.countDocuments(req.user.role === 'chef' ? { chef: req.user.id } : query),
      ProductionAssignment.countDocuments({
        ...(req.user.role === 'chef' ? { chef: req.user.id } : query),
        status: 'completed',
      }),
      ProductionAssignment.countDocuments({
        ...(req.user.role === 'chef' ? { chef: req.user.id } : query),
        status: 'in_progress',
      }),
      Order.countDocuments({ ...query, status: 'in_production' }),
      Order.countDocuments({ ...todayQuery, status: 'completed' }),
      Return.countDocuments({ ...query, status: 'pending_approval' }),
      Product.countDocuments({ isActive: true }),
    ]);

    const stats = {
      totalOrders,
      dailyOrders,
      totalSales: totalSales[0]?.totalAmount || 0,
      dailySales: dailySales[0]?.totalAmount || 0,
      lowStockItems,
      pendingReturns,
      activeChefs,
      totalTasks,
      completedTasks,
      inProgressTasks,
      inProduction,
      completedToday,
      pendingReviews,
      activeProducts,
      ordersGrowth: dailyOrders > 0 ? ((dailyOrders / (totalOrders || 1)) * 100) : 0,
      productsGrowth: 0, // Placeholder for future implementation
      revenueGrowth: dailySales[0]?.totalAmount && totalSales[0]?.totalAmount ? ((dailySales[0].totalAmount / totalSales[0].totalAmount) * 100) : 0,
      returnsGrowth: pendingReturns > 0 ? ((pendingReturns / (totalOrders || 1)) * 100) : 0,
    };

    console.log(`[${new Date().toISOString()}] Dashboard stats fetched:`, {
      userId: req.user.id,
      role: req.user.role,
      branchId: req.user.branchId,
      stats,
    });

    res.status(200).json(stats);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching dashboard stats:`, {
      error: err.message,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// Recent Orders
router.get('/recent-orders', async (req, res) => {
  try {
    const { limit = 5, branchId } = req.query;
    let query = {};
    if (req.user.role === 'branch') {
      query = { branch: req.user.branchId };
    } else if (branchId && isValidObjectId(branchId)) {
      query = { branch: branchId };
    }

    const orders = await Order.find({ ...query, status: { $in: ['pending', 'in_progress', 'in_transit'] } })
      .populate('branch', 'name')
      .populate({
        path: 'items.product',
        select: 'name price unit',
      })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    const formattedOrders = orders.map(order => ({
      _id: order._id.toString(),
      orderNumber: order.orderNumber || order._id.toString(),
      branchName: order.branch?.name || 'غير محدد',
      itemsCount: order.items?.length || 0,
      totalAmount: order.adjustedTotal || 0,
      status: order.status,
      createdAt: new Date(order.createdAt).toISOString(),
    }));

    console.log(`[${new Date().toISOString()}] Recent orders fetched:`, {
      count: formattedOrders.length,
      userId: req.user.id,
      role: req.user.role,
      branchId: req.user.branchId,
    });

    res.status(200).json({ data: formattedOrders });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching recent orders:`, {
      error: err.message,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// Branch Performance
router.get('/branches-performance', requirePermission('view_reports'), async (req, res) => {
  try {
    const query = req.user.role === 'branch' ? { _id: req.user.branchId } : {};
    const branches = await Branch.find(query).select('name').lean();
    const branchIds = branches.map(branch => branch._id);

    const performance = await Promise.all(
      branchIds.map(async (branchId) => {
        const [orderCount, salesTotal, lowStockCount] = await Promise.all([
          Order.countDocuments({ branch: branchId }),
          Sale.aggregate([
            { $match: { branch: branchId } },
            { $group: { _id: null, totalAmount: { $sum: '$totalAmount' } } },
          ]),
          Inventory.countDocuments({ branch: branchId, currentStock: { $lte: '$minStockLevel' } }),
        ]);

        // Calculate performance as a percentage
        const maxOrders = 200; // Example max value for normalization
        const performance = Math.min((orderCount / maxOrders) * 100, 100);

        return {
          _id: branchId.toString(),
          name: branches.find(b => b._id.toString() === branchId.toString())?.name || 'غير محدد',
          orderCount,
          salesTotal: salesTotal[0]?.totalAmount || 0,
          lowStockCount,
          performance: Number(performance.toFixed(2)),
        };
      })
    );

    console.log(`[${new Date().toISOString()}] Branch performance fetched:`, {
      count: performance.length,
      userId: req.user.id,
      role: req.user.role,
      branchId: req.user.branchId,
    });

    res.status(200).json(performance);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching branch performance:`, {
      error: err.message,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// Pending Reviews (Returns)
router.get('/pending-reviews', requirePermission('manage_orders'), async (req, res) => {
  try {
    const query = req.user.role === 'branch' ? { branch: req.user.branchId, status: 'pending_approval' } : { status: 'pending_approval' };
    const returns = await Return.find(query)
      .populate('order', 'orderNumber')
      .populate({
        path: 'items.product',
        select: 'name price unit',
      })
      .populate('branch', 'name')
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const formattedReturns = returns.map(returnDoc => ({
      _id: returnDoc._id.toString(),
      orderNumber: returnDoc.order?.orderNumber || returnDoc._id.toString(),
      branchName: returnDoc.branch?.name || 'غير محدد',
      itemsCount: returnDoc.items?.length || 0,
      status: returnDoc.status,
      createdAt: new Date(returnDoc.createdAt).toISOString(),
    }));

    console.log(`[${new Date().toISOString()}] Pending reviews fetched:`, {
      count: formattedReturns.length,
      userId: req.user.id,
      role: req.user.role,
      branchId: req.user.branchId,
    });

    res.status(200).json({ returns: formattedReturns, total: formattedReturns.length });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching pending reviews:`, {
      error: err.message,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// Top Products
router.get('/top-products', async (req, res) => {
  try {
    const { branchId } = req.query;
    let query = {};
    if (req.user.role === 'branch') {
      query = { branch: req.user.branchId };
    } else if (branchId && isValidObjectId(branchId)) {
      query = { branch: branchId };
    }

    const topProducts = await Sale.aggregate([
      { $match: query },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          totalQuantity: { $sum: '$items.quantity' },
          totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
        },
      },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'product',
        },
      },
      { $unwind: '$product' },
      {
        $project: {
          _id: '$_id',
          name: '$product.name',
          totalQuantity: 1,
          totalRevenue: 1,
        },
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 5 },
    ]);

    console.log(`[${new Date().toISOString()}] Top products fetched:`, {
      count: topProducts.length,
      userId: req.user.id,
      role: req.user.role,
      branchId: req.user.branchId || branchId,
    });

    res.status(200).json(topProducts);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching top products:`, {
      error: err.message,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// Chef Performance
router.get('/chefs-performance', requirePermission('view_reports'), async (req, res) => {
  try {
    const query = req.user.role === 'branch' ? { branch: req.user.branchId } : {};
    const chefPerformance = await ProductionAssignment.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$chef',
          totalTasks: { $sum: 1 },
          completedTasks: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          totalQuantity: { $sum: '$quantity' },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $lookup: {
          from: 'departments',
          localField: 'user.department',
          foreignField: '_id',
          as: 'department',
        },
      },
      { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: '$user._id',
          name: '$user.username',
          department: '$department.name',
          totalTasks: 1,
          completedTasks: 1,
          totalQuantity: 1,
          completionRate: {
            $cond: [
              { $eq: ['$totalTasks', 0] },
              0,
              { $multiply: [{ $divide: ['$completedTasks', '$totalTasks'] }, 100] },
            ],
          },
        },
      },
      { $sort: { completedTasks: -1 } },
      { $limit: 5 },
    ]);

    console.log(`[${new Date().toISOString()}] Chef performance fetched:`, {
      count: chefPerformance.length,
      userId: req.user.id,
      role: req.user.role,
      branchId: req.user.branchId,
    });

    res.status(200).json(chefPerformance);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef performance:`, {
      error: err.message,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

// Chef Tasks
router.get('/chef-tasks/:chefId', async (req, res) => {
  try {
    const { chefId } = req.params;
    if (!isValidObjectId(chefId)) {
      return res.status(400).json({ success: false, message: 'معرف الشيف غير صالح' });
    }
    if (req.user.role === 'chef' && req.user.id !== chefId) {
      return res.status(403).json({ success: false, message: 'غير مصرح لك بمشاهدة مهام شيف آخر' });
    }
    const query = { chef: chefId };
    if (req.user.role === 'branch' && req.user.branchId) {
      query.branch = req.user.branchId;
    }
    const tasks = await ProductionAssignment.find(query)
      .populate('order', 'orderNumber')
      .populate('product', 'name')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const formattedTasks = tasks.map(task => ({
      _id: task._id.toString(),
      orderId: task.order?._id.toString(),
      orderNumber: task.order?.orderNumber || task._id.toString(),
      productName: task.product?.name || 'غير محدد',
      quantity: task.quantity,
      status: task.status,
      description: task.product?.name || 'لا يوجد وصف',
      createdAt: new Date(task.createdAt).toISOString(),
    }));

    console.log(`[${new Date().toISOString()}] Chef tasks fetched:`, {
      count: tasks.length,
      chefId,
      userId: req.user.id,
      role: req.user.role,
      branchId: req.user.branchId,
    });

    res.status(200).json(formattedTasks);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error fetching chef tasks:`, {
      error: err.message,
      chefId: req.params.chefId,
      userId: req.user.id,
      role: req.user.role,
    });
    res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
  }
});

module.exports = router;
