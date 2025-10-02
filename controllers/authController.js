// controllers/authController.js
const crypto = require('crypto')
const User = require('../models/User')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { sendAdminNotification } = require('../utils/email')

// Currency configuration for supported countries
const CURRENCY_CONFIG = {
  'South Africa': { code: 'ZAR', rate: 17, symbol: 'R' },
  'Nigeria': { code: 'NGN', rate: 1500, symbol: '₦' },
  'Ghana': { code: 'GHS', rate: 12.50, symbol: 'GH₵' },
  'Philippines': { code: 'PHP', rate: 58, symbol: '₱' }
};

function signToken(user) {
  const secret = process.env.JWT_SECRET || process.env.secret_key
  if (!secret) throw new Error('JWT secret not configured (set JWT_SECRET or secret_key)')
  return jwt.sign({ id: user._id }, secret, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' })
}

function validatePassword(password) {
  const failures = []
  if (!password || typeof password !== 'string') {
    failures.push('Password is required')
    return { ok: false, failures }
  }
  if (password.length < 8) failures.push('At least 8 characters')
  if (!/[A-Z]/.test(password)) failures.push('At least one uppercase letter (A-Z)')
  if (!/[a-z]/.test(password)) failures.push('At least one lowercase letter (a-z)')
  if (!/[0-9]/.test(password)) failures.push('At least one number (0-9)')
  // special characters: keep a generous set
  if (!/[!@#\$%\^&\*\(\)\-_\+=\[\]\{\};:'",.<>\/\?\\|`~]/.test(password)) failures.push('At least one special character (e.g. !@#$%)')
  return { ok: failures.length === 0, failures }
}

// Helper function to get currency config for a country
function getCurrencyConfig(country) {
  return CURRENCY_CONFIG[country] || null;
}

// Helper function to format converted amount
function formatConvertedAmount(usdAmount, country) {
  const currencyConfig = getCurrencyConfig(country);
  if (!currencyConfig) return null;
  
  const converted = (Number(usdAmount || 0) * currencyConfig.rate).toFixed(2);
  return `${currencyConfig.symbol}${converted}`;
}

exports.register = async (req, res, next) => {
  try {
    const { firstName, lastName, email, password, phone, country, profileType, gender } = req.body
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' })

    // Server-side password strength validation
    const pwCheck = validatePassword(password)
    if (!pwCheck.ok) {
      return res.status(400).json({ message: 'Password does not meet strength requirements', details: pwCheck.failures })
    }

    const existing = await User.findOne({ email: email.toLowerCase() })
    if (existing) return res.status(400).json({ message: 'Email already registered' })

    // If referral code provided in body or query (optional), try to resolve referrer first
    const refCode = req.body.ref || req.query.ref
    let referrer = null
    if (refCode) {
      try {
        referrer = await User.findOne({ username: refCode })
      } catch (err) {
        referrer = null
      }
    }

    const hashed = await bcrypt.hash(password, 10)
    const username = (email.split('@')[0] + Math.random().toString(36).slice(2,8)).toLowerCase()

    const userData = {
      username,
      firstName: firstName || '',
      lastName: lastName || '',
      email: email.toLowerCase(),
      password: hashed,
      phone: phone || '',
      country: country || '',
      role: profileType === 'Agent account' ? 'agent' : 'user',
      gender: gender || '',
      capital: 0,
      netProfit: 0,
      referralEarnings: 0,
      deposits: [],
      referrals: []
    }

    // if we resolved a referrer, set referredBy on the new user
    if (referrer && referrer._id) {
      userData.referredBy = referrer._id
    }

    const user = new User(userData)
    await user.save()

    // If referrer was found, add a snapshot entry to the referrer's referrals (backwards-compatible)
    if (referrer) {
      try {
        referrer.referrals = referrer.referrals || []
        referrer.referrals.push({ user: user._id, email: user.email, capital: 0, commissionEarned: 0, createdAt: new Date() })
        await referrer.save()
      } catch (err) {
        console.warn('register: failed to push snapshot into referrer', err.message || err)
      }
    }

    // Notify admin about new registration (best-effort)
    try {
      await sendAdminNotification({
        subject: `New registration — ${user.email}`,
        html: `<p>New user registered.</p>
               <p><strong>Name:</strong> ${firstName || ''} ${lastName || ''}</p>
               <p><strong>Email:</strong> ${user.email}</p>
               <p><strong>Phone:</strong> ${phone || ''}</p>
               <p><strong>Country:</strong> ${country || ''}</p>
               <p><strong>Capital:</strong> ${user.capital}</p>`
      })
    } catch (err) {
      console.warn('Admin notify failed:', err.message || err)
    }

    const token = signToken(user)
    const userSafe = user.toObject(); delete userSafe.password
    res.json({ user: userSafe, token })
  } catch (err) { next(err) }
}

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' })
    const user = await User.findOne({ email: email.toLowerCase() })
    if (!user) return res.status(400).json({ message: 'Invalid credentials' })
    const match = await bcrypt.compare(password, user.password)
    if (!match) return res.status(400).json({ message: 'Invalid credentials' })

    user.lastLogin = new Date()
    await user.save()

    // Notify admin on login (best-effort)
    try {
      await sendAdminNotification({
        subject: `User login — ${user.email}`,
        html: `<p>User logged in.</p>
               <p><strong>Name:</strong> ${user.firstName || ''} ${user.lastName || ''}</p>
               <p><strong>Email:</strong> ${user.email}</p>
               <p><strong>Phone:</strong> ${user.phone || ''}</p>
               <p><strong>Country:</strong> ${user.country || ''}</p>
               <p><strong>Capital:</strong> ${user.capital}</p>`
      })
    } catch (err) {
      console.warn('Admin notify failed:', err.message || err)
    }

    const token = signToken(user)
    const userSafe = user.toObject(); delete userSafe.password
    res.json({ user: userSafe, token })
  } catch (err) { next(err) }
}

exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body
    const auth = req.headers.authorization
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ message: 'Not authorized' })
    const token = auth.split(' ')[1]
    const secret = process.env.JWT_SECRET || process.env.secret_key
    if (!secret) return res.status(500).json({ message: 'Server JWT secret not configured' })
    const decoded = jwt.verify(token, secret)
    const user = await User.findById(decoded.id)
    if (!user) return res.status(404).json({ message: 'User not found' })
    const ok = await bcrypt.compare(currentPassword, user.password)
    if (!ok) return res.status(400).json({ message: 'Current password incorrect' })

    // Validate new password strength on change as well
    const pwCheck = validatePassword(newPassword)
    if (!pwCheck.ok) {
      return res.status(400).json({ message: 'New password does not meet strength requirements', details: pwCheck.failures })
    }

    user.password = await bcrypt.hash(newPassword, 10)
    await user.save()
    res.json({ message: 'Password changed' })
  } catch (err) { next(err) }
}

/**
 * POST /auth/verify-reset
 * Body: { email, firstName, lastName, phone }
 *
 * Verifies identity fields and, if matched, generates a secure short-lived resetToken that is returned.
 * The token is stored in the DB as a hashed value with an expiry.
 *
 * Note: This endpoint returns the token in the response to support the UX where the user sets password
 * immediately in the app. If you prefer email-only flow, send the token by email instead and don't return it.
 */
exports.verifyReset = async (req, res, next) => {
  try {
    const { email, firstName, lastName, phone } = req.body || {}
    if (!email || !firstName || !lastName || !phone) {
      return res.status(400).json({ message: 'Email, firstName, lastName and phone are required' })
    }

    const normalizedEmail = String(email).toLowerCase().trim()
    const u = await User.findOne({ email: normalizedEmail }).exec()
    if (!u) {
      // generic message to avoid enumeration
      return res.status(400).json({ message: 'Verification failed — details do not match our records' })
    }

    const matchFirst = String(u.firstName || '').trim().toLowerCase() === String(firstName).trim().toLowerCase()
    const matchLast = String(u.lastName || '').trim().toLowerCase() === String(lastName).trim().toLowerCase()
    const matchPhone = String(u.phone || '').trim() === String(phone).trim()

    if (!matchFirst || !matchLast || !matchPhone) {
      return res.status(400).json({ message: 'Verification failed — details do not match our records' })
    }

    // generate secure raw token and store its sha256 hash in DB
    const rawToken = crypto.randomBytes(24).toString('hex') // ~48 chars
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    const expiry = new Date(Date.now() + (60 * 60 * 1000)) // 1 hour

    u.resetPasswordTokenHash = tokenHash
    u.resetPasswordExpires = expiry
    await u.save()

    // return allowed + raw token so frontend can use it immediately
    return res.json({ allowed: true, resetToken: rawToken })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /auth/reset-password
 * Body: { email, password, resetToken }
 *
 * Validates the token (hash + expiry) then updates the user's password securely.
 */
exports.resetPassword = async (req, res, next) => {
  try {
    const { email, password, resetToken } = req.body || {}
    if (!email || !password || !resetToken) {
      return res.status(400).json({ message: 'Email, password and resetToken are required' })
    }

    // server-side password validation
    const passCheck = validatePassword(password)
    if (!passCheck.ok) return res.status(400).json({ message: passCheck.failures ? passCheck.failures.join('; ') : 'Password validation failed' })

    const normalizedEmail = String(email).toLowerCase().trim()
    const user = await User.findOne({ email: normalizedEmail }).exec()
    if (!user) return res.status(400).json({ message: 'Invalid token or email' })

    if (!user.resetPasswordTokenHash || !user.resetPasswordExpires) {
      return res.status(400).json({ message: 'No reset request found for this account' })
    }

    if (user.resetPasswordExpires.getTime() < Date.now()) {
      // clear expired token fields for hygiene
      user.resetPasswordTokenHash = null
      user.resetPasswordExpires = null
      await user.save().catch(()=>{})
      return res.status(400).json({ message: 'Reset token has expired' })
    }

    // hash incoming token and compare
    const incomingHash = crypto.createHash('sha256').update(String(resetToken)).digest('hex')
    if (incomingHash !== user.resetPasswordTokenHash) {
      return res.status(400).json({ message: 'Invalid reset token' })
    }

    // all good: hash new password and persist
    const hashed = await bcrypt.hash(password, 10)
    user.password = hashed

    // clear token fields
    user.resetPasswordTokenHash = null
    user.resetPasswordExpires = null

    await user.save()

    // optional: notify admin that a password reset occurred (best-effort)
    try {
      await sendAdminNotification({
        subject: `Password reset — ${user.email}`,
        html: `<p>User password reset completed for ${user.email}</p>
               <p><strong>Name:</strong> ${user.firstName || ''} ${user.lastName || ''}</p>`
      })
    } catch (err) {
      console.warn('Admin notify failed (resetPassword):', err.message || err)
    }

    return res.json({ message: 'Password updated' })
  } catch (err) {
    next(err)
  }
}

// Export currency helper functions for use in other controllers
exports.getCurrencyConfig = getCurrencyConfig;
exports.formatConvertedAmount = formatConvertedAmount;