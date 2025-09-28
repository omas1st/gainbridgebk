// scripts/seedAdmin.js
require('dotenv').config()
const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const User = require('../models/User')
const connectDB = require('../config/db')

async function seed() {
  try {
    await connectDB()
    const username = process.env.ADMIN_USERNAME || 'admin'
    const password = process.env.ADMIN_PASSWORD || 'admin123'
    const email = process.env.ADMIN_EMAIL || 'admin@example.com'

    const existing = await User.findOne({ email: email.toLowerCase() })
    if (existing) {
      console.log('Admin user already exists:', existing.email)
      process.exit(0)
    }

    const hashed = await bcrypt.hash(password, 10)
    const admin = new User({
      username,
      firstName: 'Admin',
      lastName: 'User',
      email: email.toLowerCase(),
      password: hashed,
      phone: '',
      role: 'admin',
      capital: 0
    })
    await admin.save()
    console.log('Admin user created:', admin.email)
    process.exit(0)
  } catch (err) {
    console.error('Seed failed', err)
    process.exit(1)
  }
}

seed()
