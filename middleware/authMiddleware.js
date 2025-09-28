// middleware/authMiddleware.js
const jwt = require('jsonwebtoken')
const User = require('../models/User')

exports.protect = async (req, res, next) => {
  let token = null
  const auth = req.headers.authorization
  if (auth && auth.startsWith('Bearer ')) token = auth.split(' ')[1]
  if (!token) return res.status(401).json({ message: 'Not authorized' })

  try {
    // Support both JWT_SECRET and legacy secret_key env names
    const secret = process.env.JWT_SECRET || process.env.secret_key
    if (!secret) return res.status(500).json({ message: 'Server JWT secret not configured' })

    const decoded = jwt.verify(token, secret)
    req.user = await User.findById(decoded.id).select('-password')
    if (!req.user) return res.status(401).json({ message: 'User not found' })
    next()
  } catch (err) {
    console.error(err)
    return res.status(401).json({ message: 'Token invalid' })
  }
}
