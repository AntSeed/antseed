import { Link } from 'react-router-dom'

interface DocsSidebarProps {
  activeSection: string
  mobileOpen: boolean
  onMobileClose: () => void
}

const sections = [
  {
    heading: '',
    items: [
      { id: 'lightpaper', label: 'Light Paper' },
    ],
  },
  {
    heading: 'Getting Started',
    items: [
      { id: 'intro', label: 'Introduction' },
      { id: 'install', label: 'Install' },
      { id: 'config', label: 'Configuration' },
    ],
  },
  {
    heading: 'Protocol',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'discovery', label: 'Discovery' },
      { id: 'transport', label: 'Transport' },
      { id: 'metering', label: 'Metering' },
      { id: 'payments', label: 'Payments' },
      { id: 'reputation', label: 'Reputation' },
    ],
  },
  {
    heading: 'Skills',
    items: [
      { id: 'skills', label: 'Overview' },
      { id: 'create-skill', label: 'Creating Skills' },
    ],
  },
  {
    heading: 'Plugins',
    items: [
      { id: 'provider-api', label: 'Provider Plugin' },
      { id: 'router-api', label: 'Router Plugin' },
      { id: 'create-plugin', label: 'Creating plugins' },
    ],
  },
  {
    heading: 'CLI Reference',
    items: [
      { id: 'commands', label: 'Commands' },
      { id: 'flags', label: 'Flags' },
    ],
  },
]

export default function DocsSidebar({ activeSection, mobileOpen, onMobileClose }: DocsSidebarProps) {
  const sidebarContent = (
    <div className="space-y-5 py-4">
      {sections.map((group) => (
        <div key={group.heading}>
          {group.heading && (
            <div className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-1.5 px-3">
              {group.heading}
            </div>
          )}
          {group.items.map((item) => (
            <Link
              key={item.id}
              to={`/docs/${item.id}`}
              onClick={onMobileClose}
              className={`block w-full text-left px-3 py-1.5 text-[13px] rounded-md mx-1 transition-colors no-underline ${
                activeSection === item.id
                  ? 'text-accent bg-accent/10'
                  : 'text-text-dim hover:text-text hover:bg-white/[0.03]'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </div>
  )

  return (
    <>
      {/* Desktop sidebar */}
      <aside aria-label="Documentation navigation" className="hidden md:block w-52 shrink-0 border-r border-[rgba(61,255,162,0.07)] overflow-y-auto sticky top-[73px] h-[calc(100vh-73px)]">
        {sidebarContent}
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div id="docs-sidebar-mobile" className="md:hidden fixed inset-0 z-40 bg-bg/95 backdrop-blur-sm">
          <div className="pt-16 px-4">
            <button
              onClick={onMobileClose}
              className="mb-4 text-sm text-text-dim hover:text-text"
            >
              &larr; Close
            </button>
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  )
}
