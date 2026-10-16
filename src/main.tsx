import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './tokens.css'
import './index.css'
import './art.css'
import './room.css'
import './group.css'
import './checkout.css'
import './mobile.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
