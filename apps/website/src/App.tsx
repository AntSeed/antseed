import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { HelmetProvider } from 'react-helmet-async'
import Nav from './components/Nav'
import Home from './pages/Home'
import Docs from './pages/Docs'
import NotFound from './pages/NotFound'

function App() {
  return (
    <HelmetProvider>
    <BrowserRouter>
      <div className="min-h-screen">
        <Nav />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/lightpaper" element={<Navigate to="/docs/lightpaper" replace />} />
          <Route path="/docs" element={<Navigate to="/docs/intro" replace />} />
          <Route path="/docs/:section" element={<Docs />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
    </BrowserRouter>
    </HelmetProvider>
  )
}

export default App
