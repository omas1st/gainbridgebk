const Transaction = require('../models/Transaction')
const User = require('../models/User')
const Audit = require('../models/Audit')
const { profitForDeposit } = require('../utils/calcProfit')
const { sendMail, sendAdminNotification } = require('../utils/email')

// Currency configuration for supported countries
const CURRENCY_CONFIG = {
  'South Africa': { code: 'ZAR', rate: 17, symbol: 'R' },
  'Nigeria': { code: 'NGN', rate: 1500, symbol: '₦' },
  'Ghana': { code: 'GHS', rate: 12.50, symbol: 'GH₵' },
  'Philippines': { code: 'PHP', rate: 58, symbol: '₱' }
};

// Helper function to get currency config for a country
function getCurrencyConfig(country) {
  return CURRENCY_CONFIG[country] || null;
}

/**
 * computeNetProfit(user)
 *
 * Returns a Number (rounded to 2 decimals) representing the user's available net profit.
 */
async function computeNetProfit(user) {
  // 1) compute gross profit from active deposits
  let totalProfit = 0
  for (const dep of user.deposits || []) {
    if (dep.status === 'active') {
      try {
        totalProfit += profitForDeposit(dep, new Date())
      } catch (err) {
        // if profitForDeposit fails for a deposit, skip it but continue
        console.warn('profitForDeposit error for dep', dep._id || '(unknown)', err?.message || err)
      }
    }
  }

  totalProfit = Number(totalProfit || 0)

  // 2) fetch approved withdraw transactions for this user and sum amounts that were taken from netProfit
  let withdrawnFromNet = 0

  try {
    const approvedWithdraws = await Transaction.find({ user: user._id, type: 'withdraw', status: 'approved' }).select('details amount').lean()

    for (const tx of approvedWithdraws || []) {
      const details = tx.details || {}
      const approvedAmount = Number(details.approvedAmount ?? tx.amount ?? 0)

      // If an explicit breakdown exists (added by admin flow), use it
      if (details.approvedBreakdown && typeof details.approvedBreakdown.fromNet === 'number') {
        withdrawnFromNet += Number(details.approvedBreakdown.fromNet || 0)
        continue
      }

      // Otherwise attempt inference using snapshot (snapshot is captured at withdrawal creation)
      const snapshot = details.snapshot || {}
      const snapshotNet = Number(snapshot.netProfit || 0)

      // Heuristic: withdrawals take from net first, then referral; so fromNet is min(snapshotNet, approvedAmount)
      const inferredFromNet = Math.min(snapshotNet, approvedAmount)
      withdrawnFromNet += inferredFromNet
    }
  } catch (err) {
    // non-fatal: if we can't read transactions, continue with grossProfit only.
    console.warn('computeNetProfit: could not read approved withdraws for inference', err?.message || err)
  }

  // 3) compute final netProfit available = grossProfit - withdrawnFromNet
  let availableNet = Number((totalProfit - withdrawnFromNet) || 0)

  // clamp to >= 0 and round to two decimals
  if (availableNet < 0) availableNet = 0
  availableNet = Number(availableNet.toFixed(2))

  return availableNet
}

// GET /users/:id/overview
exports.getOverview = async (req, res, next) => {
  try {
    const id = req.params.id
    if (req.user._id.toString() !== id && req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' })
    const user = await User.findById(id)
    if (!user) return res.status(404).json({ message: 'User not found' })

    // === Handle matured deposits: if any active deposit has passed the 60-day window,
    // mark it completed and deduct its capital from user.capital. The profit remains accounted for
    // by computeNetProfit which is capped at 60 days.
    const now = new Date()
    let madeChanges = false
    if (Array.isArray(user.deposits) && user.deposits.length > 0) {
      for (const dep of user.deposits) {
        if (dep && dep.status === 'active') {
          // Accept startDate or approvedAt as the deposit start
          const startCandidate = dep.startDate || dep.approvedAt
          if (!startCandidate) continue

          const s = new Date(startCandidate)
          const end = new Date(s)
          end.setDate(end.getDate() + 60)
          // if the period has completed, finalize the deposit
          if (now >= end) {
            dep.status = 'completed'
            // set endDate (useful for future profit capping and audit)
            dep.endDate = end
            // Ensure startDate is set for consistency (persist approvedAt into startDate if missing)
            if (!dep.startDate && dep.approvedAt) {
              dep.startDate = dep.approvedAt
            }
            // Deduct the original capital from user's capital balance
            const depositAmount = Number(dep.amount || 0)
            user.capital = Number(user.capital || 0) - depositAmount
            if (user.capital < 0) user.capital = 0
            madeChanges = true
          }
        }
      }
    }

    // If we mutated user (deposits or capital), persist now — later we will save after netProfit calc as well,
    // but saving here ensures other concurrent logic sees the updated deposit states.
    if (madeChanges) {
      // ensure mongoose marks modified subdocuments
      await user.save()
    }

    // Recalculate netProfit (now subtracts previously-approved withdrawals)
    const calcProfit = await computeNetProfit(user)

    // Persist the adjusted netProfit so other flows see the corrected value
    user.netProfit = calcProfit
    await user.save()

    const totalPortfolio = Number(user.capital) + Number(user.netProfit) + Number(user.referralEarnings)
    
    // Add currency information to overview response
    const currencyConfig = getCurrencyConfig(user.country);
    const overviewResponse = {
      overview: {
        capital: Number(user.capital),
        netProfit: Number(user.netProfit),
        referralEarnings: Number(user.referralEarnings),
        totalPortfolio,
        deposits: user.deposits,
        // Include currency info for frontend display
        currency: currencyConfig ? {
          code: currencyConfig.code,
          rate: currencyConfig.rate,
          symbol: currencyConfig.symbol,
          showConversion: true
        } : {
          showConversion: false
        }
      }
    }

    res.json(overviewResponse)
  } catch (err) { next(err) }
}

// GET /users/:id/transactions
exports.getTransactions = async (req, res, next) => {
  try {
    const id = req.params.id
    if (req.user._id.toString() !== id && req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' })
    const txs = await Transaction.find({ user: id }).sort({ createdAt: -1 })
    res.json({ transactions: txs })
  } catch (err) { next(err) }
}

/**
 * GET /users/:id/referrals
 *
 * Returns an array of referral entries for the given user.
 */
exports.getReferrals = async (req, res, next) => {
  try {
    const id = req.params.id
    if (req.user._id.toString() !== id && req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' })

    // Load the user doc (we want snapshot referrals if present). Populate small fields for snapshot user objects.
    const userDoc = await User.findById(id).populate('referrals.user', 'email capital referralEarnings createdAt').lean().exec()
    if (!userDoc) return res.status(404).json({ message: 'User not found' })

    const snapshot = Array.isArray(userDoc.referrals) ? userDoc.referrals : []

    // Build set of emails found in snapshot (lowercased) for fallback lookup
    const emailsFromSnapshot = snapshot
      .map(r => (r && r.email) ? String(r.email).toLowerCase() : null)
      .filter(Boolean)

    // Build query to find live referred users:
    const refQuery = { $or: [] }
    if (userDoc._id) refQuery.$or.push({ referredBy: userDoc._id })
    if (userDoc.username) refQuery.$or.push({ referredBy: userDoc.username })
    if (emailsFromSnapshot.length > 0) refQuery.$or.push({ email: { $in: emailsFromSnapshot } })

    const liveReferred = (refQuery.$or.length > 0)
      ? await User.find(refQuery).select('email capital referralEarnings _id createdAt').lean()
      : []

    const map = new Map()
    const keyFor = (u) => {
      if (u && u._id) return String(u._id)
      if (u && u.email) return String(u.email).toLowerCase()
      return null
    }

    for (const lu of liveReferred || []) {
      const key = keyFor(lu) || (lu.email || '').toLowerCase()
      map.set(key, {
        _id: lu._id || null,
        email: lu.email || '—',
        capital: Number(lu.capital || 0),
        referralEarning: Number(lu.referralEarnings || 0),
        createdAt: lu.createdAt || null,
        _source: 'live'
      })
    }

    for (const r of snapshot) {
      const rUser = r.user
      const rUserId = rUser ? (typeof rUser === 'object' && rUser._id ? String(rUser._id) : String(rUser)) : null
      const key = rUserId || (r.email || '').toLowerCase()
      const commission = Number(r.commissionEarned ?? r.referralEarning ?? 0)
      const capitalSnapshot = Number(r.capital ?? (rUser && rUser.capital) ?? 0)
      const emailSnapshot = (r.email || (rUser && rUser.email) || '—')
      const created = r.createdAt || (rUser && rUser.createdAt) || null

      if (map.has(key)) {
        const existing = map.get(key)
        existing.referralEarning = Number((existing.referralEarning || 0) + commission)
        existing._source = existing._source === 'live' ? 'live+snapshot' : 'merged'
        if ((!existing.email || existing.email === '—') && emailSnapshot) existing.email = emailSnapshot
        if ((!existing.capital || existing.capital === 0) && capitalSnapshot) existing.capital = capitalSnapshot
        if (!existing.createdAt && created) existing.createdAt = created
        map.set(key, existing)
      } else {
        map.set(key, {
          _id: rUserId || null,
          email: emailSnapshot,
          capital: capitalSnapshot,
          referralEarning: commission,
          createdAt: created,
          _source: 'snapshot'
        })
      }
    }

    const referrals = Array.from(map.values())
      .map(r => ({
        _id: r._id || null,
        email: r.email,
        capital: Number(r.capital || 0),
        referralEarning: Number(r.referralEarning || 0),
        createdAt: r.createdAt || null
      }))
      .sort((a, b) => {
        if (!a.createdAt && !b.createdAt) return 0
        if (!a.createdAt) return 1
        if (!b.createdAt) return -1
        return new Date(b.createdAt) - new Date(a.createdAt)
      })

    const totalReferralEarnings = referrals.reduce((s, r) => s + Number(r.referralEarning || 0), 0)

    res.json({ referrals, totalReferralEarnings })
  } catch (err) { next(err) }
}

/**
 * Unified profile update handler used for both PUT and PATCH routes.
 * Accepts only these updatable fields: firstName, lastName, phone, email, country
 */
async function handleUpdateProfile(req, res, next) {
  try {
    const id = req.params.id
    // permit only owner or admin
    const authId = req.user && (req.user._id ? req.user._id.toString() : String(req.user))
    if (authId !== id && req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' })

    // Only accept known fields
    const allowed = ['firstName', 'lastName', 'phone', 'email', 'country']
    const updates = {}
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates[key] = req.body[key]
      }
    }

    if (updates.email) {
      if (typeof updates.email !== 'string' || !updates.email.includes('@')) {
        return res.status(400).json({ message: 'Invalid email address' })
      }
      updates.email = updates.email.toLowerCase()
    }

    // Load user, apply updates, save (so mongoose hooks run)
    const user = await User.findById(id)
    if (!user) return res.status(404).json({ message: 'User not found' })

    // apply updates
    for (const [k, v] of Object.entries(updates)) {
      user[k] = v
    }

    try {
      await user.save()
    } catch (saveErr) {
      // If save throws a validation error, reflect it to client
      if (saveErr && saveErr.name === 'ValidationError') {
        const firstKey = Object.keys(saveErr.errors || {})[0]
        const message = firstKey ? saveErr.errors[firstKey].message : 'Validation error'
        return res.status(400).json({ message })
      }
      throw saveErr
    }

    // omit password field in response
    const ret = user.toObject()
    delete ret.password

    res.json({ user: ret })
  } catch (err) { next(err) }
}

// Export handler under both names so routes can bind either method
exports.updateProfile = handleUpdateProfile
exports.patchUpdateProfile = handleUpdateProfile

// POST create withdraw request: /users/:id/withdraw
exports.createWithdrawRequest = async (req, res, next) => {
  try {
    const id = req.params.id
    const authId = req.user && (req.user._id ? req.user._id.toString() : String(req.user))
    if (authId !== id && req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' })
    const { method, amount, bank, crypto } = req.body
    const user = await User.findById(id)
    if (!user) return res.status(404).json({ message: 'User not found' })

    // Recalculate netProfit to ensure available is up-to-date
    const calcProfit = await computeNetProfit(user)
    user.netProfit = calcProfit
    await user.save()

    const available = Number(user.netProfit || 0) + Number(user.referralEarnings || 0)
    if (!amount || amount <= 0) return res.status(400).json({ message: 'Invalid amount' })

    // Enforce minimum withdrawal amount of $2
    if (Number(amount) < 2) return res.status(400).json({ message: 'Minimum withdrawal is $2' })

    if (amount > available) return res.status(400).json({ message: 'Amount exceeds available withdrawal balance' })

    // validate required method-specific details
    if (method === 'bank') {
      if (!bank || !bank.accountNumber || String(bank.accountNumber).trim() === '') {
        return res.status(400).json({ message: 'Account number is required for bank transfers' })
      }
    } else if (method === 'crypto') {
      if (!crypto || !crypto.walletAddress || String(crypto.walletAddress).trim() === '') {
        return res.status(400).json({ message: 'Wallet address is required for cryptocurrency withdrawals' })
      }
    }

    // build transaction details and snapshot of user balances
    const snapshot = {
      name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      email: user.email,
      phone: user.phone || '',
      capital: Number(user.capital || 0),
      netProfit: Number(user.netProfit || 0),
      referralEarnings: Number(user.referralEarnings || 0),
      totalPortfolio: Number(user.capital || 0) + Number(user.netProfit || 0) + Number(user.referralEarnings || 0),
      createdAt: new Date()
    }

    const tx = new Transaction({
      user: id,
      type: 'withdraw',
      amount,
      method,
      details: {
        bank: bank || null,
        crypto: crypto || null,
        snapshot
      },
      status: 'pending'
    })
    await tx.save()

    // Notify admin via centralized helper with full details
    try {
      await sendAdminNotification({
        subject: `Gainbridge Withdrawal request — ${user.email} — ${amount}`,
        html: `<h3>Withdrawal request</h3>
               <p><strong>Name:</strong> ${snapshot.name}</p>
               <p><strong>Email:</strong> ${snapshot.email}</p>
               <p><strong>Phone:</strong> ${snapshot.phone || '—'}</p>
               <p><strong>Country:</strong> ${user.country || '—'}</p>
               <p><strong>Requested amount:</strong> ${amount}</p>
               <p><strong>Method:</strong> ${method}</p>
               <h4>Account overview (snapshot)</h4>
               <p>Capital: ${snapshot.capital}</p>
               <p>Net profit: ${snapshot.netProfit}</p>
               <p>Referral earnings: ${snapshot.referralEarnings}</p>
               <p>Total portfolio: ${snapshot.totalPortfolio}</p>
               <h4>Withdrawal details</h4>
               <pre>${JSON.stringify({ bank: bank || null, crypto: crypto || null }, null, 2)}</pre>
               <p>Transaction id: ${tx._id}</p>`
      })
    } catch (err) { console.warn('notify admin withdraw err', err.message || err) }

    res.json({ message: 'Withdrawal request submitted', transactionId: tx._id })
  } catch (err) { next(err) }
}

// POST create deposit request: /users/:id/deposit
exports.createDepositRequest = async (req, res, next) => {
  try {
    const id = req.params.id
    const authId = req.user && (req.user._id ? req.user._id.toString() : String(req.user)) // Fixed typo: _1d to _id
    if (authId !== id && req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' })
    const { amount, method, plan, receiptUrl } = req.body // method can be a string id or object in settings
    const user = await User.findById(id)
    if (!user) return res.status(404).json({ message: 'User not found' })
    if (!amount || amount <= 0) return res.status(400).json({ message: 'Invalid amount' })
    if (!receiptUrl) return res.status(400).json({ message: 'Payment receipt is required' })

    // Normalize method: accept either method id string or object - store the method id on tx.method to match schema,
    // but keep the full method details in details.method so admins can see it.
    const methodId = (typeof method === 'string') ? method : (method && method.id) ? method.id : null
    const methodDetails = (typeof method === 'object' && method !== null) ? method : null

    const tx = new Transaction({
      user: id,
      type: 'deposit',
      amount,
      method: methodId, // store compact id in main field to avoid casting errors
      details: { 
        plan: plan || null, 
        method: methodDetails,
        receiptUrl: receiptUrl // Store receipt URL in transaction details
      },
      status: 'pending'
    })
    await tx.save()

    // Notify admin including method details and receipt URL
    try {
      await sendAdminNotification({
        subject: `Gainbridge Deposit request — ${user.email}`,
        html: `<p>User ${user.email} requested deposit of ${amount}</p>
               <p>Country: ${user.country || '—'}</p>
               <p>Plan: ${JSON.stringify(plan)}</p>
               <p>Capital: ${user.capital}</p>
               <h4>Payment method details</h4>
               <pre>${JSON.stringify(methodDetails || { id: methodId }, null, 2)}</pre>
               <h4>Payment Receipt</h4>
               <p><a href="${receiptUrl}" target="_blank">View Payment Receipt</a></p>
               <p>Transaction id: ${tx._id}</p>`
      })
    } catch (err) { console.warn('notify admin deposit err', err.message || err) }

    res.json({ message: 'Deposit request submitted', transactionId: tx._id })
  } catch (err) { next(err) }
}

// messages - basic in-doc store
exports.getMessages = async (req, res, next) => {
  try {
    const id = req.params.id
    const authId = req.user && (req.user._id ? req.user._id.toString() : String(req.user))
    if (authId !== id && req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' })
    const user = await User.findById(id)
    res.json({ messages: user._messages || [] })
  } catch (err) { next(err) }
}

// POST /users/:id/messages  (user sends message to admin)
exports.postMessage = async (req, res, next) => {
  try {
    const id = req.params.id
    const authId = req.user && (req.user._id ? req.user._id.toString() : String(req.user))
    if (authId !== id && req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' })
    const { text } = req.body
    if (!text) return res.status(400).json({ message: 'Message text required' })
    const user = await User.findById(id)
    if (!user) return res.status(404).json({ message: 'User not found' })

    user._messages = user._messages || []
    const entry = {
      from: 'user',
      text,
      name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      email: user.email,
      phone: user.phone || '',
      createdAt: new Date(),
      read: false
    }
    user._messages.push(entry)
    await user.save()

    // notify admin with richer content
    try {
      await sendAdminNotification({
        subject: `Message from ${user.email}`,
        html: `<h3>New message from Gainbridge user</h3>
               <p><strong>Name:</strong> ${entry.name || '—'}</p>
               <p><strong>Email:</strong> ${entry.email}</p>
               <p><strong>Phone:</strong> ${entry.phone || '—'}</p>
               <p><strong>Country:</strong> ${user.country || '—'}</p>
               <p><strong>Message:</strong></p>
               <div style="white-space:pre-wrap">${(text || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`
      })
    } catch (err) { console.warn('notify admin message err', err.message || err) }

    res.json({ message: 'Message sent' })
  } catch (err) { next(err) }
}

// Export currency helper functions
exports.getCurrencyConfig = getCurrencyConfig;