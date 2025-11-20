const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const mongoose = require('mongoose');
let compression;

try {
  compression = require('compression');
} catch (err) {
  console.warn(`[${new Date().toISOString()}] Compression module not found. Skipping compression middleware.`);
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
app.set('trust proxy', 1); // Enable trust proxy for X-Forwarded-For

const allowedOrigins = [
  process.env.CLIENT_URL,
  'https://aljodia.com',
  'https://www.aljodia.com',
  'http://localhost:5173'
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.error(`[${new Date().toISOString()}] CORS error: Origin ${origin} not allowed`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Socket-Id'],
}));

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  path: '/socket.io',
  transports: ['websocket'],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  pingInterval: 25000,
  pingTimeout: 120000,
});

app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    connectSrc: ["'self'", ...allowedOrigins.map((origin) => origin.replace(/^https?/, 'wss')), ...allowedOrigins],
    scriptSrc: ["'self'", "'unsafe-inline'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    mediaSrc: ["'self'",   'http://localhost:5173', '/sounds/notification.mp3'],
  },
}));

app.use('/sounds', express.static('sounds', {
  setHeaders: (res) => {
    res.set('Cache-Control', 'public, max-age=31536000');
  },
}));

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.headers['authorization'];
  if (!token) {
    console.error(`[${new Date().toISOString()}] No token provided for socket: ${socket.id}`);
    return next(new Error('Authentication error: No token provided'));
  }
  try {
    const cleanedToken = token.startsWith('Bearer ') ? token.replace('Bearer ', '') : token;
    const decoded = jwt.verify(cleanedToken, process.env.JWT_ACCESS_SECRET);
    const User = require('./models/User');
    const user = await User.findById(decoded.id)
      .populate('branch', 'name _id')
      .lean();
    if (!user) {
      console.error(`[${new Date().toISOString()}] User not found for socket: ${decoded.id}`);
      return next(new Error('Authentication error: User not found'));
    }
    socket.user = {
      id: user._id.toString(),
      username: user.username,
      role: user.role,
      branchId: user.branch?._id?.toString() || null,
      branchName: user.branch?.name || null,
      chefId: user.role === 'chef' ? user._id.toString() : null,
    };
    console.log(`[${new Date().toISOString()}] Socket authenticated: ${socket.id}, User: ${socket.user.username}`);
    next();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Socket auth error: ${err.message}`);
    return next(new Error(`Authentication error: ${err.message}`));
  }
});

io.on('connection', (socket) => {
  console.log(`[${new Date().toISOString()}] Connected to socket: ${socket.id}, User: ${socket.user.username}`);
  socket.on('joinRoom', ({ userId, role, branchId, chefId }) => {
    if (socket.user.id !== userId) {
      console.error(`[${new Date().toISOString()}] Unauthorized room join attempt: ${socket.user.id} tried to join as ${userId}`);
      return;
    }
    const rooms = [`user-${userId}`];
    if (role === 'admin') rooms.push('admin');
    if (role === 'branch' && branchId && /^[0-9a-fA-F]{24}$/.test(branchId)) {
      rooms.push(`branch-${branchId}`);
    }
    if (role === 'chef' && chefId ) {
      rooms.push(`chef-${chefId}`);
    }
    if (role === 'production') rooms.push('production');
    rooms.forEach(room => {
      socket.join(room);
      console.log(`[${new Date().toISOString()}] User ${socket.user.username} (${socket.user.id}) joined room: ${room}`);
    });
    socket.emit('rooms', Array.from(socket.rooms));
  });

  socket.on('getRooms', () => {
    console.log(`[${new Date().toISOString()}] Rooms for socket ${socket.id}:`, Array.from(socket.rooms));
    socket.emit('rooms', Array.from(socket.rooms));
  });

  setupNotifications(io, socket);

  socket.on('disconnect', (reason) => {
    console.log(`[${new Date().toISOString()}] User disconnected: ${socket.id}, Reason: ${reason}`);
  });
});

connectDB().catch((err) => {
  console.error(`[${new Date().toISOString()}] Failed to connect to MongoDB: ${err.message}`);
  process.exit(1);
});

app.use('/socket.io', (req, res, next) => next());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: 'Too many requests from this IP, please try again after 15 minutes',
});
app.use(limiter);
if (compression) app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('io', io);

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

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', environment: process.env.NODE_ENV || 'production', time: new Date().toISOString() });
});

app.use((req, res) => {
  console.warn(`[${new Date().toISOString()}] 404 Not Found: ${req.method} ${req.url}`);
  res.status(404).json({ success: false, message: 'المسار غير موجود' });
});

app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error: ${err.message}, Stack: ${err.stack}`);
  res.status(500).json({ success: false, message: 'خطأ في السيرفر', error: err.message });
});

const PORT = process.env.PORT || 3000;
server.setTimeout(120000); // Increase timeout to 120 seconds
server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] Received SIGTERM. Closing server gracefully.`);
  server.close(() => {
    mongoose.connection.close(false, () => {
      console.log(`[${new Date().toISOString()}] MongoDB connection closed.`);
      process.exit(0);
    });
  });
});