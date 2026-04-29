import express from 'express'
import { apiRouter } from './virtual-express-child.js'

const app = express()

app.use('/api', apiRouter)
