const mongoose = require('mongoose')
const Schema = mongoose.Schema

const AuditSchema = new Schema({
  admin: { type: Schema.Types.ObjectId, ref: 'User' },
  action: String,
  meta: Object,
  createdAt: { type: Date, default: Date.now }
})

module.exports = mongoose.model('Audit', AuditSchema)
