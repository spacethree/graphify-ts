const express = require('express')

function showUser() {}

const router = express.Router()

router.get('/users/:id', showUser)

module.exports = { router }
