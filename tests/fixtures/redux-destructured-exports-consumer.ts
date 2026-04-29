// @ts-nocheck
import { createSlice } from '@reduxjs/toolkit'

import { logout, signInSucceeded } from './redux-destructured-exports.js'

export const sessionSlice = createSlice({
  name: 'session',
  initialState: { loggedOut: false, status: 'idle' as 'idle' | 'ready' },
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(logout, (state) => {
      state.loggedOut = true
    })
    builder.addCase(signInSucceeded, (state) => {
      state.status = 'ready'
    })
  },
})
