import express from 'express'

const router = express.Router()

function listUsers() {}

router.get('/users', listUsers)

export default router
