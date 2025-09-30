// controllers/adminController.js
const mongoose = require('mongoose')
const Transaction = require('../models/Transaction')
const User = require('../models/User')
const Audit = require('../models/Audit')
const { sendMail, sendAdminNotification } = require('../utils/email')
const { rateForAmount } = require('../utils/calcProfit') // used to infer rate when plan not provided

// Helper to deduct a withdrawal amount from user's netProfit then referralEarnings
// Accepts optional mongoose session to make saves transactional
async function deductFromUser(user, amount, session = null) {
  let net = Number(user.netProfit || 0)
  let ref = Number(user.referralEarnings || 0)
  let remaining = Number(amount)

  const fromNet = Math.min(net, remaining)
  net -= fromNet
  remaining -= fromNet

  const fromRef = Math.min(ref, remaining)
  ref -= fromRef
  remaining -= fromRef

  // Persist
  user.netProfit = Number(net.toFixed(2))
  user.referralEarnings = Number(ref.toFixed(2))

  if (session) {
    await user.save({ session })
  } else {
    await user.save()
  }

  return { netAfter: user.netProfit, refAfter: user.referralEarnings, shortfall: Number(remaining.toFixed(2)) }
}

/* ======= Requests listing / approve / reject (deposit & withdraw) ======= */
exports.listWithdraws = async (req, res, next) => {
  try {
    const status = req.query.status || 'pending'
    const withdraws = await Transaction.find({ type: 'withdraw', status }).populate('user', 'email firstName lastName capital netProfit referralEarnings')
    res.json({ withdraws })
  } catch (err) { next(err) }
}

exports.listDeposits = async (req, res, next) => {
  try {
    const status = req.query.status || 'pending'
    const deposits = await Transaction.find({ type: 'deposit', status }).populate('user', 'email firstName lastName capital')
    res.json({ deposits })
  } catch (err) { next(err) }
}

exports.history = async (req, res, next) => {
  try {
    const type = req.query.type
    const q = {}
    if (type && (type === 'withdraw' || type === 'deposit')) q.type = type
    const requests = await Transaction.find(q).sort({ updatedAt: -1 }).limit(200).populate('user', 'email')
    res.json({ history: requests })
  } catch (err) { next(err) }
}

/**
 * listRequests
 * Return pending requests (or filtered by query) - returns { deposits: [], withdrawals: [] }
 * Supports query: q (name/email), from, to, type (deposit|withdrawal|all), status (default pending)
 */
exports.listRequests = async (req, res, next) => {
  try {
    const qUser = req.query.q
    const from = req.query.from
    const to = req.query.to
    const type = req.query.type
    const status = req.query.status || 'pending'

    const baseMatch = { status }

    if (qUser) {
      const users = await User.find({
        $or: [
          { email: new RegExp(qUser, 'i') },
          { firstName: new RegExp(qUser, 'i') },
          { lastName: new RegExp(qUser, 'i') }
        ]
      }).select('_id')
      const ids = users.map(u => u._id)
      if (ids.length === 0) {
        return res.json({ deposits: [], withdrawals: [] })
      }
      baseMatch.user = { $in: ids }
    }

    if (from || to) {
      baseMatch.createdAt = {}
      if (from) baseMatch.createdAt.$gte = new Date(from)
      if (to) {
        const d = new Date(to)
        d.setHours(23,59,59,999)
        baseMatch.createdAt.$lte = d
      }
    }

    const depositMatch = { ...baseMatch, type: 'deposit' }
    const withdrawMatch = { ...baseMatch, type: 'withdraw' }

    if (type && type !== 'all') {
      if (type === 'deposit') {
        const deposits = await Transaction.find(depositMatch).sort({ createdAt: -1 }).limit(200).populate('user', 'email firstName lastName capital netProfit referralEarnings')
        return res.json({ deposits, withdrawals: [] })
      }
      if (type === 'withdraw' || type === 'withdrawal') {
        const withdrawals = await Transaction.find(withdrawMatch).sort({ createdAt: -1 }).limit(200).populate('user', 'email firstName lastName capital netProfit referralEarnings')
        return res.json({ deposits: [], withdrawals })
      }
    }

    const deposits = await Transaction.find(depositMatch).sort({ createdAt: -1 }).limit(200).populate('user', 'email firstName lastName capital netProfit referralEarnings')
    const withdrawals = await Transaction.find(withdrawMatch).sort({ createdAt: -1 }).limit(200).populate('user', 'email firstName lastName capital netProfit referralEarnings')
    res.json({ deposits, withdrawals })
  } catch (err) { next(err) }
}

/**
 * approveRequest / rejectRequest - dispatchers based on tx.type
 */
exports.approveRequest = async (req, res, next) => {
  try {
    const id = req.params.id
    const tx = await Transaction.findById(id)
    if (!tx) return res.status(404).json({ message: 'Request not found' })
    if (tx.type === 'deposit') return exports.approveDeposit(req, res, next)
    if (tx.type === 'withdraw') return exports.approveWithdraw(req, res, next)
    return res.status(400).json({ message: 'Unsupported transaction type' })
  } catch (err) { next(err) }
}

exports.rejectRequest = async (req, res, next) => {
  try {
    const id = req.params.id
    const tx = await Transaction.findById(id)
    if (!tx) return res.status(404).json({ message: 'Request not found' })
    if (tx.type === 'deposit') return exports.rejectDeposit(req, res, next)
    if (tx.type === 'withdraw') return exports.rejectWithdraw(req, res, next)
    return res.status(400).json({ message: 'Unsupported transaction type' })
  } catch (err) { next(err) }
}

/* ----- approve / reject withdraw ----- */
exports.approveWithdraw = async (req, res, next) => {
  const session = await mongoose.startSession()
  try {
    const id = req.params.id
    const { approvedAmount } = req.body || {}
    const admin = req.user

    let txDoc = null
    let updatedUser = null
    let auditEntry = null

    // Use a transaction so user balance update + transaction update are atomic
    await session.withTransaction(async () => {
      const tx = await Transaction.findById(id).session(session)
      if (!tx || tx.type !== 'withdraw') {
        const e = new Error('Withdraw request not found')
        e.code = 404
        throw e
      }
      if (tx.status !== 'pending') {
        const e = new Error('Request already processed')
        e.code = 400
        throw e
      }

      const user = await User.findById(tx.user).session(session)
      if (!user) {
        const e = new Error('User not found')
        e.code = 404
        throw e
      }

      const available = Number(user.netProfit || 0) + Number(user.referralEarnings || 0)
      const approveAmt = Number(approvedAmount ?? tx.amount)
      if (approveAmt > available) {
        const e = new Error('Approved amount exceeds available withdrawal balance')
        e.code = 400
        throw e
      }

      // Deduct from user balances under session
      const result = await deductFromUser(user, approveAmt, session)

      // update tx
      tx.status = 'approved'
      tx.updatedAt = new Date()
      tx.adminRemarks = `Approved by ${admin.email}`
      tx.details = tx.details || {}
      tx.details.approvedAmount = approveAmt
      tx.details.approvedSnapshot = {
        capital: Number(user.capital || 0),
        netProfit: Number(user.netProfit || 0),
        referralEarnings: Number(user.referralEarnings || 0),
        totalPortfolio: Number(user.capital || 0) + Number(user.netProfit || 0) + Number(user.referralEarnings || 0),
        approvedAt: new Date()
      }

      await tx.save({ session })

      // create audit record inside the transaction
      auditEntry = await new Audit({
        admin: admin._id,
        action: 'approve-withdraw',
        meta: { txId: tx._id, approvedAmount: approveAmt, result }
      }).save({ session })

      // retain relevant objects to use after commit
      txDoc = tx
      updatedUser = user
    }) // end transaction

    session.endSession()

    // After commit: send emails / admin notification (outside transaction)
    try {
      if (updatedUser) {
        await sendMail({
          to: updatedUser.email,
          subject: `Withdrawal approved — ${txDoc.details.approvedAmount}`,
          html: `<p>Your withdrawal of ${txDoc.details.approvedAmount} has been approved and is being processed.</p>
                 <p>Net profit after: ${updatedUser.netProfit}</p><p>Referral earnings after: ${updatedUser.referralEarnings}</p>`
        })
      }
    } catch (err) { console.warn('notify user withdraw err', err.message || err) }

    try {
      await sendAdminNotification({
        subject: `Withdrawal approved — ${updatedUser?.email || txDoc.user} — ${txDoc.details.approvedAmount}`,
        html: `<p>Admin action: withdrawal approved</p>
               <p>User: ${updatedUser?.email || txDoc.user}</p>
               <p>Amount approved: ${txDoc.details.approvedAmount}</p>
               <p>Net profit after: ${updatedUser?.netProfit}</p>
               <p>Referral earnings after: ${updatedUser?.referralEarnings}</p>`
      })
    } catch (err) { console.warn('admin notify (approve withdraw) failed', err.message || err) }

    // Return the updated overview for the user so frontend can immediately use it
    if (updatedUser) {
      const overview = {
        capital: Number(updatedUser.capital || 0),
        netProfit: Number(updatedUser.netProfit || 0),
        referralEarnings: Number(updatedUser.referralEarnings || 0),
        totalPortfolio: Number(updatedUser.capital || 0) + Number(updatedUser.netProfit || 0) + Number(updatedUser.referralEarnings || 0)
      }
      // include the updated transaction object for immediate UI update
      return res.json({ message: 'Withdraw approved', overview, tx: txDoc })
    }

    // fallback
    res.json({ message: 'Withdraw approved' })
  } catch (err) {
    try { session.endSession() } catch (e) {}
    if (err && err.code) return res.status(err.code).json({ message: err.message })
    next(err)
  }
}

/* ----- reject withdraw ----- */
exports.rejectWithdraw = async (req, res, next) => {
  try {
    const id = req.params.id
    const { reason } = req.body || {}
    const admin = req.user

    const tx = await Transaction.findById(id)
    if (!tx || tx.type !== 'withdraw') return res.status(404).json({ message: 'Withdraw request not found' })
    if (tx.status !== 'pending') return res.status(400).json({ message: 'Request already processed' })

    tx.status = 'rejected'
    tx.updatedAt = new Date()
    tx.adminRemarks = reason || `Rejected by ${admin.email}`
    await tx.save()

    await Audit.create({ admin: admin._id, action: 'reject-withdraw', meta: { txId: tx._id, reason } })

    try {
      const user = await User.findById(tx.user)
      await sendMail({ to: user.email, subject: `Withdrawal rejected`, html: `<p>Your withdrawal request was rejected. Reason: ${reason || 'No reason provided'}</p>` })
    } catch (err) { console.warn('notify user withdraw reject err', err.message || err) }

    try {
      await sendAdminNotification({
        subject: `Withdrawal rejected — ${tx.user} — ${tx._id}`,
        html: `<p>Withdrawal request rejected</p><p>TX ID: ${tx._id}</p><p>Reason: ${reason || 'No reason'}</p><p>Processed by: ${admin.email}</p>`
      })
    } catch (err) { console.warn('admin notify (reject withdraw) failed', err.message || err) }

    res.json({ message: 'Withdraw rejected' })
  } catch (err) { next(err) }
}

/* ----- approve deposit ----- */
exports.approveDeposit = async (req, res, next) => {
  try {
    const id = req.params.id
    const { approvedAmount } = req.body || {}
    const admin = req.user

    const tx = await Transaction.findById(id)
    if (!tx || tx.type !== 'deposit') return res.status(404).json({ message: 'Deposit request not found' })
    if (tx.status !== 'pending') return res.status(400).json({ message: 'Request already processed' })

    const user = await User.findById(tx.user)
    if (!user) return res.status(404).json({ message: 'User not found' })

    const amt = Number(approvedAmount ?? tx.amount)

    // --- Normalize/repair method storage to avoid casting issues when older records stored objects in `method` ---
    // Ensure tx.method is a string id and full method object (if any) is in tx.details.method
    try {
      tx.details = tx.details || {}
      if (tx.details.method) {
        // details.method already exists; ensure tx.method is set to id if not present
        const md = tx.details.method
        if (!tx.method || typeof tx.method !== 'string') {
          tx.method = (md && (md.id || md.type)) ? String(md.id || md.type) : tx.method
        }
      } else if (tx.method && typeof tx.method === 'object') {
        // legacy: method was stored as an object; move it into details.method and set method to id/type
        const legacy = tx.method
        tx.details.method = legacy
        tx.method = legacy.id ? String(legacy.id) : (legacy.type ? String(legacy.type) : String(legacy.id || legacy.type || 'bank'))
      }
      // At this point tx.method should be string (or undefined) and tx.details.method contains full object (if available)
    } catch (err) {
      // non-fatal; continue with cautious defaults
      console.warn('approveDeposit: normalize method failed', err?.message || err)
    }

    // Determine deposit parameters
    // Prefer explicit plan in tx.details.plan (may be { amount, ratePercent, rate, days } or similar)
    const planRaw = (tx.details && tx.details.plan) ? tx.details.plan : null

    // derive ratePercent
    let ratePercent = null
    if (planRaw && (typeof planRaw.ratePercent === 'number' || typeof planRaw.rate === 'number')) {
      ratePercent = (typeof planRaw.ratePercent === 'number') ? planRaw.ratePercent : planRaw.rate
    } else if (typeof tx.details?.ratePercent === 'number') {
      ratePercent = tx.details.ratePercent
    } else {
      ratePercent = rateForAmount(Number(amt || 0))
    }

    // days (calendar days)
    const days = Number((planRaw && Number(planRaw.days)) ? planRaw.days : (tx.details?.days ? tx.details.days : 60))

    // Use approval time as start (profit accrues immediately upon approval)
    const startDate = new Date()
    const endDate = new Date(startDate)
    endDate.setDate(endDate.getDate() + days)

    user.deposits = user.deposits || []
    // Add deposit subdocument — include both startDate and approvedAt so other codepaths find a canonical start immediately
    user.deposits.push({
      amount: amt,
      ratePercent: Number(ratePercent),
      days: Number(days),
      startDate,
      approvedAt: startDate,
      endDate,
      status: 'active'
    })

    user.capital = Number((Number(user.capital || 0) + amt).toFixed(2))
    await user.save()

    // update and normalize transaction fields to avoid casting problems and keep audit trail
    tx.status = 'approved'
    tx.updatedAt = new Date()
    tx.adminRemarks = `Approved by ${admin.email}`
    tx.details = tx.details || {}
    tx.details.approvedAmount = amt
    tx.details.approvedAt = startDate
    tx.details.approvedBy = admin._id ? admin._id.toString() : (admin.id || admin._id || 'admin')
    tx.details.appliedPlan = { ratePercent: Number(ratePercent), days: Number(days), amount: amt }

    // also set top-level approvedAt for convenience and canonical timestamp
    tx.approvedAt = startDate

    // ensure main method field is a string id (if not present, leave as undefined)
    if (tx.details && tx.details.method && typeof tx.details.method === 'object') {
      tx.method = tx.method || (tx.details.method.id ? String(tx.details.method.id) : (tx.details.method.type ? String(tx.details.method.type) : tx.method))
    } else if (tx.method && typeof tx.method !== 'string') {
      // fallback: stringify
      tx.method = String(tx.method)
    }

    await tx.save()

    await Audit.create({ admin: admin._id, action: 'approve-deposit', meta: { txId: tx._id, approvedAmount: amt } })

    // ----- improved referral handling -----
    // Try to find referrer by explicit referredBy on the user, otherwise fallback to snapshot search
    let referrer = null
    try {
      if (user.referredBy) {
        referrer = await User.findById(user.referredBy)
      }
      if (!referrer) {
        // fallback: find a user that has a snapshot entry referencing this user
        referrer = await User.findOne({ 'referrals.user': user._id })
      }
    } catch (err) {
      console.warn('approveDeposit: error finding referrer', err.message || err)
      referrer = null
    }

    if (referrer) {
      // Read environment REFERRAL_RATE and parse to a number. Accepts '0.05' (5%) or '.05' etc.
      // Default to 0.05 (5%) if not set or invalid.
      const envVal = process.env.REFERRAL_RATE
      let referralRate = 0.05
      if (typeof envVal === 'string' && envVal.trim() !== '') {
        const parsed = parseFloat(envVal)
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) referralRate = parsed
      } else if (typeof envVal === 'number' && !Number.isNaN(envVal)) {
        referralRate = envVal
      }

      const commission = Number((amt * referralRate).toFixed(2))

      referrer.referralEarnings = Number((referrer.referralEarnings || 0) + commission)

      // Find existing snapshot entry pointing to this referred user
      referrer.referrals = referrer.referrals || []
      let entry = referrer.referrals.find(r => {
        if (!r) return false
        // r.user might be an ObjectId or string
        try {
          return r.user && r.user.toString() === user._id.toString()
        } catch (e) {
          return false
        }
      })

      if (entry) {
        entry.capital = Number((entry.capital || 0) + amt)
        entry.commissionEarned = Number((entry.commissionEarned || 0) + commission)
      } else {
        // push a new snapshot entry so admin UI and referrer can see it going forward
        referrer.referrals.push({
          user: user._id,
          email: user.email,
          capital: amt,
          commissionEarned: commission,
          createdAt: new Date()
        })
      }

      await referrer.save()
    }

    // notify user + admin
    try {
      // Note: updated message to reflect immediate accrual (no 24-hour delay)
      await sendMail({ to: user.email, subject: `Deposit approved — ${amt}`, html: `<p>Your deposit of ${amt} has been approved and added to your capital.</p><p>Profit starts accruing immediately after approval and accrues on business days (weekdays) only.</p>` })
    } catch (err) { console.warn('notify user deposit err', err.message || err) }

    try {
      await sendAdminNotification({
        subject: `Deposit approved — ${user.email} — ${amt}`,
        html: `<p>Deposit approved</p><p>User: ${user.email}</p><p>Amount: ${amt}</p><p>New capital: ${user.capital}</p><p>Processed by: ${admin.email}</p>`
      })
    } catch (err) { console.warn('admin notify (approve deposit) failed', err.message || err) }

    // Return the updated user and transaction so frontend can update the UI immediately (includes approvedAt)
    return res.json({ message: 'Deposit approved', user, tx })
  } catch (err) { next(err) }
}

/* ----- reject deposit ----- */
exports.rejectDeposit = async (req, res, next) => {
  try {
    const id = req.params.id
    const { reason } = req.body || {}
    const admin = req.user

    const tx = await Transaction.findById(id)
    if (!tx || tx.type !== 'deposit') return res.status(404).json({ message: 'Deposit request not found' })
    if (tx.status !== 'pending') return res.status(400).json({ message: 'Request already processed' })

    tx.status = 'rejected'
    tx.updatedAt = new Date()
    tx.adminRemarks = reason || `Rejected by ${admin.email}`
    await tx.save()

    await Audit.create({ admin: admin._id, action: 'reject-deposit', meta: { txId: tx._id, reason } })

    try {
      const user = await User.findById(tx.user)
      await sendMail({ to: user.email, subject: `Deposit rejected`, html: `<p>Your deposit request was rejected. Reason: ${reason || 'No reason provided'}</p>` })
    } catch (err) { console.warn('notify user deposit reject err', err.message || err) }

    try {
      await sendAdminNotification({
        subject: `Deposit rejected — ${tx.user} — ${tx._id}`,
        html: `<p>Deposit rejected</p><p>TX ID: ${tx._id}</p><p>Reason: ${reason || 'No reason'}</p><p>Processed by: ${admin.email}</p>`
      })
    } catch (err) { console.warn('admin notify (reject deposit) failed', err.message || err) }

    res.json({ message: 'Deposit rejected' })
  } catch (err) { next(err) }
}

/* ======= Users management (admin) ======= */

/**
 * listUsers - admin listing with filters & pagination
 * Query params supported:
 *  q (name or email), profile (profileType OR role), registeredFrom, registeredTo,
 *  minCapital, maxCapital, lastLoginFrom, lastLoginTo, page, perPage
 *
 * Note: excludes users with deleted: true
 */
exports.listUsers = async (req, res, next) => {
  try {
    const q = req.query.q
    const profile = req.query.profile
    const registeredFrom = req.query.registeredFrom
    const registeredTo = req.query.registeredTo
    const minCapital = req.query.minCapital
    const maxCapital = req.query.maxCapital
    const lastLoginFrom = req.query.lastLoginFrom
    const lastLoginTo = req.query.lastLoginTo
    const page = Math.max(1, parseInt(req.query.page || '1', 10))
    const perPage = Math.max(1, Math.min(200, parseInt(req.query.perPage || '30', 10)))

    const match = { deleted: { $ne: true } } // exclude soft-deleted users

    if (q) {
      match.$or = [
        { email: new RegExp(q, 'i') },
        { firstName: new RegExp(q, 'i') },
        { lastName: new RegExp(q, 'i') }
      ]
    }

    if (profile && profile !== 'all') {
      match.$or = match.$or || []
      match.$or.push({ profileType: profile }, { role: profile })
    }

    if (registeredFrom || registeredTo) {
      match.createdAt = {}
      if (registeredFrom) match.createdAt.$gte = new Date(registeredFrom)
      if (registeredTo) {
        const d = new Date(registeredTo)
        d.setHours(23,59,59,999)
        match.createdAt.$lte = d
      }
    }

    if (minCapital || maxCapital) {
      match.capital = {}
      if (minCapital) match.capital.$gte = Number(minCapital)
      if (maxCapital) match.capital.$lte = Number(maxCapital)
    }

    if (lastLoginFrom || lastLoginTo) {
      match.lastLogin = {}
      if (lastLoginFrom) match.lastLogin.$gte = new Date(lastLoginFrom)
      if (lastLoginTo) {
        const d = new Date(lastLoginTo)
        d.setHours(23,59,59,999)
        match.lastLogin.$lte = d
      }
    }

    // cleanup empty filter objects
    Object.keys(match).forEach(k => {
      if (match[k] && typeof match[k] === 'object' && Object.keys(match[k]).length === 0) delete match[k]
    })

    const total = await User.countDocuments(match)
    const users = await User.find(match)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)

    res.json({ users, total, page, perPage })
  } catch (err) { next(err) }
}

/**
 * getUser - return single user by id (admin)
 *
 * Enhanced: returns a merged referrals array (snapshot + live referredBy users)
 * so the admin UI sees both legacy snapshots and current referred users.
 */
exports.getUser = async (req, res, next) => {
  try {
    const id = req.params.id
    const user = await User.findById(id).select('-password').lean()
    if (!user) return res.status(404).json({ message: 'User not found' })

    // Build merged referrals: combine snapshot (user.referrals) and live users with referredBy == user._id
    try {
      const snapshot = Array.isArray(user.referrals) ? user.referrals : []
      // find live referred users
      const live = await User.find({ referredBy: user._id }).select('email capital referralEarnings _id').lean()

      const map = new Map()
      // add live users
      for (const lu of live || []) {
        const key = (lu._id || '').toString() || (lu.email || '').toLowerCase()
        map.set(key, {
          _id: lu._id,
          email: lu.email || '—',
          capital: Number(lu.capital || 0),
          referralEarning: Number(lu.referralEarnings || 0),
          _source: 'live'
        })
      }

      // merge snapshot entries
      for (const r of snapshot) {
        const rUserId = r.user ? ( (typeof r.user === 'object' && r.user._id) ? String(r.user._id) : String(r.user) ) : null
        const key = rUserId || (r.email || '').toLowerCase()
        const commission = Number(r.commissionEarned ?? r.referralEarning ?? 0)
        if (map.has(key)) {
          const existing = map.get(key)
          existing.referralEarning = Number((existing.referralEarning || 0) + commission)
          existing._source = existing._source === 'live' ? 'live+snapshot' : 'merged'
          map.set(key, existing)
        } else {
          map.set(key, {
            _id: rUserId || null,
            email: r.email || (r.user && r.user.email) || '—',
            capital: Number(r.capital || (r.user && r.user.capital) || 0),
            referralEarning: commission,
            _source: 'snapshot'
          })
        }
      }

      const referrals = Array.from(map.values()).map(rr => ({
        _id: rr._id || null,
        email: rr.email,
        capital: Number(rr.capital || 0),
        referralEarning: Number(rr.referralEarning || 0)
      }))

      user.referrals = referrals
    } catch (err) {
      // non-fatal: keep whatever is on user.referrals if merge fails
      console.warn('getUser: merging referrals failed', err.message || err)
    }

    res.json({ user })
  } catch (err) { next(err) }
}

/**
 * getUserTransactions - admin view for a user's transactions
 */
exports.getUserTransactions = async (req, res, next) => {
  try {
    const id = req.params.id
    const user = await User.findById(id).select('_id')
    if (!user) return res.status(404).json({ message: 'User not found' })
    const txs = await Transaction.find({ user: id }).sort({ createdAt: -1 })
    res.json({ transactions: txs })
  } catch (err) { next(err) }
}

/**
 * updateUser - admin can update profile fields & balances
 * Accepts referrals[] and deleted flag as well
 */
exports.updateUser = async (req, res, next) => {
  try {
    const id = req.params.id
    const allowed = ['firstName','lastName','phone','country','profileType','role','capital','netProfit','referralEarnings','email','referrals','deleted']
    const updates = {}
    for (const k of allowed) {
      if (typeof req.body[k] !== 'undefined') updates[k] = req.body[k]
    }

    if (updates.email) updates.email = ('' + updates.email).toLowerCase()

    const user = await User.findByIdAndUpdate(id, updates, { new: true }).select('-password')
    if (!user) return res.status(404).json({ message: 'User not found' })

    await Audit.create({ admin: req.user._id, action: 'admin-update-user', meta: { userId: id, updates } })
    res.json({ user })
  } catch (err) { next(err) }
}

/**
 * deleteUser - soft-delete (mark deleted = true)
 */
exports.deleteUser = async (req, res, next) => {
  try {
    const id = req.params.id
    const user = await User.findById(id)
    if (!user) return res.status(404).json({ message: 'User not found' })

    user.deleted = true
    await user.save()

    await Audit.create({ admin: req.user._id, action: 'admin-soft-delete-user', meta: { userId: id, email: user.email } })

    try {
      await sendAdminNotification({ subject: `User soft-deleted — ${user.email}`, html: `<p>Admin ${req.user.email} marked user ${user.email} as deleted</p>` })
    } catch (err) { console.warn('admin notify (soft delete) failed', err.message || err) }

    res.json({ message: 'User soft-deleted' })
  } catch (err) { next(err) }
}

/* ======= Other admin helpers (legacy) ======= */
exports.listUsersShort = async (req, res, next) => {
  try {
    const users = await User.find().select('-password').limit(500)
    res.json({ users })
  } catch (err) { next(err) }
}

exports.updateBalances = async (req, res, next) => {
  try {
    const id = req.params.id
    const { capital, netProfit, referralEarnings } = req.body
    const user = await User.findById(id)
    if (!user) return res.status(404).json({ message: 'User not found' })
    if (typeof capital === 'number') user.capital = capital
    if (typeof netProfit === 'number') user.netProfit = netProfit
    if (typeof referralEarnings === 'number') user.referralEarnings = referralEarnings
    await user.save()
    await Audit.create({ admin: req.user._id, action: 'update-balances', meta: { userId: id, changes: { capital, netProfit, referralEarnings } } })
    res.json({ user })
  } catch (err) { next(err) }
}

/**
 * POST /api/admin/message
 * Body: { to: [userIdOrEmail, ...], subject, body }
 * Admin sends a message to one or many users. Message saved to each user's _messages and email sent.
 */
exports.sendMessage = async (req, res, next) => {
  try {
    const admin = req.user
    const { to, subject, body } = req.body || {}
    if (!to || !Array.isArray(to) || to.length === 0) return res.status(400).json({ message: 'No recipients provided' })
    if (!body && !subject) return res.status(400).json({ message: 'Message body or subject required' })

    const results = { sent: 0, notFound: [] }
    for (const recipient of to) {
      // recipient can be a user id or an email
      let user = null
      if (/^[0-9a-fA-F]{24}$/.test(String(recipient))) {
        user = await User.findById(recipient)
      } else if (typeof recipient === 'string' && recipient.includes('@')) {
        user = await User.findOne({ email: recipient.toLowerCase() })
      }

      if (!user) {
        results.notFound.push(recipient)
        continue
      }

      user._messages = user._messages || []
      user._messages.push({
        from: 'admin',
        subject: subject || '',
        body: body || '',
        createdAt: new Date(),
        read: false,
        meta: { admin: admin._id }
      })
      await user.save()

      // Send email to the user
      try {
        await sendMail({
          to: user.email,
          subject: subject || `Message from Gainbridge admin`,
          html: `<p>You have a new message from management:</p>
                 ${subject ? `<p><strong>${subject}</strong></p>` : ''}
                 <div>${(body || '').replace(/\n/g, '<br/>')}</div>
                 <hr/>
                 <p>You can also view messages in your account dashboard.</p>`
        })
      } catch (err) {
        console.warn('admin sendMessage mail err', err.message || err)
      }

      results.sent += 1
    }

    await Audit.create({ admin: admin._id, action: 'admin-send-message', meta: { to, subject, sent: results.sent, notFound: results.notFound } })
    res.json({ message: 'Messages processed', results })
  } catch (err) { next(err) }
}

/**
 * GET /api/admin/user/:id/messages
 * Admin fetches messages for a particular user
 */
exports.getUserMessages = async (req, res, next) => {
  try {
    const id = req.params.id
    const user = await User.findById(id).select('_messages email firstName lastName')
    if (!user) return res.status(404).json({ message: 'User not found' })
    // option: mark unread messages as read? We'll just return the messages
    res.json({ messages: user._messages || [], user: { _id: user._id, email: user.email, name: `${user.firstName || ''} ${user.lastName || ''}`.trim() } })
  } catch (err) { next(err) }
}
