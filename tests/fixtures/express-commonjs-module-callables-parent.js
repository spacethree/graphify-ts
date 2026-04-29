import express from 'express'
import { requireAuth } from './express-commonjs-module-callable-middleware.js'

const { showUser } = require('./express-commonjs-module-callable-handler')
const router = express.Router()

router.get('/users/:id', requireAuth, showUser)
