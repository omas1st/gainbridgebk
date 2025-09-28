// models/Transaction.js
const mongoose = require('mongoose')
const Schema = mongoose.Schema

const TransactionSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['deposit','withdraw'], required: true },
  amount: { type: Number, required: true },
  // keep method as string id (e.g. 'bank-default') to avoid casting issues
  method: { type: String }, // bank / crypto / method-id
  // details can store full method object, plan snapshot, snapshot, etc.
  details: { type: Schema.Types.Mixed, default: {} }, // bank account / crypto address etc.
  status: { type: String, enum: ['pending','approved','rejected'], default: 'pending' },
  adminRemarks: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
})

// update `updatedAt` automatically
TransactionSchema.pre('save', function(next) {
  this.updatedAt = new Date()
  next()
})

module.exports = mongoose.model('Transaction', TransactionSchema)
