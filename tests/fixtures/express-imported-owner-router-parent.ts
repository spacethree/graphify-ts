import { apiRouter } from './express-imported-owner-router-child.js'

function showUser() {}

apiRouter.get('/users/:id', showUser)
