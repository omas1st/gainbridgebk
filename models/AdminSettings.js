// models/AdminSettings.js
const mongoose = require('mongoose')
const Schema = mongoose.Schema

const AdminSettingsSchema = new Schema({
  // Withdrawal Schedule Settings
  withdrawalScheduleType: { 
    type: String, 
    enum: ['daysOfWeek', 'interval'], 
    default: 'daysOfWeek' 
  },
  withdrawalDaysOfWeek: { 
    type: [Number], // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    default: [1, 3, 5] // Monday, Wednesday, Friday
  },
  withdrawalIntervalDays: { 
    type: Number, 
    default: 1 
  },
  lastUpdated: { 
    type: Date, 
    default: Date.now 
  },
  updatedBy: { 
    type: Schema.Types.ObjectId, 
    ref: 'User' 
  }
}, { 
  timestamps: true,
  // Ensure only one settings document exists
  minimize: false 
})

// Static method to get settings (creates default if none exists)
AdminSettingsSchema.statics.getSettings = async function() {
  let settings = await this.findOne()
  if (!settings) {
    settings = await this.create({})
  }
  return settings
}

module.exports = mongoose.model('AdminSettings', AdminSettingsSchema)