const apiRouter = require('./express-imported-owner-commonjs-child')

function removeUser() {}

apiRouter.delete('/users/:id', removeUser)
