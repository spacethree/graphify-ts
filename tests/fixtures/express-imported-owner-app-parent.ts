import apiApp from './express-imported-owner-app-child.js'

function createUser() {}

apiApp.post('/users', createUser)
