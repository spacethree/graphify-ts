const express = require('express')

function showUser() {}

const router = express.Router()

router.get('/users/:id', showUser)

exports.router = router
