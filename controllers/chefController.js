const Chef = require('../models/Chef');

exports.getAllChefs = async (req, res) => {
  try {
    const chefs = await Chef.find().populate('user', 'username');
    res.json(chefs);
  } catch (error) {
    console.error('Get chefs error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};