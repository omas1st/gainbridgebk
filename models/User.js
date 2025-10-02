// models/User.js
const mongoose = require('mongoose')
const Schema = mongoose.Schema

const DepositSchema = new Schema({
  amount: { type: Number, required: true },
  ratePercent: { type: Number, required: true }, // daily percent (e.g., 2.5)
  days: { type: Number, required: true }, // total calendar days window (e.g., 60)
  startDate: { type: Date, default: Date.now }, // approval start timestamp
  endDate: { type: Date },
  status: { type: String, enum: ['active','completed'], default: 'active' }
}, { _id: false })

const ReferralSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User' },
  email: String,
  capital: { type: Number, default: 0 },
  commissionEarned: { type: Number, default: 0 }
}, { _id: false })

// message entry used both for admin->user and user->admin messages
const MessageSchema = new Schema({
  from: { type: String, enum: ['admin','user'], required: true },
  subject: String,         // optional (admin may send subject)
  body: String,            // admin message body
  text: String,            // user message text (for messages from user)
  name: String,            // sender name (for user->admin)
  email: String,           // sender email (for user->admin)
  phone: String,           // sender phone (for user->admin)
  createdAt: { type: Date, default: Date.now },
  read: { type: Boolean, default: false },
  meta: Schema.Types.Mixed // any extra metadata (adminId etc.)
}, { _id: false })

const UserSchema = new Schema({
  username: { type: String, index: true, unique: true, sparse: true },
  firstName: String,
  lastName: String,
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  phone: String,
  country: String,
  role: { type: String, enum: ['user','agent','admin'], default: 'user' },

  capital: { type: Number, default: 0 }, // sum of approved deposits (reflects active capital)
  netProfit: { type: Number, default: 0 }, // computed/accumulated profit (can be recalculated)
  referralEarnings: { type: Number, default: 0 },

  deposits: { type: [DepositSchema], default: [] },
  referrals: { type: [ReferralSchema], default: [] },

  // message store (admin <-> user)
  _messages: { type: [MessageSchema], default: [] },

  lastLogin: Date,
  createdAt: { type: Date, default: Date.now },

  // soft-delete flag
  deleted: { type: Boolean, default: false },

  // --- Reset password support fields (added) ---
  // store a hash of the reset token (so we never persist raw token) and expiry timestamp
  resetPasswordTokenHash: { type: String, default: null },
  resetPasswordExpires: { type: Date, default: null }
})

// ensure deposits array is always an array on read/write
UserSchema.pre('save', function(next) {
  if (!Array.isArray(this.deposits)) this.deposits = []
  if (!Array.isArray(this._messages)) this._messages = []
  next()
})

module.exports = mongoose.model('User', UserSchema)