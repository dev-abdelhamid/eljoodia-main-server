const ItemStatus = {
  Pending: 'pending',
  Approved: 'approved',
  Assigned: 'assigned',
  InProduction: 'in_production',
  Completed: 'completed',
  InTransit: 'in_transit',
  Delivered: 'delivered',
  Cancelled: 'cancelled',
};

const NotificationType = {
  NewOrderFromBranch: 'new_order_from_branch',
  OrderApprovedForBranch: 'order_approved_for_branch',
  NewProductionAssignedToChef: 'new_production_assigned_to_chef',
  OrderCompletedByChefs: 'order_completed_by_chefs',
  OrderInTransitToBranch: 'order_in_transit_to_branch',
  OrderDelivered: 'order_delivered',
  BranchConfirmedReceipt: 'branch_confirmed_receipt',
  ReturnStatusUpdated: 'return_status_updated',
  OrderStatusUpdated: 'order_status_updated',
  TaskAssigned: 'task_assigned',
  TaskCompleted: 'task_completed',
  MissingAssignments: 'missing_assignments',
};

module.exports = { ItemStatus, NotificationType };