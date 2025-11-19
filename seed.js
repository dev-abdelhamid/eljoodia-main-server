const mongoose = require('mongoose');
require('dotenv').config();

const User = require('./models/User');
const Branch = require('./models/Branch');
const Product = require('./models/Product');
const Order = require('./models/Order');
const Department = require('./models/department');
const Chef = require('./models/Chef');
const Inventory = require('./models/Inventory');
const bcrypt = require('bcrypt');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/joudia_factory', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB Connected for seeding');
  } catch (error) {
    console.error('Database connection error:', error);
    process.exit(1);
  }
};

const seedData = async () => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Clear existing data
    await Promise.all([
      User.deleteMany({}),
      Branch.deleteMany({}),
      Product.deleteMany({}),
      Order.deleteMany({}),
      Department.deleteMany({}),
      Chef.deleteMany({}),
      Inventory.deleteMany({}),
    ]);
    console.log('Cleared existing data');

    // Create departments
    const departments = await Department.create([
      { name: 'حلويات شرقية', code: 'EAST', description: 'Eastern sweets', isActive: true },
      { name: 'حلويات غربية', code: 'WEST', description: 'Western sweets', isActive: true },
      { name: 'كيك وتورت', code: 'CAKE', description: 'Cakes and tortes', isActive: true },
      { name: 'معجنات', code: 'PAST', description: 'Pastries', isActive: true },
      { name: 'مخبوزات', code: 'BAKE', description: 'Bakery items', isActive: true },
      { name: 'موالح', code: 'SAVORY', description: 'Savory items', isActive: true },
      { name: 'بقلاوة', code: 'BAKLAVA', description: 'Baklava items', isActive: true },
    ], { session });
    if (!departments.length) throw new Error('Failed to create departments');
    console.log('Created departments:', departments.map(d => ({ _id: d._id, name: d.name })));

    // Create admin and production users
    const users = await User.create([
      {
        username: 'admin',
        password: '123456',
        name: 'مدير النظام',
        role: 'admin',
        email: 'admin@joudia.com',
        phone: '0501234567',
        isActive: true,
      },
      {
        username: 'production',
        password: '123456',
        name: 'مدير الإنتاج',
        role: 'production',
        email: 'production@joudia.com',
        phone: '0501234568',
        isActive: true,
      },
    ], { session });
    if (!users.length) throw new Error('Failed to create initial users');
    console.log('Created initial users:', users.map(u => ({ _id: u._id, username: u.username })));

    // Create branches with associated users
    const branchData = [
      {
        name: 'فرع الرياض الرئيسي',
        code: 'RYD001',
        address: 'شارع الملك فهد، الرياض',
        city: 'الرياض',
        phone: '0112345678',
        username: 'branch1',
        email: 'riyadh@joudia.com',
        phoneUser: '0501234569',
      },
      {
        name: 'فرع جدة',
        code: 'JED001',
        address: 'شارع التحلية، جدة',
        city: 'جدة',
        phone: '0122345678',
        username: 'branch2',
        email: 'jeddah@joudia.com',
        phoneUser: '0501234570',
      },
      {
        name: 'فرع الدمام',
        code: 'DMM001',
        address: 'شارع الملك عبدالعزيز، الدمام',
        city: 'الدمام',
        phone: '0132345678',
        username: 'branch3',
        email: 'dammam@joudia.com',
        phoneUser: '0501234571',
      },
      {
        name: 'فرع مكة',
        code: 'MKK001',
        address: 'شارع العزيزية، مكة المكرمة',
        city: 'مكة المكرمة',
        phone: '0122345679',
        username: 'branch4',
        email: 'mecca@joudia.com',
        phoneUser: '0501234572',
      },
      {
        name: 'فرع المدينة',
        code: 'MED001',
        address: 'شارع قباء، المدينة المنورة',
        city: 'المدينة المنورة',
        phone: '0142345678',
        username: 'branch5',
        email: 'medina@joudia.com',
        phoneUser: '0501234573',
      },
    ];

    const branches = [];
    for (const branch of branchData) {
      const branchUser = new User({
        username: branch.username,
        password: '123456',
        name: branch.name,
        role: 'branch',
        email: branch.email,
        phone: branch.phoneUser,
        isActive: true,
      });
      await branchUser.save({ session });

      const newBranch = new Branch({
        name: branch.name,
        code: branch.code,
        address: branch.address,
        city: branch.city,
        phone: branch.phone,
        user: branchUser._id,
        createdBy: users[0]._id, // Admin
        isActive: true,
      });
      await newBranch.save({ session });

      branchUser.branch = newBranch._id;
      await branchUser.save({ session });

      branches.push(newBranch);
    }
    console.log('Created branches:', branches.map(b => ({ _id: b._id, name: b.name, code: b.code, user: b.user })));

    // Create chef users
    const chefUsers = await User.create([
      {
        username: 'chef1',
        password: '123456',
        name: 'شيف الحلويات الشرقية',
        role: 'chef',
        email: 'chef1@joudia.com',
        phone: '0501234574',
        department: departments[0]._id, // حلويات شرقية
        isActive: true,
      },
      {
        username: 'chef2',
        password: '123456',
        name: 'شيف الحلويات الغربية',
        role: 'chef',
        email: 'chef2@joudia.com',
        phone: '0501234575',
        department: departments[1]._id, // حلويات غربية
        isActive: true,
      },
      {
        username: 'chef3',
        password: '123456',
        name: 'شيف الكيك والتورت',
        role: 'chef',
        email: 'chef3@joudia.com',
        phone: '0501234576',
        department: departments[2]._id, // كيك وتورت
        isActive: true,
      },
      {
        username: 'chef4',
        password: '123456',
        name: 'شيف المعجنات والمخبوزات',
        role: 'chef',
        email: 'chef4@joudia.com',
        phone: '0501234577',
        department: departments[3]._id, // معجنات
        isActive: true,
      },
      {
        username: 'chef5',
        password: '123456',
        name: 'شيف الموالح',
        role: 'chef',
        email: 'chef5@joudia.com',
        phone: '0501234578',
        department: departments[5]._id, // موالح
        isActive: true,
      },
      {
        username: 'chef6',
        password: '123456',
        name: 'شيف البقلاوة',
        role: 'chef',
        email: 'chef6@joudia.com',
        phone: '0501234579',
        department: departments[6]._id, // بقلاوة
        isActive: true,
      },
    ], { session });
    console.log('Created chef users:', chefUsers.map(u => ({ _id: u._id, username: u.username, department: u.department })));

    // Create chefs
    const chefs = await Chef.create([
      { user: chefUsers[0]._id, department: departments[0]._id, status: 'active' },
      { user: chefUsers[1]._id, department: departments[1]._id, status: 'active' },
      { user: chefUsers[2]._id, department: departments[2]._id, status: 'active' },
      { user: chefUsers[3]._id, department: departments[3]._id, status: 'active' },
      { user: chefUsers[4]._id, department: departments[5]._id, status: 'active' },
      { user: chefUsers[5]._id, department: departments[6]._id, status: 'active' },
    ], { session });
    console.log('Created chefs:', chefs.map(c => ({ _id: c._id, user: c.user, department: c.department })));

    // Create products
    const products = await Product.create([
      // حلويات شرقية
      { name: 'ملوكية بالتمر', code: 'ALBH', price: 1.700, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بلح الشام (بالكيلو)', code: 'F5-5', price: 0, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'سمبوسا جبنة (بالكيلو)', code: 'F5-6', price: 0, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بقلاوة أصابع جبن', code: 'asabie aljubn', price: 0, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'وربات بالقشطة', code: 'warabaat alqishta', price: 0, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كنافة مبرومه', code: 'kanafat mabrumuh', price: 0, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كنافة ناعمة', code: 'B3-1', price: 2.500, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كنافة عصمليه', code: 'B3-2', price: 2.500, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'معمول تمر', code: 'B2-2', price: 2.500, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بسبوسة سورية', code: 'B2-4', price: 1.500, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بسبوسة لوتس', code: 'B2-5', price: 1.500, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بسبوسة قشطة', code: 'B2-1', price: 1.700, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بسبوسة تمر', code: 'B2-3', price: 1.500, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بسبوسة شوكولاتة', code: 'B2-6', price: 1.500, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بسبوسة كرانشي', code: 'B2-7', price: 1.500, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بسبوسة بدون جوز هند', code: 'B2-11', price: 1.500, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بسبوسة كليجا', code: 'B2-12', price: 1.500, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بسبوسة كيت كات', code: 'B2-KITKAT', price: 1.500, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بسبوسة توفي', code: 'B2-13', price: 1.500, unit: 'كيلو', department: departments[0]._id, isActive: true, createdBy: users[0]._id },

      // معجنات
      { name: 'فطاير عادي بالكيلو', code: 'F-1-1', price: 52, unit: 'كيلو', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'فطائر حبة', code: 'F-1-2', price: 1.25, unit: 'قطعة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'فطائر ميني برقر', code: 'F-MINI-BURGER', price: 52, unit: 'كيلو', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'مقليات (كبة)', code: 'F5-2', price: 0, unit: 'كيلو', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'مقليات (كفتة)', code: 'F5-1', price: 0, unit: 'كيلو', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'مقليات (كفتة أصابع)', code: 'F5-3', price: 0, unit: 'كيلو', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة فطاير ميني', code: 'B51', price: 37, unit: 'علبة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة فطاير ميني جديد', code: 'B51-NEW', price: 50, unit: 'علبة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كروسان دجاج', code: 'B83', price: 0, unit: 'قطعة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'سندويشه حلوم مشوي', code: 'B75', price: 0, unit: 'قطعة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'سندويشه بافليو دجاج', code: 'B82', price: 0, unit: 'قطعة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'سندويشه دجاج مشوي', code: 'B80', price: 0, unit: 'قطعة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'ورق عنب بارد كبير', code: 'B8', price: 23, unit: 'علبة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'ورق عنب بارد صغير', code: 'B10', price: 11.5, unit: 'علبة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'ورق عنب حار كبير', code: 'B9', price: 23, unit: 'علبة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'ورق عنب حار صغير', code: 'B11', price: 11.5, unit: 'علبة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'خلية الجبن', code: 'B85', price: 10, unit: 'علبة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'خلية قرفة', code: 'B86', price: 10, unit: 'علبة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'خبز دائري', code: 'B104', price: 6, unit: 'علبة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'اقماع فارغة', code: 'B105', price: 6, unit: 'علبة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة ورق عنب', code: 'WARGENAB-BOX', price: 35, unit: 'علبة', department: departments[3]._id, isActive: true, createdBy: users[0]._id },

      // موالح
      { name: 'موالح حبة بركه', code: 'G1-1', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'موالح وردة سماق', code: 'G1-2', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'موالح مربعه كمون', code: 'G1-CUMIN', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'موالح قلب يانسون', code: 'G1-3', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'موالح حبة بركه S', code: 'G1-4', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'موالح فرنسية', code: 'G1-5', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'رموش', code: 'G1-6', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'برازق', code: 'G1-7', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بيتي فور أصابع فستق', code: 'G6', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بيتي فور وردة فستق', code: 'G2-1', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بتي فور أصابع شوكولاتة', code: 'G2-2', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'معمول محشي تمر', code: 'G2-3', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'غريبة سادة', code: 'G3-1', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'الشعبيات المغلفة بالكيلو', code: 'SHAEBIAAT', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'معمول تمر عادي', code: 'MAMUL-TAMAR', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'معمول تمر بر', code: 'MAMUL-BAR', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'معمول أصابع', code: 'MAMUL-FINGERS', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'معمول كليجا', code: 'MAMUL-KLEIJA', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'معمول سمسم', code: 'MAMUL-SESAME', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'معمول تمر جوز هند', code: 'MAMUL-COCONUT', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'شابورة ناشفة', code: 'RUSK-DRY', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'تمرية سمسم', code: 'TAMARIYA-SESAME', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بسكويت سمسم بالحليب', code: 'SESAME-BISCUIT', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بيتي فور ابيض دائري', code: 'PETIT-ROUND', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بيتي فور شوكولاته اصابع', code: 'PETIT-CHOCOLATE', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كليجا عادي', code: 'KLIJA-NORMAL', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'شابورة حلوة', code: 'RUSK-SWEET', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بسكويت زنجبيل', code: 'GINGER-BISCUIT', price: 0, unit: 'كيلو', department: departments[5]._id, isActive: true, createdBy: users[0]._id },

      // بقلاوة
      { name: 'أصابع كاجو', code: 'ASABBIA KAJU', price: 2.200, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بقلاوة محشية حلقوم', code: 'ASABHA HALKOOM', price: 1.000, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بقلاوة بندق بالشوكولاتة', code: 'BAKLAVA-HAZELNUT', price: 1.000, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بقلاوة الرمان', code: 'BAKLAVA-POMEGRANATE', price: 1.000, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كل واشكر كاجو', code: 'KULWASKUR KAJU', price: 3.000, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بؤج كاجو', code: 'BOAJ KAJU', price: 3.000, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'عش البلبل فستق', code: 'ASHA BULBUL PUSTHUK', price: 3.000, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'سوارة كورن فليكس', code: 'SEWARA CORNFLAKES', price: 3.000, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بقلاوة سكين كاجو', code: 'SIKIN KAJU', price: 5.000, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بقلاوة أصابع بالبندق', code: 'BAKLAVA-PECAN', price: 1.500, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بقلاوة الصدف', code: 'BAKLAVA-SEASHELL', price: 1.500, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بقلاوة البيكان', code: 'BAKLAVA-PECAN2', price: 1.500, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كل و اشكر التركي', code: 'KULWASKUR TURKISH', price: 1.500, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بقلاوة لقمة', code: 'BAKLAVA-LOKMA', price: 1.500, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'سكين الجوزية', code: 'SIKIN ALJAWZIA', price: 5.000, unit: 'كيلو', department: departments[6]._id, isActive: true, createdBy: users[0]._id },

      // كيك وتورت
      { name: 'كيك لافندر', code: 'LAVENDER-CAKE', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'شوكولاتة دائري وسط', code: 'CHOCOLATE-MIDDLE', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'توفي دائري صغير', code: 'CARMAL-SMALL', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'سينكرس دائري صغير', code: 'SNICKERS-SMALL', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'اوبيرا كيك', code: 'OPERA-SMALL', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'بلاك فورست', code: 'BLACK-FURST', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كيك بلوبيري', code: 'BLUEBERRY-CAKE', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كيك نسكافية', code: 'NESCAFE-CAKE', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كيك فراولة', code: 'STRAWBERRY-CAKE', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كيك رول رد فلفت', code: 'RED-VELVET-ROLL', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كيك ميني', code: 'CAKE-MINI', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'قاتوة شوكولاتة', code: 'GATHU-CHOCOLATE', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'قاتوة فانيلا', code: 'GATHU-VANILLA', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'رد فلفت', code: 'RED-VELVET', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كيك مغلف', code: 'CAKE-MUGHALAF', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كيك مدور', code: 'ROUND-CAKE', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كيك انجليزي', code: 'ENGLISH-CAKE', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'لوح شوكولاتة + كريمة', code: 'CHOCOLATE-BAR', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'لوح كتابة بيضاوي ابيض', code: 'OVAL-WHITE', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'لوح كتابة بيضاوي بني', code: 'OVAL-BROWN', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'لوح كتابة مستطيل ابيض', code: 'RECTANGLE-WHITE', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'لوح كتابة مستطيل بني', code: 'RECTANGLE-BROWN', price: 0, unit: 'قطعة', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كريمة بيضاء', code: 'WHITE-CREAM', price: 0, unit: 'كيلو', department: departments[2]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كريمة بني', code: 'BROWN-CREAM', price: 0, unit: 'كيلو', department: departments[2]._id, isActive: true, createdBy: users[0]._id },

      // العلب
      { name: 'علبة هلا شوكو', code: 'B17', price: 0, unit: 'علبة', department: departments[0]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة نواشف مكس', code: 'B43', price: 0, unit: 'علبة', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة بيتي فور أصابع مكس', code: 'B76', price: 0, unit: 'علبة', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة غريبة', code: 'B19', price: 0, unit: 'علبة', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة غريبة شوكولاتة', code: 'B42', price: 0, unit: 'علبة', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة غريبة فستقية', code: 'B70', price: 0, unit: 'علبة', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة معمول حديد', code: 'B93', price: 0, unit: 'علبة', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة تمرية', code: 'B41', price: 0, unit: 'علبة', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'شابورة حلوة', code: 'G7-1', price: 0, unit: 'علبة', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'شابورة حلوة 14', code: '589', price: 0, unit: 'علبة', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'شابورة عادي', code: 'G7-4', price: 0, unit: 'علبة', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'كليجا (كرتون)', code: 'B31', price: 0, unit: 'علبة', department: departments[5]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة بقلاوة كلاسيك صغير', code: 'B29', price: 0, unit: 'علبة', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة بقلاوة كلاسيك كبير', code: 'B30', price: 0, unit: 'علبة', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة سكين حديد', code: 'B91', price: 0, unit: 'علبة', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة بقلاوة أصابع كاجو حديد ص', code: '598', price: 0, unit: 'علبة', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
      { name: 'علبة بقلاوة أصابع كاجو حديد', code: 'B88', price: 0, unit: 'علبة', department: departments[6]._id, isActive: true, createdBy: users[0]._id },
    ], { session });
    console.log('Created products:', products.map(p => ({ _id: p._id, name: p.name, code: p.code, department: p.department })));

    // Create sample inventory for each branch
    const inventoryData = [];
    branches.forEach(branch => {
      products.forEach(product => {
        inventoryData.push({
          product: product._id,
          branch: branch._id,
          currentStock: Math.floor(Math.random() * 100), // Random stock between 0 and 100
          minStockLevel: Math.floor(Math.random() * 20), // Random min stock between 0 and 20
          createdBy: users[0]._id, // Admin user
          updatedAt: new Date(),
        });
      });
    });

    await Inventory.create(inventoryData, { session });
    console.log('Created inventory for branches');

    // Create orders
    const orders = [
      {
        branch: branches[0]._id,
        items: [
          { product: products[0]._id, quantity: 2, price: 1.700 },
          { product: products[1]._id, quantity: 1, price: 0 },
        ],
        orderNumber: 'ORD-001',
        totalAmount: 2 * 1.700,
        status: 'pending',
        priority: 'urgent',
        requestedDeliveryDate: new Date('2025-08-05'),
        createdBy: branches[0].user,
        notes: 'طلب عاجل لمناسبة خاصة',
        createdAt: new Date('2025-08-02T10:00:00Z'),
      },
      {
        branch: branches[1]._id,
        items: [
          { product: products[6]._id, quantity: 5, price: 2.500 },
          { product: products[7]._id, quantity: 3, price: 2.500 },
        ],
        orderNumber: 'ORD-002',
        totalAmount: 5 * 2.500 + 3 * 2.500,
        status: 'approved',
        priority: 'high',
        requestedDeliveryDate: new Date('2025-08-06'),
        createdBy: branches[1].user,
        approvedBy: users[0]._id,
        approvedAt: new Date('2025-08-02T12:00:00Z'),
        notes: 'تسليم قبل العصر',
        createdAt: new Date('2025-08-02T09:00:00Z'),
      },
      {
        branch: branches[2]._id,
        items: [
          {
            product: products[11]._id,
            quantity: 20,
            price: 1.700,
            assignedChef: chefUsers[0]._id,
            status: 'in_progress',
            startedAt: new Date('2025-08-02T08:00:00Z'),
          },
        ],
        orderNumber: 'ORD-003',
        totalAmount: 20 * 1.700,
        status: 'in_production',
        priority: 'medium',
        requestedDeliveryDate: new Date('2025-08-04'),
        createdBy: branches[2].user,
        createdAt: new Date('2025-08-01T15:00:00Z'),
      },
      {
        branch: branches[3]._id,
        items: [
          {
            product: products[8]._id,
            quantity: 2,
            price: 2.500,
            assignedChef: chefUsers[0]._id,
            status: 'completed',
            startedAt: new Date('2025-08-01T10:00:00Z'),
            completedAt: new Date('2025-08-02T14:00:00Z'),
          },
        ],
        orderNumber: 'ORD-004',
        totalAmount: 2 * 2.500,
        status: 'completed',
        priority: 'medium',
        requestedDeliveryDate: new Date('2025-08-03'),
        createdBy: branches[3].user,
        approvedBy: users[0]._id,
        approvedAt: new Date('2025-08-01T12:00:00Z'),
        createdAt: new Date('2025-08-01T09:00:00Z'),
      },
    ];

    // Insert orders
    for (const [index, orderData] of orders.entries()) {
      try {
        const order = new Order(orderData);
        await order.save({ session });
        console.log(`Created order ${index + 1} with orderNumber: ${order.orderNumber}`);
      } catch (error) {
        console.error(`Error creating order ${index + 1}:`, error);
        throw error;
      }
    }
    console.log('Created orders');

    await session.commitTransaction();
    session.endSession();

    console.log('✅ Database seeded successfully!');
    console.log('\n📋 Test Accounts:');
    console.log('Admin: admin / 123456');
    console.log('Production: production / 123456');
    console.log('Branch (Riyadh): branch1 / 123456');
    console.log('Branch (Jeddah): branch2 / 123456');
    console.log('Branch (Dammam): branch3 / 123456');
    console.log('Branch (Mecca): branch4 / 123456');
    console.log('Branch (Medina): branch5 / 123456');
    console.log('Chef (Eastern Sweets): chef1 / 123456');
    console.log('Chef (Western Sweets): chef2 / 123456');
    console.log('Chef (Cakes): chef3 / 123456');
    console.log('Chef (Pastries): chef4 / 123456');
    console.log('Chef (Savory): chef5 / 123456');
    console.log('Chef (Baklava): chef6 / 123456');
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Seeding error:', error);
    throw error;
  } finally {
    mongoose.connection.close();
  }
};

const runSeed = async () => {
  await connectDB();
  await seedData();
};

runSeed();