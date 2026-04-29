// @ts-nocheck
import { createSlice } from '@reduxjs/toolkit'

import { selectAuthStatus, selectToken } from './redux-destructured-exports.js'

export function readSessionState(authState) {
  return {
    ready: selectAuthStatus(authState) === 'ready',
    token: selectToken(authState),
  }
}

export const sessionSlice = createSlice({
  name: 'session',
  initialState: { ready: false },
  reducers: {},
})
