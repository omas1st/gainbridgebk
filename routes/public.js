// routes/public.js
const express = require('express')
const router = express.Router()
const { stats } = require('../controllers/publicController')

// GET /api/public/stats
router.get('/stats', stats)

module.exports = router
