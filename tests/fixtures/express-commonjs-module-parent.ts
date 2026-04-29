const express = require('express')
const child = require('./express-commonjs-module-child')

function requireAuth(_req: unknown, _res: unknown, next: () => void) {
  next()
}

const app = express()

app.use('/api', requireAuth, child.router)

module.exports = app
