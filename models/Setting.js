// models/Setting.js
const mongoose = require('mongoose')
const Schema = mongoose.Schema

const PaymentMethodSchema = new Schema({
  id: { type: String, required: true, index: true },
  type: { type: String, enum: ['bank', 'crypto', 'other'], required: true },
  label: { type: String, default: '' }, // e.g., "Bank transfer", "Bitcoin"
  // free-form details object to hold specific fields per type
  details: { type: Schema.Types.Mixed, default: {} },
  content: { type: String, default: '' }, // optional description/instructions
  createdAt: { type: Date, default: Date.now }
}, { _id: false })

const SettingSchema = new Schema({
  // this app keeps a single settings doc
  paymentMethods: { type: [PaymentMethodSchema], default: [] },
  updatedAt: { type: Date, default: Date.now }
})

module.exports = mongoose.model('Setting', SettingSchema)
