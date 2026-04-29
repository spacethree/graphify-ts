// @ts-nocheck
import { createSlice } from '@reduxjs/toolkit'

export const authSlice = createSlice({
  name: 'auth',
  initialState: { status: 'idle' as 'idle' | 'ready' },
  reducers: {
    logout(state) {
      state.status = 'idle'
    },
  },
})

export const auditSlice = createSlice({
  name: 'audit',
  initialState: { loggedOut: false },
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(authSlice.actions.logout, (state) => {
      state.loggedOut = true
    })
  },
})

export default authSlice.reducer
