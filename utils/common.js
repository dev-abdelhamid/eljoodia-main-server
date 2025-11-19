const mongoose = require('mongoose');
const User = require('../models/User');

const isValidObjectId = (id) => {
  return mongoose.isValidObjectId(id);
};

const validateStatusTransition = (currentStatus, newStatus) => {
  const validTransitions = {
    pending: ['confirmed', 'cancelled'],
    confirmed: ['inProduction', 'cancelled'],
    inProduction: ['completed', 'shipped', 'cancelled'],
    shipped: ['delivered', 'inTransit'],
    inTransit: ['delivered', 'branchConfirmed'],
    branchConfirmed: ['delivered'],
    delivered: [],
    cancelled: [],
  };
  return validTransitions[currentStatus]?.includes(newStatus) || false;
};

const emitSocketEvent = (io, event, data, rooms = []) => {
  try {
    const baseUrl = process.env.CLIENT_URL || 'https://eljoodia-client.vercel.app';
    const eventData = {
      ...data,
      sound: `${baseUrl}/sounds/notification.mp3`,
      vibrate: [200, 100, 200],
      timestamp: new Date().toISOString(),
    };
    rooms.forEach((room) => {
      io.to(room).emit(event, eventData);
      console.log(`[${new Date().toISOString()}] Socket event emitted: ${event} to room: ${room}`, eventData);
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error emitting socket event:`, {
      event,
      error: err.message,
      stack: err.stack,
    });
  }
};

const notifyUsers = async (io, roles, branchId, chefId, departmentId, event, data) => {
  try {
    const query = {};
    if (roles && roles.length > 0) query.role = { $in: roles };
    if (branchId && isValidObjectId(branchId)) query.branch = branchId;
    if (chefId && isValidObjectId(chefId)) query._id = chefId;
    if (departmentId && isValidObjectId(departmentId)) query.department = departmentId;

    const users = await User.find(query).select('_id role branch department').lean();
    const rooms = new Set();
    users.forEach((user) => {
      rooms.add(`user-${user._id}`);
      if (user.role === 'admin') rooms.add('admin');
      if (user.role === 'production') rooms.add('production');
      if (user.role === 'branch' && user.branch) rooms.add(`branch-${user.branch}`);
      if (user.role === 'chef' && user._id) rooms.add(`chef-${user._id}`);
    });

    emitSocketEvent(io, event, data, Array.from(rooms));
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error notifying users:`, {
      event,
      error: err.message,
      stack: err.stack,
    });
  }
};

module.exports = { isValidObjectId, validateStatusTransition, emitSocketEvent, notifyUsers };