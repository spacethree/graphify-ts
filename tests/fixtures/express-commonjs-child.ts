const express = require('express')

function listUser() {}

const router = express.Router()

router.get('/users/:id', listUser)

module.exports = router
