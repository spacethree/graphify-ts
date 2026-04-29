function listUser() {}

const router = require('express').Router()

router.get('/users/:id', listUser)

module.exports = router
