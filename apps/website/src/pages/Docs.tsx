import { useState } from 'react'
import { Helmet } from 'react-helmet-async'
import { useParams, Navigate } from 'react-router-dom'
import DocsSidebar from '../components/DocsSidebar'
import DocsContent from '../components/DocsContent'
import Footer from '../components/Footer'

const validSections = [
  'lightpaper',
  'intro', 'install', 'config',
  'overview', 'discovery', 'transport', 'metering', 'payments', 'reputation',
  'skills', 'create-skill',
  'provider-api', 'router-api', 'create-plugin',
  'commands', 'flags',
]

export default function Docs() {
  const { section } = useParams<{ section: string }>()
  const [mobileOpen, setMobileOpen] = useState(false)

  if (!section || !validSections.includes(section)) {
    return <Navigate to="/docs/intro" replace />
  }

  const sectionTitle = section === 'lightpaper'
    ? 'Light Paper'
    : section.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

  return (
    <div className="min-h-screen flex flex-col pt-[73px]">
      <Helmet>
        <title>{sectionTitle} — AntSeed Docs</title>
        <meta name="description" content={`AntSeed documentation — ${sectionTitle}. Learn how to build on the peer-to-peer AI services network.`} />
        <meta property="og:title" content={`${sectionTitle} — AntSeed Docs`} />
        <meta property="og:description" content={`AntSeed documentation — ${sectionTitle}.`} />
        <meta name="twitter:title" content={`${sectionTitle} — AntSeed Docs`} />
        <meta name="twitter:description" content={`AntSeed documentation — ${sectionTitle}.`} />
      </Helmet>
      {/* Mobile menu toggle */}
      <div className="md:hidden border-b border-border px-4 py-2">
        <button
          onClick={() => setMobileOpen(true)}
          className="font-mono text-xs text-text-muted hover:text-accent transition-colors"
          aria-label="Open documentation navigation"
          aria-expanded={mobileOpen}
          aria-controls="docs-sidebar-mobile"
        >
          [&equiv; sections]
        </button>
      </div>

      <div className="flex flex-1">
        <DocsSidebar
          activeSection={section}
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
        />
        <main className="flex-1 overflow-y-auto">
          <DocsContent section={section} />
        </main>
      </div>

      <Footer />
    </div>
  )
}
