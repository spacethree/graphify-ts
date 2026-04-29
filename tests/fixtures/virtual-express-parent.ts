import express from 'express'
import { apiRouter } from './virtual-express-child.ts'

const app = express()

app.use('/api', apiRouter)
