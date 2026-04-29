// @ts-nocheck
import express = require('express')

function listHealth() {}

const app = express()

app.get('/health', listHealth)
