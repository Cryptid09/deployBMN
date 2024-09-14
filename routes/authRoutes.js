const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Login route
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const payload = {
      user: {
        id: user.id,
        email: user.email
      }
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: '1h' },
      (err, token) => {
        if (err) throw err;
       
        res.json({ token, user: { id: user.id, email: user.email } });
      }
    );
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// Check session route (now using JWT)
router.get('/check-session', async (req, res) => {
  const token = req.header('x-auth-token');

  if (!token) {
    return res.json({ loggedIn: false });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.user.id).select('-password');
    if (!user) {
      return res.json({ loggedIn: false });
    }
    res.json({ loggedIn: true, user });
  } catch (error) {
    console.error('Error verifying token:', error);
    res.json({ loggedIn: false });
  }
});

// Logout route (for JWT, we don't need server-side logout)
router.post('/logout', (req, res) => {
  // With JWT, logout is typically handled on the client side by removing the token
  res.json({ message: 'Logout successful' });
});

module.exports = router;