const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true
  },
  username: {
    type: String,
    required: true
  },
  password: {
    type: String,
  },
  notesGenerated: {
    type: Number,
    default: 0
  },
  isPremium: {
    type: Boolean,
    default: false
  },
  premiumStartDate: {
    type: Date
  },
  premiumEndDate: {
    type: Date
  },
  videos: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Video'
    }
  ],
  verificationCode: { // Field to store the verification code
    type: String,
  },
  isVerified: { // Flag to indicate if the user is verified
    type: Boolean,
    default: false
  },
  freeTrials: { type: Number, default: 0 }
}, {
  timestamps: true
});

module.exports = mongoose.model('User', UserSchema);