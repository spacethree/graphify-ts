// @ts-nocheck
import { createAction, createAsyncThunk, createSlice } from '@reduxjs/toolkit'

export const refreshProfile = createAction('auth/refreshProfile')
export const fetchProfile = createAsyncThunk('auth/fetchProfile', async () => ({ id: '1' }))

export const authSlice = createSlice({
  name: 'auth',
  initialState: { status: 'idle' as 'idle' | 'ready' | 'stale' },
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(fetchProfile.fulfilled, (state) => {
      state.status = 'ready'
    })
    builder.addCase(refreshProfile, (state) => {
      state.status = 'stale'
    })
  },
})

export const authReducer = authSlice.reducer
