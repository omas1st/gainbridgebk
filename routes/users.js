// routes/users.js
const express = require('express')
const router = express.Router()
const { protect } = require('../middleware/authMiddleware')
const {
  getOverview,
  getTransactions,
  getReferrals,
  updateProfile,
  createWithdrawRequest,
  createDepositRequest,
  getMessages,
  postMessage
} = require('../controllers/userController')

// All routes under /api/users
router.get('/:id/overview', protect, getOverview)
router.get('/:id/transactions', protect, getTransactions)
router.get('/:id/referrals', protect, getReferrals)

// Accept both PUT and PATCH for profile updates (frontend uses PATCH)
router.put('/:id', protect, updateProfile)
router.patch('/:id', protect, updateProfile)

router.post('/:id/withdraw', protect, createWithdrawRequest)
router.post('/:id/deposit', protect, createDepositRequest)

// messages
router.get('/:id/messages', protect, getMessages)
router.post('/:id/messages', protect, postMessage)

module.exports = router
