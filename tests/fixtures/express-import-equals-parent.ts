// @ts-nocheck
import express = require('express')
import child = require('./express-import-equals-child')

function requireAuth(_req: unknown, _res: unknown, next: () => void) {
  next()
}

const app = express()

app.use('/api', requireAuth, child.router)

module.exports = app
