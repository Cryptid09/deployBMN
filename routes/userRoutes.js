const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Temporary storage for OTPs (in production, use a database or cache)
const otpStorage = new Map();

// Email transporter setup (replace with your SMTP settings)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Register a new user
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, referralCode } = req.body;

    // Validate input
    if (!username || !email || !password) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Check if user already exists
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Check if there's a valid referral code
    if (referralCode) {
      const referrer = await User.findById(referralCode);
      if (referrer) {
        // Increment the referrer's freeTrials
        await User.findByIdAndUpdate(referralCode, { $inc: { freeTrials: 1 } });
      }
    }

    // Generate OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    otpStorage.set(email, otp);

    // Create HTML email content
    const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Email Verification for Build My Notes</title>
        <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #7C3AED; color: white; padding: 20px; text-align: center; }
            .content { background-color: #f9f9f9; padding: 20px; border-radius: 5px; }
            .otp { font-size: 24px; font-weight: bold; color: #7C3AED; text-align: center; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Welcome to Build My Notes</h1>
            </div>
            <div class="content">
                <p>Hello,</p>
                <p>Thank you for registering with Build My Notes. To complete your registration, please use the following verification code:</p>
                <p class="otp">${otp}</p>
                <p>This code will expire in 10 minutes. If you didn't request this verification, please ignore this email.</p>
            </div>
            <div class="footer">
                <p>&copy; 2023 Build My Notes. All rights reserved.</p>
            </div>
        </div>
    </body>
    </html>
    `;

    // Send OTP via email
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Email Verification for Build My Notes',
      html: htmlContent
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error("Error sending verification email:", error);
        return res.status(500).json({ message: 'Error sending verification email', error: error.message });
      }
      console.log("Verification email sent:", info.response);
      res.status(200).json({ message: 'Verification code sent to your email' });
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Verify OTP and complete registration
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp, username, password } = req.body;

    // Check if the OTP is valid
    if (otpStorage.get(email) !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create new user
    const user = new User({
      username,
      email,
      password: hashedPassword,
      isVerified: true, // Mark user as verified
      freeTrials: 1 // Set initial free trial
    });

    await user.save();
    otpStorage.delete(email); // Remove OTP from storage

    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;