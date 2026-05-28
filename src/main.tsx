import React from 'react'
import ReactDOM from 'react-dom/client'
import { installProdConsoleSilence } from './utils/installProdConsoleSilence'
import App from './App'
import './index.css'

installProdConsoleSilence()

/** PWA: carga shell desde caché cuando no hay red (sw en /public/sw.js). */
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* sin SW en entornos file:// o si el registro falla */
    })
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)