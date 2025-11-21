const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
require('dotenv').config();
const mongoose = require('mongoose');

let compression;
try {
  compression = require('compression');
} catch (err) {
  console.warn(`[${new Date().toISOString()}] Compression module not found. Skipping.`);
}

const connectDB = require('./config/database');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const dashboardRoutes = require('./routes/dashboard');
const orderRoutes = require('./routes/orders');
const productRoutes = require('./routes/products');
const branchRoutes = require('./routes/branches');
const chefRoutes = require('./routes/chefs');
const departmentRoutes = require('./routes/departments');
const returnRoutes = require('./routes/returns');
const inventoryRoutes = require('./routes/Inventory');
const factoryRoutes = require('./routes/factoryInventory');
const factoryOrderRoutes = require('./routes/factoryOrders');
const salesRoutes = require('./routes/sales');
const notificationsRoutes = require('./routes/notifications');
const { setupNotifications } = require('./utils/notifications');

const app = express();
const server = http.createServer(app);

// مهم جدًا للـ reverse proxy (Caddy أو Nginx)
app.set('trust proxy', 1);

// قائمة المصادر المسموحة (الفرونت من هوستينجر + localhost للتطوير)
const allowedOrigins = [
  'https://aljodia.com',
  'https://www.aljodia.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000'
].filter(Boolean);

// CORS عالمي ومضمون 100% (يغطي كل حاجة بما فيها socket.io)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Socket-Id');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// باقي الـ middlewares
app.use(cookieParser());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", 'https://aljodia.com', 'wss://aljodia.com', 'https://www.aljodia.com', 'wss://www.aljodia.com'],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      mediaSrc: ["'self'", 'https://aljodia.com'],
      fontSrc: ["'self'", 'https:', 'data:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
if (compression) app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 800,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'طلبات كثيرة جدًا، حاول مرة أخرى بعد 15 دقيقة' },
});
app.use(limiter);

// Socket.io مع دعم كامل للـ Frontend من هوستينجر
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  },
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingInterval: 25000,
  pingTimeout: 60000,
});

// Socket Auth + Events
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token ||
                  socket.handshake.headers.authorization?.replace('Bearer ', '') ||
                  socket.handshake.headers.cookie?.match(/token=([^;]+)/)?.[1];

    if (!token) return next(new Error('No token'));

    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const User = require('./models/User');
    const user = await User.findById(decoded.id).select('username role branch').populate('branch', 'name').lean();

    if (!user) return next(new Error('User not found'));

    socket.user = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      branchId: user.branch?._id?.toString() || null,
      branchName: user.branch?.name || null,
    };

    console.log(`[${new Date().toISOString()}] Socket authenticated: ${socket.user.username}`);
    next();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Socket auth failed:`, err.message);
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  console.log(`[${new Date().toISOString()}] Socket connected: ${socket.id} → ${socket.user.username}`);

  socket.on('joinRoom', ({ userId, role, branchId }) => {
    if (socket.user.id !== userId) return;

    const rooms = [`user-${userId}`];
    if (role === 'admin') rooms.push('admin');
    if (role === 'branch' && branchId) rooms.push(`branch-${branchId}`);
    if (role === 'chef') rooms.push(`chef-${socket.user.id}`);
    if (role === 'production') rooms.push('production');

    rooms.forEach(room => socket.join(room));
    socket.emit('rooms', Array.from(socket.rooms));
  });

  socket.on('getRooms', () => socket.emit('rooms', Array.from(socket.rooms)));
  setupNotifications(io, socket);

  socket.on('disconnect', (reason) => {
    console.log(`[${new Date().toISOString()}] Socket disconnected: ${socket.id} → ${reason}`);
  });
});

// Static files (uploads & sounds)
app.use('/uploads', express.static('uploads', { maxAge: '1y' }));
app.use('/sounds', express.static('sounds', { maxAge: '1y' }));

// Database
connectDB().catch(err => {
  console.error(`[${new Date().toISOString()}] MongoDB connection failed:`, err.message);
  process.exit(1);
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/products', productRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/chefs', chefRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/factoryInventory', factoryRoutes);
app.use('/api/factoryOrders', factoryOrderRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/notifications', notificationsRoutes);

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    uptime: process.uptime(),
    env: process.env.NODE_ENV
  });
});

// 404
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: 'المسار غير موجود' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error:`, err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'خطأ في السيرفر'
  });
});

app.set('io', io);

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[${new Date().toISOString()}] CORS allowed: https://aljodia.com`);
});

// Graceful Shutdown
process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] Shutting down...`);
  server.close(() => {
    mongoose.connection.close(false, () => process.exit(0));
  });
});