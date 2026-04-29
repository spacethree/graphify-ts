const express = require('express')
import * as child from './express-namespace-module-child.js'

function requireAuth(_req: unknown, _res: unknown, next: () => void) {
  next()
}

const app = express()

app.use('/api', requireAuth, child.router)

export default app
