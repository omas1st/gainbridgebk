// utils/email.js
// Nodemailer helper that supports either an explicit SMTP server (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS)
// OR a Gmail account via ADMIN_EMAIL + ADMIN_EMAIL_PASSWORD.
// NOTE: For Gmail it's strongly recommended to use an App Password (not your normal account password).
// If you use a normal password you may run into "authentication disabled" errors unless you configure the account.

const nodemailer = require('nodemailer')

function createTransporter() {
  // If explicit SMTP is configured, prefer that
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    })
  }

  // Else if ADMIN_EMAIL and ADMIN_EMAIL_PASSWORD are provided, use Gmail SMTP
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_EMAIL_PASSWORD) {
    // Use Gmail's SMTP: smtp.gmail.com
    // Prefer port 465 (secure). If issues, you can switch to 587 and secure:false with TLS.
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.ADMIN_EMAIL,
        pass: process.env.ADMIN_EMAIL_PASSWORD
      }
    })
  }

  // As a fallback, create an unauthenticated transporter (useful for dev with local SMTP)
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: Number(process.env.SMTP_PORT || 25),
    secure: false,
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    } : undefined
  })
}

const transporter = createTransporter()

async function sendMail({ to, subject, html, text }) {
  const from = process.env.ADMIN_EMAIL || process.env.SMTP_USER || `no-reply@${process.env.SMTP_HOST || 'localhost'}`
  const info = await transporter.sendMail({
    from,
    to,
    subject,
    html,
    text
  })
  return info
}

async function sendAdminNotification({ subject, html, text }) {
  const admin = process.env.ADMIN_EMAIL
  if (!admin) throw new Error('ADMIN_EMAIL not configured')
  return sendMail({ to: admin, subject, html, text })
}

module.exports = { sendMail, sendAdminNotification }
