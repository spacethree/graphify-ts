import express from 'express'
const requireAuth = require('./express-commonjs-default-middleware')
const ShowUser = require('./express-commonjs-default-handler-class')

const router = express.Router()

router.get('/users/:id', requireAuth, ShowUser)
