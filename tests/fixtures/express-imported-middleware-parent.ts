import express from 'express'
import { requireAuth } from './express-imported-middleware.js'

const app = express()

app.use('/api', requireAuth)
