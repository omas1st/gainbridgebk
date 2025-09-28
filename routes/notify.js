const express = require('express')
const router = express.Router()
const { notifyRegistration, notifyLogin, test } = require('../controllers/notifyController')

router.post('/new-registration', notifyRegistration)
router.post('/login', notifyLogin)
router.post('/test', test) // body: { subject, html, text } -> sends to ADMIN_EMAIL

module.exports = router
