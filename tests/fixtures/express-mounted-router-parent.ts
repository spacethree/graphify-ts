import express from 'express'
import { apiRouter } from './express-mounted-router-child.js'

function requireAuth(_req: unknown, _res: unknown, next: () => void) {
  next()
}

const app = express()

app.use('/api', requireAuth, apiRouter)
