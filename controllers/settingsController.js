// controllers/settingsController.js
const Setting = require('../models/Setting')

/**
 * defaultPaymentMethods()
 * Provides an initial default settings doc if none exists.
 */
function defaultPaymentMethods() {
  return [
    {
      id: 'bank-default',
      type: 'bank',
      label: 'Bank transfer',
      details: {
        bankName: 'FnB',
        accountName: 'mama pty',
        accountNumber: '62509963139',
        reference: '0657350788'
      },
      content: `Make exact payment and use the reference.`
    },
    {
      id: 'crypto-default',
      type: 'crypto',
      label: 'Bitcoin',
      details: {
        crypto: 'Bitcoin',
        address: '3Liim5xHAkLEgUjzfw2DNFqbEkzaXgWWu8'
      },
      content: 'Make exact payment of the amount required.'
    }
  ]
}

/** Public GET /api/settings */
exports.getPublicSettings = async (req, res, next) => {
  try {
    let settings = await Setting.findOne().lean()
    if (!settings) {
      // create a default settings doc
      settings = await Setting.create({ paymentMethods: defaultPaymentMethods() })
    }
    res.json({ settings })
  } catch (err) { next(err) }
}

/** Admin GET /api/admin/settings (protected by admin middleware in route) */
exports.getAdminSettings = async (req, res, next) => {
  try {
    let settings = await Setting.findOne()
    if (!settings) {
      settings = await Setting.create({ paymentMethods: defaultPaymentMethods() })
    }
    res.json({ settings })
  } catch (err) { next(err) }
}

/** Admin PUT /api/admin/settings - body: { settings } or { paymentMethods: [...] } */
exports.updateAdminSettings = async (req, res, next) => {
  try {
    const incoming = req.body.settings || { paymentMethods: req.body.paymentMethods }
    if (!incoming) return res.status(400).json({ message: 'No settings provided' })

    const updates = {}
    if (incoming.paymentMethods) updates.paymentMethods = incoming.paymentMethods

    updates.updatedAt = new Date()

    // upsert the singleton settings doc
    const settings = await Setting.findOneAndUpdate({}, updates, { new: true, upsert: true, setDefaultsOnInsert: true })
    res.json({ settings })
  } catch (err) { next(err) }
}
