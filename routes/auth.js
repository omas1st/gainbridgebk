// routes/auth.js
const express = require('express')
const router = express.Router()
const { register, login, changePassword, verifyReset, resetPassword } = require('../controllers/authController')

// register and login
router.post('/register', register)
router.post('/login', login)
router.post('/change-password', changePassword)

// password reset / verification
router.post('/verify-reset', verifyReset)
router.post('/reset-password', resetPassword)

module.exports = router
