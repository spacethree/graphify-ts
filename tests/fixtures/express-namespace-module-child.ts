const express = require('express')

function showUser() {}

export const router = express.Router()

router.get('/users/:id', showUser)
