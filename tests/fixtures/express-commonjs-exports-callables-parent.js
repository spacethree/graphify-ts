import express from 'express'

const { requireAuth } = require('./express-commonjs-exports-callable-middleware')
import { showUser } from './express-commonjs-exports-callable-handler.js'

const router = express.Router()

router.get('/users/:id', requireAuth, showUser)
