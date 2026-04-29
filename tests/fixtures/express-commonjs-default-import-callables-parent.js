import express from 'express'
import requireAuth from './express-commonjs-default-arrow-middleware.js'
import showUser from './express-commonjs-default-function-handler.js'

const router = express.Router()

router.get('/users/:id', requireAuth, showUser)
