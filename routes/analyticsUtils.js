const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Return = require('../models/Return');

// دالة لتحويل بيانات المبيعات بناءً على اللغة
const transformSaleData = (sale, isRtl) => {
  return {
    ...sale,
    orderNumber: sale.saleNumber,
    branch: sale.branch
      ? {
          ...sale.branch,
          displayName: isRtl ? sale.branch.name : (sale.branch.nameEn || sale.branch.name || 'Unknown'),
        }
      : undefined,
    items: (sale.items || []).map((item) => ({
      ...item,
      productName: item.product?.name || 'منتج محذوف',
      productNameEn: item.product?.nameEn || null,
      displayName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
      displayUnit: isRtl ? (item.product?.unit || 'غير محدد') : (item.product?.unitEn || item.product?.unit || 'N/A'),
      department: item.product?.department
        ? {
            ...item.product.department,
            displayName: isRtl ? item.product.department.name : (item.product.department.nameEn || item.product.department.name || 'Unknown'),
          }
        : undefined,
    })),
    createdAt: sale.createdAt.toISOString(),
    status: sale.status,
    paymentMethod: sale.paymentMethod,
    customerName: sale.customerName,
    customerPhone: sale.customerPhone,
    notes: sale.notes,
    createdBy: sale.createdBy?.username || 'Unknown',
    returns: (sale.returns || []).map((ret) => ({
      _id: ret._id,
      returnNumber: ret.returnNumber,
      status: ret.status,
      items: (ret.items || []).map((item) => ({
        product: item.product?._id || item.product,
        productName: isRtl ? (item.product?.name || 'منتج محذوف') : (item.product?.nameEn || item.product?.name || 'Deleted Product'),
        productNameEn: item.product?.nameEn || null,
        quantity: item.quantity,
        reason: item.reason,
      })),
      reason: ret.reason,
      createdAt: ret.createdAt.toISOString(),
    })),
  };
};

// دالة لجلب إحصائيات المبيعات
const getSalesAnalytics = async (query, isRtl, limit = 10) => {
  const totalSales = await Sale.aggregate([
    { $match: query },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$totalAmount' },
        totalCount: { $sum: 1 },
      },
    },
  ]).catch(() => [{ totalSales: 0, totalCount: 0 }]);

  const branchSales = await Sale.aggregate([
    { $match: query },
    {
      $group: {
        _id: '$branch',
        totalSales: { $sum: '$totalAmount' },
        saleCount: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'branches',
        localField: '_id',
        foreignField: '_id',
        as: 'branch',
      },
    },
    { $unwind: '$branch' },
    {
      $project: {
        branchId: '$_id',
        branchName: '$branch.name',
        branchNameEn: '$branch.nameEn',
        displayName: isRtl ? '$branch.name' : { $ifNull: ['$branch.nameEn', '$branch.name', 'Unknown'] },
        totalSales: 1,
        saleCount: 1,
      },
    },
    { $sort: { totalSales: -1 } },
    { $limit },
  ]).catch(() => []);

  const leastBranchSales = await Sale.aggregate([
    { $match: query },
    {
      $group: {
        _id: '$branch',
        totalSales: { $sum: '$totalAmount' },
        saleCount: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'branches',
        localField: '_id',
        foreignField: '_id',
        as: 'branch',
      },
    },
    { $unwind: '$branch' },
    {
      $project: {
        branchId: '$_id',
        branchName: '$branch.name',
        branchNameEn: '$branch.nameEn',
        displayName: isRtl ? '$branch.name' : { $ifNull: ['$branch.nameEn', '$branch.name', 'Unknown'] },
        totalSales: 1,
        saleCount: 1,
      },
    },
    { $sort: { totalSales: 1 } },
    { $limit },
  ]).catch(() => []);

  const productSales = await Sale.aggregate([
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
        pipeline: [{ $project: { name: 1, nameEn: 1 } }],
      },
    },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        productId: '$_id',
        productName: { $ifNull: ['$product.name', 'منتج محذوف'] },
        productNameEn: '$product.nameEn',
        displayName: isRtl ? { $ifNull: ['$product.name', 'منتج محذوف'] } : { $ifNull: ['$product.nameEn', '$product.name', 'Deleted Product'] },
        totalQuantity: 1,
        totalRevenue: 1,
      },
    },
    { $sort: { totalQuantity: -1 } },
    { $limit },
  ]).catch(() => []);

  const leastProductSales = await Sale.aggregate([
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
        pipeline: [{ $project: { name: 1, nameEn: 1 } }],
      },
    },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        productId: '$_id',
        productName: { $ifNull: ['$product.name', 'منتج محذوف'] },
        productNameEn: '$product.nameEn',
        displayName: isRtl ? { $ifNull: ['$product.name', 'منتج محذوف'] } : { $ifNull: ['$product.nameEn', '$product.name', 'Deleted Product'] },
        totalQuantity: 1,
        totalRevenue: 1,
      },
    },
    { $sort: { totalQuantity: 1 } },
    { $limit },
  ]).catch(() => []);

  const departmentSales = await Sale.aggregate([
    { $match: query },
    { $unwind: '$items' },
    {
      $lookup: {
        from: 'products',
        localField: 'items.product',
        foreignField: '_id',
        as: 'product',
        pipeline: [{ $project: { department: 1, name: 1, nameEn: 1 } }],
      },
    },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: '$product.department',
        totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
        totalQuantity: { $sum: '$items.quantity' },
      },
    },
    {
      $lookup: {
        from: 'departments',
        localField: '_id',
        foreignField: '_id',
        as: 'department',
        pipeline: [{ $project: { name: 1, nameEn: 1 } }],
      },
    },
    { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        departmentId: '$_id',
        departmentName: { $ifNull: ['$department.name', 'غير معروف'] },
        departmentNameEn: '$department.nameEn',
        displayName: isRtl ? { $ifNull: ['$department.name', 'غير معروف'] } : { $ifNull: ['$department.nameEn', '$department.name', 'Unknown'] },
        totalRevenue: 1,
        totalQuantity: 1,
      },
    },
    { $sort: { totalRevenue: -1 } },
    { $limit },
  ]).catch(() => []);

  const leastDepartmentSales = await Sale.aggregate([
    { $match: query },
    { $unwind: '$items' },
    {
      $lookup: {
        from: 'products',
        localField: 'items.product',
        foreignField: '_id',
        as: 'product',
        pipeline: [{ $project: { department: 1, name: 1, nameEn: 1 } }],
      },
    },
    { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: '$product.department',
        totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.unitPrice'] } },
        totalQuantity: { $sum: '$items.quantity' },
      },
    },
    {
      $lookup: {
        from: 'departments',
        localField: '_id',
        foreignField: '_id',
        as: 'department',
        pipeline: [{ $project: { name: 1, nameEn: 1 } }],
      },
    },
    { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        departmentId: '$_id',
        departmentName: { $ifNull: ['$department.name', 'غير معروف'] },
        departmentNameEn: '$department.nameEn',
        displayName: isRtl ? { $ifNull: ['$department.name', 'غير معروف'] } : { $ifNull: ['$department.nameEn', '$department.name', 'Unknown'] },
        totalRevenue: 1,
        totalQuantity: 1,
      },
    },
    { $sort: { totalRevenue: 1 } },
    { $limit },
  ]).catch(() => []);

  const dateFormat = query.createdAt?.$gte && query.createdAt?.$lte && 
    (new Date(query.createdAt.$lte) - new Date(query.createdAt.$gte)) / (1000 * 60 * 60 * 24) > 30 ? 'month' : 'day';
  const salesTrends = await Sale.aggregate([
    { $match: query },
    {
      $group: {
        _id: {
          $dateToString: {
            format: dateFormat === 'month' ? '%Y-%m' : '%Y-%m-%d',
            date: '$createdAt',
          },
        },
        totalSales: { $sum: '$totalAmount' },
        saleCount: { $sum: 1 },
      },
    },
    {
      $project: {
        period: '$_id',
        totalSales: 1,
        saleCount: 1,
        _id: 0,
      },
    },
    { $sort: { period: 1 } },
  ]).catch(() => []);

  const topCustomers = await Sale.aggregate([
    { $match: { ...query, customerName: { $ne: null, $ne: '' } } },
    {
      $group: {
        _id: { name: '$customerName', phone: '$customerPhone' },
        totalSpent: { $sum: '$totalAmount' },
        purchaseCount: { $sum: 1 },
      },
    },
    {
      $project: {
        customerName: '$_id.name',
        customerPhone: '$_id.phone',
        totalSpent: 1,
        purchaseCount: 1,
        _id: 0,
      },
    },
    { $sort: { totalSpent: -1 } },
    { $limit: 5 },
  ]).catch(() => []);

  const returnStats = await Return.aggregate([
    { $match: query },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalQuantity: { $sum: { $sum: '$items.quantity' } },
      },
    },
    {
      $project: {
        status: '$_id',
        count: 1,
        totalQuantity: 1,
        _id: 0,
      },
    },
  ]).catch(() => []);

  const topProduct = productSales.length > 0
    ? productSales[0]
    : {
        productId: null,
        productName: isRtl ? 'غير معروف' : 'Unknown',
        productNameEn: null,
        displayName: isRtl ? 'غير معروف' : 'Unknown',
        totalQuantity: 0,
        totalRevenue: 0,
      };

  return {
    totalSales: totalSales[0]?.totalSales || 0,
    totalCount: totalSales[0]?.totalCount || 0,
    averageOrderValue: totalSales[0]?.totalCount ? (totalSales[0].totalSales / totalSales[0].totalCount).toFixed(2) : '0.00',
    returnRate: totalSales[0]?.totalCount ? ((returnStats.reduce((sum, stat) => sum + stat.count, 0) / totalSales[0].totalCount) * 100).toFixed(2) : '0.00',
    topProduct,
    branchSales,
    leastBranchSales,
    productSales,
    leastProductSales,
    departmentSales,
    leastDepartmentSales,
    salesTrends,
    topCustomers,
    returnStats,
  };
};

module.exports = { transformSaleData, getSalesAnalytics };