function listHealth() {}

const app = require('express')()

app.get('/health', listHealth)
