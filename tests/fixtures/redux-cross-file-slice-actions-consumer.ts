// @ts-nocheck
import { createSlice } from '@reduxjs/toolkit'

import { authSlice as importedAuthSlice } from './redux-cross-file-default-slice.js'

export const sessionSlice = createSlice({
  name: 'session',
  initialState: { loggedOut: false },
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(importedAuthSlice.actions.logout, (state) => {
      state.loggedOut = true
    })
  },
})
