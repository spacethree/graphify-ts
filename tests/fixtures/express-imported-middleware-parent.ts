import express from 'express'
import { requireAuth } from './express-imported-middleware'

const app = express()

app.use('/api', requireAuth)
