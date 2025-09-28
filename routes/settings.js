// routes/settings.js
const express = require('express')
const router = express.Router()
const settingsController = require('../controllers/settingsController')

router.get('/', settingsController.getPublicSettings)

module.exports = router
