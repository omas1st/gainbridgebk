// controllers/publicController.js
const User = require('../models/User')

exports.stats = async (req, res, next) => {
  try {
    // total registered users (include both user & agent)
    const totalUsers = await User.countDocuments({})

    // members online = users with lastLogin within the last 1 hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const onlineUsers = await User.countDocuments({ lastLogin: { $gte: oneHourAgo } })

    res.json({ totalUsers, onlineUsers })
  } catch (err) {
    next(err)
  }
}
