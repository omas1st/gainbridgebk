// routes/admin.js
const express = require('express')
const router = express.Router()
const { protect } = require('../middleware/authMiddleware')
const { isAdmin } = require('../middleware/adminMiddleware')
const adminController = require('../controllers/adminController')
const settingsController = require('../controllers/settingsController')

// protect + isAdmin for all admin routes
router.use(protect, isAdmin)

// Admin settings endpoints
router.get('/settings', settingsController.getAdminSettings)
router.put('/settings', settingsController.updateAdminSettings)

router.get('/withdraws', adminController.listWithdraws) // ?status=pending
router.get('/deposits', adminController.listDeposits)

// history endpoints
router.get('/requests/history', adminController.history)
router.get('/history', adminController.history)

// unified requests list & actions
router.get('/requests', adminController.listRequests)
router.post('/requests/:id/approve', adminController.approveRequest)
router.post('/requests/:id/reject', adminController.rejectRequest)

// === Messages (new) ===
// Admin send message to users (body.to = [userIdOrEmail...])
router.post('/message', adminController.sendMessage)
// Admin read a particular user's messages
router.get('/user/:id/messages', adminController.getUserMessages)

// user management endpoints
router.get('/users', adminController.listUsers)
router.get('/user/:id', adminController.getUser) // get single user details
router.get('/user/:id/transactions', adminController.getUserTransactions)
router.patch('/user/:id', adminController.updateUser)
router.delete('/user/:id', adminController.deleteUser)

// legacy / compatibility
router.get('/users/:id', adminController.getUser)
router.put('/users/:id/balances', adminController.updateBalances)

router.post('/withdraws/:id/approve', adminController.approveWithdraw)
router.post('/withdraws/:id/reject', adminController.rejectWithdraw)

router.post('/deposits/:id/approve', adminController.approveDeposit)
router.post('/deposits/:id/reject', adminController.rejectDeposit)

module.exports = router
