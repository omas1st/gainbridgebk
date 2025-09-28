// server.js (replace existing or add the public mount)
require('dotenv').config()
const express = require('express')
const path = require('path')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')
const connectDB = require('./config/db')
const errorHandler = require('./middleware/errorHandler')

const authRoutes = require('./routes/auth')
const userRoutes = require('./routes/users')
const adminRoutes = require('./routes/admin')
const notifyRoutes = require('./routes/notify')
const publicRoutes = require('./routes/public') // <-- existing
const settingsRoutes = require('./routes/settings') // <-- added: public settings endpoint

const app = express()
connectDB()

app.use(helmet())
app.use(cors())
app.use(express.json())
app.use(morgan('dev'))

app.use('/api/auth', authRoutes)
app.use('/api/users', userRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/notify', notifyRoutes)
app.use('/api/public', publicRoutes) // <-- mount public endpoints
app.use('/api/settings', settingsRoutes) // <-- mount settings (public) endpoint

app.get('/', (req, res) => res.send('GainBridge API — running. Visit /api for endpoints.'))
app.get('/api', (req, res) => res.json({
  message: 'GainBridge API root. Available routes: /api/auth, /api/users, /api/admin, /api/notify, /api/public, /api/settings'
}))

const clientBuildPath = path.join(__dirname, '..', 'client', 'build')
if (process.env.NODE_ENV === 'production') {
  try {
    app.use(express.static(clientBuildPath))
    app.get('*', (req, res) => res.sendFile(path.join(clientBuildPath, 'index.html')))
  } catch (err) {
    console.warn('No client build found at', clientBuildPath)
  }
}

app.use(errorHandler)

const PORT = process.env.PORT || 5000
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
