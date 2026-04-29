import express from 'express'
import requireAuth from './express-default-export-middleware.js'
import ShowUser from './express-default-export-handler-class.js'

const router = express.Router()

router.get('/users/:id', requireAuth, ShowUser)
